import { optionalProperties } from "../core/optional-properties.js";
import { zstdCompressSync } from "node:zlib";

import { ASSISTANT_CONTENT_LIMITS } from "@ohm/kernel/runtime/core/assistant-content-limits";

import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderState,
} from "../core/types.js";
import { BOOLEAN_VALUE, STRING_VALUE, hasControlCharacters } from "../core/value-schemas.js";
import { catalogId } from "./catalog.js";
import { requireBody } from "./lines.js";
import { normalizeImageSource, requireImageMediaType, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import {
  assertCurrentProviderReasoningEffort,
  assertOpenAIReasoningEffort,
  providerWireRequest,
} from "./messages.js";
import { decodeSSE, wasSseEventDispatchedAtEof } from "./sse.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { parseJsonWithRepair } from "./streaming-json.js";
import { baseModelCompatibility, mergeModelCompatibility, modelEvidence } from "./model-metadata.js";
import { openAIPromptCacheKey } from "./openai-affinity.js";
import { createAzureOpenAISdkEventStream, createOpenAISdkEventStream } from "./openai-sdk-transport.js";
import {
  appendGrammarInputDelta,
  providerGrammarInput,
  providerGrammarProperties,
  providerGrammarTool,
  providerStrictTool,
  type GrammarInputBuffer,
} from "./constrained-sampling.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  assertResponseOk,
  assertSecureEndpoint,
  type FetchLike,
  InvalidProviderRequestError,
  jsonValueOrString,
  normalizeError,
  PrematureStreamEndError,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
  responseDiagnostics,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";
import { consumeResponsesAttemptReset } from "./openai-responses-wire-internal.js";
import { transportErrorCode } from "./transport-error.js";
import { Value } from "typebox/value";

export interface OpenAIResponsesConfig {
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  baseUrl?: string;
  organization?: string;
  project?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  store?: boolean;
  promptCacheOptions?: OpenAIPromptCacheOptions;
  promptCacheRetention?: "in-memory" | "24h";
  serviceTier?: OpenAIServiceTier;
  /** Enable documented OpenAI hosted tool search on a compatible endpoint. */
  deferredToolLoading?: boolean;
  /** Request display-safe reasoning summaries from endpoints that implement that Responses field. */
  reasoningSummaries?: boolean;
  /** Treat documented reasoning-text events as displayable output on this endpoint. */
  reasoningTextDisplay?: boolean;
}

export interface OpenAIPromptCacheOptions {
  ttl: "30m";
}

export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";

export interface AzureOpenAIResponsesConfig {
  endpoint: string;
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  apiVersion?: string;
  deploymentName?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  store?: boolean;
}

export interface ResponsesTransportConfig {
  baseUrl: string;
  headers: HeadersInit | undefined;
  fetch: FetchLike;
  authorize: (headers: Headers, signal: AbortSignal) => Promise<void>;
  prepareHeaders?: (headers: Headers, request: ProviderRequest) => void | Promise<void>;
  buildBody?: (request: ProviderRequest) => JsonObject;
  streamEvents?: (input: ResponsesEventStreamInput) => AsyncIterable<ResponsesWireEvent>;
  listModels?: (signal: AbortSignal) => Promise<ModelInfo[]>;
  stateful: boolean;
  retainResponseId?: boolean;
  promptCache: boolean;
  promptCacheOptions?: OpenAIPromptCacheOptions;
  promptCacheRetention?: "in-memory" | "24h";
  serviceTier?: OpenAIServiceTier;
  deferredToolLoading: boolean;
  supportsReasoningSummaries: boolean;
  reasoningTextVisibility: "summary" | "provider_trace";
}

export interface ResponsesWireEvent {
  data: string;
  event?: string;
  requestId?: string;
  diagnostics?: ProviderResponseDiagnostics;
}

export interface ResponsesEventStreamInput {
  url: string;
  headers: Headers;
  body: JsonObject;
  request: ProviderRequest;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse?: (diagnostics: ProviderResponseDiagnostics, requestId?: string) => void;
}

interface ToolAccumulator {
  index: number;
  id?: string;
  itemId?: string;
  name?: string;
  arguments: string;
  grammar?: { property: string; input: GrammarInputBuffer };
  ended: boolean;
}

type ResponsesPartAliasKind = "item" | "output" | "unscoped";

interface ResponsesPartAlias {
  key: string;
  kind: ResponsesPartAliasKind;
  bytes: number;
}

interface ResponsesPartState {
  text: string;
  bytes: number;
  owners: Partial<Record<ResponsesPartAliasKind, string>>;
}

interface ResponsesPartPlan {
  part: number;
  state: ResponsesPartState | undefined;
  newAliases: ResponsesPartAlias[];
}

const MAX_RESPONSES_PART_ID_BYTES = 4_096;
const MAX_RESPONSES_PART_ALIASES = ASSISTANT_CONTENT_LIMITS.blocks * 2;
const MAX_RESPONSES_PART_IDENTITY_BYTES = ASSISTANT_CONTENT_LIMITS.fieldBytes;

class ResponsesPartRegistry {
  readonly #label: "text" | "reasoning";
  readonly #aliases = new Map<string, number>();
  readonly #parts = new Map<number, ResponsesPartState>();
  #nextPart = 0;
  #identityBytes = 0;
  #contentBytes = 0;

  constructor(label: "text" | "reasoning") {
    this.#label = label;
  }

  append(aliases: ResponsesPartAlias[], delta: string): number {
    const plan = this.#plan(aliases, true);
    if (plan === undefined) throw new Error("Responses part allocation failed");
    const previous = plan.state?.text ?? "";
    const previousBytes = plan.state?.bytes ?? 0;
    const nextBytes = previousBytes + Buffer.byteLength(delta, "utf8");
    this.#validateContentBytes(previousBytes, nextBytes);
    const state = this.#commit(plan);
    state.text = `${previous}${delta}`;
    state.bytes = nextBytes;
    this.#contentBytes += nextBytes - previousBytes;
    return plan.part;
  }

  reconcile(aliases: ResponsesPartAlias[], snapshot: string): { part: number; missing: string } | undefined {
    const plan = this.#plan(aliases, snapshot !== "");
    if (plan === undefined) return undefined;
    const previous = plan.state?.text ?? "";
    if (!snapshot.startsWith(previous)) {
      throw new ProtocolError(`Responses ${this.#label} part snapshot did not extend streamed content`);
    }
    const previousBytes = plan.state?.bytes ?? 0;
    const nextBytes = Buffer.byteLength(snapshot, "utf8");
    this.#validateContentBytes(previousBytes, nextBytes);
    const state = this.#commit(plan);
    state.text = snapshot;
    state.bytes = nextBytes;
    this.#contentBytes += nextBytes - previousBytes;
    return { part: plan.part, missing: snapshot.slice(previous.length) };
  }

  clear(): void {
    this.#aliases.clear();
    this.#parts.clear();
    this.#nextPart = 0;
    this.#identityBytes = 0;
    this.#contentBytes = 0;
  }

  #plan(aliases: ResponsesPartAlias[], allocate: boolean): ResponsesPartPlan | undefined {
    let part: number | undefined;
    for (const alias of aliases) {
      const mapped = this.#aliases.get(alias.key);
      if (mapped === undefined) continue;
      if (part === undefined) part = mapped;
      else if (part !== mapped) this.#conflict();
    }
    if (part === undefined) {
      if (!allocate) return undefined;
      if (this.#nextPart >= ASSISTANT_CONTENT_LIMITS.blocks) {
        throw new ProtocolError(
          `Responses ${this.#label} content exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} streamed blocks`,
        );
      }
      part = this.#nextPart;
    }
    const state = this.#parts.get(part);
    if (part < this.#nextPart && state === undefined) throw new Error("Responses part state was inconsistent");
    const newAliases = aliases.filter((alias) => !this.#aliases.has(alias.key));
    for (const alias of newAliases) {
      const owner = state?.owners[alias.kind];
      if (owner !== undefined && owner !== alias.key) this.#conflict();
    }
    if (this.#aliases.size + newAliases.length > MAX_RESPONSES_PART_ALIASES) {
      throw new ProtocolError(`Responses ${this.#label} part identity aliases exceeded their limit`);
    }
    const newIdentityBytes = newAliases.reduce((total, alias) => total + alias.bytes, 0);
    if (this.#identityBytes + newIdentityBytes > MAX_RESPONSES_PART_IDENTITY_BYTES) {
      throw new ProtocolError(`Responses ${this.#label} part identities exceeded their aggregate byte limit`);
    }
    return { part, state, newAliases };
  }

  #commit(plan: ResponsesPartPlan): ResponsesPartState {
    let state = plan.state;
    if (state === undefined) {
      state = { text: "", bytes: 0, owners: {} };
      this.#parts.set(plan.part, state);
      this.#nextPart += 1;
    }
    for (const alias of plan.newAliases) {
      this.#aliases.set(alias.key, plan.part);
      state.owners[alias.kind] = alias.key;
      this.#identityBytes += alias.bytes;
    }
    return state;
  }

  #validateContentBytes(previous: number, next: number): void {
    if (next > ASSISTANT_CONTENT_LIMITS.fieldBytes) {
      throw new ProtocolError(
        `Responses ${this.#label} part exceeds ${ASSISTANT_CONTENT_LIMITS.fieldBytes} UTF-8 bytes`,
      );
    }
    if (this.#contentBytes - previous + next > ASSISTANT_CONTENT_LIMITS.contentBytes) {
      throw new ProtocolError(
        `Responses ${this.#label} content exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate UTF-8 bytes`,
      );
    }
  }

  #conflict(): never {
    throw new ProtocolError(`Responses ${this.#label} part identities conflicted`);
  }
}

export type ResponsesTerminalOutcome =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "unexpected";

export function responsesTerminalOutcome(
  type: string,
  response: JsonObject | undefined,
): ResponsesTerminalOutcome | undefined {
  if (type === "response.completed") return "completed";
  if (type === "response.incomplete") return "incomplete";
  if (type === "response.failed") return "failed";
  if (type !== "response.done") return undefined;
  const status = asString(response?.status);
  if (status === undefined || status === "completed") return "completed";
  if (status === "incomplete" || status === "failed" || status === "cancelled") return status;
  return "unexpected";
}

const parsedResponsesWireEvents = new WeakMap<ResponsesWireEvent, JsonValue>();
const eofResponsesWireEvents = new WeakSet<ResponsesWireEvent>();

function responsesWireEventFromValue<Input>(
  value: Input,
  requestId?: string,
  diagnostics?: ProviderResponseDiagnostics,
): ResponsesWireEvent {
  const wire: ResponsesWireEvent = {
    data: "",
    ...optionalProperties(requestId === undefined ? undefined : { requestId }),
    ...optionalProperties(diagnostics === undefined ? undefined : { diagnostics }),
  };
  parsedResponsesWireEvents.set(wire, jsonValueOrString(value));
  return wire;
}

export class ResponsesAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #transport: ResponsesTransportConfig;

  constructor(id: ProviderId, transport: ResponsesTransportConfig) {
    this.id = id;
    this.#transport = transport;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    yield* this.#streamAttempt(request, signal, true);
  }

  async *#streamAttempt(
    request: ProviderRequest,
    signal: AbortSignal,
    allowEarlyEofRetry: boolean,
  ): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;

    try {
      const headers = new Headers(this.#transport.headers);
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      await this.#transport.authorize(headers, signal);
      await this.#transport.prepareHeaders?.(headers, request);
      applyResponsesSessionHeaders(headers, request);

      const url = `${this.#transport.baseUrl}/responses`;
      const retainServerContinuation = request.cacheRetention !== "none" && (
        this.#transport.stateful || this.#transport.retainResponseId === true
      );
      const body = this.#transport.buildBody?.(request) ?? buildResponsesBody(
        request,
        this.#transport.stateful,
        this.#transport.promptCache,
        this.#transport.promptCacheRetention,
        this.#transport.serviceTier,
        this.#transport.promptCacheOptions,
        this.#transport.deferredToolLoading,
        this.#transport.supportsReasoningSummaries,
      );
      const onResponse = (observedDiagnostics: ProviderResponseDiagnostics, observedRequestId?: string): void => {
        diagnostics = observedDiagnostics;
        requestId ??= observedRequestId;
      };
      const wireEvents = this.#transport.streamEvents?.({
        url,
        headers,
        body,
        request,
        signal,
        fetch: this.#transport.fetch,
        onResponse,
      }) ?? httpResponsesWireEvents({ url, headers, body, signal, fetch: this.#transport.fetch, onResponse });

      let started = false;
      let responseId: string | undefined;
      let responseModel = request.model;
      const outputItems = new Map<number, JsonValue>();
      const tools = new Map<string, ToolAccumulator>();
      const grammarProperties = providerGrammarProperties(
        request.tools,
        request.modelSettings?.compatibility?.supportsOpenAIGrammarTools === true,
      );
      const textParts = new ResponsesPartRegistry("text");
      const reasoningParts = new ResponsesPartRegistry("reasoning");
      let sawToolCall = false;
      let sawRefusal = false;
      const startResponse = (): AdapterEvent | undefined => {
        if (started) return undefined;
        started = true;
        const start: AdapterEvent = {
          type: "response_start",
          model: responseModel,
          ...optionalProperties(diagnostics === undefined ? undefined : { diagnostics }),
        };
        if (responseId !== undefined) start.responseId = responseId;
        if (requestId !== undefined) start.requestId = requestId;
        return start;
      };
      const reconcileTextSnapshot = (
        text: string,
        aliases: ResponsesPartAlias[],
      ): AdapterEvent[] => {
        const reconciled = textParts.reconcile(aliases, text);
        if (reconciled === undefined) return [];
        partial = true;
        if (reconciled.missing === "") return [];
        const events: AdapterEvent[] = [];
        const start = startResponse();
        if (start !== undefined) events.push(start);
        events.push({ type: "text_delta", part: reconciled.part, text: reconciled.missing });
        return events;
      };
      const reconcileReasoningSnapshot = (
        text: string,
        visibility: "summary" | "provider_trace",
        aliases: ResponsesPartAlias[],
      ): AdapterEvent[] => {
        const reconciled = reasoningParts.reconcile(aliases, text);
        if (reconciled === undefined) return [];
        partial = true;
        if (reconciled.missing === "") return [];
        const events: AdapterEvent[] = [];
        const start = startResponse();
        if (start !== undefined) events.push(start);
        events.push({
          type: "reasoning_delta",
          part: reconciled.part,
          text: reconciled.missing,
          visibility,
        });
        return events;
      };

      for await (const wire of wireEvents) {
        if (consumeResponsesAttemptReset(wire)) {
          if (partial || started) throw new ProtocolError("Responses transport reset after semantic output");
          responseId = undefined;
          responseModel = request.model;
          outputItems.clear();
          tools.clear();
          textParts.clear();
          reasoningParts.clear();
          sawToolCall = false;
          sawRefusal = false;
          requestId = wire.requestId;
        }
        requestId ??= wire.requestId;
        diagnostics ??= wire.diagnostics;
        const hasParsedEvent = parsedResponsesWireEvents.has(wire);
        if (!hasParsedEvent && wire.data.trim() === "[DONE]") break;
        let parsed: JsonValue;
        if (hasParsedEvent) {
          const cached = parsedResponsesWireEvents.get(wire);
          if (cached === undefined) throw new ProtocolError("Responses event cache was inconsistent");
          parsed = cached;
        } else {
          try {
            parsed = parseJson(wire.data, "OpenAI Responses stream event");
          } catch (error) {
            if (error instanceof ProtocolError && eofResponsesWireEvents.has(wire)) {
              throw new PrematureStreamEndError("Responses stream ended before a terminal event", wire.data);
            }
            throw error;
          }
        }
        const event = asRecord(parsed);
        if (event === undefined) throw new ProtocolError("Responses event was not an object", jsonValueOrString(parsed));
        const type = asString(event.type) ?? wire.event;
        if (type === undefined) throw new ProtocolError("Responses event did not contain a type", jsonValueOrString(parsed));
        if (isIgnorableCodexInformationalEvent(this.id, type)) continue;

        const responseValue = event.response;
        const responseObject = asRecord(responseValue);
        responseId = asString(responseObject?.id) ?? responseId;
        responseModel = asString(responseObject?.model) ?? responseModel;

        if (
          type === "response.created"
          || type === "response.in_progress"
          || type === "response.queued"
          || type === "response.metadata"
        ) {
          const requiresResponse = type === "response.created"
            || type === "response.in_progress"
            || type === "response.queued";
          partial ||= responseObject === undefined
            ? requiresResponse || responseValue !== undefined
            : responseObjectHasSemanticOutput(responseObject);
          continue;
        }

        if (type === "response.output_text.delta") {
          const text = asString(event.delta);
          if (text === undefined) {
            partial = true;
          } else if (text !== "") {
            const part = textParts.append(responseTextPartAliases(event), text);
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "text_delta", part, text };
          }
          continue;
        }

        if (type === "response.refusal.delta") {
          const text = asString(event.delta);
          if (text === undefined) {
            partial = true;
          } else if (text !== "") {
            const part = textParts.append(responseTextPartAliases(event), text);
            sawRefusal = true;
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "text_delta", part, text };
          }
          continue;
        }

        if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
          const text = asString(event.delta);
          if (text === undefined) {
            partial = true;
          } else if (text !== "") {
            partial = true;
            const visibility = type.includes("summary")
              ? "summary"
              : this.#transport.reasoningTextVisibility;
            const part = reasoningParts.append(
              responseReasoningPartAliases(event, type.includes("summary")),
              text,
            );
            const start = startResponse();
            if (start !== undefined) yield start;
            yield {
              type: "reasoning_delta",
              part,
              text,
              visibility,
            };
          }
          continue;
        }

        if (type === "response.output_text.done" || type === "response.refusal.done") {
          const text = type === "response.refusal.done" ? asString(event.refusal) : asString(event.text);
          if (text !== undefined) {
            if (type === "response.refusal.done") sawRefusal = true;
            for (const recovered of reconcileTextSnapshot(
              text,
              responseTextPartAliases(event),
            )) yield recovered;
            continue;
          }
        }

        if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done") {
          const text = asString(event.text);
          if (text !== undefined) {
            const visibility = type === "response.reasoning_summary_text.done"
              ? "summary"
              : this.#transport.reasoningTextVisibility;
            for (const recovered of reconcileReasoningSnapshot(
              text,
              visibility,
              responseReasoningPartAliases(
                event,
                type === "response.reasoning_summary_text.done",
              ),
            )) yield recovered;
            continue;
          }
        }

        if (type === "response.content_part.added" || type === "response.content_part.done") {
          const content = asRecord(event.part);
          const contentType = asString(content?.type);
          if (content !== undefined && (contentType === "output_text" || contentType === "refusal")) {
            partial ||= responseContentEntryHasSemanticContent(content);
            if (contentType === "refusal") sawRefusal = true;
            const text = contentType === "refusal" ? asString(content.refusal) : asString(content.text);
            if (text !== undefined) {
              for (const recovered of reconcileTextSnapshot(
                text,
                responseTextPartAliases(event),
              )) yield recovered;
              continue;
            }
          }
          if (content !== undefined && contentType === "reasoning_text") {
            partial ||= responseContentEntryHasSemanticContent(content);
            const text = asString(content.text);
            if (text !== undefined) {
              for (const recovered of reconcileReasoningSnapshot(
                text,
                this.#transport.reasoningTextVisibility,
                responseReasoningPartAliases(event, false),
              )) yield recovered;
              continue;
            }
          }
        }

        if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
          const content = asRecord(event.part);
          if (content?.type === "summary_text") {
            partial ||= responseContentEntryHasSemanticContent(content);
            const text = asString(content.text);
            if (text !== undefined) {
              for (const recovered of reconcileReasoningSnapshot(
                text,
                "summary",
                responseReasoningPartAliases(event, true),
              )) yield recovered;
              continue;
            }
          }
        }

        if (type === "response.output_item.added" || type === "response.output_item.done") {
          const wireIndex = responseOptionalPartIndex(event.output_index, "output_index");
          const index = wireIndex ?? outputItems.size;
          const item = asRecord(event.item);
          if (item !== undefined) outputItems.set(index, jsonValueOrString(item));
          partial ||= item === undefined || responseOutputItemHasSemanticContent(item);
          if (item?.type === "message") {
            const itemId = responsePartItemId(item.id, "output item ID");
            for (const [contentIndex, value] of asArray(item.content).entries()) {
              const content = asRecord(value);
              const contentType = asString(content?.type);
              const text = contentType === "output_text"
                ? asString(content?.text)
                : contentType === "refusal"
                  ? asString(content?.refusal)
                  : undefined;
              if (contentType === "refusal") sawRefusal = true;
              if (text === undefined) continue;
              for (const recovered of reconcileTextSnapshot(
                text,
                responsePartAliases(wireIndex, itemId, contentIndex),
              )) yield recovered;
            }
          }
          if (item?.type === "reasoning") {
            const itemId = responsePartItemId(item.id, "output item ID");
            const content = [
              ...asArray(item.summary).map((value, part) => ({
                value,
                part,
                visibility: "summary" as const,
                channel: "summary" as const,
              })),
              ...asArray(item.content).map((value, part) => ({
                value,
                part,
                visibility: this.#transport.reasoningTextVisibility,
                channel: "reasoning" as const,
              })),
            ];
            for (const entry of content) {
              const text = asString(asRecord(entry.value)?.text) ?? "";
              for (const recovered of reconcileReasoningSnapshot(
                text,
                entry.visibility,
                responsePartAliases(wireIndex, itemId, entry.part, entry.channel),
              )) yield recovered;
            }
          }
          if (item?.type === "function_call" || item?.type === "custom_tool_call") {
            sawToolCall = true;
            const key = asString(item.id) ?? `index:${index}`;
            let tool = tools.get(key);
            if (tool === undefined) {
              const name = asString(item.name);
              const property = name === undefined ? undefined : grammarProperties.get(name);
              tool = {
                index,
                arguments: "",
                ...(property === undefined
                  ? { arguments: asString(item.arguments) ?? "" }
                  : { grammar: { property, input: { value: "", opened: false, closed: false } } }),
                ended: false,
              };
              const id = asString(item.call_id);
              const itemId = asString(item.id);
              if (id !== undefined) tool.id = id;
              if (itemId !== undefined) tool.itemId = itemId;
              if (name !== undefined) tool.name = name;
              tools.set(key, tool);
              partial = true;
              const responseStart = startResponse();
              if (responseStart !== undefined) yield responseStart;
              const start: AdapterEvent = { type: "tool_call_start", index };
              if (tool.id !== undefined) start.id = tool.id;
              if (tool.name !== undefined) start.name = tool.name;
              yield start;
              const input = asString(item.input);
              if (input !== undefined && tool.grammar) {
                const fragment = appendGrammarInputDelta(tool.grammar.input, tool.grammar.property, input, false);
                if (fragment) {
                  tool.arguments += fragment;
                  yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
                }
              }
            } else {
              if (tool.grammar && !tool.grammar.input.closed) {
                const input = asString(item.input);
                if (input !== undefined) {
                  const fragment = appendGrammarInputDelta(tool.grammar.input, tool.grammar.property, input, false);
                  if (fragment) {
                    tool.arguments += fragment;
                    yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
                  }
                }
              } else {
                tool.arguments = asString(item.arguments) ?? tool.arguments;
              }
              const name = asString(item.name);
              const id = asString(item.call_id);
              if (name !== undefined) tool.name = name;
              if (id !== undefined) tool.id = id;
            }
            if (type.endsWith(".done") && !tool.ended) {
              if (tool.grammar && !tool.grammar.input.closed) {
                const fragment = appendGrammarInputDelta(tool.grammar.input, tool.grammar.property, tool.grammar.input.value, true);
                if (fragment) {
                  tool.arguments += fragment;
                  yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
                }
              }
              yield finishTool(tool);
            }
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const found = findTool(tools, event);
          const tool = found.tool;
          if (found.created) {
            partial = true;
            const responseStart = startResponse();
            if (responseStart !== undefined) yield responseStart;
            const start: AdapterEvent = { type: "tool_call_start", index: tool.index };
            yield start;
          }
          const fragment = asString(event.delta) ?? "";
          tool.arguments += fragment;
          partial = true;
          yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
          continue;
        }

        if (type === "response.function_call_arguments.done") {
          const found = findTool(tools, event);
          const tool = found.tool;
          if (found.created) {
            partial = true;
            const responseStart = startResponse();
            if (responseStart !== undefined) yield responseStart;
            const start: AdapterEvent = { type: "tool_call_start", index: tool.index };
            yield start;
          }
          tool.arguments = asString(event.arguments) ?? tool.arguments;
          if (!tool.ended) yield finishTool(tool);
          continue;
        }

        if (type === "response.custom_tool_call_input.delta" || type === "response.custom_tool_call_input.done") {
          const found = findTool(tools, event);
          const tool = found.tool;
          if (found.created) {
            partial = true;
            const responseStart = startResponse();
            if (responseStart !== undefined) yield responseStart;
            yield { type: "tool_call_start", index: tool.index };
          }
          const name = tool.name ?? asString(event.name);
          const property = name === undefined ? undefined : grammarProperties.get(name);
          if (!tool.grammar && property !== undefined) {
            tool.grammar = { property, input: { value: "", opened: false, closed: false } };
          }
          if (!tool.grammar) throw new ProtocolError("Custom tool input did not match a declared grammar tool", jsonValueOrString(event));
          const nextInput = type.endsWith(".delta")
            ? tool.grammar.input.value + (asString(event.delta) ?? "")
            : asString(event.input) ?? tool.grammar.input.value;
          const fragment = appendGrammarInputDelta(tool.grammar.input, tool.grammar.property, nextInput, type.endsWith(".done"));
          if (fragment) {
            tool.arguments += fragment;
            partial = true;
            yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
          }
          continue;
        }

        const terminalOutcome = responsesTerminalOutcome(type, responseObject);
        if (terminalOutcome === "failed" || terminalOutcome === "cancelled" || type === "error") {
          const rawError = asRecord(event.error) ?? asRecord(responseObject?.error);
          const providerCode = asString(rawError?.code) ?? asString(rawError?.type) ?? (
            terminalOutcome === "cancelled" ? "response_cancelled" : "response_failed"
          );
          throw new ProviderStreamError(
            asString(rawError?.message) ?? (
              terminalOutcome === "cancelled" ? "OpenAI response was cancelled" : "OpenAI response failed"
            ),
            providerCode,
            jsonValueOrString(event),
          );
        }

        if (terminalOutcome === "unexpected") {
          throw new ProtocolError(
            `OpenAI response.done contained a non-terminal status: ${asString(responseObject?.status) ?? "unknown"}`,
            jsonValueOrString(event),
          );
        }

        if (terminalOutcome === "completed" || terminalOutcome === "incomplete") {
          const start = startResponse();
          if (start !== undefined) yield start;
          for (const tool of tools.values()) {
            if (!tool.ended) {
              if (tool.grammar && !tool.grammar.input.closed) {
                const fragment = appendGrammarInputDelta(tool.grammar.input, tool.grammar.property, tool.grammar.input.value, true);
                if (fragment) {
                  tool.arguments += fragment;
                  yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
                }
              }
              yield finishTool(tool);
            }
          }
          for (const [index, item] of asArray(responseObject?.output).entries()) {
            outputItems.set(index, jsonValueOrString(item));
          }
          const usage = usageFromResponse(
            responseObject?.usage,
            resolvedResponsesServiceTier(
              this.id,
              asString(responseObject?.service_tier),
              this.#transport.serviceTier,
            ),
          );
          if (usage !== undefined) yield { type: "usage", usage, semantics: "final" };
          const rawReason = incompleteReason(responseObject);
          const reason =
            terminalOutcome === "incomplete"
              ? mapIncompleteReason(rawReason)
              : sawToolCall
                ? "tool_calls"
                : sawRefusal
                  ? "refusal"
                  : "stop";
          terminal = true;
          const end: AdapterEvent = {
            type: "response_end",
            reason,
            state: responsesState(retainServerContinuation ? responseId : undefined, outputItems),
          };
          if (rawReason !== undefined) end.rawReason = rawReason;
          yield end;
          return;
        }

        partial = true;
        yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
      }

      if (!terminal) throw new PrematureStreamEndError("Responses stream ended before a terminal event");
    } catch (error) {
      if (!terminal) {
        if (
          allowEarlyEofRetry &&
          !partial &&
          !signal.aborted &&
          Error.isError(error) &&
          error instanceof PrematureStreamEndError
        ) {
          yield* this.#streamAttempt(request, signal, false);
          return;
        }
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.#transport.listModels !== undefined) return this.#transport.listModels(signal);
    const headers = new Headers(this.#transport.headers);
    headers.set("accept", "application/json");
    await this.#transport.authorize(headers, signal);
    const response = await this.#transport.fetch(`${this.#transport.baseUrl}/models`, { headers, signal, redirect: "error" });
    await assertResponseOk(response);
    const body = await readJsonResponse(response);
    const data = asArray(asRecord(body)?.data);
    const observedAt = new Date().toISOString();
    return data.flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const id = catalogId(model?.id);
      if (id === undefined) return [];
      const capabilities = unknownCapabilities(observedAt);
      const compatibility = baseModelCompatibility("openai-responses", capabilities.tools, observedAt);
      if (this.#transport.promptCache) {
        compatibility.cacheMode = modelEvidence("automatic", "configuration", observedAt);
        compatibility.cacheAffinity = modelEvidence("prefix", "configuration", observedAt);
        if (this.#transport.promptCacheRetention !== undefined) {
          compatibility.cacheTiers = modelEvidence([this.#transport.promptCacheRetention], "configuration", observedAt);
        }
      }
      if (this.#transport.stateful) {
        compatibility.sessionAffinity = modelEvidence("optional", "configuration", observedAt);
      }
      compatibility.deferredTools = this.#transport.deferredToolLoading
        ? openAIDeferredToolsCapability(id, observedAt)
        : modelEvidence("unknown", "configuration", observedAt);
      return [
        mergeModelCompatibility({
          id,
          provider: this.id,
          capabilities,
          metadata: jsonValueOrString(model),
        }, compatibility),
      ];
    });
  }
}

export async function* httpResponsesWireEvents(input: {
  url: string;
  headers: Headers;
  body: JsonObject;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse?: (diagnostics: ProviderResponseDiagnostics, requestId?: string) => void;
}, options: { compressZstd?: boolean } = {}): AsyncGenerator<ResponsesWireEvent> {
  const headers = new Headers(input.headers);
  const json = stringifyProviderJson(input.body);
  let body: BodyInit = json;
  if (options.compressZstd === true) {
    try {
      body = Uint8Array.from(zstdCompressSync(json));
      headers.set("content-encoding", "zstd");
    } catch {
      headers.delete("content-encoding");
    }
  }
  const response = await input.fetch(input.url, {
    method: "POST",
    headers,
    body,
    signal: input.signal,
    redirect: "error",
  });
  const requestId = requestIdFromHeaders(response.headers);
  const diagnostics = responseDiagnostics(response);
  await assertResponseOk(response);
  input.onResponse?.(diagnostics, requestId);
  try {
    for await (const sse of decodeSSE(requireBody(response))) {
      const wire: ResponsesWireEvent = {
        data: sse.data,
        ...optionalProperties(sse.event === undefined ? undefined : { event: sse.event }),
        ...optionalProperties(requestId === undefined ? undefined : { requestId }),
        diagnostics,
      };
      if (wasSseEventDispatchedAtEof(sse)) eofResponsesWireEvents.add(wire);
      yield wire;
    }
  } catch (error) {
    if (!(error instanceof TypeError) || input.signal.aborted) throw error;
    const code = transportErrorCode(error);
    throw new PrematureStreamEndError(
      `Responses stream connection terminated${code === undefined ? "" : ` (${code})`}`,
      undefined,
      { cause: error, ...optionalProperties(code === undefined ? undefined : { transportCode: code }) },
    );
  }
}

export class OpenAIResponsesAdapter extends ResponsesAdapter {
  constructor(config: OpenAIResponsesConfig) {
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    const baseUrl = trimSlash(config.baseUrl ?? "https://api.openai.com/v1");
    assertSecureEndpoint(baseUrl, "OpenAI base URL");
    if (config.deferredToolLoading !== undefined && !Value.Check(BOOLEAN_VALUE, config.deferredToolLoading)) {
      throw new TypeError("OpenAI deferredToolLoading must be a boolean");
    }
    if (config.reasoningSummaries !== undefined && !Value.Check(BOOLEAN_VALUE, config.reasoningSummaries)) {
      throw new TypeError("OpenAI reasoningSummaries must be a boolean");
    }
    if (config.reasoningTextDisplay !== undefined && !Value.Check(BOOLEAN_VALUE, config.reasoningTextDisplay)) {
      throw new TypeError("OpenAI reasoningTextDisplay must be a boolean");
    }
    super("openai", {
      baseUrl,
      headers: config.headers,
      fetch: fetchImplementation,
      authorize: async (headers, signal) => {
        const token = (await resolveToken(config.accessToken, signal)) ?? (await resolveToken(config.apiKey, signal));
        if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
        if (config.organization !== undefined) headers.set("openai-organization", config.organization);
        if (config.project !== undefined) headers.set("openai-project", config.project);
      },
      ...optionalProperties(baseUrl === "https://api.openai.com/v1" ? {
            streamEvents: createOpenAISdkEventStream({
              baseUrl,
              fetch: fetchImplementation,
              fallback: httpResponsesWireEvents,
              eventFromValue: responsesWireEventFromValue,
            }),
          } : undefined),
      stateful: config.store ?? false,
      promptCache: true,
      deferredToolLoading: config.deferredToolLoading ?? baseUrl === "https://api.openai.com/v1",
      supportsReasoningSummaries: config.reasoningSummaries ?? baseUrl === "https://api.openai.com/v1",
      reasoningTextVisibility: config.reasoningTextDisplay === true ? "summary" : "provider_trace",
      ...optionalProperties(config.promptCacheOptions === undefined ? undefined : { promptCacheOptions: openAIPromptCacheOptions(config.promptCacheOptions) }),
      ...optionalProperties(config.promptCacheRetention === undefined ? undefined : { promptCacheRetention: promptCacheRetention(config.promptCacheRetention) }),
      ...optionalProperties(config.serviceTier === undefined ? undefined : { serviceTier: openAIServiceTier(config.serviceTier) }),
    });
  }
}

export class AzureOpenAIResponsesAdapter extends ResponsesAdapter {
  constructor(config: AzureOpenAIResponsesConfig) {
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    const baseUrl = trimSlash(azureV1Base(config.endpoint));
    assertSecureEndpoint(baseUrl, "Azure OpenAI endpoint");
    super("azure-openai", {
      baseUrl,
      headers: config.headers,
      fetch: fetchImplementation,
      authorize: async (headers, signal) => {
        const accessToken = await resolveToken(config.accessToken, signal);
        if (accessToken !== undefined) {
          headers.set("authorization", `Bearer ${accessToken}`);
          return;
        }
        const apiKey = await resolveToken(config.apiKey, signal);
        if (apiKey !== undefined) headers.set("api-key", apiKey);
      },
      ...optionalProperties(config.deploymentName === undefined ? undefined : {
            buildBody: (request) => buildResponsesBody(
              { ...request, model: config.deploymentName! },
              config.store ?? false,
              false,
              undefined,
              undefined,
              undefined,
              false,
              true,
            ),
          }),
      streamEvents: createAzureOpenAISdkEventStream({
        baseUrl,
        apiVersion: config.apiVersion ?? "v1",
        fetch: fetchImplementation,
        eventFromValue: responsesWireEventFromValue,
      }),
      stateful: config.store ?? false,
      promptCache: false,
      deferredToolLoading: false,
      supportsReasoningSummaries: true,
      reasoningTextVisibility: "provider_trace",
    });
  }
}

export function buildResponsesBody(
  request: ProviderRequest,
  stateful: boolean,
  promptCache: boolean,
  retention?: "in-memory" | "24h",
  serviceTier?: OpenAIServiceTier,
  cacheOptions?: OpenAIPromptCacheOptions,
  deferredToolLoading = false,
  supportsReasoningSummaries = false,
): ResponsesRequestBody {
  request = providerWireRequest(request, request.providerState?.kind === "openai_responses");
  const effectiveStateful = stateful && request.cacheRetention !== "none";
  const compatibility = request.modelSettings?.compatibility;
  const promptCacheEnabled = promptCache && request.cacheRetention !== "none";
  const supportsPromptCacheBreakpoints = promptCacheEnabled &&
    request.provider === "openai" &&
    request.api === "openai-responses" &&
    compatibility?.supportsPromptCacheBreakpoints === true;
  const input = buildResponsesInput(request, compatibility?.supportsDeveloperRole === true);
  const breakpointInput = supportsPromptCacheBreakpoints
    ? markStableInstructionBreakpoint(input)
    : { input, applied: false };
  const body: ResponsesRequestBody = {
    model: request.model,
    input: breakpointInput.input,
    stream: true,
    store: effectiveStateful,
  };
  if (!effectiveStateful) body.include = ["reasoning.encrypted_content"];
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = Math.max(16, request.maxOutputTokens);
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const reasoningEffort = openAIReasoningEffort(request);
  if (reasoningEffort !== undefined && reasoningEffort !== null) {
    body.reasoning = {
      effort: reasoningEffort,
      ...optionalProperties(supportsReasoningSummaries && reasoningEffort !== "none" ? { summary: "auto" } : undefined),
    };
  }
  if (request.tools.length > 0) {
    const supportsToolSearch = compatibility?.supportsToolSearch ?? (
      deferredToolLoading && request.provider === "openai" && openAIDeferredToolsSupported(request.model)
    );
    const useDeferredTools = supportsToolSearch &&
      request.tools.some((tool) => tool.loading === "deferred");
    const supportsGrammar = compatibility?.supportsOpenAIGrammarTools === true;
    const supportsStrict = compatibility?.supportsStrictMode ?? true;
    const tools = request.tools.map((tool) => {
      const grammar = providerGrammarTool(tool, supportsGrammar);
      if (grammar) {
        return {
          type: "custom",
          name: tool.name,
          description: tool.description,
          format: { type: "grammar", syntax: grammar.format, definition: grammar.definition },
          ...optionalProperties(useDeferredTools && tool.loading === "deferred" ? { defer_loading: true } : undefined),
        };
      }
      const strict = providerStrictTool(tool, supportsStrict);
      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        ...optionalProperties(supportsStrict ? { strict: strict ?? false } : undefined),
        ...optionalProperties(useDeferredTools && tool.loading === "deferred" ? { defer_loading: true } : undefined),
      };
    });
    body.tools = useDeferredTools ? [...tools, { type: "tool_search" }] : tools;
  }
  if (request.toolChoice !== undefined) body.tool_choice = openAIToolChoice(request.toolChoice);
  if (request.metadata !== undefined) body.metadata = request.metadata;
  if (promptCacheEnabled && request.sessionId !== undefined && request.sessionId !== "") {
    body.prompt_cache_key = openAIPromptCacheKey(request.sessionId);
  }
  if (promptCacheEnabled && breakpointInput.applied) {
    body.prompt_cache_options = { mode: "explicit", ttl: "30m" };
  } else if (promptCacheEnabled && cacheOptions !== undefined) {
    body.prompt_cache_options = { ttl: cacheOptions.ttl };
  }
  if (
    promptCache &&
    request.cacheRetention === "none" &&
    compatibility?.supportsExplicitPromptCacheMode === true
  ) {
    body.prompt_cache_options = { mode: "explicit" };
  }
  // Current wire values: https://developers.openai.com/api/docs/guides/prompt-caching#prompt-cache-retention
  // The API uses an underscore even though the harness setting uses the more
  // readable `in-memory` spelling.
  const requestRetention = request.api === "openai-responses" && request.provider === "openai"
    ? request.cacheRetention === "short"
      ? "in-memory"
      : request.cacheRetention === "long"
        ? compatibility?.supportsLongCacheRetention === false ? "in-memory" : "24h"
        : retention
    : retention;
  if (
    promptCacheEnabled &&
    !supportsPromptCacheBreakpoints &&
    requestRetention !== undefined &&
    !(requestRetention === "24h" && compatibility?.supportsLongCacheRetention === false)
  ) {
    body.prompt_cache_retention = requestRetention === "in-memory" ? "in_memory" : requestRetention;
  }
  if (serviceTier !== undefined) body.service_tier = serviceTier;
  const state = request.providerState?.kind === "openai_responses" ? request.providerState : undefined;
  if (effectiveStateful && state?.previousResponseId !== undefined) body.previous_response_id = state.previousResponseId;
  return body;
}

function openAIReasoningEffort(request: ProviderRequest): string | null | undefined {
  if (request.modelSettings?.compatibility?.supportsReasoningEffort === false) return undefined;
  if (request.reasoningEffort === undefined) return undefined;
  const key = request.reasoningEffort === "none" ? "off" : request.reasoningEffort;
  const mapped = request.modelSettings?.reasoningEffortMap?.[key];
  const effort = mapped !== undefined || Object.hasOwn(request.modelSettings?.reasoningEffortMap ?? {}, key)
    ? mapped === "off" ? "none" : mapped
    : request.reasoningEffort === "off" ? "none" : request.reasoningEffort;
  if (effort !== null) {
    assertCurrentProviderReasoningEffort(effort);
    if (request.provider === "openai" || request.provider === "openai-codex" || request.provider === "azure-openai") {
      assertOpenAIReasoningEffort(effort);
    }
  }
  return effort;
}

function openAIToolChoice(toolChoice: NonNullable<ProviderRequest["toolChoice"]>): ResponsesToolChoice {
  if (!Value.Check(STRING_VALUE, toolChoice)) return { type: "function", name: toolChoice.function.name };
  return toolChoice;
}

function markStableInstructionBreakpoint(input: JsonValue[]): MarkedResponsesInput {
  let selected: { item: number; block?: number } | undefined;
  for (let itemIndex = 0; itemIndex < input.length; itemIndex += 1) {
    const item = asRecord(input[itemIndex]);
    const role = asString(item?.role);
    if (role !== "system" && role !== "developer") continue;
    const textContent = asString(item?.content);
    if (textContent !== undefined) {
      if (textContent !== "") selected = { item: itemIndex };
      continue;
    }
    const content = asArray(item?.content);
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = asRecord(content[blockIndex]);
      if (block?.type === "input_text" && asString(block.text) !== "") {
        selected = { item: itemIndex, block: blockIndex };
      }
    }
  }
  if (selected === undefined) return { input, applied: false };

  const marked = [...input];
  const item = asRecord(input[selected.item]);
  if (item === undefined) throw new ProtocolError("Stable instruction breakpoint item was invalid");
  if (selected.block === undefined) {
    const text = asString(item.content);
    if (text === undefined) throw new ProtocolError("Stable instruction breakpoint text was invalid");
    marked[selected.item] = {
      ...item,
      content: [{
        type: "input_text",
        text,
        prompt_cache_breakpoint: { mode: "explicit" },
      }],
    };
  } else {
    const content = [...asArray(item.content)];
    content[selected.block] = {
      ...asRecord(content[selected.block]),
      prompt_cache_breakpoint: { mode: "explicit" },
    };
    marked[selected.item] = { ...item, content };
  }
  return { input: marked, applied: true };
}

function openAIPromptCacheOptions<Input>(value: Input): OpenAIPromptCacheOptions {
  if (!isJsonObject(value)) {
    throw new TypeError("OpenAI promptCacheOptions must be an object");
  }
  const unknown = Object.keys(value).filter((key) => key !== "ttl");
  if (unknown.length > 0) {
    throw new TypeError(`OpenAI promptCacheOptions contains unknown keys: ${unknown.join(", ")}`);
  }
  if (value.ttl !== "30m") throw new TypeError("OpenAI promptCacheOptions.ttl must be 30m");
  return { ttl: "30m" };
}

function promptCacheRetention(value: string): "in-memory" | "24h" {
  if (value !== "in-memory" && value !== "24h") {
    throw new TypeError("OpenAI promptCacheRetention must be in-memory or 24h");
  }
  return value;
}

function openAIServiceTier(value: string): OpenAIServiceTier {
  if (value !== "auto" && value !== "default" && value !== "flex" && value !== "priority") {
    throw new TypeError("OpenAI serviceTier must be auto, default, flex, or priority");
  }
  return value;
}

function knownOpenAIServiceTier(value: string | undefined): OpenAIServiceTier | undefined {
  return value === "auto" || value === "default" || value === "flex" || value === "priority"
    ? value
    : undefined;
}

function openAIDeferredToolsSupported(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(model);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 4);
}

function openAIDeferredToolsCapability(model: string, observedAt: string): ModelCapability {
  const recognized = /^gpt-\d+(?:\.\d+)?(?:-|$)/u.test(model);
  return modelEvidence(
    openAIDeferredToolsSupported(model) ? "supported" : recognized ? "unsupported" : "unknown",
    "maintained",
    observedAt,
  );
}

function buildResponsesInput(request: ProviderRequest, supportsDeveloperRole: boolean): JsonValue[] {
  const state = request.providerState?.kind === "openai_responses" ? request.providerState : undefined;
  const grammarProperties = providerGrammarProperties(
    request.tools,
    request.modelSettings?.compatibility?.supportsOpenAIGrammarTools === true,
  );
  const lastAssistant = findLastAssistant(request);
  if (
    request.cacheRetention !== "none" &&
    state?.previousResponseId !== undefined &&
    lastAssistant >= 0
  ) {
    return request.messages.slice(lastAssistant + 1).flatMap((message) =>
      messageToResponsesItems(message, request.provider, supportsDeveloperRole, grammarProperties));
  }
  if (state !== undefined && state.outputItems.length > 0 && lastAssistant >= 0) {
    return [
      ...request.messages.slice(0, lastAssistant).flatMap((message) =>
        messageToResponsesItems(message, request.provider, supportsDeveloperRole, grammarProperties)),
      ...state.outputItems,
      ...request.messages.slice(lastAssistant + 1).flatMap((message) =>
        messageToResponsesItems(message, request.provider, supportsDeveloperRole, grammarProperties)),
    ];
  }
  return request.messages.flatMap((message) =>
    messageToResponsesItems(message, request.provider, supportsDeveloperRole, grammarProperties));
}

function messageToResponsesItems(
  message: ProviderRequest["messages"][number],
  provider: ProviderId,
  supportsDeveloperRole: boolean,
  grammarProperties: ReadonlyMap<string, string>,
): JsonValue[] {
  const items: JsonValue[] = [];
  const text: string[] = [];
  const content: ResponsesInputContent[] = [];
  let hasImage = false;
  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
      content.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      hasImage = true;
      content.push(responsesImageContent(block));
    } else if (block.type === "tool_result") {
      const resultText = toolResultText(block);
      if (grammarProperties.has(block.name)) {
        items.push({
          type: "custom_tool_call_output",
          call_id: block.callId,
          output: resultText,
        });
        if ((block.images?.length ?? 0) > 0) {
          items.push({
            role: "user",
            content: block.images!.map(responsesImageContent),
          });
        }
      } else {
        const output = (block.images?.length ?? 0) === 0
          ? resultText
          : [
              { type: "input_text", text: resultText },
              ...(block.images ?? []).map(responsesImageContent),
            ];
        items.push({ type: "function_call_output", call_id: block.callId, output });
      }
    } else if (block.type === "tool_call") {
      const property = grammarProperties.get(block.name);
      const grammarArguments = property === undefined ? undefined : asRecord(block.arguments);
      if (property !== undefined && grammarArguments === undefined) {
        throw new InvalidProviderRequestError(`Grammar tool ${block.name} arguments must be an object`);
      }
      items.push(property === undefined
        ? {
            type: "function_call",
            call_id: block.callId,
            name: block.name,
            arguments: stringifyProviderJson(block.arguments),
          }
        : {
            type: "custom_tool_call",
            call_id: block.callId,
            name: block.name,
            input: providerGrammarInput(block.name, grammarArguments ?? {}, property),
          });
    } else if (block.type === "provider_opaque" && block.provider === provider) {
      items.push(block.value);
    }
  }
  if (content.length > 0) {
    items.unshift({
      role: message.role === "tool"
        ? "user"
        : message.role === "system" && supportsDeveloperRole
          ? "developer"
          : message.role,
      content: hasImage ? content : text.join("\n"),
    });
  }
  return items;
}

function applyResponsesSessionHeaders(headers: Headers, request: ProviderRequest): void {
  if (request.cacheRetention === "none") {
    headers.delete("session-id");
    headers.delete("session_id");
    headers.delete("x-session-id");
    headers.delete("x-client-request-id");
    headers.delete("x-session-affinity");
    return;
  }
  if (
    request.sessionId === undefined ||
    request.sessionId === ""
  ) return;
  const sessionId = request.provider === "openai" || request.provider === "openai-codex"
    ? openAIPromptCacheKey(request.sessionId)
    : request.sessionId;
  const format = request.modelSettings?.compatibility?.sessionAffinityFormat ?? "openai";
  if (format === "openrouter") {
    headers.set("x-session-id", sessionId);
    return;
  }
  if (format === "openai") headers.set("session_id", sessionId);
  headers.set("x-client-request-id", sessionId);
}

function responsesImageContent(block: ImageBlock): ResponsesImageContent {
  const source = normalizeImageSource(block, "OpenAI Responses");
  requireImageMediaType(source, "OpenAI Responses", ["image/jpeg", "image/png", "image/gif", "image/webp"]);
  requireImageUrlProtocol(source, "OpenAI Responses", ["http:", "https:"]);
  return {
    type: "input_image",
    image_url: source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`,
  };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function findTool(
  tools: Map<string, ToolAccumulator>,
  event: JsonObject,
): FoundTool {
  const itemId = asString(event.item_id);
  const index = asNumber(event.output_index);
  for (const tool of tools.values()) {
    if ((itemId !== undefined && tool.itemId === itemId) || (index !== undefined && tool.index === index)) {
      return { tool, created: false };
    }
  }
  const tool: ToolAccumulator = { index: index ?? tools.size, arguments: "", ended: false };
  if (itemId !== undefined) tool.itemId = itemId;
  tools.set(itemId ?? `index:${tool.index}`, tool);
  return { tool, created: true };
}

function finishTool(tool: ToolAccumulator): AdapterEvent {
  tool.ended = true;
  const name = tool.name ?? "unknown_tool";
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: tool.index,
    name,
    rawArguments: tool.arguments,
  };
  if (tool.id !== undefined) event.id = tool.id;
  try {
    event.arguments = jsonValueOrString(parseJsonWithRepair(tool.arguments === "" ? "{}" : tool.arguments));
  } catch (error) {
    event.parseError = error instanceof Error ? error.message : String(error);
  }
  return event;
}

function responseOptionalPartIndex(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const index = asNumber(value);
  if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
    throw new ProtocolError(`Responses ${label} must be a non-negative safe integer`);
  }
  return index;
}

function responsePartIndex(value: JsonValue | undefined, label: string): number {
  return responseOptionalPartIndex(value, label) ?? 0;
}

function responsePartItemId(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const itemId = asString(value);
  if (
    itemId === undefined
    || itemId === ""
    || Buffer.byteLength(itemId, "utf8") > MAX_RESPONSES_PART_ID_BYTES
    || hasControlCharacters(itemId)
  ) {
    throw new ProtocolError(
      `Responses ${label} must be a non-empty identity without control characters and no larger than ${MAX_RESPONSES_PART_ID_BYTES} UTF-8 bytes`,
    );
  }
  return itemId;
}

function responseTextPartAliases(event: JsonObject): ResponsesPartAlias[] {
  return responsePartAliases(
    responseOptionalPartIndex(event.output_index, "output_index"),
    responsePartItemId(event.item_id, "item_id"),
    responsePartIndex(event.content_index, "content_index"),
  );
}

function responseReasoningPartAliases(
  event: JsonObject,
  summary: boolean,
): ResponsesPartAlias[] {
  const summaryIndex = responseOptionalPartIndex(event.summary_index, "summary_index");
  const contentIndex = responseOptionalPartIndex(event.content_index, "content_index");
  return responsePartAliases(
    responseOptionalPartIndex(event.output_index, "output_index"),
    responsePartItemId(event.item_id, "item_id"),
    summary ? summaryIndex ?? contentIndex ?? 0 : contentIndex ?? 0,
    summary ? "summary" : "reasoning",
  );
}

function responsePartAliases(
  outputIndex: number | undefined,
  itemId: string | undefined,
  part: number,
  scope?: "summary" | "reasoning",
): ResponsesPartAlias[] {
  const prefix = scope === undefined ? "" : `${scope}:`;
  const aliases: Array<Omit<ResponsesPartAlias, "bytes">> = [];
  if (itemId !== undefined) aliases.push({ key: `${prefix}item:${itemId}:${part}`, kind: "item" });
  if (outputIndex !== undefined) aliases.push({ key: `${prefix}output:${outputIndex}:${part}`, kind: "output" });
  if (aliases.length === 0) aliases.push({ key: `${prefix}unscoped:${part}`, kind: "unscoped" });
  return aliases.map((alias) => ({ ...alias, bytes: Buffer.byteLength(alias.key, "utf8") }));
}

function responseContentEntryHasSemanticContent(value: JsonValue): boolean {
  const content = asRecord(value);
  if (content === undefined) return true;
  const type = asString(content.type);
  if (type === "output_text") {
    const text = asString(content.text);
    return text === undefined
      || (content.annotations !== undefined && !Array.isArray(content.annotations))
      || text !== ""
      || asArray(content.annotations).length > 0;
  }
  if (type === "refusal") {
    const refusal = asString(content.refusal);
    return refusal === undefined || refusal !== "";
  }
  if (type === "reasoning_text" || type === "summary_text") {
    const text = asString(content.text);
    return text === undefined || text !== "";
  }
  return true;
}

function responseContentListHasSemanticContent(
  value: JsonValue | undefined,
  allowedTypes: ReadonlySet<string>,
): boolean {
  return !Array.isArray(value) || value.some((entry) => {
    const content = asRecord(entry);
    return content === undefined
      || !allowedTypes.has(asString(content.type) ?? "")
      || responseContentEntryHasSemanticContent(content);
  });
}

const responseMessageContentTypes = new Set(["output_text", "refusal"]);
const responseReasoningSummaryTypes = new Set(["summary_text"]);
const responseReasoningContentTypes = new Set(["reasoning_text"]);

function responseOutputItemHasSemanticContent(item: JsonObject): boolean {
  if (item.type === "function_call" || item.type === "custom_tool_call") return true;
  if (item.type === "message") {
    return responseContentListHasSemanticContent(item.content, responseMessageContentTypes);
  }
  if (item.type === "reasoning") {
    if (
      item.encrypted_content !== undefined
      && item.encrypted_content !== null
      && asString(item.encrypted_content) === undefined
    ) return true;
    if ((asString(item.encrypted_content) ?? "") !== "") return true;
    return (item.summary !== undefined
      && responseContentListHasSemanticContent(item.summary, responseReasoningSummaryTypes))
      || (item.content !== undefined
        && responseContentListHasSemanticContent(item.content, responseReasoningContentTypes));
  }
  return true;
}

function responseObjectHasSemanticOutput(response: JsonObject | undefined): boolean {
  const output = response?.output;
  if (output === undefined) return false;
  if (!Array.isArray(output)) return true;
  return output.some((item) => {
    const record = asRecord(item);
    return record === undefined || responseOutputItemHasSemanticContent(record);
  });
}

function usageFromResponse<Input>(value: Input, serviceTier?: OpenAIServiceTier): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return normalizeUsage({
    raw: jsonValueOrString({
      ...usage,
      ...optionalProperties(serviceTier === undefined ? undefined : { service_tier: serviceTier }),
    }),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reportedTotalTokens: usage.total_tokens,
    cacheReadTokens: inputDetails?.cached_tokens,
    cacheWriteTokens: inputDetails?.cache_write_tokens,
    reasoningTokens: outputDetails?.reasoning_tokens,
    inputIncludesCache: true,
  });
}

function resolvedResponsesServiceTier(
  provider: ProviderId,
  responseTier: string | undefined,
  requestTier: OpenAIServiceTier | undefined,
): OpenAIServiceTier | undefined {
  const reported = knownOpenAIServiceTier(responseTier);
  if (
    provider === "openai-codex" &&
    reported === "default" &&
    (requestTier === "flex" || requestTier === "priority")
  ) return requestTier;
  return reported ?? requestTier;
}

function responsesState(responseId: string | undefined, items: Map<number, JsonValue>): ProviderState {
  const state: Extract<ProviderState, { kind: "openai_responses" }> = {
    kind: "openai_responses",
    outputItems: [...items.entries()].sort(([left], [right]) => left - right).map(([, value]) => value),
  };
  if (responseId !== undefined) state.previousResponseId = responseId;
  return state;
}

function incompleteReason(response: JsonObject | undefined): string | undefined {
  return asString(asRecord(response?.incomplete_details)?.reason);
}

function mapIncompleteReason(reason: string | undefined): FinishReason {
  if (reason === "max_output_tokens") return "length";
  if (reason?.includes("context") === true) return "context_limit";
  if (reason?.includes("filter") === true) return "content_filter";
  return "incomplete";
}

function isIgnorableCodexInformationalEvent(provider: ProviderId, type: string): boolean {
  return provider === "openai-codex" && (
    type === "codex.rate_limits"
    || type === "codex.response.metadata"
    || type === "responsesapi.websocket_timing"
  );
}

function parseJson(text: string, label: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonValue(parsed)) throw new ProtocolError(`Malformed ${label}`, text);
    return parsed;
  } catch {
    throw new ProtocolError(`Malformed ${label}`, text);
  }
}

type ResponsesToolChoice = string | { type: "function"; name: string };

type MarkedResponsesInput = {
  input: JsonValue[];
  applied: boolean;
};

type ResponsesInputContent = {
  type: "input_text" | "input_image";
  text?: string;
  image_url?: string;
};

type ResponsesImageContent = {
  type: "input_image";
  image_url: string;
};

type FoundTool = {
  tool: ToolAccumulator;
  created: boolean;
};

type ResponsesRequestBody = {
  model: string;
  input: JsonValue[];
  stream: true;
  store: boolean;
  include?: string[];
  max_output_tokens?: number;
  temperature?: number;
  reasoning?: JsonObject;
  tools?: JsonValue[];
  tool_choice?: ResponsesToolChoice;
  metadata?: Record<string, string>;
  prompt_cache_key?: string;
  prompt_cache_options?: JsonObject;
  prompt_cache_retention?: string;
  service_tier?: OpenAIServiceTier;
  previous_response_id?: string;
  instructions?: string;
  text?: JsonObject;
  parallel_tool_calls?: boolean;
};

function unknownCapabilities(observedAt: string): ModelInfo["capabilities"] {
  const capability = { value: "unknown" as const, source: "provider" as const, observedAt };
  return { tools: capability, reasoning: capability, images: capability };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function azureV1Base(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new TypeError(`Invalid Azure OpenAI endpoint: ${endpoint}`);
  }
  const path = url.pathname.replace(/\/+$/u, "");
  const serviceHost = [".openai.azure.com", ".cognitiveservices.azure.com", ".ai.azure.com"]
    .some((suffix) => url.hostname.endsWith(suffix));
  if (serviceHost && (path === "" || path === "/" || path === "/openai" || path === "/openai/v1/responses")) {
    url.pathname = "/openai/v1";
    url.search = "";
  }
  return url.toString().replace(/\/+$/u, "");
}
