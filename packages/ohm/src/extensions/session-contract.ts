import { isDeepStrictEqual } from "node:util";

import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@ohm/kernel";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createId } from "../core/ids.js";
import { isJsonObject, isJsonValue } from "../core/json.js";
import { optionalProperties } from "../core/optional-properties.js";
import { canonicalAssistantDiagnostics } from "../core/assistant-diagnostics.js";
import {
  canonicalAssistantContent as canonicalPublicAssistantContent,
  publicAssistantContent,
} from "../core/public-assistant-content.js";
import { isNormalizedUsage } from "../core/usage.js";
import type {
  CanonicalMessage,
  ImageBlock,
  ModelProtocolFamily,
  NormalizedUsage,
  ProviderState,
  TextBlock,
  ToolResultBlock,
} from "../core/types.js";
import type {
  ActiveBranchUsage,
  SessionEntryProjectionMetadata,
  SessionManager,
} from "../storage/session-manager.js";
import type {
  BranchSummaryEntry as CanonicalBranchSummaryEntry,
  CompactionEntry as CanonicalCompactionEntry,
  CustomEntry,
  CustomMessageEntry as CanonicalCustomMessageEntry,
  LabelEntry,
  ModelChangeEntry as CanonicalModelChangeEntry,
  PersistedSessionMessage as CanonicalPersistedSessionMessage,
  SessionBranchQuery,
  SessionEntry as CanonicalSessionEntry,
  SessionHeader,
  SessionInfoEntry,
  ThinkingLevelChangeEntry,
} from "../storage/types.js";
import {
  selectSessionBranchEntries,
  validateSessionBranchQuery,
} from "../storage/session-branch-query.js";
import { protocolFromPublicApi, publicApiFromProtocol } from "./model-boundary.js";

export type {
  CustomEntry,
  ExtensionSessionProvenance,
  LabelEntry,
  SessionHeader,
  SessionInfoEntry,
  SessionBranchQuery,
  ThinkingLevelChangeEntry,
} from "../storage/types.js";
export { REASONING_MEDIA_TYPE } from "../core/public-assistant-content.js";

const CANONICAL_APIS: ReadonlySet<ModelProtocolFamily> = new Set([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
  "gemini-interactions",
  "bedrock-converse",
  "ollama-chat",
  "extension-stream",
]);

const BOUNDARY_RECORD_VALUE = Type.Object({
  arguments: Type.Optional(Type.Unknown()),
  cacheRead: Type.Optional(Type.Unknown()),
  cacheWrite: Type.Optional(Type.Unknown()),
  id: Type.Optional(Type.Unknown()),
  index: Type.Optional(Type.Unknown()),
  input: Type.Optional(Type.Unknown()),
  jsonFragment: Type.Optional(Type.Unknown()),
  name: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.Unknown()),
  part: Type.Optional(Type.Unknown()),
  reasoning: Type.Optional(Type.Unknown()),
  redacted: Type.Optional(Type.Unknown()),
  text: Type.Optional(Type.Unknown()),
  textSignature: Type.Optional(Type.Unknown()),
  thinkingSignature: Type.Optional(Type.Unknown()),
  thoughtSignature: Type.Optional(Type.Unknown()),
  total: Type.Optional(Type.Unknown()),
  totalTokens: Type.Optional(Type.Unknown()),
  type: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });
const BOOLEAN_VALUE = Type.Boolean();
const FINITE_NUMBER_VALUE = Type.Number();
const IMAGE_CONTENT_VALUE = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
}, { additionalProperties: true });
const NON_NEGATIVE_SAFE_INTEGER_VALUE = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const STRING_ARRAY_VALUE = Type.Array(Type.String());
const STRING_VALUE = Type.String();
const PROJECTION_CACHE_MANAGER_VALUE = Type.Object({
  getSessionId: Type.Function([], Type.String()),
  getSessionFile: Type.Function([], Type.Union([Type.String(), Type.Undefined()])),
  getTreeRevision: Type.Function([], Type.Number()),
  getEntryCount: Type.Function([], Type.Number()),
}, { additionalProperties: true });
const PROJECTION_INDEX_MANAGER_VALUE = Type.Intersect([
  PROJECTION_CACHE_MANAGER_VALUE,
  Type.Object({
    getEntryProjectionMetadataPage: Type.Function(
      [Type.Number(), Type.Number()],
      Type.Array(Type.Unknown()),
    ),
  }, { additionalProperties: true }),
]);
const PAGED_SESSION_MANAGER_VALUE = Type.Object({
  getEntriesPage: Type.Function([Type.Number(), Type.Number()], Type.Array(Type.Unknown())),
}, { additionalProperties: true });

type CanonicalMessageWithProviderState = CanonicalMessage & { providerState?: ProviderState };

export interface SessionEntryPage {
  entries: SessionEntry[];
  totalEntries: number;
}

function supportsProjectionCache<T>(value: T): boolean {
  return Value.Check(PROJECTION_CACHE_MANAGER_VALUE, value);
}

function supportsProjectionIndex<T>(value: T): boolean {
  return Value.Check(PROJECTION_INDEX_MANAGER_VALUE, value);
}

function supportsPagedEntries<T>(value: T): boolean {
  return Value.Check(PAGED_SESSION_MANAGER_VALUE, value);
}

export interface SessionEntryBase {
  timestamp: string;
  parentId: string | null;
  id: string;
  type: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  message: AgentMessage;
  type: "message";
}

export type ModelChangeEntry = CanonicalModelChangeEntry;
export type CompactionEntry<T = unknown> = Omit<CanonicalCompactionEntry<T>, "usage"> & { usage?: Usage };
export type BranchSummaryEntry<T = unknown> = Omit<CanonicalBranchSummaryEntry<T>, "usage"> & { usage?: Usage };
export type CustomMessageEntry<T = unknown> = Omit<CanonicalCustomMessageEntry<T>, "content"> & {
  content: string | Array<TextContent | ImageContent>;
};

type SessionConversationEntry =
  | SessionMessageEntry
  | CustomMessageEntry;
type SessionSelectionEntry =
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CustomEntry
  | LabelEntry
  | SessionInfoEntry;
type SessionSummaryEntry = CompactionEntry | BranchSummaryEntry;

export type SessionEntry = SessionConversationEntry | SessionSelectionEntry | SessionSummaryEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  labelTimestamp?: string;
  label?: string;
  children: SessionTreeNode[];
  entry: SessionEntry;
}

export interface SessionContext {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  messages: AgentMessage[];
}

export type PersistedSessionMessage = AgentMessage;

export interface ReadonlyExtensionSessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getLabel(id: string): string | undefined;
  getBranch(fromId?: string): SessionEntry[];
  findEntriesOnBranch(query?: SessionBranchQuery): SessionEntry[];
  findEntryOnBranch(query?: SessionBranchQuery): SessionEntry | undefined;
  buildContextEntries(): SessionEntry[];
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
  getEntriesPage(offset: number, limit: number): SessionEntryPage;
  getTree(): SessionTreeNode[];
  getSessionName(): string | undefined;
}

export interface ExtensionSessionManager extends ReadonlyExtensionSessionManager {
  setSessionFile(path: string): void;
  newSession(options?: { id?: string; parentSession?: string }): string | undefined;
  isPersisted(): boolean;
  usesDefaultSessionDir(): boolean;
  appendMessage(message: AgentMessage): string;
  appendThinkingLevelChange(thinkingLevel: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string;
  appendCustomEntry<T = unknown>(customType: string, data?: T): string;
  appendSessionInfo(name: string): string;
  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: T,
  ): string;
  getChildren(parentId: string): SessionEntry[];
  appendLabelChange(targetId: string, label: string | undefined): string;
  buildSessionContext(): SessionContext;
  branch(branchFromId: string): void;
  resetLeaf(): void;
  branchWithSummary<T = unknown>(
    branchFromId: string | null,
    summary: string,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string;
  createBranchedSession(leafId: string): string | undefined;
}

function record<T>(value: T) {
  return Value.Check(BOUNDARY_RECORD_VALUE, value) ? value : undefined;
}

function finiteNonNegative<T>(value: T, label: string): number {
  if (!Value.Check(FINITE_NUMBER_VALUE, value) || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function token<T>(value: T, label: string): number {
  if (!Value.Check(NON_NEGATIVE_SAFE_INTEGER_VALUE, value)) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function timestamp<T>(value: T, label: string): number {
  if (!Value.Check(FINITE_NUMBER_VALUE, value) || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function nonEmpty<T>(value: T, label: string): string {
  if (!Value.Check(STRING_VALUE, value) || value.trim() === "" || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function publicTimestamp(value: string): number {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function canonicalTimestamp(value: number): string {
  const milliseconds = timestamp(value, "Message timestamp");
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new TypeError("Message timestamp is outside the supported range");
  return date.toISOString();
}

export function extensionUsage(value: NormalizedUsage | undefined): Usage {
  return {
    ...optionalProperties(value?.inputTokens === undefined ? undefined : { input: value.inputTokens }),
    ...optionalProperties(value?.outputTokens === undefined ? undefined : { output: value.outputTokens }),
    ...optionalProperties(value?.cacheReadTokens === undefined ? undefined : { cacheRead: value.cacheReadTokens }),
    ...optionalProperties(value?.cacheWriteTokens === undefined ? undefined : { cacheWrite: value.cacheWriteTokens }),
    ...optionalProperties(value?.cacheWrite1hTokens === undefined ? undefined : { cacheWrite1h: value.cacheWrite1hTokens }),
    ...optionalProperties(value?.reasoningTokens === undefined ? undefined : { reasoning: value.reasoningTokens }),
    ...optionalProperties(value?.totalTokens === undefined ? undefined : { totalTokens: value.totalTokens }),
    ...optionalProperties(value?.cost === undefined ? undefined : { cost: { ...value.cost } }),
  };
}

export function canonicalUsage(value: Usage): NormalizedUsage {
  const input = value.input === undefined ? undefined : token(value.input, "Usage input");
  const output = value.output === undefined ? undefined : token(value.output, "Usage output");
  const cacheRead = value.cacheRead === undefined ? undefined : token(value.cacheRead, "Usage cacheRead");
  const cacheWrite = value.cacheWrite === undefined ? undefined : token(value.cacheWrite, "Usage cacheWrite");
  const totalTokens = value.totalTokens === undefined ? undefined : token(value.totalTokens, "Usage totalTokens");
  const components = [input, output, cacheRead, cacheWrite];
  if (
    totalTokens !== undefined && components.every((component) => component !== undefined) &&
    totalTokens !== components.reduce<number>((sum, component) => sum + component!, 0)
  ) {
    throw new TypeError("Usage totalTokens must equal input + output + cacheRead + cacheWrite");
  }
  const result: NormalizedUsage = {
    ...optionalProperties(input === undefined ? undefined : { inputTokens: input }),
    ...optionalProperties(output === undefined ? undefined : { outputTokens: output }),
    ...optionalProperties(cacheRead === undefined ? undefined : { cacheReadTokens: cacheRead }),
    ...optionalProperties(cacheWrite === undefined ? undefined : { cacheWriteTokens: cacheWrite }),
    ...optionalProperties(totalTokens === undefined ? undefined : { totalTokens }),
  };
  if (value.cost !== undefined) {
    const costValue = record(value.cost);
    if (costValue === undefined) throw new TypeError("Usage cost must be an object");
    const inputCost = finiteNonNegative(costValue.input, "Usage input cost");
    const outputCost = finiteNonNegative(costValue.output, "Usage output cost");
    const cacheReadCost = finiteNonNegative(costValue.cacheRead, "Usage cacheRead cost");
    const cacheWriteCost = finiteNonNegative(costValue.cacheWrite, "Usage cacheWrite cost");
    const totalCost = finiteNonNegative(costValue.total, "Usage total cost");
    const expectedCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    if (Math.abs(totalCost - expectedCost) > Math.max(1e-12, Math.abs(totalCost) * 1e-9)) {
      throw new TypeError("Usage total cost must equal its component costs");
    }
    result.cost = { input: inputCost, output: outputCost, cacheRead: cacheReadCost, cacheWrite: cacheWriteCost, total: expectedCost };
  }
  if (value.cacheWrite1h !== undefined) {
    if (cacheWrite === undefined) throw new TypeError("Usage cacheWrite1h requires cacheWrite");
    const cacheWrite1h = token(value.cacheWrite1h, "Usage cacheWrite1h");
    if (cacheWrite1h > cacheWrite) throw new TypeError("Usage cacheWrite1h must not exceed cacheWrite");
    result.cacheWrite1hTokens = cacheWrite1h;
  }
  if (value.reasoning !== undefined) result.reasoningTokens = token(value.reasoning, "Usage reasoning");
  if (!isNormalizedUsage(result)) throw new TypeError("Usage is internally inconsistent");
  return result;
}

export function extensionImage(value: ImageBlock): ImageContent {
  if (value.data === undefined) {
    throw new TypeError("Extension-visible images must contain base64 data; URL-only images cannot cross this boundary");
  }
  return { type: "image", data: value.data, mimeType: value.mediaType };
}

export function canonicalImage(value: ImageContent): ImageBlock {
  if (!Value.Check(IMAGE_CONTENT_VALUE, value)) {
    throw new TypeError("Image content must be an image block");
  }
  return { type: "image", mediaType: nonEmpty(value.mimeType, "Image MIME type"), data: value.data };
}

export function extensionInputContent(
  value: string | readonly (TextBlock | ImageBlock)[],
): string | Array<TextContent | ImageContent> {
  if (Value.Check(STRING_VALUE, value)) return value;
  return value.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : extensionImage(block));
}

export function extensionContent(
  value: readonly (TextBlock | ImageBlock)[],
): Array<TextContent | ImageContent> {
  const converted = extensionInputContent(value);
  return Value.Check(STRING_VALUE, converted) ? [{ type: "text", text: converted }] : converted;
}

export function canonicalInputContent(
  value: string | readonly (TextContent | ImageContent)[],
): string | Array<TextBlock | ImageBlock> {
  if (Value.Check(STRING_VALUE, value)) return value;
  if (!Array.isArray(value)) throw new TypeError("Message content must be a string or content array");
  return value.map((block) => {
    if (block.type === "text") {
      if (!Value.Check(STRING_VALUE, block.text)) throw new TypeError("Text content must contain text");
      return { type: "text", text: block.text };
    }
    return canonicalImage(block);
  });
}

export function canonicalContent(
  value: readonly (TextContent | ImageContent)[],
): Array<TextBlock | ImageBlock> {
  const converted = canonicalInputContent(value);
  if (Value.Check(STRING_VALUE, converted)) throw new TypeError("Content must be an array");
  return converted;
}

function extensionAssistantContent(message: CanonicalMessage): AssistantMessage["content"] {
  return publicAssistantContent(message.content);
}

function extensionAssistantKernelStreamContent(message: CanonicalMessage): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({
        type: "text",
        text: block.text,
        ...optionalProperties(block.textSignature === undefined ? undefined : { textSignature: block.textSignature }),
      });
      continue;
    }
    if (block.type === "thinking") {
      if (block.visibility === "provider_trace") continue;
      content.push({
        type: "thinking",
        thinking: block.thinking,
        ...optionalProperties(block.thinkingSignature === undefined ? undefined : { thinkingSignature: block.thinkingSignature }),
        ...optionalProperties(block.redacted === undefined ? undefined : { redacted: block.redacted }),
      });
      continue;
    }
    if (block.type === "tool_call") {
      if (!isJsonObject(block.arguments)) {
        throw new TypeError("Kernel-certified assistant tool-call arguments must be a JSON object");
      }
      content.push({
        type: "toolCall",
        id: block.callId,
        name: block.name,
        arguments: structuredClone(block.arguments),
        ...optionalProperties(block.thoughtSignature === undefined ? undefined : { thoughtSignature: block.thoughtSignature }),
      });
      continue;
    }
    throw new TypeError("Kernel-certified assistant stream content contains unsupported blocks");
  }
  return content;
}

function extensionStopReason(reason: CanonicalMessage["stopReason"]): AssistantMessage["stopReason"] {
  if (reason === "length" || reason === "stop" || reason === "error" || reason === "aborted") return reason;
  if (reason === "tool_calls") return "toolUse";
  if (reason === "cancelled") return "aborted";
  if (reason === undefined) return "stop";
  return reason === "context_limit" ? "length" : "error";
}

function extensionApi(message: CanonicalMessage): string {
  return message.publicApi ?? (message.api === undefined ? "extension-stream" : publicApiFromProtocol(message.api));
}

function extensionProviderState(message: CanonicalMessageWithProviderState): AssistantMessage["providerState"] {
  if (message.providerState === undefined) return undefined;
  return {
    source: {
      api: extensionApi(message),
      provider: message.provider ?? "ohm",
      model: message.model ?? "unknown",
    },
    value: structuredClone(message.providerState),
  };
}

function extensionUserMessage(message: CanonicalMessage): UserMessage {
  const content: Array<TextContent | ImageContent> = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "image") content.push(extensionImage(block));
  }
  return { role: "user", content, timestamp: publicTimestamp(message.createdAt) };
}

function extensionAssistantMessageWithContent(
  message: CanonicalMessageWithProviderState,
  content: AssistantMessage["content"],
): AssistantMessage {
  const providerState = extensionProviderState(message);
  const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
  return {
    role: "assistant",
    content,
    api: extensionApi(message),
    provider: message.provider ?? "ohm",
    model: message.model ?? "unknown",
    ...optionalProperties(message.responseModel === undefined ? undefined : { responseModel: message.responseModel }),
    ...optionalProperties(message.responseId === undefined ? undefined : { responseId: message.responseId }),
    ...optionalProperties(diagnostics === undefined ? undefined : { diagnostics }),
    usage: extensionUsage(message.usage),
    stopReason: extensionStopReason(message.stopReason),
    ...optionalProperties(message.errorMessage === undefined ? undefined : { errorMessage: message.errorMessage }),
    ...optionalProperties(providerState === undefined ? undefined : { providerState }),
    timestamp: publicTimestamp(message.createdAt),
  };
}

function extensionAssistantMessage(message: CanonicalMessageWithProviderState): AssistantMessage {
  return extensionAssistantMessageWithContent(message, extensionAssistantContent(message));
}

/** Project an assistant snapshot already bounded and detached by the active kernel stream. */
export function extensionAssistantKernelStreamMessage(
  message: CanonicalMessageWithProviderState,
): AssistantMessage {
  return {
    ...extensionAssistantMessageWithContent(message, extensionAssistantKernelStreamContent(message)),
    stopReason: "pending",
  };
}

function toolResultContent(block: ToolResultBlock): Array<TextContent | ImageContent> {
  const stored = block.contentBlocks;
  if (stored !== undefined) return stored.map((item) => item.type === "text"
    ? { type: "text", text: item.text }
    : extensionImage(item));
  return [
    { type: "text", text: block.content },
    ...(block.images ?? []).map(extensionImage),
  ];
}

export function extensionToolResult(
  message: CanonicalMessage,
  block: ToolResultBlock,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: block.callId,
    toolName: block.name,
    content: toolResultContent(block),
    ...optionalProperties(block.metadata === undefined ? undefined : { details: structuredClone(block.metadata) }),
    ...optionalProperties(block.addedToolNames === undefined ? undefined : { addedToolNames: [...block.addedToolNames] }),
    ...optionalProperties(message.usage === undefined ? undefined : { usage: extensionUsage(message.usage) }),
    isError: block.isError,
    timestamp: publicTimestamp(message.createdAt),
  };
}

export function extensionToolResultBlock(
  block: ToolResultBlock,
  options: { timestamp?: number; usage?: NormalizedUsage } = {},
): ToolResultMessage {
  const timestampValue = options.timestamp ?? Date.now();
  return extensionToolResult({
    id: createId("msg"),
    role: "tool",
    content: [block],
    createdAt: canonicalTimestamp(timestampValue),
    ...optionalProperties(options.usage === undefined ? undefined : { usage: options.usage }),
  }, block);
}

function extensionCustomMessage(message: CanonicalMessage): CustomMessage {
  const custom = message.custom;
  if (custom === undefined) throw new TypeError("Canonical custom message metadata is missing");
  return {
    role: "custom",
    customType: custom.customType,
    content: extensionInputContent(message.content.filter(
      (block): block is TextBlock | ImageBlock => block.type === "text" || block.type === "image",
    )),
    display: custom.display,
    ...optionalProperties(custom.details === undefined ? undefined : { details: structuredClone(custom.details) }),
    timestamp: custom.timestamp,
  };
}

export function extensionMessages(message: CanonicalPersistedSessionMessage): AgentMessage[] {
  if (message.role === "bashExecution") {
    const value: BashExecutionMessage = { ...message };
    return [value];
  }
  if (message.role === "custom") {
    return [{
      ...message,
      content: extensionInputContent(message.content),
    }];
  }
  if (message.custom !== undefined) return [extensionCustomMessage(message)];
  if (message.role === "assistant") return [extensionAssistantMessage(message)];
  if (message.role === "tool") {
    return message.content
      .filter((block): block is ToolResultBlock => block.type === "tool_result")
      .map((block) => extensionToolResult(message, block));
  }
  return [extensionUserMessage(message)];
}

export function extensionMessage(message: CanonicalMessage): AgentMessage {
  const converted = extensionMessages(message);
  if (converted.length !== 1) {
    throw new TypeError("A canonical tool batch must be projected through the session-entry boundary");
  }
  return converted[0]!;
}

export function extensionAssistantEvent<T>(
  event: T,
  message: CanonicalMessage,
): AssistantMessageEvent {
  return extensionAssistantEventFromMessage(event, extensionAssistantMessage(message));
}

/** Attach one already-projected assistant snapshot to its public stream event. */
export function extensionAssistantEventFromMessage<T>(
  event: T,
  assistant: AssistantMessage,
): AssistantMessageEvent {
  const value = record(event);
  if (value === undefined || !Value.Check(STRING_VALUE, value.type)) {
    return { type: "start", partial: assistant };
  }
  const index = Value.Check(NON_NEGATIVE_SAFE_INTEGER_VALUE, value.part)
    ? value.part
    : Value.Check(NON_NEGATIVE_SAFE_INTEGER_VALUE, value.index)
      ? value.index
      : 0;
  if (value.type === "text_started") {
    return { type: "text_start", contentIndex: index, partial: assistant };
  }
  if (value.type === "text_delta" && Value.Check(STRING_VALUE, value.text)) {
    return { type: "text_delta", contentIndex: index, delta: value.text, partial: assistant };
  }
  if (value.type === "text_completed" && Value.Check(STRING_VALUE, value.text)) {
    return {
      type: "text_end",
      contentIndex: index,
      content: value.text,
      ...optionalProperties(Value.Check(STRING_VALUE, value.textSignature) ? { contentSignature: value.textSignature } : undefined),
      partial: assistant,
    };
  }
  if (value.type === "reasoning_started") {
    return { type: "thinking_start", contentIndex: index, partial: assistant };
  }
  if (value.type === "reasoning_delta" && Value.Check(STRING_VALUE, value.text)) {
    return { type: "thinking_delta", contentIndex: index, delta: value.text, partial: assistant };
  }
  if (value.type === "reasoning_completed" && Value.Check(STRING_VALUE, value.text)) {
    return {
      type: "thinking_end",
      contentIndex: index,
      content: value.text,
      ...optionalProperties(Value.Check(STRING_VALUE, value.thinkingSignature) ? { contentSignature: value.thinkingSignature } : undefined),
      ...optionalProperties(Value.Check(BOOLEAN_VALUE, value.redacted) ? { redacted: value.redacted } : undefined),
      partial: assistant,
    };
  }
  if (value.type === "tool_call_started") {
    return { type: "toolcall_start", contentIndex: index, partial: assistant };
  }
  if (value.type === "tool_call_delta" && Value.Check(STRING_VALUE, value.jsonFragment)) {
    return { type: "toolcall_delta", contentIndex: index, delta: value.jsonFragment, partial: assistant };
  }
  if (value.type === "tool_call_completed" && Value.Check(STRING_VALUE, value.name)) {
    const argumentsValue = isJsonObject(value.arguments) ? structuredClone(value.arguments) : {};
    return {
      type: "toolcall_end",
      contentIndex: index,
      toolCall: {
        type: "toolCall",
        id: Value.Check(STRING_VALUE, value.id) ? value.id : `call_${index}`,
        name: value.name,
        arguments: argumentsValue,
        ...optionalProperties(Value.Check(STRING_VALUE, value.thoughtSignature) ? { thoughtSignature: value.thoughtSignature } : undefined),
      },
      partial: assistant,
    };
  }
  return { type: "start", partial: assistant };
}

function canonicalApi(value: string, previous: CanonicalMessage | undefined): ModelProtocolFamily {
  if (previous !== undefined && extensionApi(previous) === value && previous.api !== undefined) return previous.api;
  const protocol = protocolFromPublicApi(value);
  if (!CANONICAL_APIS.has(protocol)) throw new TypeError(`Assistant API ${value} has no canonical provider protocol`);
  return protocol;
}

function canonicalStopReason(
  value: AssistantMessage["stopReason"],
  previous: CanonicalMessage | undefined,
): NonNullable<CanonicalMessage["stopReason"]> {
  if (previous?.stopReason !== undefined && extensionStopReason(previous.stopReason) === value) return previous.stopReason;
  if (value === "pending") return "incomplete";
  if (value === "toolUse") return "tool_calls";
  return value;
}

function canonicalProviderState(
  value: AssistantMessage,
  previous: CanonicalMessageWithProviderState | undefined,
): ProviderState | undefined {
  if (value.providerState === undefined) return undefined;
  if (previous === undefined) throw new TypeError("Provider continuation state cannot be introduced by an extension");
  const exposed = extensionProviderState(previous);
  if (exposed === undefined || !isDeepStrictEqual(exposed, value.providerState)) {
    throw new TypeError("Provider continuation state is host-owned and cannot be changed by an extension");
  }
  return previous.providerState;
}

function canonicalResponseMetadata(
  value: AssistantMessage,
  previous: CanonicalMessage | undefined,
): Pick<CanonicalMessage, "responseModel" | "responseId" | "diagnostics"> {
  if (previous === undefined) {
    if (value.responseModel !== undefined || value.responseId !== undefined || value.diagnostics !== undefined) {
      throw new TypeError("Provider response metadata cannot be introduced by an extension");
    }
    return {};
  }

  const diagnostics = canonicalAssistantDiagnostics(previous.diagnostics);
  if (value.responseModel !== undefined && value.responseModel !== previous.responseModel) {
    throw new TypeError("Provider response metadata is host-owned and cannot be changed by an extension");
  }
  if (value.responseId !== undefined && value.responseId !== previous.responseId) {
    throw new TypeError("Provider response metadata is host-owned and cannot be changed by an extension");
  }
  if (value.diagnostics !== undefined) {
    const selected = canonicalAssistantDiagnostics(value.diagnostics);
    if (!isDeepStrictEqual(selected, diagnostics)) {
      throw new TypeError("Provider response metadata is host-owned and cannot be changed by an extension");
    }
  }
  return {
    ...optionalProperties(previous.responseModel === undefined ? undefined : { responseModel: previous.responseModel }),
    ...optionalProperties(previous.responseId === undefined ? undefined : { responseId: previous.responseId }),
    ...optionalProperties(diagnostics === undefined ? undefined : { diagnostics }),
  };
}

function canonicalUserMessage(value: UserMessage, previous?: CanonicalMessage): CanonicalMessage {
  const selected = canonicalInputContent(value.content ?? []);
  const content: CanonicalMessage["content"] = Value.Check(STRING_VALUE, selected)
    ? [{ type: "text", text: selected }]
    : selected;
  return {
    id: previous?.id ?? createId("msg"),
    role: "user",
    content,
    createdAt: previous?.createdAt ?? canonicalTimestamp(value.timestamp),
    ...optionalProperties(previous?.displayText === undefined ? undefined : { displayText: previous.displayText }),
    ...optionalProperties(previous?.purpose === undefined ? undefined : { purpose: previous.purpose }),
  };
}

function canonicalAssistantMessage(value: AssistantMessage, previous?: CanonicalMessage): CanonicalMessage & { providerState?: ProviderState } {
  const api = canonicalApi(nonEmpty(value.api, "Assistant API"), previous);
  const publicApi = publicApiFromProtocol(api) === value.api ? undefined : value.api;
  const providerState = canonicalProviderState(value, previous);
  const responseMetadata = canonicalResponseMetadata(value, previous);
  return {
    id: previous?.id ?? createId("msg"),
    role: "assistant",
    content: canonicalPublicAssistantContent(value.content ?? []),
    createdAt: previous?.createdAt ?? canonicalTimestamp(value.timestamp),
    provider: nonEmpty(value.provider, "Assistant provider"),
    model: nonEmpty(value.model, "Assistant model"),
    api,
    ...optionalProperties(publicApi === undefined ? undefined : { publicApi }),
    ...responseMetadata,
    usage: canonicalUsage(value.usage),
    stopReason: canonicalStopReason(value.stopReason, previous),
    ...optionalProperties(value.errorMessage === undefined ? undefined : { errorMessage: value.errorMessage }),
    ...optionalProperties(providerState === undefined ? undefined : { providerState }),
    ...optionalProperties(previous?.displayText === undefined ? undefined : { displayText: previous.displayText }),
    ...optionalProperties(previous?.retryTransient === undefined ? undefined : { retryTransient: previous.retryTransient }),
  };
}

function canonicalToolResultMessage(value: ToolResultMessage, previous?: CanonicalMessage): CanonicalMessage {
  const content = canonicalInputContent(value.content ?? []);
  if (Value.Check(STRING_VALUE, content)) throw new TypeError("Tool result content must be an array");
  if (value.details !== undefined && !isJsonValue(value.details)) {
    throw new TypeError("Tool result details must be JSON-safe for session persistence");
  }
  if (value.addedToolNames !== undefined && (
    !Value.Check(STRING_ARRAY_VALUE, value.addedToolNames)
    || value.addedToolNames.some((name) => name.trim() === "")
  )) throw new TypeError("Tool result addedToolNames must contain non-empty strings");
  const texts = content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text);
  const images = content.filter((block): block is ImageBlock => block.type === "image");
  const block: ToolResultBlock = {
    type: "tool_result",
    callId: nonEmpty(value.toolCallId, "Tool-call id"),
    name: nonEmpty(value.toolName, "Tool name"),
    content: texts.join(""),
    contentBlocks: content,
    isError: value.isError,
    ...optionalProperties(value.details === undefined ? undefined : { metadata: structuredClone(value.details) }),
    ...optionalProperties(value.addedToolNames === undefined ? undefined : { addedToolNames: [...value.addedToolNames] }),
    ...optionalProperties(images.length === 0 ? undefined : { images }),
  };
  return {
    id: previous?.id ?? createId("msg"),
    role: "tool",
    content: [block],
    createdAt: previous?.createdAt ?? canonicalTimestamp(value.timestamp),
    ...optionalProperties(value.usage === undefined ? undefined : { usage: canonicalUsage(value.usage) }),
  };
}

function canonicalBashMessage(value: BashExecutionMessage): CanonicalPersistedSessionMessage {
  return {
    role: "bashExecution",
    command: value.command,
    output: value.output,
    exitCode: value.exitCode,
    ...optionalProperties(value.isError === undefined ? undefined : { isError: value.isError }),
    cancelled: value.cancelled,
    ...optionalProperties(value.timedOut === undefined ? undefined : { timedOut: value.timedOut }),
    ...optionalProperties(value.signal === undefined ? undefined : { signal: value.signal }),
    truncated: value.truncated,
    ...optionalProperties(value.fullOutputPath === undefined ? undefined : { fullOutputPath: value.fullOutputPath }),
    timestamp: timestamp(value.timestamp, "Bash message timestamp"),
    ...optionalProperties(value.excludeFromContext === undefined ? undefined : { excludeFromContext: value.excludeFromContext }),
  };
}

function canonicalCustom(value: CustomMessage): CanonicalPersistedSessionMessage {
  if (value.details !== undefined && !isJsonValue(value.details)) {
    throw new TypeError("Custom message details must be JSON-safe for session persistence");
  }
  return {
    role: "custom",
    customType: nonEmpty(value.customType, "Custom message type"),
    content: canonicalInputContent(value.content ?? []),
    display: value.display,
    ...optionalProperties(value.details === undefined ? undefined : { details: structuredClone(value.details) }),
    timestamp: timestamp(value.timestamp, "Custom message timestamp"),
  };
}

export function canonicalMessage(value: AgentMessage, previous?: CanonicalMessage): CanonicalPersistedSessionMessage {
  if (value.role === "user") return canonicalUserMessage(value, previous);
  if (value.role === "assistant") return canonicalAssistantMessage(value, previous);
  if (value.role === "toolResult") return canonicalToolResultMessage(value, previous);
  if (value.role === "bashExecution") return canonicalBashMessage(value);
  if (value.role === "custom") return canonicalCustom(value);
  throw new TypeError(`Message role ${String(value.role)} cannot be written directly to a session message entry`);
}

export function extensionCanonicalMessages(messages: readonly CanonicalMessage[]): AgentMessage[] {
  return messages.flatMap((message) => extensionMessages(message));
}

export function canonicalAgentMessages(
  messages: readonly AgentMessage[],
  previous: readonly CanonicalMessage[] = [],
): CanonicalMessage[] {
  return messages.map((message, index) => {
    const converted = canonicalMessage(message, previous[index]);
    if (converted.role === "bashExecution" || converted.role === "custom") {
      throw new TypeError("Context replacements may contain only model conversation messages");
    }
    return converted;
  });
}

interface ProjectedEntry {
  publicEntry: SessionEntry;
  canonicalId: string;
}

interface SessionProjection {
  entries: ProjectedEntry[];
  byId: Map<string, ProjectedEntry>;
  canonicalIdByPublicId: Map<string, string>;
  tailByCanonicalId: Map<string, string>;
}

interface IndexedProjectedEntry {
  canonicalId: string;
  parentId: string | null;
  publicIds: string[];
  publicStart: number;
}

interface SessionProjectionIndex {
  entries: IndexedProjectedEntry[];
  canonicalIdByPublicId: Map<string, string>;
  tailByCanonicalId: Map<string, string>;
  used: Set<string>;
  totalEntries: number;
}

function projectedId(base: string, index: number, used: Set<string>): string {
  if (index === 0 && !used.has(base)) return base;
  let suffix = index;
  let candidate = `${base}~${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}~${suffix}`;
  }
  return candidate;
}

function emptySessionProjectionIndex(): SessionProjectionIndex {
  return {
    entries: [],
    canonicalIdByPublicId: new Map(),
    tailByCanonicalId: new Map(),
    used: new Set(),
    totalEntries: 0,
  };
}

function appendSessionProjectionIndex(
  index: SessionProjectionIndex,
  metadata: readonly SessionEntryProjectionMetadata[],
): void {
  for (const entry of metadata) {
    if (!Number.isSafeInteger(entry.projectedEntryCount) || entry.projectedEntryCount < 1) {
      throw new Error(`Session entry ${entry.id} has an invalid projected entry count`);
    }
    const parentId = entry.parentId === null
      ? null
      : index.tailByCanonicalId.get(entry.parentId) ?? entry.parentId;
    const publicIds: string[] = [];
    for (let row = 0; row < entry.projectedEntryCount; row += 1) {
      const id = projectedId(entry.id, row, index.used);
      index.used.add(id);
      index.canonicalIdByPublicId.set(id, entry.id);
      publicIds.push(id);
    }
    const tail = publicIds.at(-1)!;
    index.entries.push({
      canonicalId: entry.id,
      parentId,
      publicIds,
      publicStart: index.totalEntries,
    });
    index.tailByCanonicalId.set(entry.id, tail);
    index.totalEntries += publicIds.length;
  }
}

function projectionIndexFromSessionProjection(projection: SessionProjection): SessionProjectionIndex {
  const index = emptySessionProjectionIndex();
  for (const item of projection.entries) {
    let entry = index.entries.at(-1);
    if (entry?.canonicalId !== item.canonicalId) {
      entry = {
        canonicalId: item.canonicalId,
        parentId: item.publicEntry.parentId,
        publicIds: [],
        publicStart: index.totalEntries,
      };
      index.entries.push(entry);
    }
    entry.publicIds.push(item.publicEntry.id);
    index.used.add(item.publicEntry.id);
    index.canonicalIdByPublicId.set(item.publicEntry.id, item.canonicalId);
    index.tailByCanonicalId.set(item.canonicalId, item.publicEntry.id);
    index.totalEntries += 1;
  }
  return index;
}

function canonicalIndexAtPublicOffset(entries: readonly IndexedProjectedEntry[], offset: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle]!;
    if (entry.publicStart + entry.publicIds.length <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function projectMessageEntry(
  entry: Extract<CanonicalSessionEntry, { type: "message" }>,
  parentId: string | null,
  used: Set<string>,
): SessionMessageEntry[] {
  const messages = extensionMessages(entry.message);
  const result: SessionMessageEntry[] = [];
  let parent = parentId;
  for (const [index, message] of messages.entries()) {
    const id = projectedId(entry.id, index, used);
    used.add(id);
    result.push({ type: "message", id, parentId: parent, timestamp: entry.timestamp, message });
    parent = id;
  }
  if (result.length > 0) return result;
  const id = projectedId(entry.id, 0, used);
  used.add(id);
  return [{
    type: "message",
    id,
    parentId,
    timestamp: entry.timestamp,
    message: {
      role: "custom",
      customType: "empty-tool-batch",
      content: "",
      display: false,
      timestamp: publicTimestamp(entry.timestamp),
    },
  }];
}

function projectEntry(
  entry: CanonicalSessionEntry,
  parentId: string | null,
  used: Set<string>,
): SessionEntry[] {
  if (entry.type === "message") return projectMessageEntry(entry, parentId, used);
  const id = projectedId(entry.id, 0, used);
  used.add(id);
  if (entry.type === "model_change") {
    return [{
      type: "model_change",
      id,
      parentId,
      timestamp: entry.timestamp,
      provider: entry.provider,
      modelId: entry.modelId,
    }];
  }
  if (entry.type === "compaction") {
    const { usage, ...rest } = entry;
    return [{
      ...rest,
      id,
      parentId,
      ...optionalProperties(usage === undefined ? undefined : { usage: extensionUsage(usage) }),
    }];
  }
  if (entry.type === "branch_summary") {
    const { usage, ...rest } = entry;
    return [{
      ...rest,
      id,
      parentId,
      ...optionalProperties(usage === undefined ? undefined : { usage: extensionUsage(usage) }),
    }];
  }
  if (entry.type === "custom_message") {
    return [{ ...entry, id, parentId, content: extensionInputContent(entry.content) }];
  }
  return [{ ...entry, id, parentId }];
}

function projectSession(entries: readonly CanonicalSessionEntry[]): SessionProjection {
  const projected: ProjectedEntry[] = [];
  const byId = new Map<string, ProjectedEntry>();
  const canonicalIdByPublicId = new Map<string, string>();
  const tailByCanonicalId = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    const parentId = entry.parentId === null ? null : tailByCanonicalId.get(entry.parentId) ?? entry.parentId;
    const converted = projectEntry(entry, parentId, used);
    for (const publicEntry of converted) {
      const item = { publicEntry, canonicalId: entry.id };
      projected.push(item);
      byId.set(publicEntry.id, item);
      canonicalIdByPublicId.set(publicEntry.id, entry.id);
    }
    const tail = converted.at(-1);
    if (tail !== undefined) tailByCanonicalId.set(entry.id, tail.id);
  }
  return { entries: projected, byId, canonicalIdByPublicId, tailByCanonicalId };
}

export function extensionSessionEntries(entries: readonly CanonicalSessionEntry[]): SessionEntry[] {
  return projectSession(entries).entries.map((entry) => cloneEntry(entry.publicEntry));
}

export function extensionSessionEntry(entry: CanonicalSessionEntry): SessionEntry {
  const converted = extensionSessionEntries([entry]);
  if (converted.length !== 1) {
    throw new TypeError("A batched tool entry has more than one extension-visible session entry");
  }
  return converted[0]!;
}

/** @internal Resolve an extension-visible entry id to its canonical journal entry. */
export function canonicalSessionEntryId(manager: SessionManager, publicId: string): string | undefined {
  return projectSession(manager.getEntries()).byId.get(publicId)?.canonicalId;
}

function cloneEntry<T>(value: T): T {
  return structuredClone(value);
}

class ExtensionSessionManagerFacade implements ExtensionSessionManager {
  readonly #manager: SessionManager;
  #cachedProjection: { key: string; value: SessionProjection } | undefined;
  #cachedProjectionIndex: {
    entryCount: number;
    key: string;
    revision: number;
    value: SessionProjectionIndex;
  } | undefined;

  constructor(manager: SessionManager) {
    this.#manager = manager;
  }

  #projection(): SessionProjection {
    if (!supportsProjectionCache(this.#manager)) {
      return projectSession(this.#manager.getEntries());
    }
    const key = [
      this.#manager.getSessionId(),
      this.#manager.getSessionFile() ?? "",
      this.#manager.getTreeRevision(),
      this.#manager.getEntryCount(),
    ].join("\0");
    if (this.#cachedProjection?.key === key) return this.#cachedProjection.value;
    const value = projectSession(this.#manager.getEntries());
    this.#cachedProjection = { key, value };
    return value;
  }

  #projectionIndex(): SessionProjectionIndex {
    if (!supportsProjectionIndex(this.#manager)) {
      return projectionIndexFromSessionProjection(this.#projection());
    }
    const key = [this.#manager.getSessionId(), this.#manager.getSessionFile() ?? ""].join("\0");
    const revision = this.#manager.getTreeRevision();
    const entryCount = this.#manager.getEntryCount();
    const cached = this.#cachedProjectionIndex;
    if (cached?.key === key && cached.revision === revision && cached.entryCount === entryCount) {
      return cached.value;
    }
    if (
      cached?.key === key
      && revision > cached.revision
      && entryCount > cached.entryCount
    ) {
      const metadata = this.#manager.getEntryProjectionMetadataPage(
        cached.entryCount,
        entryCount - cached.entryCount,
      );
      if (metadata.length !== entryCount - cached.entryCount) {
        throw new Error("Session projection metadata did not cover the appended entries");
      }
      appendSessionProjectionIndex(cached.value, metadata);
      this.#cachedProjectionIndex = { key, revision, entryCount, value: cached.value };
      return cached.value;
    }
    const metadata = this.#manager.getEntryProjectionMetadataPage(0, entryCount);
    if (metadata.length !== entryCount) {
      throw new Error("Session projection metadata did not cover the session entries");
    }
    const value = emptySessionProjectionIndex();
    appendSessionProjectionIndex(value, metadata);
    this.#cachedProjectionIndex = { key, revision, entryCount, value };
    return value;
  }

  #canonicalId(publicId: string): string {
    return this.#projectionIndex().canonicalIdByPublicId.get(publicId) ?? publicId;
  }

  getCwd(): string { return this.#manager.getCwd(); }
  getSessionDir(): string { return this.#manager.getSessionDir(); }
  getSessionId(): string { return this.#manager.getSessionId(); }
  getSessionFile(): string | undefined { return this.#manager.getSessionFile(); }
  isPersisted(): boolean { return this.#manager.isPersisted(); }
  usesDefaultSessionDir(): boolean { return this.#manager.usesDefaultSessionDir(); }
  setSessionFile(path: string): void { this.#manager.setSessionFile(path); }
  newSession(options?: { id?: string; parentSession?: string }): string | undefined { return this.#manager.newSession(options); }

  getLeafId(): string | null {
    const id = this.#manager.getLeafId();
    return id === null ? null : this.#projectionIndex().tailByCanonicalId.get(id) ?? id;
  }

  getLeafEntry(): SessionEntry | undefined {
    const id = this.getLeafId();
    return id === null ? undefined : this.getEntry(id);
  }

  /** @internal Preserves canonical usage provenance for host presentation. */
  getActiveBranchUsage(): ActiveBranchUsage {
    return this.#manager.getActiveBranchUsage();
  }

  getEntry(id: string): SessionEntry | undefined {
    const entry = this.#projection().byId.get(id)?.publicEntry;
    return entry === undefined ? undefined : cloneEntry(entry);
  }

  getLabel(id: string): string | undefined { return this.#manager.getLabel(this.#canonicalId(id)); }

  getBranch(fromId?: string): SessionEntry[] {
    const projection = this.#projection();
    const target = fromId === undefined ? undefined : projection.byId.get(fromId);
    const branch = this.#manager.getBranch(target?.canonicalId ?? fromId);
    const ids = new Set(branch.map((entry) => entry.id));
    const result: SessionEntry[] = [];
    for (const item of projection.entries) {
      if (!ids.has(item.canonicalId)) continue;
      result.push(cloneEntry(item.publicEntry));
      if (fromId !== undefined && item.publicEntry.id === fromId) break;
    }
    return result;
  }

  findEntriesOnBranch(query: SessionBranchQuery = {}): SessionEntry[] {
    validateSessionBranchQuery(query);
    const start = query.start === undefined ? this.getLeafId() : query.start;
    if (start === null) return [];
    const path = this.getBranch(start);
    if (path.length === 0) throw new Error(`Entry ${start} not found`);
    return selectSessionBranchEntries(path, query).map((entry) => cloneEntry(entry));
  }

  findEntryOnBranch(query: SessionBranchQuery = {}): SessionEntry | undefined {
    return this.findEntriesOnBranch({ ...query, limit: 1 })[0];
  }

  buildContextEntries(): SessionEntry[] {
    const projection = projectSession(this.#manager.buildContextEntries());
    return projection.entries.map((entry) => cloneEntry(entry.publicEntry));
  }

  buildSessionContext(): SessionContext {
    const context = this.#manager.buildSessionContext();
    const messages: AgentMessage[] = [];
    for (const message of context.messages) {
      if (message.role === "branchSummary") {
        const value: BranchSummaryMessage = { ...message };
        messages.push(value);
      } else if (message.role === "compactionSummary") {
        const value: CompactionSummaryMessage = { ...message };
        messages.push(value);
      } else messages.push(...extensionMessages(message));
    }
    return {
      messages,
      thinkingLevel: context.thinkingLevel,
      model: context.model === null ? null : { provider: context.model.provider, modelId: context.model.modelId },
    };
  }

  getHeader(): SessionHeader | null {
    const header = this.#manager.getHeader();
    return header === null ? null : cloneEntry(header);
  }

  getEntries(): SessionEntry[] {
    return this.#projection().entries.map((entry) => cloneEntry(entry.publicEntry));
  }

  /** @internal Projects one committed canonical entry without materializing the full session payload. */
  projectCanonicalEntry(entry: CanonicalSessionEntry): SessionEntry[] {
    const projection = this.#projectionIndex();
    const sequence = this.#manager.getEntrySequence(entry.id);
    const indexed = sequence === undefined ? undefined : projection.entries[sequence];
    if (indexed === undefined || indexed.canonicalId !== entry.id) {
      throw new Error(`Committed session entry ${entry.id} is missing from its projection index`);
    }
    const converted = projectEntry(entry, indexed.parentId, new Set());
    if (converted.length !== indexed.publicIds.length) {
      throw new Error(`Session entry ${entry.id} changed its projected entry count`);
    }
    return converted.map((publicEntry, row) => cloneEntry({
      ...publicEntry,
      id: indexed.publicIds[row]!,
      parentId: row === 0 ? indexed.parentId : indexed.publicIds[row - 1]!,
    }));
  }

  /** @internal Bounded projection used by streaming interfaces. */
  getEntriesPage(offset: number, limit: number): SessionEntryPage {
    const projection = this.#projectionIndex();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || limit < 1) {
      return { entries: [], totalEntries: projection.totalEntries };
    }
    const end = Math.min(projection.totalEntries, offset + limit);
    if (offset >= end) return { entries: [], totalEntries: projection.totalEntries };
    const firstCanonical = canonicalIndexAtPublicOffset(projection.entries, offset);
    const lastCanonical = canonicalIndexAtPublicOffset(projection.entries, end - 1);
    const metadata = projection.entries.slice(firstCanonical, lastCanonical + 1);
    const canonical = supportsPagedEntries(this.#manager)
      ? this.#manager.getEntriesPage(firstCanonical, metadata.length)
      : this.#manager.getEntries().slice(firstCanonical, firstCanonical + metadata.length);
    if (canonical.length !== metadata.length) {
      throw new Error("Session entry page did not match its projection metadata");
    }
    const entries: SessionEntry[] = [];
    for (const [entryIndex, entry] of canonical.entries()) {
      const indexed = metadata[entryIndex]!;
      if (entry.id !== indexed.canonicalId) {
        throw new Error("Session entry page changed while it was being projected");
      }
      const converted = projectEntry(entry, indexed.parentId, new Set());
      if (converted.length !== indexed.publicIds.length) {
        throw new Error(`Session entry ${entry.id} changed its projected entry count`);
      }
      for (const [row, publicEntry] of converted.entries()) {
        entries.push({
          ...publicEntry,
          id: indexed.publicIds[row]!,
          parentId: row === 0 ? indexed.parentId : indexed.publicIds[row - 1]!,
        });
      }
    }
    const pageStart = offset - metadata[0]!.publicStart;
    return {
      entries: entries.slice(pageStart, pageStart + limit).map((entry) => cloneEntry(entry)),
      totalEntries: projection.totalEntries,
    };
  }

  getTree(): SessionTreeNode[] {
    const projection = this.#projection();
    const entries = projection.entries.map((entry) => cloneEntry(entry.publicEntry));
    const nodes = new Map<string, SessionTreeNode>(
      entries.map((entry) => [entry.id, { entry, children: [] }]),
    );
    const roots: SessionTreeNode[] = [];
    for (const [index, entry] of entries.entries()) {
      const node = nodes.get(entry.id)!;
      const canonicalId = projection.entries[index]?.canonicalId ?? entry.id;
      const label = this.#manager.getLabel(canonicalId);
      if (label !== undefined) node.label = label;
      if (entry.parentId === null || !nodes.has(entry.parentId)) roots.push(node);
      else nodes.get(entry.parentId)!.children.push(node);
    }
    return roots;
  }

  getSessionName(): string | undefined { return this.#manager.getSessionName(); }
  appendMessage(message: AgentMessage): string { return this.#manager.appendMessage(canonicalMessage(message)); }
  appendThinkingLevelChange(level: string): string { return this.#manager.appendThinkingLevelChange(level); }

  appendModelChange(provider: string, modelId: string): string {
    return this.#manager.appendModelChange(provider, modelId);
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string {
    return this.#manager.appendCompaction(
      summary,
      this.#canonicalId(firstKeptEntryId),
      tokensBefore,
      details,
      fromHook,
      usage === undefined ? undefined : canonicalUsage(usage),
    );
  }

  appendCustomEntry<T = unknown>(customType: string, data?: T): string {
    return this.#manager.appendCustomEntry(customType, data);
  }

  appendSessionInfo(name: string): string { return this.#manager.appendSessionInfo(name); }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: T,
  ): string {
    return this.#manager.appendCustomMessageEntry(customType, canonicalInputContent(content), display, details);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.getEntries().filter((entry) => entry.parentId === parentId);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    return this.#manager.appendLabelChange(this.#canonicalId(targetId), label);
  }

  branch(branchFromId: string): void { this.#manager.branch(this.#canonicalId(branchFromId)); }
  resetLeaf(): void { this.#manager.resetLeaf(); }

  branchWithSummary<T = unknown>(
    branchFromId: string | null,
    summary: string,
    details?: T,
    fromHook?: boolean,
    usage?: Usage,
  ): string {
    return this.#manager.branchWithSummary(
      branchFromId === null ? null : this.#canonicalId(branchFromId),
      summary,
      details,
      fromHook,
      usage === undefined ? undefined : canonicalUsage(usage),
    );
  }

  createBranchedSession(leafId: string): string | undefined {
    return this.#manager.createBranchedSession(this.#canonicalId(leafId));
  }
}

const sessionFacades = new WeakMap<SessionManager, ExtensionSessionManagerFacade>();

function extensionSessionManagerFacade(manager: SessionManager): ExtensionSessionManagerFacade {
  const existing = sessionFacades.get(manager);
  if (existing !== undefined) return existing;
  const facade = new ExtensionSessionManagerFacade(manager);
  sessionFacades.set(manager, facade);
  return facade;
}

export function extensionSessionManager(manager: SessionManager): ExtensionSessionManager {
  return extensionSessionManagerFacade(manager);
}

/** @internal Projects only the canonical entry just committed by the journal owner. */
export function extensionSessionEntriesForCanonicalEntry(
  manager: SessionManager,
  entry: CanonicalSessionEntry,
): SessionEntry[] {
  return extensionSessionManagerFacade(manager).projectCanonicalEntry(entry);
}
