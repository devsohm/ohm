import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { ASSISTANT_CONTENT_LIMITS } from "./assistant-content-limits.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { optionalProperty } from "../../internal/optional-properties.js";
import type {
  CanonicalMessage,
  ModelProtocolFamily,
  ProviderState,
  ProviderStateSource,
  RoutedProviderStateProvenance,
} from "./types.js";
import { hasControlCharacters, STRING_VALUE } from "../../internal/value-schemas.js";

const MODEL_PROTOCOL_FAMILY_VALUE = Type.Union([
  Type.Literal("openai-responses"),
  Type.Literal("openai-chat-completions"),
  Type.Literal("anthropic-messages"),
  Type.Literal("gemini-generate-content"),
  Type.Literal("gemini-interactions"),
  Type.Literal("bedrock-converse"),
  Type.Literal("ollama-chat"),
  Type.Literal("extension-stream"),
]);

const PROVIDER_STATE_KIND_VALUE = Type.Union([
  Type.Literal("openai_responses"),
  Type.Literal("anthropic_messages"),
  Type.Literal("gemini_interactions"),
  Type.Literal("gemini_generate_content"),
  Type.Literal("extension_stream"),
  Type.Literal("bedrock_converse"),
  Type.Literal("chat_completions"),
  Type.Literal("openrouter_chat"),
  Type.Literal("ollama_chat"),
]);

const PROVIDER_STATE_KINDS = Object.freeze({
  openai_responses: { value: "outputItems", array: true, id: "previousResponseId", api: "openai-responses" },
  anthropic_messages: { value: "assistantBlocks", array: true, api: "anthropic-messages" },
  gemini_interactions: { value: "steps", array: true, id: "previousInteractionId", api: "gemini-interactions" },
  gemini_generate_content: { value: "parts", array: true, api: "gemini-generate-content" },
  extension_stream: { value: "assistantContent", array: true, id: "responseId", api: "extension-stream" },
  bedrock_converse: { value: "assistantMessage", array: false, api: "bedrock-converse" },
  chat_completions: { value: "assistantMessage", array: false, api: "openai-chat-completions" },
  openrouter_chat: { value: "assistantMessage", array: false, api: "openai-chat-completions" },
  ollama_chat: { value: "assistantMessage", array: false, api: "ollama-chat" },
} as const satisfies Record<string, {
  value: string;
  array: boolean;
  id?: string;
  api: ModelProtocolFamily;
}>);

export interface ValidatedProviderState {
  state: ProviderState;
  serialized: string;
  api: ModelProtocolFamily;
}

function invalidProviderState(): never {
  throw new TypeError("Provider continuation state is invalid");
}

function providerStateRecord(value: JsonValue | undefined, fields: readonly string[]): JsonObject {
  if (!isJsonObject(value)) return invalidProviderState();
  const record = value;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    return invalidProviderState();
  }
  return record;
}

function providerStateIdentity(value: JsonValue | undefined): string {
	if (!Check(STRING_VALUE, value) || value === "" || Buffer.byteLength(value, "utf8") > 4_096
		|| hasControlCharacters(value)) {
    return invalidProviderState();
  }
  return value;
}

function providerStateProtocol(value: JsonValue | undefined): ModelProtocolFamily {
  if (!Check(MODEL_PROTOCOL_FAMILY_VALUE, value)) return invalidProviderState();
  return value;
}

function providerStateSource(
  record: JsonObject,
  expectedApi: ModelProtocolFamily,
): ProviderStateSource | undefined {
  if (record.source === undefined) return undefined;
  const source = providerStateRecord(record.source, ["provider", "model", "api"]);
  const api = providerStateProtocol(source.api);
  if (api !== expectedApi) return invalidProviderState();
  return {
    provider: providerStateIdentity(source.provider),
    model: providerStateIdentity(source.model),
    api,
  };
}

function providerStateRoute(
  record: JsonObject,
  expectedApi: ModelProtocolFamily,
): RoutedProviderStateProvenance | undefined {
  if (record.routed === undefined) return undefined;
  const routed = providerStateRecord(record.routed, [
    "provider",
    "model",
    "delegate",
    "upstreamModel",
    "protocolFamily",
    "scope",
  ]);
  const protocolFamily = providerStateProtocol(routed.protocolFamily);
  if (protocolFamily !== expectedApi) return invalidProviderState();
  return {
    provider: providerStateIdentity(routed.provider),
    model: providerStateIdentity(routed.model),
    delegate: providerStateIdentity(routed.delegate),
    upstreamModel: providerStateIdentity(routed.upstreamModel),
    protocolFamily,
    scope: providerStateIdentity(routed.scope),
  };
}

function parsedProviderState(
  kind: ProviderState["kind"],
  record: JsonObject,
  source: ProviderStateSource | undefined,
  routed: RoutedProviderStateProvenance | undefined,
): ProviderState {
  const provenance = {
    ...optionalProperty("source", source),
    ...optionalProperty("routed", routed),
  };
  const arrayValue = (field: string): JsonValue[] => {
    const value = record[field];
    if (!Array.isArray(value)) return invalidProviderState();
    return value;
  };
  const requiredValue = (field: string): JsonValue => {
    const value = record[field];
    return value === undefined ? invalidProviderState() : value;
  };
  switch (kind) {
    case "openai_responses":
      return {
        kind,
        outputItems: arrayValue("outputItems"),
        ...optionalProperty(
          "previousResponseId",
          record.previousResponseId === undefined
            ? undefined
            : providerStateIdentity(record.previousResponseId),
        ),
        ...provenance,
      };
    case "anthropic_messages":
      return { kind, assistantBlocks: arrayValue("assistantBlocks"), ...provenance };
    case "gemini_interactions":
      return {
        kind,
        steps: arrayValue("steps"),
        ...optionalProperty(
          "previousInteractionId",
          record.previousInteractionId === undefined
            ? undefined
            : providerStateIdentity(record.previousInteractionId),
        ),
        ...provenance,
      };
    case "gemini_generate_content":
      return { kind, parts: arrayValue("parts"), ...provenance };
    case "extension_stream":
      return {
        kind,
        assistantContent: arrayValue("assistantContent"),
        ...optionalProperty(
          "responseId",
          record.responseId === undefined ? undefined : providerStateIdentity(record.responseId),
        ),
        ...provenance,
      };
    case "bedrock_converse":
    case "chat_completions":
    case "openrouter_chat":
    case "ollama_chat":
      return { kind, assistantMessage: requiredValue("assistantMessage"), ...provenance };
  }
}

/** Validates and detaches opaque continuation state before it crosses a provider boundary. */
export function validateProviderState<T>(value: T): ValidatedProviderState {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider continuation state",
    maximumBytes: ASSISTANT_CONTENT_LIMITS.contentBytes,
    maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
  });
  if (!isJsonObject(snapshot.value)) return invalidProviderState();
  const record = snapshot.value;
  const kind = record.kind;
  if (!Check(PROVIDER_STATE_KIND_VALUE, kind)) return invalidProviderState();
  const stateKind = PROVIDER_STATE_KINDS[kind];
  const stateId = "id" in stateKind ? stateKind.id : undefined;
  const allowed = new Set(["kind", stateKind.value, "source", "routed", ...(stateId === undefined ? [] : [stateId])]);
  if (Object.keys(record).some((field) => !allowed.has(field)) || !Object.hasOwn(record, stateKind.value)) {
    return invalidProviderState();
  }
  if (stateKind.array && !Array.isArray(record[stateKind.value])) return invalidProviderState();
  if (stateId !== undefined && record[stateId] !== undefined) providerStateIdentity(record[stateId]);
  const source = providerStateSource(record, stateKind.api);
  const routed = providerStateRoute(record, stateKind.api);
  return {
    state: parsedProviderState(kind, record, source, routed),
    serialized: snapshot.serialized,
    api: stateKind.api,
  };
}

export interface ReconciledProviderState {
  providerState?: ProviderState;
  providerStateMessageId?: string;
}

export function replayProviderStateAfterPrefixRewrite(state: ProviderState): ProviderState | undefined {
  if (state.kind === "openai_responses") {
    if (state.outputItems.length === 0) return undefined;
    const { previousResponseId: _previousResponseId, ...replayable } = state;
    return replayable;
  }
  if (state.kind === "gemini_interactions") {
    if (state.steps.length === 0) return undefined;
    const { previousInteractionId: _previousInteractionId, ...replayable } = state;
    return replayable;
  }
  return state;
}

export function reconcileProviderStateAfterContextRewrite(
  state: ProviderState | undefined,
  stateMessageId: string | undefined,
  previousMessages: readonly CanonicalMessage[],
  nextMessages: readonly CanonicalMessage[],
): ReconciledProviderState {
  if (state === undefined || stateMessageId === undefined) return {};
  const previousIndex = previousMessages.findIndex((message) => message.id === stateMessageId);
  const nextIndex = nextMessages.findIndex((message) => message.id === stateMessageId);
  if (
    previousIndex < 0 ||
    nextIndex < 0 ||
    !isDeepStrictEqual(previousMessages[previousIndex], nextMessages[nextIndex])
  ) return {};
  if (
    previousIndex === nextIndex &&
    isDeepStrictEqual(
      previousMessages.slice(0, previousIndex + 1),
      nextMessages.slice(0, nextIndex + 1),
    )
  ) {
    return { providerState: state, providerStateMessageId: stateMessageId };
  }
  const replayable = replayProviderStateAfterPrefixRewrite(state);
  return replayable === undefined
    ? {}
    : { providerState: replayable, providerStateMessageId: stateMessageId };
}
