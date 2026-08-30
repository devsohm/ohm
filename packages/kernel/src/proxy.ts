import { optionalProperty } from "./internal/optional-properties.js";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamOptions,
  type Usage,
} from "@ohm/models";
import { Check } from "typebox/value";

import { ASSISTANT_CONTENT_LIMITS } from "./runtime/core/assistant-content-limits.js";
import { canonicalAssistantDiagnostics } from "./runtime/core/assistant-diagnostics.js";
import { assertRedactableSecret, defaultSecretRedactor } from "./runtime/auth/redaction.js";
import { boundedJsonSnapshot } from "./runtime/core/bounded-json.js";
import { isJsonObject, toJsonValue, type JsonObject, type JsonValue } from "./runtime/core/json.js";
import { canonicalUsageCost } from "./runtime/core/usage.js";
import {
	BOOLEAN_VALUE,
	hasControlCharacters,
	isObjectValue,
	NUMBER_VALUE,
  STRING_VALUE,
} from "./internal/value-schemas.js";
import {
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "./runtime/core/events.js";

const REQUEST_LIMIT = 16 * 1024 * 1024;
const ERROR_BODY_LIMIT = 64 * 1024;
const WIRE_LIMIT = 64 * 1024 * 1024;
const LINE_LIMIT = 32 * 1024 * 1024;
const CHUNK_LIMIT = 64 * 1024 * 1024;
const EVENT_LIMIT = 65_536;
const QUEUED_EVENT_LIMIT = 4_096;
const QUEUED_EVENT_BYTES_LIMIT = 32 * 1024 * 1024;
const PENDING_READ_LIMIT = 4_096;
const TOOL_LIMIT = 256;
const RESPONSE_ID_LIMIT = 4 * 1024;
const RESPONSE_MODEL_LIMIT = 1_024;
const ERROR_MESSAGE_LIMIT = 4 * 1024;
const CONTENT_LIMITS = ASSISTANT_CONTENT_LIMITS;

export type ProxyStreamOptions = Omit<StreamOptions, "metadata" | "signal"> & {
  /** Bearer credential; four characters is the minimum reliably redacted length. */
  authToken: string;
  proxyUrl: string;
  signal?: AbortSignal;
  metadata?: object;
};

interface QueueWaiter {
  accept: (value: IteratorResult<AssistantMessageEvent>) => void;
}

class ProxyEventQueue implements AsyncIterable<AssistantMessageEvent> {
  readonly #events: Array<{ event: AssistantMessageEvent; bytes: number }> = [];
  readonly #waiters: QueueWaiter[] = [];
  readonly #resultPromise: Promise<AssistantMessage>;
  #resolveResult!: (message: AssistantMessage) => void;
  #ended = false;
  #queuedBytes = 0;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor() {
    this.#resultPromise = new Promise<AssistantMessage>((accept) => { this.#resolveResult = accept; });
  }

  attachReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.#reader = reader;
  }

  emit(event: AssistantMessageEvent, retainedBytes?: number): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.accept({ done: false, value: event });
    else {
      const bytes = retainedBytes ?? Buffer.byteLength(JSON.stringify(event), "utf8");
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Proxy event retention estimate is invalid");
      }
      if (this.#events.length >= QUEUED_EVENT_LIMIT || this.#queuedBytes + bytes > QUEUED_EVENT_BYTES_LIMIT) {
        this.#events.length = 0;
        this.#queuedBytes = 0;
        throw new Error("Proxy event buffer exceeded its retention limit");
      }
      this.#events.push({ event, bytes });
      this.#queuedBytes += bytes;
    }
  }

  finish(message: AssistantMessage): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#resolveResult(message);
    for (const waiter of this.#waiters.splice(0)) waiter.accept({ done: true, value: undefined });
  }

  fail(message: AssistantMessage): void {
    if (this.#ended) return;
    this.#events.length = 0;
    this.#queuedBytes = 0;
    const event: AssistantMessageEvent = { type: "error", reason: "error", error: message };
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.accept({ done: false, value: event });
    else {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      this.#events.push({ event, bytes });
      this.#queuedBytes = bytes;
    }
    this.finish(message);
  }

  async result(): Promise<AssistantMessage> {
    return this.#resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return {
      next: async () => {
        const queued = this.#events.shift();
        if (queued !== undefined) {
          this.#queuedBytes -= queued.bytes;
          return { done: false as const, value: queued.event };
        }
        if (this.#ended) return { done: true as const, value: undefined };
        if (this.#waiters.length >= PENDING_READ_LIMIT) {
          throw new Error("Proxy event stream exceeded its pending-read limit");
        }
        return new Promise<IteratorResult<AssistantMessageEvent>>((accept) => this.#waiters.push({ accept }));
      },
      return: async () => {
        await this.#reader?.cancel().catch(() => undefined);
        return { done: true as const, value: undefined };
      },
    };
  }
}

function safeJson<Value>(value: Value, depth = 0): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || Check(STRING_VALUE, value) || Check(BOOLEAN_VALUE, value)) return value;
  if (Check(NUMBER_VALUE, value)) {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return value;
  }
	if (!isObjectValue(value)) throw new TypeError("Value is not JSON-safe");
  if (depth > 64) throw new TypeError("JSON value is too deeply nested");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
      throw new TypeError("Invalid array length");
    }
    const output: JsonValue[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Sparse arrays are not supported");
      output.push(safeJson(descriptor.value, depth + 1) ?? null);
    }
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Only plain JSON objects are supported");
  const output: JsonObject = {};
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) throw new TypeError(`Property ${name} must not be an accessor`);
    const selected = safeJson(descriptor.value, depth + 1);
    if (selected !== undefined) {
      Object.defineProperty(output, name, {
        configurable: true,
        enumerable: true,
        value: selected,
        writable: true,
      });
    }
  }
  return output;
}

function cloneRecord<Value>(value: Value, label: string): JsonObject {
  const selected = safeJson(value);
  if (!isJsonObject(selected)) {
    throw new TypeError(`${label} must be an object`);
  }
  return selected;
}

function terminalIdentity<Value>(
  value: Value,
  label: string,
  maximumBytes: number,
  requestToken?: string,
): string | undefined {
  if (value === undefined) return undefined;
	if (
		!Check(STRING_VALUE, value) || value === "" || Buffer.byteLength(value, "utf8") > maximumBytes ||
		hasControlCharacters(value)
	) throw new TypeError(`Invalid terminal ${label}`);
  if (requestToken !== undefined && value.includes(requestToken)) {
    throw new TypeError(`Terminal ${label} contains request credentials`);
  }
  return value;
}

function containsText(value: JsonValue, selected: string): boolean {
  if (Check(STRING_VALUE, value)) return value.includes(selected);
  if (Array.isArray(value)) return value.some((item) => containsText(item, selected));
  if (isJsonObject(value)) {
    return Object.entries(value).some(([name, item]) => name.includes(selected) || containsText(item, selected));
  }
  return false;
}

function rejectRequestToken(value: JsonValue | undefined, requestToken: string, label: string): void {
  if (value !== undefined && containsText(value, requestToken)) {
    throw new TypeError(`${label} contains request credentials`);
  }
}

function rejectAppendedRequestToken(
  retained: string,
  delta: string,
  requestToken: string,
  label: string,
): string {
  const candidate = `${retained}${delta}`;
  if (candidate.includes(requestToken)) {
    throw new TypeError(`${label} contains request credentials`);
  }
  return candidate.slice(Math.max(0, candidate.length - requestToken.length + 1));
}

function terminalErrorMessage<Value>(value: Value, requestToken: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Check(STRING_VALUE, value)) throw new TypeError("Terminal error message must be text");
  const message = defaultSecretRedactor.redact(value).split(requestToken).join("[REDACTED]").replaceAll("\0", "�");
  if (Buffer.byteLength(message, "utf8") > ERROR_MESSAGE_LIMIT) {
    throw new TypeError("Terminal error message exceeds its byte limit");
  }
  return message;
}

function redactedFailureMessage<Value>(value: Value, requestToken: string, fallback: string): string {
  const message = Check(STRING_VALUE, value)
    ? defaultSecretRedactor.redact(value).split(requestToken).join("[REDACTED]").replaceAll("\0", "�")
    : fallback;
  return Buffer.byteLength(message, "utf8") <= ERROR_MESSAGE_LIMIT ? message : fallback;
}

function terminalProviderState<Value>(
  value: Value,
  model: Model,
  requestToken: string,
): AssistantMessage["providerState"] | undefined {
  if (value === undefined) return undefined;
  const bounded = boundedJsonSnapshot(value, {
    label: "Proxy provider state",
    maximumBytes: ASSISTANT_CONTENT_LIMITS.contentBytes,
    maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
  });
	const snapshot = toJsonValue(JSON.parse(bounded.serialized));
  rejectRequestToken(snapshot, requestToken, "Terminal provider state");
  if (!isJsonObject(snapshot)) {
    throw new TypeError("Provider state is invalid");
  }
  if (Object.keys(snapshot).length !== 2 || !Object.hasOwn(snapshot, "source") || !Object.hasOwn(snapshot, "value")) {
    throw new TypeError("Provider state is invalid");
  }
  const source = snapshot.source;
  if (!isJsonObject(source)) {
    throw new TypeError("Provider state is invalid");
  }
  if (
    Object.keys(source).length !== 3 || source.api !== model.api ||
    source.provider !== model.provider || source.model !== model.id
  ) throw new TypeError("Provider state crosses the selected model boundary");
  const provider = terminalIdentity(source.provider, "provider state provider", RESPONSE_ID_LIMIT);
  const modelId = terminalIdentity(source.model, "provider state model", RESPONSE_ID_LIMIT);
  const api = terminalIdentity(source.api, "provider state API", RESPONSE_ID_LIMIT);
  if (provider === undefined || modelId === undefined || api === undefined) {
    throw new TypeError("Provider state source is invalid");
  }
  return {
    source: { api: model.api, provider, model: modelId },
    value: snapshot.value,
  };
}

function emptyUsage(): Usage {
  return {};
}

function errorMessage(model: Model, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function partialMessage(model: Model, content: AssistantMessage["content"]): AssistantMessage {
  const snapshot = structuredClone(content);
  return {
    role: "assistant",
    content: snapshot,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function validateUsage<Value>(value: Value): Usage {
  const usage = cloneRecord(value, "usage");
  const allowedUsageKeys = new Set([
    "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost",
  ]);
  if (Object.keys(usage).some((key) => !allowedUsageKeys.has(key))) {
    throw new TypeError("Invalid usage field");
  }
  const numeric = (name: string): number => {
    const selected = usage[name];
    if (!Check(NUMBER_VALUE, selected) || !Number.isSafeInteger(selected) || selected < 0) {
      throw new TypeError(`Invalid usage ${name}`);
    }
    return selected;
  };
  const optionalNumeric = (name: string): number | undefined =>
    usage[name] === undefined ? undefined : numeric(name);
  const input = optionalNumeric("input");
  const output = optionalNumeric("output");
  const cacheRead = usage.cacheRead === undefined ? undefined : numeric("cacheRead");
  const cacheWrite = usage.cacheWrite === undefined ? undefined : numeric("cacheWrite");
  const totalTokens = optionalNumeric("totalTokens");
  const knownTotal = [input, output, cacheRead, cacheWrite]
    .filter((candidate): candidate is number => candidate !== undefined)
    .reduce((sum, candidate) => sum + candidate, 0);
  if (!Number.isSafeInteger(knownTotal) || (totalTokens !== undefined && totalTokens < knownTotal)) {
    throw new TypeError("Invalid usage token total");
  }
  const componentTotal = input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined
    ? input + output + cacheRead + cacheWrite
    : undefined;
  if (componentTotal !== undefined && !Number.isSafeInteger(componentTotal)) {
    throw new TypeError("Invalid usage token total");
  }
  if (totalTokens !== undefined && componentTotal !== undefined && totalTokens !== componentTotal) {
    throw new TypeError("Invalid usage token total");
  }
  const cacheWrite1h = optionalNumeric("cacheWrite1h");
  if (cacheWrite1h !== undefined && (
    cacheWrite === undefined ||
    cacheWrite1h > cacheWrite
  )) {
    throw new TypeError("Invalid usage one-hour cache write count");
  }
  const reasoning = optionalNumeric("reasoning");
  let validatedCost: Usage["cost"];
  if (usage.cost !== undefined) {
    const cost = cloneRecord(usage.cost, "usage cost");
    const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
    const allowedCostFields = new Set<string>(costFields);
    if (Object.keys(cost).length !== costFields.length || Object.keys(cost).some((key) => !allowedCostFields.has(key))) {
      throw new TypeError("Invalid usage cost field");
    }
    for (const name of costFields) {
      if (!Check(NUMBER_VALUE, cost[name]) || !Number.isFinite(cost[name]) || cost[name] < 0) {
        throw new TypeError(`Invalid usage cost ${name}`);
      }
    }
    validatedCost = canonicalUsageCost(cost);
    if (validatedCost === undefined) throw new TypeError("Invalid usage cost total");
  }
  return {
    ...optionalProperty("input", input),
    ...optionalProperty("output", output),
    ...optionalProperty("cacheRead", cacheRead),
    ...optionalProperty("cacheWrite", cacheWrite),
    ...optionalProperty("cacheWrite1h", cacheWrite1h),
    ...optionalProperty("reasoning", reasoning),
    ...optionalProperty("totalTokens", totalTokens),
    ...optionalProperty("cost", validatedCost),
  };
}

function secureEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  if (endpoint.username !== "" || endpoint.password !== "") throw new TypeError("Proxy URL must not contain credentials");
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) throw new TypeError("Proxy URL must use HTTPS unless it is explicit loopback HTTP");
  return new URL("api/stream", endpoint.href.endsWith("/") ? endpoint : new URL(`${endpoint.href}/`));
}

interface ProxyRequestSnapshot {
  token: string;
  signal?: AbortSignal;
  url: URL;
  body: string;
}

function requestSnapshot(
  model: Model,
  contextValue: Context,
  optionsValue: ProxyStreamOptions,
): ProxyRequestSnapshot {
  const tokenDescriptor = Object.getOwnPropertyDescriptor(optionsValue, "authToken");
  if (tokenDescriptor === undefined || !("value" in tokenDescriptor) || !Check(STRING_VALUE, tokenDescriptor.value)) {
    throw new TypeError("Proxy authentication token must be an own data property");
  }
  const proxyUrlDescriptor = Object.getOwnPropertyDescriptor(optionsValue, "proxyUrl");
  if (proxyUrlDescriptor === undefined || !("value" in proxyUrlDescriptor) || !Check(STRING_VALUE, proxyUrlDescriptor.value)) {
    throw new TypeError("Proxy URL must be an own data property");
  }
  const token = tokenDescriptor.value;
  const proxyUrl = proxyUrlDescriptor.value;
  if (token === "") throw new TypeError("Proxy authentication token is required");
  assertRedactableSecret(token, "Proxy authentication token");
  const signalDescriptor = Object.getOwnPropertyDescriptor(optionsValue, "signal");
  if (signalDescriptor !== undefined && !("value" in signalDescriptor)) throw new TypeError("Proxy signal must be a data property");
  const signal = signalDescriptor !== undefined && "value" in signalDescriptor && signalDescriptor.value instanceof AbortSignal
    ? signalDescriptor.value
    : undefined;
  const context = cloneRecord(contextValue, "context");
  const messages = context.messages;
  if (!Array.isArray(messages)) throw new TypeError("Proxy context messages must be an array");
  context.messages = messages.map((message) => {
    if (!isJsonObject(message)) return message;
    const copy: JsonObject = Object.fromEntries(Object.entries(message));
    const state = copy.providerState;
    if (isJsonObject(state)) {
      const source = state.source;
      const matches = isJsonObject(source)
        && source.api === model.api && source.provider === model.provider && source.model === model.id;
      if (!matches) delete copy.providerState;
    }
    return copy;
  });
  const optionDescriptors = Object.getOwnPropertyDescriptors(optionsValue);
  const serializable: JsonObject = {};
  for (const [name, descriptor] of Object.entries(optionDescriptors)) {
    if (["authToken", "proxyUrl", "signal"].includes(name)) continue;
    if (!("value" in descriptor)) throw new TypeError(`Proxy option ${name} must not be an accessor`);
    const selected = safeJson(descriptor.value);
    if (selected !== undefined) serializable[name] = selected;
  }
  const body = JSON.stringify({ model: safeJson(model), context, options: serializable });
  if (body === undefined) throw new TypeError("Proxy request could not be serialized");
  if (Buffer.byteLength(body, "utf8") > REQUEST_LIMIT) throw new TypeError(`Proxy request exceeds ${REQUEST_LIMIT} UTF-8 bytes`);
  return { token, ...optionalProperty("signal", signal), url: secureEndpoint(proxyUrl), body };
}

function parsePartialArguments(value: string): JsonObject {
  const candidates = [value];
  if (value.length <= 4096) {
    const quoteCount = (value.match(/(?<!\\)"/gu) ?? []).length;
    let completed = value;
    if (quoteCount % 2 === 1) completed += "\"";
    const opens = (completed.match(/\{/gu) ?? []).length - (completed.match(/\}/gu) ?? []).length;
    if (opens > 0) completed += "}".repeat(opens);
    candidates.push(completed);
  }
  for (const candidate of candidates) {
    try {
      const parsed = toJsonValue(JSON.parse(candidate));
      if (isJsonObject(parsed)) return parsed;
    } catch { /* incomplete */ }
  }
  return {};
}

async function boundedHttpError(response: Response, token: string): Promise<string> {
  if (response.body === null) return `Proxy request failed (${response.status})`;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const selected = await reader.read();
      if (selected.done) {
        break;
      }
      const next = total + selected.value.byteLength;
      if (!Number.isSafeInteger(next) || next > ERROR_BODY_LIMIT) {
        await reader.cancel().catch(() => undefined);
        return `Proxy request failed (${response.status})`;
      }
      chunks.push(selected.value);
      total = next;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return `Proxy request failed (${response.status})`;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return `Proxy request failed (${response.status})`; }
  let message = text;
  try {
    const parsed = toJsonValue(JSON.parse(text));
    if (isJsonObject(parsed) && Check(STRING_VALUE, parsed.error)) message = parsed.error;
  } catch { /* plain response */ }
  if (message === "") return `Proxy request failed (${response.status})`;
  return message.split(token).join("[REDACTED]");
}

async function pump(model: Model, context: Context, options: ProxyStreamOptions, queue: ProxyEventQueue): Promise<void> {
  let request: ReturnType<typeof requestSnapshot>;
  try { request = requestSnapshot(model, context, options); } catch (error) {
    const message = errorMessage(model, error instanceof Error ? error.message : "Invalid proxy request");
    queue.emit({ type: "error", reason: "error", error: message });
    queue.finish(message);
    return;
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
      body: request.body,
      redirect: "error",
      ...optionalProperty("signal", request.signal),
    });
  } catch (error) {
    const message = errorMessage(model, redactedFailureMessage(
      error instanceof Error ? error.message : undefined,
      request.token,
      "Proxy request failed",
    ));
    queue.emit({ type: "error", reason: "error", error: message });
    queue.finish(message);
    return;
  }
  if (!response.ok) {
    const message = errorMessage(model, await boundedHttpError(response, request.token));
    queue.emit({ type: "error", reason: "error", error: message });
    queue.finish(message);
    return;
  }
  if (response.body === null) {
    const message = errorMessage(model, "Proxy response has no body");
    queue.emit({ type: "error", reason: "error", error: message });
    queue.finish(message);
    return;
  }

  const reader = response.body.getReader();
  queue.attachReader(reader);
  const content: AssistantMessage["content"] = [];
  const state = new Map<number, "text" | "text-ended" | "thinking" | "thinking-ended" | "tool" | "tool-ended">();
  const toolBuffers = new Map<number, string>();
  const fieldBytes = new Map<number, number>();
  const toolBufferBytes = new Map<number, number>();
  const credentialTails = new Map<number, string>();
  let aggregateContentBytes = 0;
  let contentEnvelopeBytes = 0;
  let eventCount = 0;
  let terminal: AssistantMessage | undefined;
  let doneMarker = false;
  let wireBytes = 0;
  let pending = new Uint8Array();
  let pendingLength = 0;

  function fail(reason: string): never {
    throw new Error(reason);
  }
  const appendPending = (bytes: Uint8Array): void => {
    const required = pendingLength + bytes.byteLength;
    if (!Number.isSafeInteger(required) || required > LINE_LIMIT) fail("Proxy response line exceeds its limit");
    if (required > pending.byteLength) {
      let capacity = Math.max(1_024, pending.byteLength);
      while (capacity < required) capacity = Math.min(LINE_LIMIT, Math.max(required, capacity * 2));
      const expanded = new Uint8Array(capacity);
      expanded.set(pending.subarray(0, pendingLength));
      pending = expanded;
    }
    pending.set(bytes, pendingLength);
    pendingLength = required;
  };
  const index = <Value>(value: Value): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= CONTENT_LIMITS.blocks) fail("Invalid content index");
    const selected = Number(value);
    if (selected > content.length) fail("Sparse content index is not allowed");
    return selected;
  };
  const emit = async (event: AssistantMessageEvent, retainedBytes?: number): Promise<void> => {
    queue.emit(event, retainedBytes);
    await Promise.resolve();
  };
  const deltaRetentionBytes = (deltaBytes: number): number => {
    const modelBytes = Buffer.byteLength(model.api, "utf8")
      + Buffer.byteLength(model.provider, "utf8")
      + Buffer.byteLength(model.id, "utf8");
    const retained = 16_384 + (modelBytes * 6) + contentEnvelopeBytes
      + (aggregateContentBytes * 6) + (deltaBytes * 6);
    if (!Number.isSafeInteger(retained)) fail("Proxy event retention estimate exceeds its safe range");
    return retained;
  };
  const processEvent = async <Value>(raw: Value): Promise<void> => {
    if (doneMarker) fail("Proxy event arrived after its done marker");
    if (terminal !== undefined) fail("Proxy event arrived after its terminal event");
    eventCount += 1;
    if (eventCount > EVENT_LIMIT) fail(`Proxy response exceeds ${EVENT_LIMIT} events`);
    const event = cloneRecord(raw, "proxy event");
    if (!Check(STRING_VALUE, event.type)) fail("Proxy event type is missing");
    if (event.type === "start") {
      await emit({ type: "start", partial: partialMessage(model, content) });
      return;
    }
    if (event.type === "text_start" || event.type === "thinking_start") {
      const selected = index(event.contentIndex);
      if (state.has(selected)) fail(`${event.type} repeated for content index ${selected}`);
      const thinking = event.type === "thinking_start";
      content[selected] = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
      state.set(selected, thinking ? "thinking" : "text");
      fieldBytes.set(selected, 0);
      credentialTails.set(selected, "");
      contentEnvelopeBytes += 4_096;
      await emit(thinking
        ? { type: "thinking_start", contentIndex: selected, partial: partialMessage(model, content) }
        : { type: "text_start", contentIndex: selected, partial: partialMessage(model, content) });
      return;
    }
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      const selected = index(event.contentIndex);
      const expected = event.type === "text_delta" ? "text" : "thinking";
      if (state.get(selected) !== expected) fail(`${event.type} occurred before ${expected}_start or after ${expected}_end`);
      const deltaValue = event.delta;
      if (!Check(STRING_VALUE, deltaValue)) fail(`${event.type} delta must be text`);
      const delta = deltaValue;
      const bytes = Buffer.byteLength(delta, "utf8");
      const block = content[selected];
      const current = expected === "text"
        ? block?.type === "text" ? block.text : fail("Text content state is inconsistent")
        : block?.type === "thinking" ? block.thinking : fail("Thinking content state is inconsistent");
      const nextFieldBytes = (fieldBytes.get(selected) ?? 0) + bytes;
      if (!Number.isSafeInteger(nextFieldBytes) || nextFieldBytes > CONTENT_LIMITS.fieldBytes) fail(`${expected} field exceeds its byte limit`);
      aggregateContentBytes += bytes;
      if (aggregateContentBytes > CONTENT_LIMITS.fieldBytes * 2) fail("Assistant aggregate content byte limit exceeded");
      const joined = current + delta;
      credentialTails.set(selected, rejectAppendedRequestToken(
        credentialTails.get(selected) ?? "",
        delta,
        request.token,
        `Proxy ${expected} content`,
      ));
      if (block?.type === "text") block.text = joined;
      else if (block?.type === "thinking") block.thinking = joined;
      else fail("Streaming content state is inconsistent");
      fieldBytes.set(selected, nextFieldBytes);
      const retainedBytes = deltaRetentionBytes(bytes);
      await emit(event.type === "text_delta"
        ? { type: "text_delta", contentIndex: selected, delta, partial: partialMessage(model, content) }
        : { type: "thinking_delta", contentIndex: selected, delta, partial: partialMessage(model, content) }, retainedBytes);
      return;
    }
    if (event.type === "text_end" || event.type === "thinking_end") {
      const selected = index(event.contentIndex);
      const expected = event.type === "text_end" ? "text" : "thinking";
      if (state.get(selected) === `${expected}-ended`) fail(`${event.type} already occurred for content index ${selected}`);
      if (state.get(selected) !== expected) fail(`${event.type} occurred without ${expected}_start`);
      state.set(selected, expected === "text" ? "text-ended" : "thinking-ended");
      const block = content[selected];
      const completedContent = expected === "text"
        ? block?.type === "text" ? block.text : fail("Text content state is inconsistent")
        : block?.type === "thinking" ? block.thinking : fail("Thinking content state is inconsistent");
      await emit(event.type === "text_end"
        ? { type: "text_end", contentIndex: selected, content: completedContent, partial: partialMessage(model, content) }
        : { type: "thinking_end", contentIndex: selected, content: completedContent, partial: partialMessage(model, content) });
      return;
    }
    if (event.type === "toolcall_start") {
      const selected = index(event.contentIndex);
      if (state.has(selected)) fail("toolcall_start repeated for content index");
      if ([...state.values()].filter((value) => value === "tool" || value === "tool-ended").length >= TOOL_LIMIT) fail(`Proxy response exceeds ${TOOL_LIMIT} tool calls`);
      const id = terminalIdentity(event.id, "tool-call identity", MAX_TOOL_CALL_STREAM_ID_BYTES, request.token);
      const toolName = terminalIdentity(event.toolName, "tool-call identity", MAX_TOOL_CALL_STREAM_NAME_BYTES, request.token);
      if (id === undefined || toolName === undefined) fail("Tool-call identity is invalid");
      content[selected] = { type: "toolCall", id, name: toolName, arguments: {} };
      state.set(selected, "tool");
      toolBuffers.set(selected, "");
      toolBufferBytes.set(selected, 0);
      credentialTails.set(selected, "");
      contentEnvelopeBytes += 4_096 + (Buffer.byteLength(id, "utf8") * 6)
        + (Buffer.byteLength(toolName, "utf8") * 6);
      if (!Number.isSafeInteger(contentEnvelopeBytes)) fail("Proxy content metadata exceeds its safe range");
      await emit({ type: "toolcall_start", contentIndex: selected, partial: partialMessage(model, content) });
      return;
    }
    if (event.type === "toolcall_delta") {
      const selected = index(event.contentIndex);
      if (state.get(selected) !== "tool") fail("toolcall_delta occurred outside an active tool call");
      const deltaValue = event.delta;
      if (!Check(STRING_VALUE, deltaValue)) fail("Tool-call delta must be text");
      const delta = deltaValue;
      const current = toolBuffers.get(selected) ?? "";
      const deltaBytes = Buffer.byteLength(delta, "utf8");
      const nextToolBytes = (toolBufferBytes.get(selected) ?? 0) + deltaBytes;
      if (!Number.isSafeInteger(nextToolBytes) || nextToolBytes > CONTENT_LIMITS.fieldBytes) fail("Tool-call arguments exceed their field byte limit");
      const nextAggregateBytes = aggregateContentBytes + deltaBytes;
      if (!Number.isSafeInteger(nextAggregateBytes) || nextAggregateBytes > CONTENT_LIMITS.fieldBytes * 2) {
        fail("Assistant aggregate content byte limit exceeded");
      }
      const joined = current + delta;
      credentialTails.set(selected, rejectAppendedRequestToken(
        credentialTails.get(selected) ?? "",
        delta,
        request.token,
        "Proxy tool-call arguments",
      ));
      toolBuffers.set(selected, joined);
      toolBufferBytes.set(selected, nextToolBytes);
      aggregateContentBytes = nextAggregateBytes;
      const block = content[selected];
      if (block?.type !== "toolCall") fail("Tool-call content state is inconsistent");
      block.arguments = joined.length <= 4_096 ? parsePartialArguments(joined) : {};
      const retainedBytes = deltaRetentionBytes(deltaBytes);
      await emit(
        { type: "toolcall_delta", contentIndex: selected, delta, partial: partialMessage(model, content) },
        retainedBytes,
      );
      return;
    }
    if (event.type === "toolcall_end") {
      const selected = index(event.contentIndex);
      if (state.get(selected) !== "tool") fail("toolcall_end occurred without an active tool call");
      const rawArguments = toolBuffers.get(selected) ?? "";
      let argumentsValue: JsonValue = {};
      if (rawArguments !== "") {
        try { argumentsValue = toJsonValue(JSON.parse(rawArguments)); } catch { fail("Tool-call arguments are not valid JSON"); }
      }
      if (!isJsonObject(argumentsValue)) fail("Tool-call arguments must be an object");
      const boundedArguments = boundedJsonSnapshot(argumentsValue, {
        label: "Proxy tool-call arguments",
        maximumBytes: CONTENT_LIMITS.fieldBytes,
        maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
        maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
        maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
      });
      const boundedValue = boundedArguments.value;
      if (!isJsonObject(boundedValue)) fail("Tool-call arguments must be an object");
      const block = content[selected];
      if (block?.type !== "toolCall") fail("Tool-call content state is inconsistent");
      block.arguments = boundedValue;
      state.set(selected, "tool-ended");
      await emit({
        type: "toolcall_end",
        contentIndex: selected,
        toolCall: structuredClone(block),
        partial: partialMessage(model, content),
      });
      return;
    }
    if (event.type === "done" || event.type === "error") {
      if ([...state.values()].some((value) => value === "tool")) fail("Terminal event arrived with an active tool call");
      const terminalFields = event.type === "done"
        ? new Set(["type", "reason", "usage", "responseId", "responseModel", "diagnostics", "providerState"])
        : new Set(["type", "reason", "usage", "errorMessage", "responseId", "responseModel", "diagnostics", "providerState"]);
      if (Object.keys(event).some((key) => !terminalFields.has(key))) fail("Terminal event contains unsupported fields");
      const usage = validateUsage(event.usage);
      const reasonValue = event.reason;
      if (!Check(STRING_VALUE, reasonValue)) fail("Invalid terminal reason");
      let reason: AssistantMessage["stopReason"];
      if (event.type === "done") {
        if (reasonValue !== "stop" && reasonValue !== "length" && reasonValue !== "toolUse") fail("Invalid terminal reason");
        reason = reasonValue;
      } else {
        if (reasonValue !== "error" && reasonValue !== "aborted") fail("Invalid terminal reason");
        reason = reasonValue;
      }
      if (event.type === "error" && reasonValue === "aborted" && event.errorMessage !== undefined) {
        fail("Terminal aborted event cannot include an error message");
      }
      const errorMessage = terminalErrorMessage(event.errorMessage, request.token);
      const responseId = terminalIdentity(event.responseId, "response ID", RESPONSE_ID_LIMIT, request.token);
      const responseModel = terminalIdentity(event.responseModel, "response model", RESPONSE_MODEL_LIMIT, request.token);
      rejectRequestToken(event.diagnostics, request.token, "Terminal diagnostics");
      const diagnostics = canonicalAssistantDiagnostics(event.diagnostics);
      const providerState = terminalProviderState(event.providerState, model, request.token);
      for (const [contentIndex, contentState] of state) {
        if (contentState !== "text" && contentState !== "thinking") continue;
        const block = content[contentIndex];
        const completedContent = contentState === "text"
          ? block?.type === "text" ? block.text : fail("Text content state is inconsistent")
          : block?.type === "thinking" ? block.thinking : fail("Thinking content state is inconsistent");
        state.set(contentIndex, contentState === "text" ? "text-ended" : "thinking-ended");
        await emit(contentState === "text"
          ? { type: "text_end", contentIndex, content: completedContent, partial: partialMessage(model, content) }
          : { type: "thinking_end", contentIndex, content: completedContent, partial: partialMessage(model, content) });
      }
      const completed: AssistantMessage = {
        role: "assistant",
        content: structuredClone(content),
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: reason,
        timestamp: Date.now(),
        ...optionalProperty("errorMessage", errorMessage),
        ...optionalProperty("responseId", responseId),
        ...optionalProperty("responseModel", responseModel),
        ...optionalProperty("diagnostics", diagnostics),
        ...optionalProperty("providerState", providerState),
      };
      terminal = completed;
      if (event.type === "done") {
        if (reason !== "stop" && reason !== "length" && reason !== "toolUse") fail("Invalid terminal reason");
        await emit({ type: "done", reason, message: completed });
      } else {
        if (reason !== "error" && reason !== "aborted") fail("Invalid terminal reason");
        await emit({ type: "error", reason, error: completed });
      }
      return;
    }
    fail(`Unsupported proxy event type: ${event.type}`);
  };
  const processLine = async (bytes: Uint8Array): Promise<void> => {
    let line = "";
    try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r$/u, ""); } catch { fail("Proxy response contains invalid UTF-8"); }
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") {
      if (doneMarker) fail("Duplicate proxy done marker");
      doneMarker = true;
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { fail("Proxy event is not valid JSON"); }
    await processEvent(parsed);
  };

  try {
    while (true) {
      const selected = await reader.read();
      if (selected.done) break;
      const chunk = selected.value;
      const lengthValue = chunk.byteLength;
      if (!Check(NUMBER_VALUE, lengthValue) || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > CHUNK_LIMIT) fail("Proxy response chunk exceeds its limit");
      const length = lengthValue;
      wireBytes += length;
      if (wireBytes > WIRE_LIMIT) fail("Proxy response exceeds its aggregate wire limit");
      if (!(selected.value instanceof Uint8Array)) {
        const tail = chunk.subarray(0);
        if (Check(NUMBER_VALUE, tail.byteLength) && tail.byteLength > LINE_LIMIT) fail("Proxy response line exceeds its limit");
        continue;
      }
      let start = 0;
      while (true) {
        const newline = selected.value.indexOf(10, start);
        if (newline < 0) break;
        appendPending(selected.value.subarray(start, newline));
        await processLine(pending.subarray(0, pendingLength));
        pendingLength = 0;
        start = newline + 1;
      }
      appendPending(selected.value.subarray(start));
    }
    if (pendingLength > 0) await processLine(pending.subarray(0, pendingLength));
    if (terminal === undefined) fail("Proxy response ended without a terminal event");
    queue.finish(terminal);
  } catch (error) {
    const failed = errorMessage(model, redactedFailureMessage(
      error instanceof Error ? error.message : undefined,
      request.token,
      "Proxy response failed",
    ));
    queue.fail(failed);
    await reader.cancel().catch(() => undefined);
  }
}

export function streamProxy(model: Model, context: Context, options: ProxyStreamOptions): AssistantMessageEventStream {
  const queue = new ProxyEventQueue();
  queueMicrotask(() => { void pump(model, context, options, queue); });
  return queue;
}
