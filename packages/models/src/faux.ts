import type {
  AssistantContent,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  JsonObject,
  JsonValue,
  Model,
  Provider,
  SimpleStreamOptions,
} from "./contracts.js";
import { calculateCost } from "./utilities.js";
import { createAssistantMessageEventStream, emptyUsage } from "./streaming.js";

const MAX_ASSISTANT_BLOCKS = 1_024;
const MAX_ASSISTANT_FIELD_BYTES = 4 * 1024 * 1024;
const MAX_ASSISTANT_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_CALL_ID_BYTES = 1_024;
const MAX_TOOL_CALL_NAME_BYTES = 256;
const MAX_TOOL_ARGUMENT_VALUES = 8_192;
const MAX_TOOL_ARGUMENT_CONTAINERS = 8_192;
const MAX_TOOL_ARGUMENT_DEPTH = 59;
const EMPTY_TOOL_ARGUMENT_BYTES = 2;
const DELIVERY_YIELD_INTERVAL = 256;
const utf8Encoder = new TextEncoder();

const fauxModelValue: Model<"faux"> = {
  id: "faux",
  name: "Faux",
  api: "faux",
  provider: "faux",
  baseUrl: "faux://local",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};
export const fauxModel: Model<"faux"> = Object.freeze(fauxModelValue);

export interface FauxScript {
  text?: string | readonly string[];
  thinking?: string | readonly string[];
  toolCalls?: readonly FauxToolCall[];
  stopReason?: "stop" | "length" | "toolUse";
  usage?: Partial<AssistantMessage["usage"]>;
  error?: string;
}

export interface FauxToolCall {
  id?: string;
  name: string;
  arguments?: JsonObject;
  argumentChunks?: readonly string[];
}

export type FauxResponder = (
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
) => FauxScript | Promise<FauxScript>;

function chunks(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

function* surrogateSafeChunks(value: readonly string[]): Iterable<string> {
  let pending = "";
  for (const original of value) {
    let current = pending + original;
    pending = "";
    if (current.length && /[\uD800-\uDBFF]/u.test(current.at(-1)!)) {
      pending = current.at(-1)!;
      current = current.slice(0, -1);
    }
    if (current) yield current;
  }
  if (pending) yield "\uFFFD";
}

interface FauxContentBudget {
  contentBytes: number;
  eventsSinceYield: number;
}

function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
  const usage = { ...message.usage };
  if (message.usage.cost !== undefined) usage.cost = { ...message.usage.cost };
  const snapshot: AssistantMessage = {
    ...message,
    content: message.content.map((block) => block.type === "toolCall"
      ? { ...block, arguments: structuredClone(block.arguments) }
      : { ...block }),
    usage,
  };
  if (message.diagnostics !== undefined) snapshot.diagnostics = structuredClone(message.diagnostics);
  if (message.providerState !== undefined) snapshot.providerState = structuredClone(message.providerState);
  return snapshot;
}

function byteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function requiredToolIdentity(value: string, label: string, maximumBytes: number): string {
  if (
    value?.constructor !== String || value === "" || byteLength(value) > maximumBytes ||
    hasControlCharacter(value)
  ) throw new TypeError(`Invalid ${label}`);
  return value;
}

interface CanonicalToolArguments {
  value: JsonObject;
  serialized: string;
  bytes: number;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && value.constructor === Object;
}

function isJsonContainer(value: JsonValue): value is JsonObject | JsonValue[] {
  return value !== null && (value.constructor === Array || value.constructor === Object);
}

function canonicalToolArguments(value: JsonObject): CanonicalToolArguments {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError("Tool arguments must be JSON-serializable"); }
  if (serialized === undefined) throw new TypeError("Tool arguments must be JSON-serializable");
  const bytes = byteLength(serialized);
  if (bytes > MAX_ASSISTANT_FIELD_BYTES) throw new RangeError("Tool arguments exceeded 4 MiB");
  const detached: JsonValue = JSON.parse(serialized);
  if (!isJsonObject(detached)) {
    throw new TypeError("Tool arguments must serialize to an object");
  }
  validateToolArgumentComplexity(detached);
  return { value: detached, serialized, bytes };
}

function canonicalStreamedToolArguments(raw: string): ReturnType<typeof canonicalToolArguments> {
  if (!raw.trim()) return canonicalToolArguments({});
  let parsed: JsonValue;
  try { parsed = JSON.parse(raw); } catch { throw new TypeError("Tool arguments must be a valid JSON object"); }
  if (!isJsonObject(parsed)) throw new TypeError("Tool arguments must be a valid JSON object");
  return canonicalToolArguments(parsed);
}

function validateToolArgumentComplexity(value: JsonObject): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  let containers = 0;
  while (pending.length > 0) {
    const selected = pending.pop();
    if (selected === undefined) break;
    values += 1;
    if (values > MAX_TOOL_ARGUMENT_VALUES) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_VALUES} JSON values`);
    }
    if (selected.depth > MAX_TOOL_ARGUMENT_DEPTH) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_DEPTH} levels`);
    }
    if (!isJsonContainer(selected.value)) continue;
    containers += 1;
    if (containers > MAX_TOOL_ARGUMENT_CONTAINERS) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_CONTAINERS} JSON containers`);
    }
    const children = Array.isArray(selected.value) ? selected.value : Object.values(selected.value);
    if (children.length > MAX_TOOL_ARGUMENT_VALUES - values - pending.length) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_VALUES} JSON values`);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index]!, depth: selected.depth + 1 });
    }
  }
}

async function yieldDelivery(budget: FauxContentBudget, signal?: AbortSignal): Promise<void> {
  budget.eventsSinceYield += 1;
  if (budget.eventsSinceYield < DELIVERY_YIELD_INTERVAL) return;
  budget.eventsSinceYield = 0;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

function canonicalUsage(value: FauxScript["usage"]): AssistantMessage["usage"] {
  const usage: AssistantMessage["usage"] = {};
  if (value === undefined) return usage;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
    const candidate = value[field];
    if (candidate !== undefined && Number.isSafeInteger(candidate) && candidate >= 0) usage[field] = candidate;
  }
  if (usage.cacheWrite1h !== undefined && (
    usage.cacheWrite === undefined || usage.cacheWrite1h > usage.cacheWrite
  )) delete usage.cacheWrite1h;
  const knownComponents = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .filter((candidate): candidate is number => candidate !== undefined);
  const knownTotal = knownComponents.reduce((sum, candidate) => sum + candidate, 0);
  if (knownComponents.length > 0 && !Number.isSafeInteger(knownTotal)) {
    delete usage.input;
    delete usage.output;
    delete usage.cacheRead;
    delete usage.cacheWrite;
    delete usage.cacheWrite1h;
    delete usage.totalTokens;
    return usage;
  }
  if (usage.totalTokens !== undefined && usage.totalTokens < knownTotal) delete usage.totalTokens;
  if (
    usage.input !== undefined && usage.output !== undefined &&
    usage.cacheRead !== undefined && usage.cacheWrite !== undefined
  ) {
    const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (Number.isSafeInteger(total)) {
      usage.totalTokens = total;
    } else {
      delete usage.input;
      delete usage.output;
      delete usage.cacheRead;
      delete usage.cacheWrite;
      delete usage.cacheWrite1h;
      delete usage.totalTokens;
    }
  }
  return usage;
}

export function createFauxTransport(responder: FauxResponder = defaultResponder) {
  return (model: Model, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    const cancellation = new AbortController();
    const signal = options.signal === undefined
      ? cancellation.signal
      : AbortSignal.any([options.signal, cancellation.signal]);
    const stream = createAssistantMessageEventStream(() => {
      cancellation.abort(new DOMException("Stream consumer cancelled", "AbortError"));
    });
    let activeMessage: AssistantMessage | undefined;
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      const { signal: _ignored, ...plainOptions } = options;
      return responder(model, structuredClone(context), { ...structuredClone(plainOptions), signal });
    }).then(async (script) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: canonicalUsage(script.usage),
        stopReason: "pending",
        timestamp: 0,
      };
      activeMessage = message;
      const budget: FauxContentBudget = { contentBytes: 0, eventsSinceYield: 0 };
      const snapshot = () => snapshotAssistantMessage(message);
      stream.push({ type: "start", partial: snapshot() });
      if (script.error) {
        message.stopReason = "error";
        message.errorMessage = script.error;
        stream.push({ type: "error", reason: "error", error: snapshot() });
        return;
      }
      await emitPart(stream, message, budget, "thinking", surrogateSafeChunks(chunks(script.thinking)), signal);
      await emitPart(stream, message, budget, "text", surrogateSafeChunks(chunks(script.text)), signal);
      for (const [toolNumber, call] of (script.toolCalls ?? []).entries()) {
        signal.throwIfAborted();
        if (message.content.length >= MAX_ASSISTANT_BLOCKS) {
          throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
        }
        const index = message.content.length;
        const id = requiredToolIdentity(call.id ?? `faux_tool_${toolNumber}`, "tool-call ID", MAX_TOOL_CALL_ID_BYTES);
        const name = requiredToolIdentity(call.name, "tool-call name", MAX_TOOL_CALL_NAME_BYTES);
        const finalized = canonicalToolArguments(call.arguments ?? {});
        if (EMPTY_TOOL_ARGUMENT_BYTES > MAX_ASSISTANT_CONTENT_BYTES - budget.contentBytes) {
          throw new RangeError("Assistant content exceeded 8 MiB");
        }
        budget.contentBytes += EMPTY_TOOL_ARGUMENT_BYTES;
        const block: AssistantContent = { type: "toolCall", id, name, arguments: {} };
        message.content.push(block);
        stream.push({ type: "toolcall_start", contentIndex: index, id, name, partial: snapshot() });
        let argumentBytes = 0;
        const emittedArgumentChunks: string[] = [];
        const argumentChunks = call.argumentChunks ?? [finalized.serialized];
        for (const delta of surrogateSafeChunks(argumentChunks)) {
          const deltaBytes = byteLength(delta);
          if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - argumentBytes) {
            throw new RangeError("Tool arguments exceeded 4 MiB");
          }
          const retainedBytes = budget.contentBytes - Math.max(argumentBytes, EMPTY_TOOL_ARGUMENT_BYTES);
          const nextArgumentBytes = argumentBytes + deltaBytes;
          const nextContentBytes = retainedBytes + Math.max(nextArgumentBytes, EMPTY_TOOL_ARGUMENT_BYTES);
          if (nextContentBytes > MAX_ASSISTANT_CONTENT_BYTES) {
            throw new RangeError("Assistant content exceeded 8 MiB");
          }
          argumentBytes = nextArgumentBytes;
          budget.contentBytes = nextContentBytes;
          emittedArgumentChunks.push(delta);
          stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: snapshot() });
          await yieldDelivery(budget, signal);
        }
        const streamed = call.argumentChunks === undefined
          ? finalized
          : canonicalStreamedToolArguments(emittedArgumentChunks.join(""));
        const retainedBytes = budget.contentBytes - Math.max(argumentBytes, EMPTY_TOOL_ARGUMENT_BYTES);
        if (streamed.bytes > MAX_ASSISTANT_CONTENT_BYTES - retainedBytes) {
          throw new RangeError("Assistant content exceeded 8 MiB");
        }
        budget.contentBytes = retainedBytes + streamed.bytes;
        block.arguments = streamed.value;
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: structuredClone(block), partial: snapshot() });
        await yieldDelivery(budget, signal);
      }
      signal.throwIfAborted();
      const reason = script.stopReason ?? (script.toolCalls?.length ? "toolUse" : "stop");
      message.stopReason = reason;
      const cost = calculateCost(model, message.usage);
      if (cost !== undefined) message.usage.cost = cost;
      stream.push({ type: "done", reason, message: snapshot() });
    }).catch((cause) => {
      const aborted = signal.aborted;
      const error: AssistantMessage = activeMessage ?? {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: emptyUsage(), stopReason: aborted ? "aborted" : "error", timestamp: 0,
      };
      error.stopReason = aborted ? "aborted" : "error";
      if (aborted) delete error.errorMessage;
      else error.errorMessage = cause instanceof Error ? cause.message : String(cause);
      if (activeMessage === undefined) {
        stream.push({ type: "start", partial: { ...error, stopReason: "pending" } });
      }
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: snapshotAssistantMessage(error) });
    });
    return stream;
  };
}

async function emitPart(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
  budget: FauxContentBudget,
  type: "text" | "thinking",
  deltas: Iterable<string>,
  signal?: AbortSignal,
): Promise<void> {
  let index = -1;
  let block: AssistantContent | undefined;
  let fieldBytes = 0;
  for (const delta of deltas) {
    const deltaBytes = byteLength(delta);
    if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - fieldBytes) {
      throw new RangeError(`Assistant ${type} content exceeded 4 MiB`);
    }
    if (deltaBytes > MAX_ASSISTANT_CONTENT_BYTES - budget.contentBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    if (block === undefined) {
      if (message.content.length >= MAX_ASSISTANT_BLOCKS) {
        throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
      }
      index = message.content.length;
      block = type === "text" ? { type, text: "" } : { type, thinking: "" };
      message.content.push(block);
      const partial = snapshotAssistantMessage(message);
      stream.push(type === "text"
        ? { type: "text_start", contentIndex: index, partial }
        : { type: "thinking_start", contentIndex: index, partial });
    }
    if (block.type === "text") block.text += delta;
    else if (block.type === "thinking") block.thinking += delta;
    fieldBytes += deltaBytes;
    budget.contentBytes += deltaBytes;
    const partial = snapshotAssistantMessage(message);
    stream.push(type === "text"
      ? { type: "text_delta", contentIndex: index, delta, partial }
      : { type: "thinking_delta", contentIndex: index, delta, partial });
    await yieldDelivery(budget, signal);
  }
  if (block === undefined) return;
  const content = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "";
  const partial = snapshotAssistantMessage(message);
  stream.push(type === "text"
    ? { type: "text_end", contentIndex: index, content, partial }
    : { type: "thinking_end", contentIndex: index, content, partial });
  await yieldDelivery(budget, signal);
}

function defaultResponder(_model: Model, context: Context): FauxScript {
  const last = context.messages.at(-1);
  const text = last === undefined
    ? ""
    : Array.isArray(last.content)
      ? last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ")
      : String(last.content);
  return { text: text || "faux" };
}

export function fauxProvider(responder?: FauxResponder): Provider<"faux"> {
  const transport = createFauxTransport(responder);
  return {
    id: "faux",
    name: "Faux",
    auth: {},
    getModels: () => [fauxModel],
    stream: transport,
    streamSimple: transport,
  };
}

export function fauxEvents(script: FauxScript, model: Model = fauxModel): AssistantMessageEvent[] {
  const events: AssistantMessageEvent[] = [];
  const stream = createFauxTransport(() => script)(model, { messages: [] });
  Object.defineProperty(events, Symbol.asyncIterator, {
    configurable: true,
    value: stream[Symbol.asyncIterator].bind(stream),
  });
  return events;
}
