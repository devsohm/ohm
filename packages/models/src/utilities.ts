import type {
  AssistantMessage,
  AssistantMessageDiagnostic,
  Context,
  JsonValue,
  Message,
  Model,
  RetryCallbacks,
  RetryPolicy,
  Usage,
  ResponseDiagnostic,
} from "./contracts.js";
import { Allow, parse as parsePartialJson } from "partial-json";

const replacement = "\uFFFD";

interface ProviderResponseDetails {
  status?: number;
  headers: Record<string, string>;
}

interface ProviderDiagnosticDetails {
  response: ProviderResponseDetails;
  provider?: string;
  requestId?: string;
}

const contextOverflowPatternSources = Object.freeze([
  String.raw`maximum context length`,
  String.raw`input tokens? exceed(?:s|ed)? (?:the )?model token limit`,
  String.raw`reduce the length of (?:the )?messages`,
  String.raw`input token count[^\n]{0,160}exceeds? the maximum number of tokens allowed`,
  String.raw`maximum prompt length[^\n]{0,160}(?:request contains more|exceed)`,
  String.raw`input[^\n]{0,160}(?:is )?longer than (?:the )?model(?:'s)? context length`,
  String.raw`prompt has[^\n]{0,160}configured context size`,
  String.raw`range of input length should be`,
  String.raw`\b413\b[^\n]{0,80}status code`,
] as const);

/** Returns fresh, bounded matchers for common provider context-window failures. */
export function getOverflowPatterns(): readonly RegExp[] {
  return Object.freeze(contextOverflowPatternSources.map((source) => new RegExp(source, "iu")));
}

export function isContextOverflowText(value: string): boolean {
  const bounded = value.slice(0, 4_096);
  return getOverflowPatterns().some((pattern) => pattern.test(bounded));
}

export function sanitizeUnicode(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else result += replacement;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) result += replacement;
    else result += value[index]!;
  }
  return result;
}

export function contentText(content: Message["content"]): string {
  if (!Array.isArray(content)) return String(content);
  return content.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "thinking") return [part.thinking];
    if (part.type === "toolCall") return [JSON.stringify(part.arguments)];
    return [];
  }).join("\n");
}

export function estimateTokens(value: string | Message): number {
  const text = value instanceof Object ? contentText(value.content) : String(value);
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4));
}

export interface ContextTokenEstimate {
  tokens: number;
}

function isContext(value: Context | readonly Message[]): value is Context {
  return !Array.isArray(value);
}

export function estimateContextTokens(value: Context | readonly Message[]): ContextTokenEstimate {
  const messages = isContext(value) ? value.messages : value;
  const systemPrompt = isContext(value) ? value.systemPrompt : undefined;
  const tools = isContext(value) ? value.tools : undefined;
  let tokens = messages.reduce((sum, message) => sum + estimateTokens(message) + 4, 0);
  if (systemPrompt) tokens += estimateTokens(systemPrompt);
  if (tools) {
    for (const tool of tools) {
      tokens += estimateTokens(tool.name) + estimateTokens(tool.description);
      tokens += estimateTokens(JSON.stringify(tool.parameters));
    }
  }
  return { tokens };
}

export function calculateContextTokens(usage: Usage): number | undefined {
  const token = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0;
  if (token(usage.totalTokens) && token(usage.output) && usage.totalTokens >= usage.output) {
    return usage.totalTokens - usage.output;
  }
  if (!token(usage.input) || !token(usage.cacheRead) || !token(usage.cacheWrite)) return undefined;
  const result = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function calculateCost(model: Model, usage: Omit<Usage, "cost">): Usage["cost"] {
  const token = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0;
  if (
    !token(usage.input) || !token(usage.output) ||
    !token(usage.cacheRead) || !token(usage.cacheWrite)
  ) return undefined;
  const inputTokens = usage.input;
  const outputTokens = usage.output;
  const cacheReadTokens = usage.cacheRead;
  const cacheWriteTokens = usage.cacheWrite;
  const inputVolume = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(inputVolume)) return undefined;
  const tier = [...(model.cost.tiers ?? [])]
    .sort((left, right) => right.inputTokensAbove - left.inputTokensAbove)
    .find((candidate) => inputVolume > candidate.inputTokensAbove);
  const rates = tier ?? model.cost;
  const cost = {
    input: inputTokens * rates.input / 1_000_000,
    output: outputTokens * rates.output / 1_000_000,
    cacheRead: cacheReadTokens * rates.cacheRead / 1_000_000,
    cacheWrite: cacheWriteTokens * rates.cacheWrite / 1_000_000,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return Object.values(cost).every((value) => Number.isFinite(value) && value >= 0) ? cost : undefined;
}

export function boundedJsonSnapshot<Value>(value: Value, maxBytes = 64 * 1024): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item) => {
    if (Object(item).constructor === BigInt) return String(item);
    if (item instanceof Object) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }) ?? "null";
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length <= maxBytes) return serialized;
  const suffix = "…";
  let end = Math.max(0, maxBytes - new TextEncoder().encode(suffix).length);
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end)) + suffix;
}

export function repairJson(value: string): string {
  const source = value.trim();
  if (!source) return "null";
  const stack: string[] = [];
  let output = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === "\"") {
        output += character;
        quoted = false;
      } else if (character === "\\") {
        const next = source[index + 1];
        if (next === undefined) continue;
        if ('"\\/bfnrt'.includes(next)) {
          output += character + next;
          index += 1;
        } else if (next === "u" && /^[0-9a-fA-F]{4}$/u.test(source.slice(index + 2, index + 6))) {
          output += source.slice(index, index + 6);
          index += 5;
        } else {
          output += "\\\\";
        }
      } else if (character.charCodeAt(0) <= 0x1f) {
        output += JSON.stringify(character).slice(1, -1);
      } else {
        output += character;
      }
      continue;
    }
    output += character;
    if (character === "\"") quoted = true;
    else if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if ((character === "}" || character === "]") && stack.at(-1) === character) stack.pop();
  }
  if (quoted) output += "\"";
  output = output.replace(/,\s*$/u, "");
  while (stack.length) {
    output = output.replace(/,\s*$/u, "");
    output += stack.pop();
  }
  return output;
}

export function parseJsonWithRepair(value: string): JsonValue {
  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(repairJson(value));
  }
}

export function parseStreamingJson(value: string): JsonValue {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    try {
      const parsed: JsonValue = parsePartialJson(
        value,
        Allow.STR | Allow.NUM | Allow.ARR | Allow.OBJ | Allow.NULL | Allow.BOOL,
      );
      return parsed;
    } catch {
      return {};
    }
  }
}

export function errorMessage<ErrorValue>(error: ErrorValue): string {
  if (error instanceof Error) return error.message;
  return error !== null && error !== undefined && Object(error).constructor === String
    ? String(error)
    : boundedJsonSnapshot(error);
}

export interface AssistantMessageSnapshotDiagnostic {
  api: AssistantMessage["api"];
  provider: string;
  model: string;
  stopReason: AssistantMessage["stopReason"];
  usage: Usage;
  errorMessage?: string;
}

export function createAssistantMessageDiagnostic(message: AssistantMessage): Readonly<AssistantMessageSnapshotDiagnostic>;
export function createAssistantMessageDiagnostic<ErrorValue, Details>(
  type: string,
  error?: ErrorValue,
  details?: Details,
): AssistantMessageDiagnostic;
export function createAssistantMessageDiagnostic<ErrorValue, Details>(
  messageOrType: AssistantMessage | string,
  error?: ErrorValue,
  details?: Details,
): Readonly<AssistantMessageSnapshotDiagnostic> | AssistantMessageDiagnostic {
  if (!(messageOrType instanceof Object)) {
    const diagnosticError = error === undefined
      ? undefined
      : assistantDiagnosticError(error);
    const diagnostic: AssistantMessageDiagnostic = {
      type: String(messageOrType),
      timestamp: Date.now(),
    };
    if (diagnosticError !== undefined) diagnostic.error = diagnosticError;
    if (details !== undefined) diagnostic.details = structuredClone(details);
    return diagnostic;
  }
  const message = messageOrType;
  const diagnostic: AssistantMessageSnapshotDiagnostic = {
    api: message.api,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    usage: structuredClone(message.usage),
  };
  if (message.errorMessage !== undefined) diagnostic.errorMessage = message.errorMessage;
  return Object.freeze(diagnostic);
}

function diagnosticString<Value>(value: Value): string | undefined {
  return value !== null && value !== undefined && Object(value).constructor === String
    ? String(value)
    : undefined;
}

function diagnosticNumber<Value>(value: Value): number | undefined {
  if (value === null || value === undefined || Object(value).constructor !== Number) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function assistantDiagnosticError<ErrorValue>(error: ErrorValue): NonNullable<AssistantMessageDiagnostic["error"]> {
  const message = errorMessage(error);
  if (!(error instanceof Object)) return { message };
  const codeValue = Object.getOwnPropertyDescriptor(error, "code")?.value;
  const statusValue = Object.getOwnPropertyDescriptor(error, "status")?.value;
  const code = diagnosticString(codeValue) ?? diagnosticNumber(codeValue);
  const status = diagnosticNumber(statusValue);
  const diagnostic: NonNullable<AssistantMessageDiagnostic["error"]> = { message };
  if (error instanceof Error && error.name !== "Error") diagnostic.name = error.name;
  if (code !== undefined) diagnostic.code = code;
  if (status !== undefined) diagnostic.status = status;
  return diagnostic;
}

const safeOpaqueToken = /^[A-Za-z0-9._:/-]{1,256}$/u;
const diagnosticHeaderNames = new Set([
  "apim-request-id",
  "cf-ray",
  "content-type",
  "request-id",
  "retry-after",
  "retry-after-ms",
  "x-amzn-request-id",
  "x-amzn-requestid",
  "x-correlation-id",
  "x-generation-id",
  "x-goog-request-id",
  "x-request-id",
  "x-should-retry",
]);

export function providerResponseDiagnostic(
  response: Pick<ResponseDiagnostic, "status" | "headers">,
  timestamp?: number,
): AssistantMessageDiagnostic;
export function providerResponseDiagnostic(
  response: Pick<ResponseDiagnostic, "status" | "headers">,
  provider?: string,
  requestId?: string,
): AssistantMessageDiagnostic;
export function providerResponseDiagnostic(
  response: Pick<ResponseDiagnostic, "status" | "headers">,
  timestampOrProvider: number | string = Date.now(),
  explicitRequestId?: string,
): AssistantMessageDiagnostic {
  const responseHeaders: Record<string, string> = {};
  let retainedBytes = 0;
  let requestId: string | undefined;
  if (Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599) {
    // Retained below in the bounded response projection.
  }
  const normalized = new Headers(response.headers);
  for (const [name, rawValue] of normalized) {
    if (!diagnosticHeaderNames.has(name)) continue;
    const value = Array.from(rawValue, (character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    }).join("").replace(/\s+/gu, " ").trim();
    const bytes = new TextEncoder().encode(`${name}${value}`).length;
    if (bytes > 2_048 || retainedBytes + bytes > 16_384) continue;
    responseHeaders[name] = value;
    retainedBytes += bytes;
  }
  for (const name of ["request-id", "x-request-id", "apim-request-id", "x-amzn-requestid", "x-amzn-request-id", "x-generation-id", "x-goog-request-id", "x-correlation-id"]) {
    const value = responseHeaders[name];
    if (value && safeOpaqueToken.test(value)) {
      requestId = value;
      break;
    }
  }
  const responseDetails: ProviderResponseDetails = { headers: responseHeaders };
  if (Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599) {
    responseDetails.status = response.status;
  }
  const details: ProviderDiagnosticDetails = { response: responseDetails };
  const provider = diagnosticString(timestampOrProvider);
  if (provider !== undefined && safeOpaqueToken.test(provider)) details.provider = provider;
  if (explicitRequestId && safeOpaqueToken.test(explicitRequestId)) {
    requestId = explicitRequestId;
  }
  if (requestId !== undefined) details.requestId = requestId;
  const timestamp = diagnosticNumber(timestampOrProvider);
  return {
    type: "provider_response",
    timestamp: timestamp !== undefined
      ? timestamp
      : Date.now(),
    details,
  };
}

export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const time = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) bytes[index] = Number((time >> BigInt((5 - index) * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function retryable(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  const error = message.errorMessage?.toLowerCase() ?? "";
  if (/quota|credit|billing|usage.?limit|insufficient_quota/.test(error)) return false;
  return /429|408|409|425|5\d\d|timeout|timed out|temporar|overload|rate.?limit|connection|network|socket/.test(error);
}

function abortedClone(message: AssistantMessage): AssistantMessage {
  const clone = structuredClone(message);
  clone.stopReason = "aborted";
  delete clone.errorMessage;
  return clone;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function retryAssistantCall(
  produce: () => Promise<AssistantMessage>,
  policy?: RetryPolicy,
  signal?: AbortSignal,
  callbacks: RetryCallbacks = {},
): Promise<AssistantMessage> {
  let message = await produce();
  if (!policy?.enabled || policy.maxRetries <= 0) return message;
  const maxAttempts = policy.maxRetries + 1;
  for (let attempt = 1; attempt < maxAttempts && retryable(message); attempt += 1) {
    if (signal?.aborted) return abortedClone(message);
    const uncapped = policy.baseDelayMs * 2 ** (attempt - 1);
    const delayMs = Math.min(uncapped, policy.maxDelayMs ?? Number.MAX_SAFE_INTEGER);
    await callbacks.onRetryScheduled?.(attempt, maxAttempts, delayMs, message.errorMessage ?? "Transient error");
    if (!await wait(delayMs, signal)) return abortedClone(message);
    await callbacks.onRetryAttemptStart?.(attempt);
    message = await produce();
    await callbacks.onRetryFinished?.(
      message.stopReason !== "error" && message.stopReason !== "aborted",
      attempt,
    );
    if (message.stopReason === "aborted") return message;
  }
  return message;
}
