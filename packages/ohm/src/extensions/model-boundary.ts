import { isProxy } from "node:util/types";

import type { StreamFn, ThinkingLevel } from "@ohm/kernel";
import { snapshotAdapterEvent } from "@ohm/kernel/runtime/core/adapter-event";
import { ASSISTANT_CONTENT_LIMITS } from "@ohm/kernel/runtime/core/assistant-content-limits";
import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { validateProviderState } from "@ohm/kernel/runtime/core/provider-state";
import { createAssistantMessageEventStream } from "@ohm/models";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Credential,
  ImageContent,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  Provider as ExtensionProvider,
  RefreshModelsContext,
  SimpleStreamOptions,
  StreamOptions,
  TextContent,
  Usage,
} from "@ohm/models";

import { errorMessage } from "../core/errors.js";
import {
  isJsonObject,
  isJsonValue,
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../core/json.js";
import { optionalProperties } from "../core/optional-properties.js";
import {
  BOOLEAN_VALUE,
  isObjectValue,
  STRING_VALUE,
} from "../core/value-schemas.js";
import {
  MAX_TOOL_CALL_STREAM_DELTA_BYTES,
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "../core/events.js";
import { createId } from "../core/ids.js";
import {
  assistantDiagnosticsFromProviderResponse,
  canonicalAssistantDiagnostics,
} from "../core/assistant-diagnostics.js";
import {
  assistantContentFromProviderState,
  canonicalAssistantContent,
  publicAssistantContent,
  withThinkingVisibility,
} from "../core/public-assistant-content.js";
import type {
  AdapterEvent,
  CanonicalMessage,
  FinishReason,
  ModelProtocolFamily,
  ModelRequestCompatibility,
  NormalizedUsage,
  ProviderState,
  ProviderRequest,
  TextBlock,
  ProviderToolDefinition,
  ToolResultBlock,
} from "../core/types.js";
import {
  ModelRegistry as InternalModelRegistry,
  type ProviderAuthStatus,
  type ProviderConfigInput as InternalProviderConfig,
  type ProviderConfigModel as InternalProviderModelConfig,
  type ResolvedRequestAuth,
} from "../providers/model-registry.js";
import type {
  Provider as InternalProvider,
  ProviderAuth as InternalProviderAuth,
  ProviderCredential,
  ProviderModel,
  ProviderOAuthCredential,
  ProviderRefreshContext,
  ProviderStreamContext,
  ProviderStreamOptions,
} from "../providers/models.js";
import { ProviderStreamProjector } from "../providers/stream-envelope.js";

/** Public provider-model declaration used by trusted direct extensions. */
export interface ExtensionProviderModelConfig {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: Array<"text" | "image">;
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxInputTokens?: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface ExtensionOAuthConfig {
  name: string;
  isSubscription?: boolean;
  getApiKey(credentials: OAuthCredentials): string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
}

/** Public configuration accepted by direct extension provider registration. */
export interface ExtensionProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: ExtensionOAuthConfig;
  models?: ExtensionProviderModelConfig[];
  refreshModels?(context: RefreshModelsContext): Promise<ExtensionProviderModelConfig[]>;
}

const PUBLIC_TO_INTERNAL_API = new Map<string, ModelProtocolFamily>([
  ["anthropic-messages", "anthropic-messages"],
  ["azure-openai-responses", "openai-responses"],
  ["bedrock-converse", "bedrock-converse"],
  ["bedrock-converse-stream", "bedrock-converse"],
  ["extension-stream", "extension-stream"],
  ["gemini-generate-content", "gemini-generate-content"],
  ["google-generative-ai", "gemini-generate-content"],
  ["google-vertex", "gemini-generate-content"],
  ["gemini-interactions", "gemini-interactions"],
  ["ollama-chat", "ollama-chat"],
  ["openai-codex-responses", "openai-responses"],
  ["openai-chat-completions", "openai-chat-completions"],
  ["openai-completions", "openai-chat-completions"],
  ["openai-responses", "openai-responses"],
]);

const INTERNAL_TO_PUBLIC_API = {
  "anthropic-messages": "anthropic-messages",
  "bedrock-converse": "bedrock-converse-stream",
  "extension-stream": "extension-stream",
  "gemini-generate-content": "google-generative-ai",
  "gemini-interactions": "gemini-interactions",
  "ollama-chat": "openai-completions",
  "openai-chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
} satisfies Partial<Record<ModelProtocolFamily, Api>>;

const NON_NEGATIVE_SAFE_INTEGER_VALUE = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const REASONING_FORMAT_VALUE = Type.Union([
  Type.Literal("ant-ling"),
  Type.Literal("chat-template"),
  Type.Literal("deepseek"),
  Type.Literal("openai"),
  Type.Literal("openrouter"),
  Type.Literal("qwen"),
  Type.Literal("qwen-chat-template"),
  Type.Literal("string-thinking"),
  Type.Literal("together"),
  Type.Literal("zai"),
]);

const PUBLIC_STREAM_RECORD_VALUE = Type.Object({
  arguments: Type.Optional(Type.Unknown()),
  content: Type.Optional(Type.Unknown()),
  contentIndex: Type.Optional(Type.Unknown()),
  contentSignature: Type.Optional(Type.Unknown()),
  delta: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Unknown()),
  id: Type.Optional(Type.Unknown()),
  message: Type.Optional(Type.Unknown()),
  model: Type.Optional(Type.Unknown()),
  name: Type.Optional(Type.Unknown()),
  part: Type.Optional(Type.Unknown()),
  partial: Type.Optional(Type.Unknown()),
  reason: Type.Optional(Type.Unknown()),
  redacted: Type.Optional(Type.Unknown()),
  responseId: Type.Optional(Type.Unknown()),
  responseModel: Type.Optional(Type.Unknown()),
  text: Type.Optional(Type.Unknown()),
  thoughtSignature: Type.Optional(Type.Unknown()),
  toolCall: Type.Optional(Type.Unknown()),
  type: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });

const USAGE_VALUE = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Optional(Type.Number()),
  cost: Type.Optional(Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
const JSON_VALUE = Type.Cyclic({
  value: Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref("value")),
    Type.Record(Type.String(), Type.Ref("value")),
  ]),
}, "value");
const ASSISTANT_CONTENT_VALUE = Type.Union([
  Type.Object({
    type: Type.Literal("text"),
    text: Type.String(),
    textSignature: Type.Optional(Type.String()),
  }, { additionalProperties: true }),
  Type.Object({
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    thinkingSignature: Type.Optional(Type.String()),
    redacted: Type.Optional(Type.Boolean()),
  }, { additionalProperties: true }),
  Type.Object({
    type: Type.Literal("toolCall"),
    id: Type.String(),
    name: Type.String(),
    arguments: Type.Record(Type.String(), JSON_VALUE),
    thoughtSignature: Type.Optional(Type.String()),
  }, { additionalProperties: true }),
]);
const ASSISTANT_DIAGNOSTIC_VALUE = Type.Object({
  type: Type.String(),
  timestamp: Type.Number(),
  message: Type.Optional(Type.String()),
  error: Type.Optional(Type.Object({
    name: Type.Optional(Type.String()),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
    code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    status: Type.Optional(Type.Number()),
  }, { additionalProperties: true })),
  details: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });
const ASSISTANT_MESSAGE_VALUE = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(ASSISTANT_CONTENT_VALUE),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  usage: USAGE_VALUE,
  stopReason: Type.Union([
    Type.Literal("pending"),
    Type.Literal("stop"),
    Type.Literal("length"),
    Type.Literal("toolUse"),
    Type.Literal("error"),
    Type.Literal("aborted"),
  ]),
  errorMessage: Type.Optional(Type.String()),
  timestamp: Type.Number(),
  responseModel: Type.Optional(Type.String()),
  responseId: Type.Optional(Type.String()),
  diagnostics: Type.Optional(Type.Array(ASSISTANT_DIAGNOSTIC_VALUE)),
  providerState: Type.Optional(Type.Object({
    source: Type.Object({
      api: Type.String(),
      provider: Type.String(),
      model: Type.String(),
    }, { additionalProperties: true }),
    value: Type.Unknown(),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

const TOOL_CHOICE_VALUE = Type.Object({
  type: Type.Literal("function"),
  function: Type.Object({ name: Type.String() }, { additionalProperties: true }),
}, { additionalProperties: true });
const TOOL_CHOICE_MODE_VALUE = Type.Union([
  Type.Literal("auto"),
  Type.Literal("none"),
  Type.Literal("required"),
]);

type PublicStreamRecord = Static<typeof PUBLIC_STREAM_RECORD_VALUE>;

interface PublicStreamString {
  value: string;
  bytes: number;
}

interface PublicStreamToolArguments {
  value: JsonObject;
  serialized: string;
}

/** Translate a public provider API into the protocol used by the core run loop. */
export function protocolFromPublicApi(api: Api): ModelProtocolFamily {
  return PUBLIC_TO_INTERNAL_API.get(api) ?? "extension-stream";
}

/** Translate a core protocol into its canonical public provider API. */
export function publicApiFromProtocol(protocol: ModelProtocolFamily): Api {
  const api = INTERNAL_TO_PUBLIC_API[protocol];
  if (api === undefined) throw new TypeError(`Unsupported model protocol: ${protocol}`);
  return api;
}

function modelKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

function compatibilityFromInternal(
  compatibility: ModelRequestCompatibility | undefined,
): Model<Api>["compat"] {
  if (compatibility === undefined) return undefined;
  return {
    ...optionalProperties(compatibility.supportsStore === undefined ? undefined : { supportsStore: compatibility.supportsStore }),
    ...optionalProperties(compatibility.supportsDeveloperRole === undefined ? undefined : { supportsDeveloperRole: compatibility.supportsDeveloperRole }),
    ...optionalProperties(compatibility.supportsUsageInStreaming === undefined ? undefined : { supportsUsageInStreaming: compatibility.supportsUsageInStreaming }),
    ...optionalProperties(compatibility.supportsStrictMode === undefined ? undefined : { supportsStrictMode: compatibility.supportsStrictMode }),
    ...optionalProperties(compatibility.supportsOpenAIGrammarTools === undefined ? undefined : { supportsOpenAIGrammarTools: compatibility.supportsOpenAIGrammarTools }),
    ...optionalProperties(compatibility.supportsStrictTools === undefined ? undefined : { supportsStrictTools: compatibility.supportsStrictTools }),
    ...optionalProperties(compatibility.maxTokensField === undefined ? undefined : { maxTokensField: compatibility.maxTokensField }),
    ...optionalProperties(compatibility.requiresToolResultName === undefined ? undefined : { requiresToolResultName: compatibility.requiresToolResultName }),
    ...optionalProperties(compatibility.requiresAssistantAfterToolResult === undefined ? undefined : { requiresAssistantAfterToolResult: compatibility.requiresAssistantAfterToolResult }),
    ...optionalProperties(compatibility.requiresThinkingAsText === undefined ? undefined : { requiresThinkingAsText: compatibility.requiresThinkingAsText }),
    ...optionalProperties(compatibility.requiresReasoningContentOnAssistantMessages === undefined ? undefined : { requiresReasoningContentOnAssistantMessages: compatibility.requiresReasoningContentOnAssistantMessages }),
    ...optionalProperties(compatibility.supportsReasoningEffort === undefined ? undefined : { supportsReasoningEffort: compatibility.supportsReasoningEffort }),
    ...optionalProperties(compatibility.supportsReasoningSummaries === undefined ? undefined : { supportsReasoningSummaries: compatibility.supportsReasoningSummaries }),
    ...optionalProperties(compatibility.exposesReasoningText === undefined ? undefined : { exposesReasoningText: compatibility.exposesReasoningText }),
    ...optionalProperties(compatibility.supportsThinkingDisplay === undefined ? undefined : { supportsThinkingDisplay: compatibility.supportsThinkingDisplay }),
    ...optionalProperties(compatibility.reasoningOutputFormat === undefined ? undefined : { reasoningOutputFormat: compatibility.reasoningOutputFormat }),
    ...optionalProperties(compatibility.includeReasoning === undefined ? undefined : { includeReasoning: compatibility.includeReasoning }),
    ...optionalProperties(compatibility.reasoningFormat === undefined ? undefined : { reasoningFormat: compatibility.reasoningFormat }),
    ...optionalProperties(compatibility.chatTemplateParameters === undefined ? undefined : { chatTemplateKwargs: compatibility.chatTemplateParameters }),
    ...optionalProperties(compatibility.zaiToolStream === undefined ? undefined : { zaiToolStream: compatibility.zaiToolStream }),
    ...optionalProperties(compatibility.deferredToolsMode === undefined ? undefined : { deferredToolsMode: compatibility.deferredToolsMode }),
    ...optionalProperties(compatibility.supportsToolSearch === undefined ? undefined : { supportsToolSearch: compatibility.supportsToolSearch }),
    ...optionalProperties(compatibility.supportsExplicitPromptCacheMode === undefined ? undefined : { supportsExplicitPromptCacheMode: compatibility.supportsExplicitPromptCacheMode }),
    ...optionalProperties(compatibility.supportsPromptCacheBreakpoints === undefined ? undefined : { supportsPromptCacheBreakpoints: compatibility.supportsPromptCacheBreakpoints }),
    ...optionalProperties(compatibility.cacheControlFormat === undefined ? undefined : { cacheControlFormat: compatibility.cacheControlFormat }),
    ...optionalProperties(compatibility.cacheControlTtl === undefined ? undefined : { cacheControlTtl: compatibility.cacheControlTtl }),
    ...optionalProperties(compatibility.supportsLongCacheRetention === undefined ? undefined : { supportsLongCacheRetention: compatibility.supportsLongCacheRetention }),
    ...optionalProperties(compatibility.supportsPromptCaching === undefined ? undefined : { supportsPromptCaching: compatibility.supportsPromptCaching }),
    ...optionalProperties(compatibility.supportsCacheControlOnTools === undefined ? undefined : { supportsCacheControlOnTools: compatibility.supportsCacheControlOnTools }),
    ...optionalProperties(compatibility.supportsTemperature === undefined ? undefined : { supportsTemperature: compatibility.supportsTemperature }),
    ...optionalProperties(compatibility.sendSessionAffinityHeaders === undefined ? undefined : { sendSessionAffinityHeaders: compatibility.sendSessionAffinityHeaders }),
    ...optionalProperties(compatibility.sessionAffinityFormat === undefined ? undefined : { sessionAffinityFormat: compatibility.sessionAffinityFormat }),
    ...optionalProperties(compatibility.openRouterRouting === undefined ? undefined : { openRouterRouting: compatibility.openRouterRouting }),
    ...optionalProperties(compatibility.vercelGatewayRouting === undefined ? undefined : { vercelGatewayRouting: compatibility.vercelGatewayRouting }),
    ...optionalProperties(compatibility.supportsEagerToolInputStreaming === undefined ? undefined : { supportsEagerToolInputStreaming: compatibility.supportsEagerToolInputStreaming }),
    ...optionalProperties(compatibility.forceAdaptiveThinking === undefined ? undefined : { forceAdaptiveThinking: compatibility.forceAdaptiveThinking }),
    ...optionalProperties(compatibility.allowEmptySignature === undefined ? undefined : { allowEmptySignature: compatibility.allowEmptySignature }),
    ...optionalProperties(compatibility.supportsToolReferences === undefined ? undefined : { supportsToolReferences: compatibility.supportsToolReferences }),
  };
}

function compatibilityToInternal(compatibility: Model<Api>["compat"]): ModelRequestCompatibility | undefined {
  if (compatibility === undefined) return undefined;
  const selected = compatibility;
  const result: ModelRequestCompatibility = {};
  if (Value.Check(BOOLEAN_VALUE, selected.supportsStore)) result.supportsStore = selected.supportsStore;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsDeveloperRole)) result.supportsDeveloperRole = selected.supportsDeveloperRole;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsUsageInStreaming)) result.supportsUsageInStreaming = selected.supportsUsageInStreaming;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsStrictMode)) result.supportsStrictMode = selected.supportsStrictMode;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsOpenAIGrammarTools)) result.supportsOpenAIGrammarTools = selected.supportsOpenAIGrammarTools;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsStrictTools)) result.supportsStrictTools = selected.supportsStrictTools;
  if (selected.maxTokensField === "max_completion_tokens" || selected.maxTokensField === "max_tokens") result.maxTokensField = selected.maxTokensField;
  if (Value.Check(BOOLEAN_VALUE, selected.requiresToolResultName)) result.requiresToolResultName = selected.requiresToolResultName;
  if (Value.Check(BOOLEAN_VALUE, selected.requiresAssistantAfterToolResult)) result.requiresAssistantAfterToolResult = selected.requiresAssistantAfterToolResult;
  if (Value.Check(BOOLEAN_VALUE, selected.requiresThinkingAsText)) result.requiresThinkingAsText = selected.requiresThinkingAsText;
  if (Value.Check(BOOLEAN_VALUE, selected.requiresReasoningContentOnAssistantMessages)) result.requiresReasoningContentOnAssistantMessages = selected.requiresReasoningContentOnAssistantMessages;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsReasoningEffort)) result.supportsReasoningEffort = selected.supportsReasoningEffort;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsReasoningSummaries)) result.supportsReasoningSummaries = selected.supportsReasoningSummaries;
  if (Value.Check(BOOLEAN_VALUE, selected.exposesReasoningText)) result.exposesReasoningText = selected.exposesReasoningText;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsThinkingDisplay)) result.supportsThinkingDisplay = selected.supportsThinkingDisplay;
  if (selected.reasoningOutputFormat === "parsed") result.reasoningOutputFormat = "parsed";
  if (Value.Check(BOOLEAN_VALUE, selected.includeReasoning)) result.includeReasoning = selected.includeReasoning;
  const reasoningFormat = selected.reasoningFormat ?? selected.thinkingFormat;
  if (Value.Check(REASONING_FORMAT_VALUE, reasoningFormat)) result.reasoningFormat = reasoningFormat;
  if (isJsonObject(selected.chatTemplateKwargs)) {
    result.chatTemplateParameters = selected.chatTemplateKwargs;
  }
  if (selected.cacheControlFormat === "anthropic") result.cacheControlFormat = "anthropic";
  if (selected.cacheControlTtl === "5m" || selected.cacheControlTtl === "1h") result.cacheControlTtl = selected.cacheControlTtl;
  if (Value.Check(BOOLEAN_VALUE, selected.zaiToolStream)) result.zaiToolStream = selected.zaiToolStream;
  if (selected.deferredToolsMode === "kimi") result.deferredToolsMode = "kimi";
  if (Value.Check(BOOLEAN_VALUE, selected.supportsToolSearch)) result.supportsToolSearch = selected.supportsToolSearch;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsExplicitPromptCacheMode)) {
    result.supportsExplicitPromptCacheMode = selected.supportsExplicitPromptCacheMode;
  }
  if (Value.Check(BOOLEAN_VALUE, selected.supportsPromptCacheBreakpoints)) {
    result.supportsPromptCacheBreakpoints = selected.supportsPromptCacheBreakpoints;
  }
  if (Value.Check(BOOLEAN_VALUE, selected.supportsLongCacheRetention)) result.supportsLongCacheRetention = selected.supportsLongCacheRetention;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsPromptCaching)) result.supportsPromptCaching = selected.supportsPromptCaching;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsCacheControlOnTools)) result.supportsCacheControlOnTools = selected.supportsCacheControlOnTools;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsTemperature)) result.supportsTemperature = selected.supportsTemperature;
  if (Value.Check(BOOLEAN_VALUE, selected.sendSessionAffinityHeaders)) result.sendSessionAffinityHeaders = selected.sendSessionAffinityHeaders;
  if (selected.sessionAffinityFormat === "openai" || selected.sessionAffinityFormat === "openai-nosession" || selected.sessionAffinityFormat === "openrouter") {
    result.sessionAffinityFormat = selected.sessionAffinityFormat;
  }
  if (isJsonObject(selected.openRouterRouting)) {
    result.openRouterRouting = selected.openRouterRouting;
  }
  if (isJsonObject(selected.vercelGatewayRouting)) {
    result.vercelGatewayRouting = selected.vercelGatewayRouting;
  }
  if (Value.Check(BOOLEAN_VALUE, selected.supportsEagerToolInputStreaming)) result.supportsEagerToolInputStreaming = selected.supportsEagerToolInputStreaming;
  if (Value.Check(BOOLEAN_VALUE, selected.forceAdaptiveThinking)) result.forceAdaptiveThinking = selected.forceAdaptiveThinking;
  if (Value.Check(BOOLEAN_VALUE, selected.allowEmptySignature)) result.allowEmptySignature = selected.allowEmptySignature;
  if (Value.Check(BOOLEAN_VALUE, selected.supportsToolReferences)) result.supportsToolReferences = selected.supportsToolReferences;
  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizedUsageFromPublic(usage: Usage): NormalizedUsage {
  return {
    ...optionalProperties(usage.input === undefined ? undefined : { inputTokens: usage.input }),
    ...optionalProperties(usage.output === undefined ? undefined : { outputTokens: usage.output }),
    ...optionalProperties(usage.totalTokens === undefined ? undefined : { totalTokens: usage.totalTokens }),
    ...optionalProperties(usage.cacheRead === undefined ? undefined : { cacheReadTokens: usage.cacheRead }),
    ...optionalProperties(usage.cacheWrite === undefined ? undefined : { cacheWriteTokens: usage.cacheWrite }),
    ...optionalProperties(usage.cacheWrite1h === undefined ? undefined : { cacheWrite1hTokens: usage.cacheWrite1h }),
    ...optionalProperties(usage.reasoning === undefined ? undefined : { reasoningTokens: usage.reasoning }),
    ...optionalProperties(usage.cost === undefined ? undefined : { cost: { ...usage.cost } }),
  };
}

function publicUsageFromNormalized(usage: NormalizedUsage | undefined): Usage {
  return {
    ...optionalProperties(usage?.inputTokens === undefined ? undefined : { input: usage.inputTokens }),
    ...optionalProperties(usage?.outputTokens === undefined ? undefined : { output: usage.outputTokens }),
    ...optionalProperties(usage?.cacheReadTokens === undefined ? undefined : { cacheRead: usage.cacheReadTokens }),
    ...optionalProperties(usage?.cacheWriteTokens === undefined ? undefined : { cacheWrite: usage.cacheWriteTokens }),
    ...optionalProperties(usage?.cacheWrite1hTokens === undefined ? undefined : { cacheWrite1h: usage.cacheWrite1hTokens }),
    ...optionalProperties(usage?.reasoningTokens === undefined ? undefined : { reasoning: usage.reasoningTokens }),
    ...optionalProperties(usage?.totalTokens === undefined ? undefined : { totalTokens: usage.totalTokens }),
    ...optionalProperties(usage?.cost === undefined ? undefined : { cost: { ...usage.cost } }),
  };
}

function publicStopReason(reason: FinishReason | undefined): AssistantMessage["stopReason"] {
  if (reason === "length" || reason === "context_limit") return "length";
  if (reason === "tool_calls") return "toolUse";
  if (reason === "cancelled" || reason === "aborted") return "aborted";
  if (reason === "error" || reason === "content_filter" || reason === "refusal") return "error";
  return "stop";
}

function internalFinishReason(reason: AssistantMessage["stopReason"]): FinishReason {
  if (reason === "pending") return "incomplete";
  if (reason === "length") return "length";
  if (reason === "toolUse") return "tool_calls";
  if (reason === "aborted") return "aborted";
  if (reason === "error") return "error";
  return "stop";
}

function textFromCanonical(message: CanonicalMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function publicContextFromInternal(
  context: ProviderStreamContext,
  model: Model<Api>,
): Context {
  const systemPrompt = context.messages
    .filter((message) => message.role === "system")
    .map(textFromCanonical)
    .filter(Boolean)
    .join("\n\n");
  const messages: Context["messages"] = [];
  for (const message of context.messages) {
    const timestamp = Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : Date.now();
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content: Array<TextContent | ImageContent> = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        if (block.type === "image" && block.data !== undefined) {
          content.push({ type: "image", data: block.data, mimeType: block.mediaType });
        }
      }
      messages.push({ role: "user", content, timestamp });
      continue;
    }
    if (message.role === "assistant") {
      const content = publicAssistantContent(message.content);
      const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
      messages.push({
        role: "assistant",
        content,
        api: message.publicApi ?? (message.api === undefined ? model.api : publicApiFromProtocol(message.api)),
        provider: message.provider ?? model.provider,
        model: message.model ?? model.id,
        ...optionalProperties(message.responseModel === undefined ? undefined : { responseModel: message.responseModel }),
        ...optionalProperties(message.responseId === undefined ? undefined : { responseId: message.responseId }),
        ...optionalProperties(diagnostics === undefined ? undefined : { diagnostics }),
        usage: publicUsageFromNormalized(message.usage),
        stopReason: publicStopReason(message.stopReason),
        ...optionalProperties(message.errorMessage === undefined ? undefined : { errorMessage: message.errorMessage }),
        timestamp,
      });
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      messages.push({
        role: "toolResult",
        toolCallId: block.callId,
        toolName: block.name,
        content: [
          { type: "text", text: block.content },
          ...(block.images ?? []).flatMap((image) => image.data === undefined
            ? []
            : [{ type: "image" as const, data: image.data, mimeType: image.mediaType }]),
        ],
        ...optionalProperties(block.metadata === undefined ? undefined : { details: block.metadata }),
        isError: block.isError,
        timestamp,
      });
    }
  }
  if (context.providerState !== undefined) {
    const lastAssistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
    if (lastAssistant !== undefined && isJsonValue(context.providerState)) {
      lastAssistant.providerState = {
        source: { api: lastAssistant.api, provider: lastAssistant.provider, model: lastAssistant.model },
        value: context.providerState,
      };
    }
  }
  const tools = context.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.inputSchema),
    ...optionalProperties(tool.constrainedSampling === undefined ? undefined : { constrainedSampling: structuredClone(tool.constrainedSampling) }),
  }));
  return {
    ...optionalProperties(systemPrompt === "" ? undefined : { systemPrompt }),
    messages,
    ...optionalProperties(tools === undefined ? undefined : { tools }),
  };
}

function publicOptionsFromInternal(options: ProviderStreamOptions): SimpleStreamOptions {
  const selected = options.reasoningEffort;
  const reasoning = selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh" || selected === "max"
    ? selected
    : undefined;
  return {
    ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    ...optionalProperties(options.apiKey === undefined ? undefined : { apiKey: options.apiKey }),
    ...optionalProperties(options.headers === undefined ? undefined : { headers: options.headers }),
    ...optionalProperties(options.env === undefined ? undefined : { env: options.env }),
    ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
    ...optionalProperties(options.maxOutputTokens === undefined ? undefined : { maxTokens: options.maxOutputTokens }),
    ...optionalProperties(reasoning === undefined ? undefined : { reasoning }),
    ...optionalProperties(options.toolChoice === undefined ? undefined : { toolChoice: options.toolChoice }),
    ...optionalProperties(options.temperature === undefined ? undefined : { temperature: options.temperature }),
    ...optionalProperties(options.cacheRetention === undefined ? undefined : { cacheRetention: options.cacheRetention }),
    ...optionalProperties(options.thinkingBudgets === undefined ? undefined : { thinkingBudgets: options.thinkingBudgets }),
    ...optionalProperties(options.sessionId === undefined ? undefined : { sessionId: options.sessionId }),
    ...optionalProperties(options.metadata === undefined ? undefined : { metadata: options.metadata }),
    ...optionalProperties(options.transport === undefined ? undefined : { transport: options.transport }),
    ...optionalProperties(options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs }),
    ...optionalProperties(options.websocketConnectTimeoutMs === undefined ? undefined : { websocketConnectTimeoutMs: options.websocketConnectTimeoutMs }),
    ...optionalProperties(options.websocketIdleTimeoutMs === undefined ? undefined : { websocketIdleTimeoutMs: options.websocketIdleTimeoutMs }),
    ...optionalProperties(options.maxRetries === undefined ? undefined : { maxRetries: options.maxRetries }),
    ...optionalProperties(options.maxRetryDelayMs === undefined ? undefined : { maxRetryDelayMs: options.maxRetryDelayMs }),
    ...optionalProperties(options.onPayload === undefined ? undefined : { onPayload: options.onPayload }),
    ...optionalProperties(options.onResponse === undefined ? undefined : { onResponse: options.onResponse }),
  };
}

function providerStateProtocol(state: ProviderState): ModelProtocolFamily {
  switch (state.kind) {
    case "openai_responses": return "openai-responses";
    case "anthropic_messages": return "anthropic-messages";
    case "gemini_interactions": return "gemini-interactions";
    case "gemini_generate_content": return "gemini-generate-content";
    case "extension_stream": return "extension-stream";
    case "bedrock_converse": return "bedrock-converse";
    case "chat_completions":
    case "openrouter_chat": return "openai-chat-completions";
    case "ollama_chat": return "ollama-chat";
  }
}

function stateFromAssistant(message: AssistantMessage, api: ModelProtocolFamily): ProviderState {
  const explicit = message.providerState;
  const explicitState = explicit === undefined ? undefined : parsedProviderState(explicit.value);
  if (
    explicit !== undefined &&
    explicit.source.api === message.api &&
    explicit.source.provider === message.provider &&
    explicit.source.model === message.model &&
    explicitState !== undefined &&
    providerStateProtocol(explicitState) === api
  ) {
    return Object.assign(structuredClone(explicitState), {
      source: { provider: message.provider, model: message.model, api },
    });
  }

  const assistantContent = message.content.map((block) => toJsonValue(block));
  const source = { provider: message.provider, model: message.model, api };
  switch (api) {
    case "openai-responses": return {
      kind: "openai_responses",
      outputItems: assistantContent,
      ...optionalProperties(message.responseId === undefined ? undefined : { previousResponseId: message.responseId }),
      source,
    };
    case "anthropic-messages": return { kind: "anthropic_messages", assistantBlocks: assistantContent, source };
    case "gemini-interactions": return {
      kind: "gemini_interactions",
      steps: assistantContent,
      ...optionalProperties(message.responseId === undefined ? undefined : { previousInteractionId: message.responseId }),
      source,
    };
    case "gemini-generate-content": return { kind: "gemini_generate_content", parts: assistantContent, source };
    case "bedrock-converse": return {
      kind: "bedrock_converse",
      assistantMessage: { role: "assistant", content: assistantContent },
      source,
    };
    case "ollama-chat": return {
      kind: "ollama_chat",
      assistantMessage: { role: "assistant", content: assistantContent },
      source,
    };
    case "openai-chat-completions": return {
      kind: "chat_completions",
      assistantMessage: { role: "assistant", content: assistantContent },
      source,
    };
    case "extension-stream": return {
      kind: "extension_stream",
      assistantContent,
      ...optionalProperties(message.responseId === undefined ? undefined : { responseId: message.responseId }),
      source,
    };
  }
}

const MAX_PUBLIC_STREAM_TOOL_CALLS = 256;
const MAX_PUBLIC_STREAM_MESSAGE_BYTES = 20 * 1024 * 1024;

function publicStreamRecord<T>(value: T, label: string): PublicStreamRecord {
  if (!isObjectValue(value) || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) throw new TypeError(`${label} contains too many fields`);
  const selected: object = Object.create(null);
  for (const key of keys) {
    if (!Value.Check(STRING_VALUE, key)) throw new TypeError(`${label} must not contain symbol fields`);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain only enumerable data fields`);
    }
    Object.defineProperty(selected, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  if (!Value.Check(PUBLIC_STREAM_RECORD_VALUE, selected)) throw new TypeError(`${label} must be an object`);
  return selected;
}

function publicStreamMessage<T>(value: T, label: string): AssistantMessage {
  const snapshot = boundedJsonSnapshot(value, {
    label,
    maximumBytes: MAX_PUBLIC_STREAM_MESSAGE_BYTES,
    maximumValues: (ASSISTANT_CONTENT_LIMITS.argumentValues * 2) + ASSISTANT_CONTENT_LIMITS.blocks,
    maximumContainers: (ASSISTANT_CONTENT_LIMITS.containers * 2) + ASSISTANT_CONTENT_LIMITS.blocks,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth + 2,
  });
  if (!Value.Check(ASSISTANT_MESSAGE_VALUE, snapshot.value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return snapshot.value;
}

function publicStreamIndex<T>(value: T, kind: "text" | "thinking" | "tool"): number {
  if (!Value.Check(NON_NEGATIVE_SAFE_INTEGER_VALUE, value)) {
    throw new TypeError(`Provider returned an invalid public stream ${kind} index`);
  }
  return value;
}

function publicStreamString<T>(value: T, label: string, maximumBytes: number): PublicStreamString {
  if (!Value.Check(STRING_VALUE, value)) throw new TypeError(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) throw new RangeError(`${label} exceeds ${maximumBytes} bytes`);
  return { value, bytes };
}

function publicStreamToolArguments<T>(value: T): PublicStreamToolArguments {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider public stream tool arguments",
    maximumBytes: MAX_TOOL_CALL_STREAM_DELTA_BYTES,
    maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
  });
  const detached: unknown = JSON.parse(snapshot.serialized);
  if (!isJsonObject(detached)) {
    throw new TypeError("Provider public stream tool arguments must be a plain JSON object");
  }
  return { value: detached, serialized: snapshot.serialized };
}

function publicToolArgumentsRecord(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function publicBoundaryProviderState<T>(value: T, api: ModelProtocolFamily): ProviderState {
  const selected = validateProviderState(value);
  if (selected.api !== api) {
    throw new TypeError(`Provider returned ${selected.api} continuation state for a ${api} stream`);
  }
  return selected.state;
}

type StreamPartKind = "text" | "thinking";

interface StreamPartCompletion {
  newlyStarted: boolean;
  suffix: string;
}

class StreamPartRetention {
  readonly #label: string;
  readonly #values = { text: new Map<number, string>(), thinking: new Map<number, string>() };
  readonly #bytes = { text: new Map<number, number>(), thinking: new Map<number, number>() };
  readonly #signatureBytes = { text: new Map<number, number>(), thinking: new Map<number, number>() };
  readonly #started = { text: new Set<number>(), thinking: new Set<number>() };
  readonly #completed = { text: new Set<number>(), thinking: new Set<number>() };
  #aggregateBytes = 0;

  constructor(label: string) {
    this.#label = label;
  }

  start(kind: StreamPartKind, part: number, explicit: boolean): boolean {
    if (this.#completed[kind].has(part)) throw new Error(`${this.#label} emitted ${kind} after completed part ${part}`);
    if (this.#started[kind].has(part)) {
      if (explicit) throw new Error(`${this.#label} emitted more than one ${kind}_start for part ${part}`);
      return false;
    }
    const other = kind === "text" ? this.#started.thinking : this.#started.text;
    if (this.#started[kind].size + other.size >= ASSISTANT_CONTENT_LIMITS.blocks) {
      throw new RangeError(`${this.#label} content exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} streamed blocks`);
    }
    this.#started[kind].add(part);
    return true;
  }

  append(kind: StreamPartKind, part: number, delta: string): boolean {
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    const totalBytes = (this.#bytes[kind].get(part) ?? 0) + deltaBytes;
    if (totalBytes > ASSISTANT_CONTENT_LIMITS.fieldBytes) {
      throw new RangeError(`${this.#label} ${kind} part ${part} exceeds ${ASSISTANT_CONTENT_LIMITS.fieldBytes} bytes`);
    }
    this.#setAggregate(this.#aggregateBytes + deltaBytes);
    const started = this.start(kind, part, false);
    this.#values[kind].set(part, `${this.#values[kind].get(part) ?? ""}${delta}`);
    this.#bytes[kind].set(part, totalBytes);
    return started;
  }

  finish(
    kind: StreamPartKind,
    part: number,
    content: string,
    signature = "",
  ): StreamPartCompletion {
    if (this.#completed[kind].has(part)) throw new Error(`${this.#label} emitted more than one ${kind}_end for part ${part}`);
    const emitted = this.#values[kind].get(part) ?? "";
    if (!content.startsWith(emitted)) throw new Error(`${this.#label} final ${kind} did not match its streamed prefix`);
    const contentBytes = Buffer.byteLength(content, "utf8");
    const signatureBytes = Buffer.byteLength(signature, "utf8");
    this.#setAggregate(
      this.#aggregateBytes
        - (this.#bytes[kind].get(part) ?? 0)
        - (this.#signatureBytes[kind].get(part) ?? 0)
        + contentBytes
        + signatureBytes,
    );
    const newlyStarted = this.start(kind, part, false);
    this.#values[kind].set(part, content);
    this.#bytes[kind].set(part, contentBytes);
    this.#signatureBytes[kind].set(part, signatureBytes);
    this.#completed[kind].add(part);
    return { newlyStarted, suffix: content.slice(emitted.length) };
  }

  content(kind: StreamPartKind, part: number): string {
    return this.#values[kind].get(part) ?? "";
  }

  isCompleted(kind: StreamPartKind, part: number): boolean {
    return this.#completed[kind].has(part);
  }

  started(kind: StreamPartKind): ReadonlySet<number> {
    return this.#started[kind];
  }

  #setAggregate(value: number): void {
    if (value > ASSISTANT_CONTENT_LIMITS.contentBytes) {
      throw new RangeError(`${this.#label} content exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate bytes`);
    }
    this.#aggregateBytes = value;
  }
}

async function* adapterEventsFromPublicStream(
  stream: AssistantMessageEventStream,
  api: ModelProtocolFamily,
): AsyncIterable<AdapterEvent> {
  let terminal = false;
  let started = false;
  const retainedParts = new StreamPartRetention("Provider public stream");
  const startedTools = new Set<number>();
  const completedTools = new Set<number>();
  const compatibilityProjector = new ProviderStreamProjector("extension-stream");

  const addTool = (index: number, explicit: boolean): void => {
    if (completedTools.has(index)) throw new Error(`Provider emitted a tool event after toolcall_end for index ${index}`);
    if (startedTools.has(index)) {
      if (explicit) throw new Error(`Provider emitted more than one toolcall_start for index ${index}`);
      return;
    }
    if (startedTools.size >= MAX_PUBLIC_STREAM_TOOL_CALLS) {
      throw new RangeError(
        `Provider returned more than ${MAX_PUBLIC_STREAM_TOOL_CALLS} streaming tool calls in one step`,
      );
    }
    startedTools.add(index);
  };

  for await (const rawEvent of stream) {
    if (terminal) throw new Error("Provider emitted an event after a terminal event");
    const event = publicStreamRecord(rawEvent, "Provider public stream event");
    if (!Value.Check(STRING_VALUE, event.type)) {
      throw new TypeError("Provider public stream event type must be a string");
    }
    const isNormalized = event.type === "response_start"
      || event.type === "response_end"
      || event.type === "usage"
      || (event.type === "text_start" && "part" in event)
      || (event.type === "text_end" && "part" in event)
      || event.type === "reasoning_start"
      || event.type === "reasoning_end"
      || event.type === "reasoning_delta"
      || event.type === "tool_call_start"
      || event.type === "tool_call_delta"
      || event.type === "tool_call_end"
      || (event.type === "text_delta" && "text" in event)
      || (event.type === "error" && !("reason" in event));
    if (isNormalized) {
      const selected = snapshotAdapterEvent(event);
      const projected = compatibilityProjector.project(selected);
      if (projected === undefined) continue;
      if (selected.type === "response_start") {
        if (started) throw new Error("Provider emitted more than one start event");
        started = true;
      } else if (selected.type === "text_start") {
        retainedParts.start("text", selected.part, true);
      } else if (selected.type === "text_delta") {
        retainedParts.append("text", selected.part, selected.text);
      } else if (selected.type === "text_end") {
        retainedParts.finish("text", selected.part, selected.text, selected.textSignature);
      } else if (selected.type === "reasoning_start") {
        retainedParts.start("thinking", selected.part, true);
      } else if (selected.type === "reasoning_delta") {
        retainedParts.append("thinking", selected.part, selected.text);
      } else if (selected.type === "reasoning_end") {
        retainedParts.finish("thinking", selected.part, selected.text, selected.thinkingSignature);
      } else if (selected.type === "tool_call_start") {
        addTool(selected.index, true);
      } else if (selected.type === "tool_call_delta") {
        addTool(selected.index, false);
      } else if (selected.type === "tool_call_end") {
        addTool(selected.index, false);
        completedTools.add(selected.index);
      } else if (selected.type === "response_end" || selected.type === "error") {
        terminal = true;
      }
      yield selected;
    } else if (event.type === "start") {
      if (started) throw new Error("Provider emitted more than one start event");
      started = true;
      const partial = publicStreamRecord(event.partial, "Provider public stream start partial");
      const responseModel = partial.responseModel ?? partial.model;
      if (!Value.Check(STRING_VALUE, responseModel)) {
        throw new TypeError("Provider public stream model must be a string");
      }
      if (partial.responseId !== undefined && !Value.Check(STRING_VALUE, partial.responseId)) {
        throw new TypeError("Provider public stream response ID must be a string");
      }
      yield {
        type: "response_start",
        model: responseModel,
        ...optionalProperties(partial.responseId === undefined ? undefined : { responseId: partial.responseId }),
      };
    } else if (event.type === "text_start") {
      const part = publicStreamIndex(event.contentIndex, "text");
      retainedParts.start("text", part, true);
      yield { type: "text_start", part };
    } else if (event.type === "text_delta") {
      const part = publicStreamIndex(event.contentIndex, "text");
      const delta = publicStreamString(
        event.delta,
        "Provider public stream text delta",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      if (retainedParts.append("text", part, delta.value)) {
        yield { type: "text_start", part };
      }
      yield { type: "text_delta", part, text: delta.value };
    } else if (event.type === "text_end") {
      const part = publicStreamIndex(event.contentIndex, "text");
      const content = publicStreamString(
        event.content,
        "Provider public stream final text",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      const signature = event.contentSignature === undefined
        ? undefined
        : publicStreamString(
            event.contentSignature,
            `Provider public stream text signature ${part}`,
            ASSISTANT_CONTENT_LIMITS.fieldBytes,
          );
      const completed = retainedParts.finish("text", part, content.value, signature?.value);
      if (completed.newlyStarted) {
        yield { type: "text_start", part };
      }
      if (completed.suffix !== "") yield { type: "text_delta", part, text: completed.suffix };
      yield {
        type: "text_end",
        part,
        text: content.value,
        ...optionalProperties(signature === undefined ? undefined : { textSignature: signature.value }),
      };
    } else if (event.type === "thinking_start") {
      const part = publicStreamIndex(event.contentIndex, "thinking");
      retainedParts.start("thinking", part, true);
      yield { type: "reasoning_start", part, visibility: "provider_trace" };
    } else if (event.type === "thinking_delta") {
      const part = publicStreamIndex(event.contentIndex, "thinking");
      const delta = publicStreamString(
        event.delta,
        "Provider public stream thinking delta",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      if (retainedParts.append("thinking", part, delta.value)) {
        yield { type: "reasoning_start", part, visibility: "provider_trace" };
      }
      yield { type: "reasoning_delta", part, text: delta.value, visibility: "provider_trace" };
    } else if (event.type === "thinking_end") {
      const part = publicStreamIndex(event.contentIndex, "thinking");
      const content = publicStreamString(
        event.content,
        "Provider public stream final thinking",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      const signature = event.contentSignature === undefined
        ? undefined
        : publicStreamString(
            event.contentSignature,
            `Provider public stream thinking signature ${part}`,
            ASSISTANT_CONTENT_LIMITS.fieldBytes,
          );
      if (event.redacted !== undefined && !Value.Check(BOOLEAN_VALUE, event.redacted)) {
        throw new TypeError("Provider public stream thinking redacted marker must be a boolean");
      }
      const completed = retainedParts.finish("thinking", part, content.value, signature?.value);
      if (completed.newlyStarted) {
        yield { type: "reasoning_start", part, visibility: "provider_trace" };
      }
      if (completed.suffix !== "" && event.redacted !== true) {
        yield { type: "reasoning_delta", part, text: completed.suffix, visibility: "provider_trace" };
      }
      yield {
        type: "reasoning_end",
        part,
        text: content.value,
        visibility: "provider_trace",
        ...optionalProperties(signature === undefined ? undefined : { thinkingSignature: signature.value }),
        ...optionalProperties(event.redacted === undefined ? undefined : { redacted: event.redacted }),
      };
    } else if (event.type === "toolcall_start") {
      const index = publicStreamIndex(event.contentIndex, "tool");
      addTool(index, true);
      yield { type: "tool_call_start", index };
    } else if (event.type === "toolcall_delta") {
      const index = publicStreamIndex(event.contentIndex, "tool");
      addTool(index, false);
      const delta = publicStreamString(
        event.delta,
        "Provider public stream tool call delta",
        MAX_TOOL_CALL_STREAM_DELTA_BYTES,
      );
      yield { type: "tool_call_delta", index, jsonFragment: delta.value };
    } else if (event.type === "toolcall_end") {
      const index = publicStreamIndex(event.contentIndex, "tool");
      addTool(index, false);
      const toolCall = publicStreamRecord(event.toolCall, "Provider public stream tool call");
      const id = publicStreamString(toolCall.id, "Provider public stream tool call ID", MAX_TOOL_CALL_STREAM_ID_BYTES);
      const name = publicStreamString(toolCall.name, "Provider public stream tool call name", MAX_TOOL_CALL_STREAM_NAME_BYTES);
      const signature = toolCall.thoughtSignature === undefined
        ? undefined
        : publicStreamString(
            toolCall.thoughtSignature,
            "Provider public stream tool call signature",
            ASSISTANT_CONTENT_LIMITS.fieldBytes,
          );
      const argumentsSnapshot = publicStreamToolArguments(toolCall.arguments);
      completedTools.add(index);
      yield {
        type: "tool_call_end",
        index,
        id: id.value,
        name: name.value,
        arguments: argumentsSnapshot.value,
        rawArguments: argumentsSnapshot.serialized,
        ...optionalProperties(signature === undefined ? undefined : { thoughtSignature: signature.value }),
      };
    } else if (event.type === "done") {
      terminal = true;
      const message = publicStreamMessage(event.message, "Provider public stream terminal message");
      const terminalContent = canonicalAssistantContent(message.content);
      for (const part of retainedParts.started("text")) {
        if (terminalContent[part]?.type !== "text") {
          throw new Error(`Provider terminal message omitted streamed text part ${part}`);
        }
      }
      for (const part of retainedParts.started("thinking")) {
        if (terminalContent[part]?.type !== "thinking") {
          throw new Error(`Provider terminal message omitted streamed thinking part ${part}`);
        }
      }
      if (!started) {
        yield {
          type: "response_start",
          model: message.responseModel ?? message.model,
          ...optionalProperties(message.responseId === undefined ? undefined : { responseId: message.responseId }),
        };
      }
      for (const [index, block] of terminalContent.entries()) {
        if (block.type === "text") {
          const emitted = retainedParts.content("text", index);
          if (!block.text.startsWith(emitted)) throw new Error("Provider terminal text did not match its streamed prefix");
          const completed = retainedParts.isCompleted("text", index);
          if (completed && block.text !== emitted) {
            throw new Error(`Provider terminal message changed completed streamed text part ${index}`);
          }
          if (!completed && retainedParts.start("text", index, false)) {
            yield { type: "text_start", part: index };
          }
          if (!completed && block.text.length > emitted.length) {
            yield { type: "text_delta", part: index, text: block.text.slice(emitted.length) };
          }
          if (!completed) {
            yield {
              type: "text_end",
              part: index,
              text: block.text,
              ...optionalProperties(block.textSignature === undefined ? undefined : { textSignature: block.textSignature }),
            };
          }
        } else if (block.type === "thinking") {
          const emitted = retainedParts.content("thinking", index);
          if (!block.thinking.startsWith(emitted)) throw new Error("Provider terminal thinking did not match its streamed prefix");
          const completed = retainedParts.isCompleted("thinking", index);
          if (completed && block.thinking !== emitted) {
            throw new Error(`Provider terminal message changed completed streamed thinking part ${index}`);
          }
          if (!completed && retainedParts.start("thinking", index, false)) {
            yield { type: "reasoning_start", part: index, visibility: "provider_trace" };
          }
          if (!completed && block.thinking.length > emitted.length) {
            yield { type: "reasoning_delta", part: index, text: block.thinking.slice(emitted.length), visibility: "provider_trace" };
          }
          if (!completed) {
            yield {
              type: "reasoning_end",
              part: index,
              text: block.thinking,
              visibility: "provider_trace",
              ...optionalProperties(block.thinkingSignature === undefined ? undefined : { thinkingSignature: block.thinkingSignature }),
              ...optionalProperties(block.redacted === undefined ? undefined : { redacted: block.redacted }),
            };
          }
        } else if (!completedTools.has(index)) {
          addTool(index, false);
          const argumentsSnapshot = publicStreamToolArguments(block.arguments);
          yield { type: "tool_call_start", index, id: block.callId, name: block.name };
          yield {
            type: "tool_call_end",
            index,
            id: block.callId,
            name: block.name,
            arguments: argumentsSnapshot.value,
            rawArguments: argumentsSnapshot.serialized,
            ...optionalProperties(block.thoughtSignature === undefined ? undefined : { thoughtSignature: block.thoughtSignature }),
          };
        }
      }
      yield { type: "usage", usage: normalizedUsageFromPublic(message.usage), semantics: "final" };
      yield {
        type: "response_end",
        reason: internalFinishReason(message.stopReason),
        state: stateFromAssistant({
          ...message,
          content: publicAssistantContent(terminalContent),
        }, api),
        content: terminalContent.map((block) =>
          block.type === "thinking"
            ? withThinkingVisibility(block, "provider_trace")
            : block),
        ...(() => {
          const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
          return diagnostics === undefined ? {} : { assistantDiagnostics: diagnostics };
        })(),
      };
    } else if (event.type === "error") {
      terminal = true;
      const message = publicStreamMessage(event.error, "Provider public stream error message");
      yield { type: "usage", usage: normalizedUsageFromPublic(message.usage), semantics: "final" };
      yield {
        type: "error",
        error: {
          category: event.reason === "aborted" ? "cancelled" : "provider",
          message: message.errorMessage ?? "Provider stream failed",
          retryable: false,
          partial: message.content.length > 0,
        },
      };
    }
  }
  if (!terminal) {
    yield {
      type: "error",
      error: {
        category: "protocol",
        message: "Provider stream ended without a terminal event",
        retryable: true,
        partial: true,
      },
    };
  }
}

/** @internal Adapt a low-level agent stream hook to the canonical provider event boundary. */
export async function* streamFunctionAdapterEvents(
  model: Model<Api>,
  request: ProviderRequest,
  signal: AbortSignal,
  streamFunction: StreamFn,
  overrides: SimpleStreamOptions = {},
): AsyncIterable<AdapterEvent> {
  const options = publicOptionsFromInternal({
    signal,
    ...optionalProperties(request.maxOutputTokens === undefined ? undefined : { maxOutputTokens: request.maxOutputTokens }),
    ...optionalProperties(request.reasoningEffort === undefined ? undefined : { reasoningEffort: request.reasoningEffort }),
    ...optionalProperties(request.toolChoice === undefined ? undefined : { toolChoice: request.toolChoice }),
    ...optionalProperties(request.temperature === undefined ? undefined : { temperature: request.temperature }),
    ...optionalProperties(request.cacheRetention === undefined ? undefined : { cacheRetention: request.cacheRetention }),
    ...optionalProperties(request.thinkingBudgets === undefined ? undefined : { thinkingBudgets: request.thinkingBudgets }),
    ...optionalProperties(request.sessionId === undefined ? undefined : { sessionId: request.sessionId }),
    ...optionalProperties(request.metadata === undefined ? undefined : { metadata: request.metadata }),
    ...optionalProperties(request.transport === undefined ? undefined : { transport: request.transport }),
    ...optionalProperties(request.timeoutMs === undefined ? undefined : { timeoutMs: request.timeoutMs }),
    ...optionalProperties(request.maxRetries === undefined ? undefined : { maxRetries: request.maxRetries }),
    ...optionalProperties(request.maxRetryDelayMs === undefined ? undefined : { maxRetryDelayMs: request.maxRetryDelayMs }),
    ...optionalProperties(request.onPayload === undefined ? undefined : { onPayload: request.onPayload }),
    ...optionalProperties(request.onResponse === undefined ? undefined : { onResponse: request.onResponse }),
    ...optionalProperties(request.modelSettings?.headers === undefined ? undefined : { headers: request.modelSettings.headers }),
  });
  const stream = await streamFunction(model, publicContextFromInternal({
    messages: request.messages,
    tools: request.tools,
    ...optionalProperties(request.providerState === undefined ? undefined : { providerState: request.providerState }),
  }, model), { ...options, ...overrides, signal });
  yield* adapterEventsFromPublicStream(stream, request.api ?? protocolFromPublicApi(model.api));
}

function parsedProviderState<T>(value: T): ProviderState | undefined {
  try {
    return validateProviderState(value).state;
  } catch {
    return undefined;
  }
}

function internalContextFromPublic(context: Context): ProviderStreamContext {
  const messages: CanonicalMessage[] = [];
  if (context.systemPrompt !== undefined && context.systemPrompt !== "") {
    messages.push({
      id: createId("message"),
      role: "system",
      content: [{ type: "text", text: context.systemPrompt }],
      createdAt: new Date().toISOString(),
      purpose: "instructions",
    });
  }
  let providerState: ProviderState | undefined;
  for (const message of context.messages) {
    const createdAt = new Date(message.timestamp).toISOString();
    if (message.role === "user") {
      const content: CanonicalMessage["content"] = Value.Check(STRING_VALUE, message.content)
        ? [{ type: "text", text: message.content }]
        : message.content.map((block) => block.type === "text"
          ? { type: "text", text: block.text }
          : { type: "image", mediaType: block.mimeType, data: block.data });
      messages.push({ id: createId("message"), role: "user", content, createdAt });
      continue;
    }
    if (message.role === "assistant") {
      const api = protocolFromPublicApi(message.api);
      const content = canonicalAssistantContent(message.content);
      const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
      messages.push({
        id: createId("message"),
        role: "assistant",
        content,
        createdAt,
        provider: message.provider,
        model: message.model,
        ...optionalProperties(message.responseModel === undefined ? undefined : { responseModel: message.responseModel }),
        ...optionalProperties(message.responseId === undefined ? undefined : { responseId: message.responseId }),
        ...optionalProperties(diagnostics === undefined ? undefined : { diagnostics }),
        api,
        ...optionalProperties(publicApiFromProtocol(api) === message.api ? undefined : { publicApi: message.api }),
        stopReason: internalFinishReason(message.stopReason),
        ...optionalProperties(message.errorMessage === undefined ? undefined : { errorMessage: message.errorMessage }),
        usage: normalizedUsageFromPublic(message.usage),
      });
      if (message.providerState !== undefined && isJsonValue(message.providerState.value)) {
        const value = message.providerState.value;
        providerState = parsedProviderState(value)
          ?? {
              kind: "extension_stream",
              assistantContent: [],
              source: {
                provider: message.providerState.source.provider,
                model: message.providerState.source.model,
                api: protocolFromPublicApi(message.providerState.source.api),
              },
            };
      }
      continue;
    }
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const images = message.content.flatMap((block) => block.type === "image"
      ? [{ type: "image" as const, mediaType: block.mimeType, data: block.data }]
      : []);
    const result: ToolResultBlock = {
      type: "tool_result",
      callId: message.toolCallId,
      name: message.toolName,
      content: text,
      isError: message.isError,
      ...optionalProperties(images.length === 0 ? undefined : { images }),
      ...optionalProperties(message.details === undefined || !isJsonValue(message.details) ? undefined : { metadata: message.details }),
    };
    messages.push({ id: createId("message"), role: "tool", content: [result], createdAt });
  }
  const tools: ProviderToolDefinition[] | undefined = context.tools?.map((tool) => {
    if (!isJsonObject(tool.parameters)) {
      throw new TypeError(`Tool ${tool.name} parameters must be a JSON object`);
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      ...optionalProperties(tool.constrainedSampling === undefined ? undefined : { constrainedSampling: structuredClone(tool.constrainedSampling) }),
    };
  });
  return {
    messages,
    ...optionalProperties(tools === undefined ? undefined : { tools }),
    ...optionalProperties(providerState === undefined ? undefined : { providerState }),
  };
}

function canonicalToolChoice<T>(value: T): ProviderRequest["toolChoice"] | undefined {
  if (Value.Check(TOOL_CHOICE_MODE_VALUE, value)) return value;
  if (!Value.Check(TOOL_CHOICE_VALUE, value)) return undefined;
  return { type: "function", function: { name: value.function.name } };
}

function internalOptionsFromPublic(
  options: (StreamOptions & {
    reasoning?: SimpleStreamOptions["reasoning"];
    thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"];
    toolChoice?: unknown;
  }) | undefined,
): ProviderStreamOptions {
  const metadata = options?.metadata === undefined
    ? undefined
    : Object.fromEntries(Object.entries(options.metadata).filter((entry): entry is [string, string] =>
        Value.Check(STRING_VALUE, entry[1])));
  const toolChoice = canonicalToolChoice(options?.toolChoice);
  return {
    ...optionalProperties(options?.signal === undefined ? undefined : { signal: options.signal }),
    ...optionalProperties(options?.apiKey === undefined ? undefined : { apiKey: options.apiKey }),
    ...optionalProperties(options?.headers === undefined ? undefined : { headers: options.headers }),
    ...optionalProperties(options?.env === undefined ? undefined : { env: options.env }),
    ...optionalProperties(options?.fetch === undefined ? undefined : { fetch: options.fetch }),
    ...optionalProperties(options?.maxTokens === undefined ? undefined : { maxOutputTokens: options.maxTokens }),
    ...optionalProperties(options?.reasoning === undefined ? undefined : { reasoningEffort: options.reasoning }),
    ...optionalProperties(toolChoice === undefined ? undefined : { toolChoice }),
    ...optionalProperties(options?.temperature === undefined ? undefined : { temperature: options.temperature }),
    ...optionalProperties(options?.cacheRetention === undefined ? undefined : { cacheRetention: options.cacheRetention }),
    ...optionalProperties(options?.thinkingBudgets === undefined ? undefined : { thinkingBudgets: options.thinkingBudgets }),
    ...optionalProperties(options?.sessionId === undefined ? undefined : { sessionId: options.sessionId }),
    ...optionalProperties(metadata === undefined ? undefined : { metadata }),
    ...optionalProperties(options?.transport === undefined ? undefined : { transport: options.transport }),
    ...optionalProperties(options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs }),
    ...optionalProperties(options?.websocketConnectTimeoutMs === undefined ? undefined : { websocketConnectTimeoutMs: options.websocketConnectTimeoutMs }),
    ...optionalProperties(options?.websocketIdleTimeoutMs === undefined ? undefined : { websocketIdleTimeoutMs: options.websocketIdleTimeoutMs }),
    ...optionalProperties(options?.maxRetries === undefined ? undefined : { maxRetries: options.maxRetries }),
    ...optionalProperties(options?.maxRetryDelayMs === undefined ? undefined : { maxRetryDelayMs: options.maxRetryDelayMs }),
    ...optionalProperties(options?.onPayload === undefined ? undefined : { onPayload: options.onPayload }),
    ...optionalProperties(options?.onResponse === undefined ? undefined : { onResponse: options.onResponse }),
  };
}

function publicStreamFromAdapterEvents(
  model: Model<Api>,
  events: AsyncIterable<AdapterEvent>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => void (async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: publicUsageFromNormalized(undefined),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    const textIndexes = new Map<number, number>();
    const thinkingIndexes = new Map<number, number>();
    const toolIndexes = new Map<number, number>();
    const retainedParts = new StreamPartRetention("Provider stream");
    const projector = new ProviderStreamProjector(model.provider);
    let started = false;
    let terminal = false;
    const snapshot = () => structuredClone(message);
    const appendContent = (block: AssistantMessage["content"][number]): number => {
      if (message.content.length >= ASSISTANT_CONTENT_LIMITS.blocks) {
        throw new RangeError(`Provider stream exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} public content blocks`);
      }
      const index = message.content.length;
      message.content.push(block);
      return index;
    };
    const start = () => {
      if (started) return;
      started = true;
      output.push({ type: "start", partial: snapshot() });
    };
    try {
      for await (const sourceEvent of events) {
        signal?.throwIfAborted();
        const canonicalSourceEvent = snapshotAdapterEvent(sourceEvent);
        const projected = projector.project(canonicalSourceEvent);
        if (projected === undefined) continue;
        const { event } = projected;
        if (event.type === "response_start") {
          message.responseModel = event.model;
          if (event.responseId !== undefined) message.responseId = event.responseId;
          const diagnostics = assistantDiagnosticsFromProviderResponse(event.diagnostics);
          if (diagnostics !== undefined) message.diagnostics = diagnostics;
          start();
        } else if (event.type === "text_start") {
          start();
          retainedParts.start("text", event.part, true);
          const index = appendContent({ type: "text", text: "" });
          textIndexes.set(event.part, index);
          output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "text_delta") {
          start();
          retainedParts.append("text", event.part, event.delta);
          let index = textIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "text", text: "" });
            textIndexes.set(event.part, index);
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "text") throw new Error("Provider text stream index changed type");
          block.text += event.delta;
          output.push({ type: "text_delta", contentIndex: index, delta: event.delta, partial: snapshot() });
        } else if (event.type === "text_end") {
          start();
          retainedParts.finish("text", event.part, event.content, event.contentSignature);
          let index = textIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "text", text: "" });
            textIndexes.set(event.part, index);
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "text") throw new Error("Provider text stream index changed type");
          block.text = event.content;
          if (event.contentSignature !== undefined) block.textSignature = event.contentSignature;
          output.push({
            type: "text_end",
            contentIndex: index,
            content: block.text,
            ...optionalProperties(block.textSignature === undefined ? undefined : { contentSignature: block.textSignature }),
            partial: snapshot(),
          });
        } else if (event.type === "reasoning_start") {
          if (event.visibility === "provider_trace") continue;
          start();
          retainedParts.start("thinking", event.part, true);
          const index = appendContent({ type: "thinking", thinking: "" });
          thinkingIndexes.set(event.part, index);
          output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "reasoning_delta") {
          if (event.visibility === "provider_trace") continue;
          start();
          retainedParts.append("thinking", event.part, event.delta);
          let index = thinkingIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "thinking", thinking: "" });
            thinkingIndexes.set(event.part, index);
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "thinking") throw new Error("Provider reasoning stream index changed type");
          block.thinking += event.delta;
          output.push({ type: "thinking_delta", contentIndex: index, delta: event.delta, partial: snapshot() });
        } else if (event.type === "reasoning_end") {
          if (event.visibility === "provider_trace") continue;
          start();
          retainedParts.finish("thinking", event.part, event.content, event.contentSignature);
          let index = thinkingIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "thinking", thinking: "" });
            thinkingIndexes.set(event.part, index);
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "thinking") throw new Error("Provider reasoning stream index changed type");
          block.thinking = event.content;
          if (event.contentSignature !== undefined) block.thinkingSignature = event.contentSignature;
          if (event.redacted !== undefined) block.redacted = event.redacted;
          output.push({
            type: "thinking_end",
            contentIndex: index,
            content: block.thinking,
            ...optionalProperties(block.thinkingSignature === undefined ? undefined : { contentSignature: block.thinkingSignature }),
            ...optionalProperties(block.redacted === undefined ? undefined : { redacted: block.redacted }),
            partial: snapshot(),
          });
        } else if (event.type === "tool_call_start") {
          start();
          const index = appendContent({
            type: "toolCall",
            id: event.partial.id ?? createId("tool"),
            name: event.partial.name ?? "",
            arguments: publicToolArgumentsRecord(event.partial.arguments),
          });
          toolIndexes.set(event.index, index);
          output.push({ type: "toolcall_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "tool_call_delta") {
          start();
          let index = toolIndexes.get(event.index);
          if (index === undefined) {
            index = appendContent({
              type: "toolCall",
              id: event.partial.id ?? createId("tool"),
              name: event.partial.name ?? "",
              arguments: publicToolArgumentsRecord(event.partial.arguments),
            });
            toolIndexes.set(event.index, index);
            output.push({ type: "toolcall_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "toolCall") throw new Error("Provider tool-call stream index changed type");
          if (event.partial.id !== undefined) block.id = event.partial.id;
          if (event.partial.name !== undefined) block.name = event.partial.name;
          if (event.partial.arguments !== undefined) {
            block.arguments = publicToolArgumentsRecord(event.partial.arguments);
          }
          output.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta, partial: snapshot() });
        } else if (event.type === "tool_call_end") {
          start();
          const index = toolIndexes.get(event.index) ?? message.content.length;
          let block = message.content[index];
          if (block?.type !== "toolCall") {
            block = {
              type: "toolCall",
              id: event.toolCall.id ?? createId("tool"),
              name: event.toolCall.name ?? "",
              arguments: {},
            };
            if (index === message.content.length) appendContent(block);
            else message.content[index] = block;
          }
          toolIndexes.set(event.index, index);
          block.id = event.toolCall.id ?? block.id;
          block.name = event.toolCall.name ?? block.name;
          block.arguments = isJsonObject(event.toolCall.arguments)
            ? event.toolCall.arguments
            : {};
          if (event.toolCall.thoughtSignature !== undefined) block.thoughtSignature = event.toolCall.thoughtSignature;
          output.push({ type: "toolcall_end", contentIndex: index, toolCall: structuredClone(block), partial: snapshot() });
        } else if (event.type === "usage") {
          message.usage = publicUsageFromNormalized(event.usage);
        } else if (event.type === "response_end") {
          if (canonicalSourceEvent.type !== "response_end") {
            throw new Error("Provider stream projection changed terminal type");
          }
          start();
          if (event.assistantDiagnostics !== undefined) {
            message.diagnostics = canonicalAssistantDiagnostics(event.assistantDiagnostics)!;
          }
          const terminalContent = event.content ?? assistantContentFromProviderState(canonicalSourceEvent.state);
          if (terminalContent !== undefined) {
            const startedTextParts = new Set(textIndexes.keys());
            const startedThinkingParts = new Set(thinkingIndexes.keys());
            message.content = publicAssistantContent(terminalContent.filter((block) =>
              block.type !== "thinking" || block.visibility === "summary"));
            textIndexes.clear();
            thinkingIndexes.clear();
            toolIndexes.clear();
            for (const [index, block] of message.content.entries()) {
              if (block.type === "text") {
                textIndexes.set(index, index);
                if (!startedTextParts.has(index)) output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
              }
              else if (block.type === "thinking") {
                thinkingIndexes.set(index, index);
                if (!startedThinkingParts.has(index)) output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
              }
              else toolIndexes.set(index, index);
            }
          }
          for (const [part, index] of textIndexes) {
            if (retainedParts.isCompleted("text", part)) continue;
            const block = message.content[index];
            if (block?.type === "text") output.push({
              type: "text_end",
              contentIndex: index,
              content: block.text,
              ...optionalProperties(block.textSignature === undefined ? undefined : { contentSignature: block.textSignature }),
              partial: snapshot(),
            });
          }
          for (const [part, index] of thinkingIndexes) {
            if (retainedParts.isCompleted("thinking", part)) continue;
            const block = message.content[index];
            if (block?.type === "thinking") output.push({
              type: "thinking_end",
              contentIndex: index,
              content: block.thinking,
              ...optionalProperties(block.thinkingSignature === undefined ? undefined : { contentSignature: block.thinkingSignature }),
              ...optionalProperties(block.redacted === undefined ? undefined : { redacted: block.redacted }),
              partial: snapshot(),
            });
          }
          message.stopReason = publicStopReason(event.reason);
          const providerState = publicBoundaryProviderState(
            canonicalSourceEvent.state,
            protocolFromPublicApi(model.api),
          );
          message.providerState = {
            source: { api: model.api, provider: model.provider, model: model.id },
            value: providerState,
          };
          terminal = true;
          output.push({
            type: "done",
            reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
            message: snapshot(),
          });
          break;
        } else if (event.type === "error") {
          start();
          message.stopReason = event.error.category === "cancelled" ? "aborted" : "error";
          message.errorMessage = event.error.message;
          terminal = true;
          output.push({ type: "error", reason: message.stopReason, error: snapshot() });
          break;
        }
      }
      if (!terminal) throw new Error("Provider stream ended without a terminal event");
    } catch (error) {
      if (terminal) return;
      start();
      message.stopReason = signal?.aborted ? "aborted" : "error";
      message.errorMessage = errorMessage(error);
      output.push({ type: "error", reason: message.stopReason, error: snapshot() });
    }
  })());
  return output;
}

function internalOAuthCredential(credential: OAuthCredentials): ProviderOAuthCredential {
  return { ...credential, type: "oauth" };
}

function publicOAuthCredential(credential: ProviderOAuthCredential): OAuthCredentials {
  return { ...credential, type: "oauth" };
}

function publicProviderCredential(
  credential: ProviderCredential | undefined,
): Credential | undefined {
  if (credential === undefined) return undefined;
  if (credential.type === "oauth") {
    return { ...publicOAuthCredential(credential), type: "oauth" };
  }
  return {
    type: "api_key",
    ...optionalProperties(credential.key === undefined ? undefined : { key: credential.key }),
    ...optionalProperties(credential.env === undefined ? undefined : { env: { ...credential.env } }),
  };
}

function internalAuthFromPublic(auth: ExtensionProvider["auth"]): InternalProviderAuth {
  const converted: InternalProviderAuth = {};
  const apiKey = auth.apiKey;
  if (apiKey !== undefined) {
    const selected: NonNullable<InternalProviderAuth["apiKey"]> = {
      name: apiKey.name,
      resolve: async (input) => await apiKey.resolve(input),
    };
    const login = apiKey.login;
    const check = apiKey.check;
    if (login !== undefined) selected.login = async (interaction) => await login(interaction);
    if (check !== undefined) selected.check = async (input) => await check(input);
    converted.apiKey = selected;
  }
  const providerAccount = auth.providerAccount;
  if (providerAccount !== undefined) {
    converted.providerAccount = {
      name: providerAccount.name,
      ...optionalProperties(providerAccount.loginLabel === undefined ? undefined : { loginLabel: providerAccount.loginLabel }),
      login: async (interaction) => await providerAccount.login(interaction),
    };
  }
  const oauth = auth.oauth;
  if (oauth !== undefined) {
    converted.oauth = {
      name: oauth.name,
      ...optionalProperties(oauth.loginLabel === undefined ? undefined : { loginLabel: oauth.loginLabel }),
      ...optionalProperties(oauth.isSubscription === undefined ? undefined : { isSubscription: oauth.isSubscription }),
      async login(interaction) {
        return internalOAuthCredential(await oauth.login(interaction));
      },
      async refresh(credential, signal) {
        return internalOAuthCredential(await oauth.refresh(publicOAuthCredential(credential), signal));
      },
      toAuth: async (credential) => await oauth.toAuth(publicOAuthCredential(credential)),
    };
  }
  return converted;
}

function publicAuthFromInternal(auth: InternalProviderAuth): ExtensionProvider["auth"] {
  const internalOAuth = auth.oauth;
  const publicOAuth = internalOAuth?.login === undefined || internalOAuth.refresh === undefined
    ? undefined
    : {
        name: internalOAuth.name,
        ...optionalProperties(internalOAuth.loginLabel === undefined ? undefined : { loginLabel: internalOAuth.loginLabel }),
        ...optionalProperties(internalOAuth.isSubscription === undefined ? undefined : { isSubscription: internalOAuth.isSubscription }),
        async login(interaction: Parameters<NonNullable<ExtensionProvider["auth"]["oauth"]>["login"]>[0]) {
          return publicOAuthCredential(await internalOAuth.login!(interaction));
        },
        async refresh(
          credential: OAuthCredentials,
          signal?: AbortSignal,
        ) {
          return publicOAuthCredential(await internalOAuth.refresh!(internalOAuthCredential(credential), signal));
        },
        toAuth: (credential: OAuthCredentials) => internalOAuth.toAuth(internalOAuthCredential(credential)),
      };
  const converted: ExtensionProvider["auth"] = {};
  const apiKey = auth.apiKey;
  if (apiKey !== undefined) {
    const selected: NonNullable<ExtensionProvider["auth"]["apiKey"]> = {
      name: apiKey.name,
      resolve: async (input) => await apiKey.resolve(input),
    };
    const login = apiKey.login;
    const check = apiKey.check;
    if (login !== undefined) selected.login = async (interaction) => await login(interaction);
    if (check !== undefined) selected.check = async (input) => await check(input);
    converted.apiKey = selected;
  }
  const providerAccount = auth.providerAccount;
  if (providerAccount !== undefined) {
    converted.providerAccount = {
      name: providerAccount.name,
      ...optionalProperties(providerAccount.loginLabel === undefined ? undefined : { loginLabel: providerAccount.loginLabel }),
      login: async (interaction) => await providerAccount.login(interaction),
    };
  }
  if (publicOAuth !== undefined) converted.oauth = publicOAuth;
  return converted;
}

function internalProviderConfigModel(
  definition: ExtensionProviderModelConfig,
): InternalProviderModelConfig {
  return {
    id: definition.id,
    name: definition.name,
    ...optionalProperties(definition.api === undefined ? undefined : { api: protocolFromPublicApi(definition.api) }),
    ...optionalProperties(definition.baseUrl === undefined ? undefined : { baseUrl: definition.baseUrl }),
    reasoning: definition.reasoning,
    ...optionalProperties(definition.thinkingLevelMap === undefined ? undefined : { thinkingLevelMap: definition.thinkingLevelMap }),
    input: [...definition.input],
    cost: { ...definition.cost, ...optionalProperties(definition.cost.tiers === undefined ? undefined : { tiers: definition.cost.tiers.map((tier) => ({ ...tier })) }) },
    contextWindow: definition.contextWindow,
    ...optionalProperties(definition.maxInputTokens === undefined ? undefined : { maxInputTokens: definition.maxInputTokens }),
    maxTokens: definition.maxTokens,
    ...optionalProperties(definition.headers === undefined ? undefined : { headers: { ...definition.headers } }),
    ...(() => {
      const compat = compatibilityToInternal(definition.compat);
      return compat === undefined ? {} : { compat };
    })(),
  };
}

/** Present one core provider model through the stable public model contract. */
export function extensionModel(
  model: ProviderModel,
  api: Api = publicApiFromProtocol(model.api),
): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...optionalProperties(model.thinkingLevelMap === undefined ? undefined : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    input: [...model.input],
    cost: {
      ...model.cost,
      ...optionalProperties(model.cost.tiers === undefined ? undefined : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
    },
    contextWindow: model.contextWindow,
    ...optionalProperties(model.maxInputTokens === undefined ? undefined : { maxInputTokens: model.maxInputTokens }),
    maxTokens: model.maxTokens,
    ...optionalProperties(model.headers === undefined ? undefined : { headers: { ...model.headers } }),
    ...(() => {
      const compat = compatibilityFromInternal(model.compat);
      return compat === undefined ? {} : { compat };
    })(),
  };
}

/** Clone and recursively freeze one extension-facing model snapshot. */
export function immutableExtensionModel(model: Model<Api>): Model<Api> {
  const freeze = <T>(value: T): void => {
    if (!isObjectValue(value) || Object.isFrozen(value)) return;
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  };
  const snapshot = structuredClone(model);
  freeze(snapshot);
  return snapshot;
}

/** Extension-facing model directory backed by the active internal model registry. */
export class ExtensionModelRegistry {
  readonly #internal: InternalModelRegistry;
  readonly #publicModels = new Map<string, Model<Api>>();
  readonly #publicProviders = new Map<string, ExtensionProvider>();
  readonly #providerViews = new Map<string, ExtensionProvider>();
  readonly #publicConfigs = new Map<string, ExtensionProviderConfig>();

  constructor(internal: InternalModelRegistry) {
    this.#internal = internal;
  }

  #clearPublicModels(provider: string): void {
    for (const key of this.#publicModels.keys()) {
      if (key.startsWith(`${provider}\0`)) this.#publicModels.delete(key);
    }
  }

  async refresh(): Promise<void> { await this.#internal.refresh(); }
  getError(): string | undefined { return this.#internal.getError(); }

  #publicModel(model: ProviderModel): Model<Api> {
    const key = modelKey(model.provider, model.id);
    const preserved = this.#publicModels.get(key);
    const selected = extensionModel(model, preserved?.api);
    if (preserved?.compat !== undefined) selected.compat = preserved.compat;
    this.#publicModels.set(key, selected);
    return selected;
  }

  /** Present one internal model through the stable public provider contract. */
  present(model: ProviderModel): Model<Api> {
    return this.#publicModel(model);
  }

  resolve(model: Model<Api>): ProviderModel {
    const selected = this.#internal.find(model.provider, model.id);
    if (selected !== undefined) {
      this.#publicModels.set(modelKey(model.provider, model.id), model);
      return selected;
    }
    const converted: ProviderModel = {
      id: model.id,
      name: model.name,
      api: protocolFromPublicApi(model.api),
      provider: model.provider,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      ...optionalProperties(model.thinkingLevelMap === undefined ? undefined : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
      input: [...model.input],
      cost: { ...model.cost, ...optionalProperties(model.cost.tiers === undefined ? undefined : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }) },
      contextWindow: model.contextWindow,
      ...optionalProperties(model.maxInputTokens === undefined ? undefined : { maxInputTokens: model.maxInputTokens }),
      maxTokens: model.maxTokens,
      ...optionalProperties(model.headers === undefined ? undefined : { headers: { ...model.headers } }),
      ...(() => {
        const compat = compatibilityToInternal(model.compat);
        return compat === undefined ? {} : { compat };
      })(),
    };
    this.#publicModels.set(modelKey(model.provider, model.id), model);
    return converted;
  }

  getAll(): Model<Api>[] { return this.#internal.getAll().map((model) => this.#publicModel(model)); }
  getAvailable(): Model<Api>[] { return this.#internal.getAvailable().map((model) => this.#publicModel(model)); }
  find(provider: string, modelId: string): Model<Api> | undefined {
    const model = this.#internal.find(provider, modelId);
    return model === undefined ? undefined : this.#publicModel(model);
  }
  hasConfiguredAuth(model: Model<Api>): boolean { return this.#internal.hasConfiguredAuth(model.provider); }
  getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> { return this.#internal.getApiKeyAndHeaders(this.resolve(model)); }
  getApiKeyForProvider(provider: string): Promise<string | undefined> { return this.#internal.getApiKeyForProvider(provider); }
  getProviderAuthStatus(provider: string): ProviderAuthStatus { return this.#internal.getProviderAuthStatus(provider); }
  getProviderDisplayName(provider: string): string { return this.#internal.getProviderDisplayName(provider); }
  getProviderAuth(provider: string) { return this.#internal.getProviderAuth(provider); }
  isUsingOAuth(model: Model<Api>): boolean { return this.#internal.isUsingOAuth(model.provider); }
  isSubscription(model: Model<Api>): boolean { return this.#internal.isSubscription(model.provider); }

  getProvider(provider: string): ExtensionProvider | undefined {
    const registered = this.#publicProviders.get(provider);
    if (registered !== undefined) return registered;
    const cached = this.#providerViews.get(provider);
    if (cached !== undefined) return cached;
    const internal = this.#internal.getProvider(provider);
    if (internal === undefined) return undefined;
    const view = publicProviderFromInternal(internal, this);
    this.#providerViews.set(provider, view);
    return view;
  }

  registerProvider(provider: ExtensionProvider): void;
  registerProvider(providerName: string, config: ExtensionProviderConfig): void;
  registerProvider(providerOrName: ExtensionProvider | string, config?: ExtensionProviderConfig): void {
    const id = Value.Check(STRING_VALUE, providerOrName) ? providerOrName : providerOrName.id;
    if (!Value.Check(STRING_VALUE, providerOrName)) {
      this.#clearPublicModels(id);
      this.#publicProviders.set(id, providerOrName);
      this.#providerViews.delete(id);
      this.#publicConfigs.delete(id);
      for (const model of providerOrName.getModels()) this.#publicModels.set(modelKey(id, model.id), model);
      this.#internal.registerProvider(internalProviderFromExtension(providerOrName, this));
      return;
    }
    if (config === undefined) {
      throw new Error("A provider object is required when registration uses a string name");
    }
    const replacingNativeProvider = this.#publicProviders.has(id);
    this.#publicProviders.delete(id);
    this.#providerViews.delete(id);
    const merged: ExtensionProviderConfig = { ...this.#publicConfigs.get(id) };
    if (config.name !== undefined) merged.name = config.name;
    if (config.baseUrl !== undefined) merged.baseUrl = config.baseUrl;
    if (config.apiKey !== undefined) merged.apiKey = config.apiKey;
    if (config.api !== undefined) merged.api = config.api;
    if (config.streamSimple !== undefined) merged.streamSimple = config.streamSimple;
    if (config.headers !== undefined) merged.headers = config.headers;
    if (config.authHeader !== undefined) merged.authHeader = config.authHeader;
    if (config.oauth !== undefined) merged.oauth = config.oauth;
    if (config.models !== undefined) merged.models = config.models;
    if (config.refreshModels !== undefined) merged.refreshModels = config.refreshModels;
    this.#publicConfigs.set(id, merged);
    if (replacingNativeProvider || config.models !== undefined) this.#clearPublicModels(id);
    if (config.models !== undefined) rememberConfigModels(this, id, merged, config.models);
    this.#internal.registerProvider(id, internalProviderConfigFromExtension(id, config, this));
  }

  unregisterProvider(providerName: string): void {
    this.#publicProviders.delete(providerName);
    this.#providerViews.delete(providerName);
    this.#publicConfigs.delete(providerName);
    this.#clearPublicModels(providerName);
    this.#internal.unregisterProvider(providerName);
  }

  getRegisteredProviderConfig(providerName: string): ExtensionProviderConfig | undefined {
    return this.#publicConfigs.get(providerName);
  }
  getRegisteredNativeProvider(providerName: string): ExtensionProvider | undefined {
    return this.#publicProviders.get(providerName);
  }
  getRegisteredProviderIds(): readonly string[] {
    return [...new Set([...this.#publicConfigs.keys(), ...this.#publicProviders.keys()])];
  }
}

const REGISTRY_VIEWS = new WeakMap<InternalModelRegistry, ExtensionModelRegistry>();

export function extensionModelRegistry(internal: InternalModelRegistry): ExtensionModelRegistry {
  const existing = REGISTRY_VIEWS.get(internal);
  if (existing !== undefined) return existing;
  const created = new ExtensionModelRegistry(internal);
  REGISTRY_VIEWS.set(internal, created);
  return created;
}

function rememberConfigModels(
  registry: ExtensionModelRegistry,
  provider: string,
  config: ExtensionProviderConfig,
  definitions: readonly ExtensionProviderModelConfig[],
): void {
  for (const definition of definitions) {
    const current = registry.find(provider, definition.id);
    const api = definition.api ?? config.api ?? current?.api;
    const baseUrl = definition.baseUrl ?? config.baseUrl ?? current?.baseUrl;
    if (api === undefined || baseUrl === undefined) continue;
    registry.resolve({
      id: definition.id,
      name: definition.name,
      api,
      provider,
      baseUrl,
      reasoning: definition.reasoning,
      ...optionalProperties(definition.thinkingLevelMap === undefined ? undefined : { thinkingLevelMap: { ...definition.thinkingLevelMap } }),
      input: [...definition.input],
      cost: {
        ...definition.cost,
        ...optionalProperties(definition.cost.tiers === undefined ? undefined : { tiers: definition.cost.tiers.map((tier) => ({ ...tier })) }),
      },
      contextWindow: definition.contextWindow,
      ...optionalProperties(definition.maxInputTokens === undefined ? undefined : { maxInputTokens: definition.maxInputTokens }),
      maxTokens: definition.maxTokens,
      ...optionalProperties(definition.headers === undefined ? undefined : { headers: { ...definition.headers } }),
      ...optionalProperties(definition.compat === undefined ? undefined : { compat: definition.compat }),
    });
  }
}

function publicProviderFromInternal(
  provider: InternalProvider,
  registry: ExtensionModelRegistry,
): ExtensionProvider {
  return {
    id: provider.id,
    name: provider.name,
    ...optionalProperties(provider.baseUrl === undefined ? undefined : { baseUrl: provider.baseUrl }),
    ...optionalProperties(provider.headers === undefined ? undefined : { headers: provider.headers }),
    auth: publicAuthFromInternal(provider.auth),
    getModels: () => provider.getModels().map((model) => registry.present(model)),
    ...optionalProperties(provider.refreshModels === undefined ? undefined : {
      async refreshModels(context) {
        await provider.refreshModels!({
          ...optionalProperties(context.credential === undefined ? undefined : { credential: context.credential }),
          store: {
            async read() {
              const stored = await context.store.read();
              return stored === undefined
                ? undefined
                : { ...stored, models: stored.models.map((model) => registry.resolve(model)) };
            },
            async write(entry) {
              await context.store.write({ ...entry, models: entry.models.map((model) => registry.present(model)) });
            },
            delete: () => context.store.delete(),
          },
          allowNetwork: context.allowNetwork,
          ...optionalProperties(context.force === undefined ? undefined : { force: context.force }),
          ...optionalProperties(context.signal === undefined ? undefined : { signal: context.signal }),
        });
      },
    }),
    ...optionalProperties(provider.filterModels === undefined ? undefined : {
      filterModels(models, credential) {
        return provider.filterModels!(models.map((model) => registry.resolve(model)), credential)
          .map((model) => registry.present(model));
      },
    }),
    stream(model, context, options) {
      const internal = registry.resolve(model);
      return publicStreamFromAdapterEvents(
        model,
        provider.stream(internal, internalContextFromPublic(context), internalOptionsFromPublic(options)),
        options?.signal,
      );
    },
    streamSimple(model, context, options) {
      const internal = registry.resolve(model);
      return publicStreamFromAdapterEvents(
        model,
        provider.streamSimple(internal, internalContextFromPublic(context), internalOptionsFromPublic(options)),
        options?.signal,
      );
    },
  };
}

function internalProviderFromExtension(
  provider: ExtensionProvider,
  registry: ExtensionModelRegistry,
): InternalProvider {
  let models = provider.getModels().map((model) => registry.resolve(model));
  const refreshModels = provider.refreshModels;
  const filterModels = provider.filterModels;
  return {
    id: provider.id,
    name: provider.name,
    ...optionalProperties(provider.baseUrl === undefined ? undefined : { baseUrl: provider.baseUrl }),
    ...optionalProperties(provider.headers === undefined ? undefined : { headers: provider.headers }),
    auth: internalAuthFromPublic(provider.auth),
    getModels: () => models,
    ...optionalProperties(refreshModels === undefined ? undefined : {
      async refreshModels(context: ProviderRefreshContext) {
        const credential = publicProviderCredential(context.credential);
        await refreshModels({
          ...optionalProperties(credential === undefined ? undefined : { credential }),
          store: {
            async read() {
              const stored = await context.store.read();
              return stored === undefined
                ? undefined
                : { ...stored, models: stored.models.map((model) => registry.present(model)) };
            },
            async write(entry) {
              await context.store.write({ ...entry, models: entry.models.map((model) => registry.resolve(model)) });
            },
            delete: () => context.store.delete(),
          },
          allowNetwork: context.allowNetwork,
          ...optionalProperties(context.force === undefined ? undefined : { force: context.force }),
          ...optionalProperties(context.signal === undefined ? undefined : { signal: context.signal }),
        });
        models = provider.getModels().map((model) => registry.resolve(model));
      },
    }),
    ...optionalProperties(filterModels === undefined ? undefined : {
      filterModels(entries, credential) {
        const selected = filterModels(
          entries.map((model) => registry.present(model)),
          publicProviderCredential(credential),
        );
        return selected.map((model) => registry.resolve(model));
      },
    }),
    stream(model, context, options = {}) {
      const publicModel = registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })();
      return adapterEventsFromPublicStream(provider.stream(publicModel, publicContextFromInternal(context, publicModel), publicOptionsFromInternal(options)), model.api);
    },
    streamSimple(model, context, options = {}) {
      const publicModel = registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })();
      return adapterEventsFromPublicStream(provider.streamSimple(publicModel, publicContextFromInternal(context, publicModel), publicOptionsFromInternal(options)), model.api);
    },
  };
}

function internalProviderConfigFromExtension(
  providerName: string,
  config: ExtensionProviderConfig,
  registry: ExtensionModelRegistry,
): InternalProviderConfig {
  const streamSimple = config.streamSimple;
  const oauth = config.oauth;
  const refreshModels = config.refreshModels;
  let internalOAuth: InternalProviderConfig["oauth"];
  if (oauth !== undefined) {
    const modifyModels = oauth.modifyModels;
    internalOAuth = {
      name: oauth.name,
      ...optionalProperties(oauth.isSubscription === undefined ? undefined : { isSubscription: oauth.isSubscription }),
      async login(input) {
        return await oauth.login({
          ...optionalProperties(input.signal === undefined ? undefined : { signal: input.signal }),
          onAuth: input.onAuth,
          onDeviceCode: input.onDeviceCode,
          onPrompt: input.onPrompt,
          onProgress: input.onProgress,
          onManualCodeInput: input.onManualCodeInput,
          async onSelect(prompt) { return await input.onSelect(prompt); },
        });
      },
      refreshToken: (credential, signal) => oauth.refreshToken(credential, signal),
      getApiKey: (credential) => oauth.getApiKey(credential),
      ...optionalProperties(modifyModels === undefined ? undefined : {
        modifyModels(models, credential) {
          return modifyModels(
            models.map((model) => registry.find(model.provider, model.id)
              ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })()),
            credential,
          ).map((model) => registry.resolve(model));
        },
      }),
    };
  }
  return {
    ...optionalProperties(config.name === undefined ? undefined : { name: config.name }),
    ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
    ...optionalProperties(config.apiKey === undefined ? undefined : { apiKey: config.apiKey }),
    ...optionalProperties(config.api === undefined ? undefined : { api: protocolFromPublicApi(config.api) }),
    ...optionalProperties(config.headers === undefined ? undefined : { headers: { ...config.headers } }),
    ...optionalProperties(config.authHeader === undefined ? undefined : { authHeader: config.authHeader }),
    ...optionalProperties(config.models === undefined ? undefined : { models: config.models.map(internalProviderConfigModel) }),
    ...optionalProperties(streamSimple === undefined ? undefined : {
      streamSimple(model, context, options = {}) {
        const publicModel = registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })();
        return adapterEventsFromPublicStream(streamSimple(publicModel, publicContextFromInternal(context, publicModel), publicOptionsFromInternal(options)), model.api);
      },
    }),
    ...optionalProperties(internalOAuth === undefined ? undefined : { oauth: internalOAuth }),
    ...optionalProperties(refreshModels === undefined ? undefined : {
      async refreshModels(context: ProviderRefreshContext) {
        const credential = publicProviderCredential(context.credential);
        const models = await refreshModels({
          ...optionalProperties(credential === undefined ? undefined : { credential }),
          store: {
            async read() {
              const stored = await context.store.read();
              return stored === undefined ? undefined : {
                ...stored,
                models: stored.models.map((model) => {
                  const exposed = registry.present(model);
                  const selected = config.api === undefined || model.api !== "extension-stream"
                    ? exposed
                    : { ...exposed, api: config.api };
                  registry.resolve(selected);
                  return selected;
                }),
              };
            },
            async write(entry) {
              await context.store.write({ ...entry, models: entry.models.map((model) => registry.resolve(model)) });
            },
            delete: () => context.store.delete(),
          },
          allowNetwork: context.allowNetwork,
          ...optionalProperties(context.force === undefined ? undefined : { force: context.force }),
          ...optionalProperties(context.signal === undefined ? undefined : { signal: context.signal }),
        });
        rememberConfigModels(registry, providerName, config, models);
        return models.map(internalProviderConfigModel);
      },
    }),
  };
}

export type ExtensionThinkingLevel = ThinkingLevel;
