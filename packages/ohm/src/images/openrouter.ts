import { optionalProperties } from "../core/optional-properties.js";
import { isProxy } from "node:util/types";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

import { validateImageSource } from "../core/image-source.js";
import { assertRedactableSecret, defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import type { UsageCost } from "../core/types.js";
import { NUMBER_VALUE, STRING_VALUE, isObjectValue } from "../core/value-schemas.js";
import { sanitizeUnicode, stringifyProviderJson } from "../providers/json.js";
import { assertSecureEndpoint, HttpResponseError, ProtocolError, type FetchLike } from "../providers/transport.js";
import { imageErrorResult } from "./models.js";
import type {
  AssistantImages,
  ImagesContext,
  ImagesFunction,
  ImagesHeaders,
  ImagesImageContent,
  ImagesModel,
  ImagesOptions,
  ImagesProviderResponse,
  ImagesTextContent,
  ImagesUsage,
  ProviderImages,
} from "./types.js";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 160 * 1024 * 1024;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;
const MAX_OUTPUT_IMAGES = 16;
const MAX_ERROR_BYTES = 4 * 1024;
const SENSITIVE_HEADER = /(?:authorization|api[-_]?key|token|cookie|secret)/iu;

interface OpenAISdkClientOptions {
  apiKey: string;
  baseURL: string;
  fetch: FetchLike;
  maxRetries: number;
  logLevel: "off";
}

interface OpenAISdkRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries: number;
  headers?: Record<string, string>;
}

interface OpenAISdkCompletionResult {
  data: object;
  response: Response;
  request_id?: string | null;
}

interface OpenAISdk {
  default: new (options: OpenAISdkClientOptions) => {
    chat: {
      completions: {
        create(
          payload: ChatCompletionCreateParamsNonStreaming,
          options: OpenAISdkRequestOptions,
        ): { withResponse(): Promise<OpenAISdkCompletionResult> };
      };
    };
  };
}

export interface OpenRouterImagesDependencies {
  loadSdk?: () => Promise<OpenAISdk>;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const OPENROUTER_PAYLOAD_VALUE = Type.Object({
  model: Type.String(),
  messages: Type.Array(Type.Object({
    role: Type.Literal("user"),
    content: Type.Array(Type.Union([
      Type.Object({ type: Type.Literal("text"), text: Type.String() }),
      Type.Object({
        type: Type.Literal("image_url"),
        image_url: Type.Object({ url: Type.String() }),
      }),
    ])),
  })),
  stream: Type.Literal(false),
  modalities: Type.Array(Type.Union([Type.Literal("image"), Type.Literal("text")])),
}, { additionalProperties: true });

type OpenRouterPayload = Static<typeof OPENROUTER_PAYLOAD_VALUE> & JsonObject;

export function createOpenRouterImagesApi(
  dependencies: OpenRouterImagesDependencies = {},
): ProviderImages<"openrouter-images"> {
  const generate = createOpenRouterImagesGenerator(dependencies);
  return {
    generateImages: (model, context, options) => generate(model, context, options),
  };
}

export function createOpenRouterImagesGenerator(
  dependencies: OpenRouterImagesDependencies = {},
): ImagesFunction<"openrouter-images"> {
  let loaded: Promise<OpenAISdk> | undefined;
  const load = (): Promise<OpenAISdk> => {
    loaded ??= dependencies.loadSdk?.() ?? import("openai");
    return loaded;
  };

  return async (model, context, options): Promise<AssistantImages> => {
    const timestamp = dependencies.now?.() ?? Date.now();
    const output: AssistantImages = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: "stop",
      timestamp,
    };

    try {
      options?.signal?.throwIfAborted();
      const apiKey = options?.apiKey;
      if (apiKey === undefined || apiKey === "") {
        throw new Error(`No API key for image provider: ${model.provider}`);
      }
      assertRedactableSecret(apiKey, "Image provider API key");
      defaultSecretRedactor.register(apiKey);
      assertSecureEndpoint(model.baseUrl, "Image provider endpoint");
      const retry = retryPolicy(options);
      const maximumResponseBytes = boundedInteger(
        options?.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        1,
        MAX_RESPONSE_BYTES,
        "maxResponseBytes",
      );
      const timeoutMs = options?.timeoutMs === undefined
        ? undefined
        : boundedInteger(options.timeoutMs, options.timeoutMs, 1, MAX_TIMEOUT_MS, "timeoutMs");
      const fetchImplementation = boundedSdkFetch(
        options?.fetch ?? dependencies.fetch ?? globalThis.fetch,
        maximumResponseBytes,
      );
      const sdk = await load();
      options?.signal?.throwIfAborted();
      const sdkClient = new sdk.default({
        apiKey,
        baseURL: model.baseUrl,
        fetch: fetchImplementation,
        maxRetries: 0,
        logLevel: "off",
      });
      const payload = await requestPayload(model, context, options);
      const headers = requestHeaders(model.headers, options?.headers);

      const response = await withRetries(
        async () => {
          options?.signal?.throwIfAborted();
          // SAFETY: requestPayload validated the required model, messages, non-streaming flag, and modalities while retaining OpenRouter-specific JSON fields accepted by the compatible endpoint.
          const sdkPayload = payload as ChatCompletionCreateParamsNonStreaming;
          return await sdkClient.chat.completions.create(sdkPayload, {
            ...optionalProperties(options?.signal === undefined ? undefined : { signal: options.signal }),
            ...optionalProperties(timeoutMs === undefined ? undefined : { timeout: timeoutMs }),
            maxRetries: 0,
            ...optionalProperties(headers === undefined ? undefined : { headers }),
          }).withResponse();
        },
        retry,
        dependencies.sleep ?? sleep,
        options?.signal,
        async (error) => {
          const responseInfo = responseFromError(error);
          if (responseInfo !== undefined) await options?.onResponse?.(responseInfo, model);
        },
      );

      const responseInfo = responseMetadata(response.response);
      await options?.onResponse?.(responseInfo, model);
      const responseData = parseSdkResponse(response.data);
      const parsed = parseImageResponse(responseData, model);
      output.output.push(...parsed.output);
      if (parsed.responseId !== undefined) output.responseId = parsed.responseId;
      if (parsed.usage !== undefined) output.usage = parsed.usage;
      return output;
    } catch (error) {
      const failure = runtimeValue(error);
      const failed = imageErrorResult(model, failure, options?.signal);
      failed.timestamp = timestamp;
      failed.errorMessage = normalizedImageError(failure, options?.signal);
      return failed;
    }
  };
}

export const generateOpenRouterImages = createOpenRouterImagesGenerator();

async function requestPayload(
  model: ImagesModel<"openrouter-images">,
  context: ImagesContext,
  options: ImagesOptions | undefined,
): Promise<OpenRouterPayload> {
  if (!Array.isArray(context.input) || context.input.length === 0 || context.input.length > 64) {
    throw new TypeError("Image generation input must contain 1 through 64 content items");
  }
  let imageCount = 0;
  const content: OpenRouterPayload["messages"][number]["content"] = context.input.map((item) => {
    if (item.type === "text") {
      return { type: "text", text: sanitizeUnicode(item.text) };
    }
    imageCount += 1;
    if (imageCount > 16) throw new RangeError("Image generation input supports at most 16 images");
    const image = validateImageSource({
      type: "image",
      mediaType: item.mimeType,
      data: item.data,
    });
    if (image.kind !== "base64") throw new TypeError("Image generation input must use base64 image data");
    return {
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    };
  });
  const original: OpenRouterPayload = {
    model: model.id,
    messages: [{ role: "user", content }],
    stream: false,
    modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
  };
  const replacement = await options?.onPayload?.(original, model);
  const selected = replacement === undefined ? original : replacement;
  const serialized = stringifyProviderJson(selected);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Image request payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonObject(parsed) || !Value.Check(OPENROUTER_PAYLOAD_VALUE, parsed)) {
    throw new TypeError("Image request payload must be a JSON object");
  }
  return parsed;
}

function requestHeaders(
  modelHeaders: Readonly<Record<string, string>> | undefined,
  request: ImagesHeaders | undefined,
): Record<string, string> | undefined {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of Object.entries(request ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  // Authorization is always owned by the resolved credential passed to the SDK.
  headers.delete("authorization");
  for (const [name, value] of headers) {
    if (SENSITIVE_HEADER.test(name)) {
      assertRedactableSecret(value, `Image provider ${name} header credential`);
      defaultSecretRedactor.register(value);
    }
  }
  const entries = [...headers.entries()];
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function responseMetadata(response: Response): ImagesProviderResponse {
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
}

function parseImageResponse(
  response: JsonObject,
  model: ImagesModel<"openrouter-images">,
): ParsedImageResponse {
  const result: ParsedImageResponse = {
    output: [],
  };
  if (Value.Check(STRING_VALUE, response.id) && response.id !== "") {
    result.responseId = boundedText(sanitizeUnicode(response.id), 4_096);
  }
  const usage = parseUsage(response.usage, model);
  if (usage !== undefined) result.usage = usage;

  const choice = Array.isArray(response.choices) ? record(response.choices[0]) : undefined;
  const message = record(choice?.message);
  const content = message?.content;
  if (Value.Check(STRING_VALUE, content) && content !== "") {
    result.output.push({ type: "text", text: sanitizeUnicode(content) });
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const candidate of content) {
      const part = record(candidate);
      if (part?.type === "text" && Value.Check(STRING_VALUE, part.text)) {
        parts.push(sanitizeUnicode(part.text));
      }
    }
    const text = parts.join("");
    if (text !== "") result.output.push({ type: "text", text });
  }

  const images = Array.isArray(message?.images) ? message.images : [];
  for (const candidate of images.slice(0, MAX_OUTPUT_IMAGES)) {
    const image = record(candidate);
    const value = image?.image_url;
    const nestedUrl = record(value)?.url;
    const url = Value.Check(STRING_VALUE, value) ? value : nestedUrl;
    if (!Value.Check(STRING_VALUE, url)) continue;
    const parsed = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(url);
    if (parsed === null) continue;
    try {
      const validated = validateImageSource({
        type: "image",
        mediaType: parsed[1]!,
        data: parsed[2]!,
      });
      if (validated.kind === "base64") {
        result.output.push({
          type: "image",
          mimeType: validated.mediaType,
          data: validated.data,
        });
      }
    } catch {
      // Ignore malformed or oversized provider images while preserving valid siblings.
    }
  }
  return result;
}

function parseSdkResponse<T>(value: T): JsonObject {
  const serialized = stringifyProviderJson(value);
  const parsed: JsonValue = JSON.parse(serialized);
  if (!isJsonObject(parsed)) throw new ProtocolError("Image provider response must be a JSON object");
  return parsed;
}

interface ParsedImageResponse {
  output: Array<ImagesTextContent | ImagesImageContent>;
  responseId?: string;
  usage?: ImagesUsage;
}

function parseUsage<T>(value: T, model: ImagesModel<"openrouter-images">): ImagesUsage | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const details = record(raw.prompt_tokens_details);
  const prompt = token(raw.prompt_tokens);
  const output = token(raw.completion_tokens);
  const cacheReadTokens = token(details?.cached_tokens);
  const cacheWriteTokens = token(details?.cache_write_tokens);
  const inputTokens = prompt === undefined
    ? undefined
    : Math.max(0, prompt - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0));
  const reportedTotal = token(raw.total_tokens);
  const totalTokens = reportedTotal ?? (
    prompt === undefined || output === undefined ? undefined : prompt + output
  );
  const usage: ImagesUsage = {
    ...optionalProperties(inputTokens === undefined ? undefined : { inputTokens }),
    ...optionalProperties(output === undefined ? undefined : { outputTokens: output }),
    ...optionalProperties(cacheReadTokens === undefined ? undefined : { cacheReadTokens }),
    ...optionalProperties(cacheWriteTokens === undefined ? undefined : { cacheWriteTokens }),
    ...optionalProperties(totalTokens === undefined || !Number.isSafeInteger(totalTokens) ? undefined : { totalTokens }),
  };
  if (Object.keys(usage).length === 0) return undefined;
  const cost = usageCost(usage, model);
  if (cost !== undefined) usage.cost = cost;
  return usage;
}

function token<T>(value: T): number | undefined {
  return Value.Check(NUMBER_VALUE, value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageCost(
  usage: ImagesUsage,
  model: ImagesModel<"openrouter-images">,
): UsageCost | undefined {
  const pricing = model.pricing;
  if (
    pricing === undefined ||
    usage.inputTokens === undefined || usage.outputTokens === undefined ||
    usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined ||
    Object.values(pricing).some((value) => !Number.isFinite(value) || value < 0)
  ) return undefined;
  const input = pricing.input * usage.inputTokens / 1_000_000;
  const output = pricing.output * usage.outputTokens / 1_000_000;
  const cacheRead = pricing.cacheRead * usage.cacheReadTokens / 1_000_000;
  const cacheWrite = pricing.cacheWrite * usage.cacheWriteTokens / 1_000_000;
  const total = input + output + cacheRead + cacheWrite;
  return [input, output, cacheRead, cacheWrite, total].every(Number.isFinite)
    ? { input, output, cacheRead, cacheWrite, total }
    : undefined;
}

interface RetryPolicy {
  maximum: number;
  maximumServerDelayMs: number;
}

function retryPolicy(options: ImagesOptions | undefined): RetryPolicy {
  return {
    maximum: boundedInteger(options?.maxRetries, 0, 0, MAX_RETRIES, "maxRetries"),
    maximumServerDelayMs: boundedInteger(
      options?.maxRetryDelayMs,
      DEFAULT_MAX_RETRY_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
      "maxRetryDelayMs",
    ),
  };
}

async function withRetries<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  observeError: (error: RuntimeValue) => Promise<void>,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const failure = runtimeValue(error);
      await observeError(failure);
      signal?.throwIfAborted();
      if (attempt >= policy.maximum || !retryable(failure)) throw error;
      const requested = retryDelay(failure);
      if (
        requested !== undefined &&
        policy.maximumServerDelayMs !== 0 &&
        requested > policy.maximumServerDelayMs
      ) {
        throw new Error(
          `Provider requested a retry delay of ${requested}ms, exceeding the ${policy.maximumServerDelayMs}ms cap`,
          { cause: failure },
        );
      }
      const delay = requested ?? Math.min(10_000, 250 * 2 ** attempt);
      await wait(delay, signal);
      attempt += 1;
    }
  }
}

declare const RUNTIME_OBJECT: unique symbol;

interface RuntimeObject {
  readonly [RUNTIME_OBJECT]?: never;
}

type RuntimeValue = RuntimeObject | string | number | boolean | bigint | symbol | null | undefined;
type ErrorTester = (candidate: RuntimeValue) => boolean;

function runtimeValue<T>(value: T): RuntimeValue {
  // SAFETY: RuntimeObject is a structural marker that accepts every object and callable while the union names every primitive category.
  return value as RuntimeValue;
}

function isErrorObject(value: RuntimeValue): value is RuntimeValue & Error {
  // SAFETY: recent Node runtimes may expose Error.isError; this optional shape is checked before invocation.
  const isError = (Error as ErrorConstructor & { isError?: ErrorTester }).isError;
  return isError?.(value) === true;
}

function errorInstance<TError extends Error>(
  value: RuntimeValue,
  constructor: abstract new (...argumentsValue: never[]) => TError,
): value is RuntimeValue & TError {
  if (!isErrorObject(value)) return false;
  try { return value instanceof constructor; }
  catch { return false; }
}

function errorField(value: RuntimeValue, key: string): RuntimeValue {
  if (!isObjectValue(value) || isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function headerValue(headers: Headers | undefined, name: string): string | null | undefined {
  return headers === undefined ? undefined : Headers.prototype.get.call(headers, name);
}

function retryable(error: RuntimeValue): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status);
  const name = isErrorObject(error) ? errorField(error, "name") : undefined;
  return errorInstance(error, TypeError) || (Value.Check(STRING_VALUE, name) && /connection|timeout|network/iu.test(name));
}

function retryDelay(error: RuntimeValue): number | undefined {
  const headers = errorHeaders(error);
  const milliseconds = numericHeader(headers, "retry-after-ms");
  if (milliseconds !== undefined) return milliseconds;
  const value = headerValue(headers, "retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function numericHeader(headers: Headers | undefined, name: string): number | undefined {
  const raw = headerValue(headers, name);
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function responseFromError(error: RuntimeValue): ImagesProviderResponse | undefined {
  const status = errorStatus(error);
  const headers = errorHeaders(error);
  return status === undefined
    ? undefined
    : { status, headers: headers === undefined ? {} : Object.fromEntries(Headers.prototype.entries.call(headers)) };
}

function errorStatus(error: RuntimeValue): number | undefined {
  for (const current of errorChain(error)) {
    if (errorInstance(current, HttpResponseError)) return current.status;
    const status = errorField(current, "status");
    if (Value.Check(NUMBER_VALUE, status) && Number.isSafeInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

function errorHeaders(error: RuntimeValue): Headers | undefined {
  for (const current of errorChain(error)) {
    if (errorInstance(current, HttpResponseError)) return current.headers;
    const headers = errorField(current, "headers");
    if (isObjectValue(headers) && !isProxy(headers) && headers instanceof Headers) return headers;
  }
  return undefined;
}

function* errorChain(error: RuntimeValue): Generator<RuntimeValue> {
  const seen = new Set<RuntimeValue>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current);
    yield current;
    current = errorField(current, "cause");
  }
}

function normalizedImageError(error: RuntimeValue, signal?: AbortSignal): string {
  if (signal?.aborted === true || isAbortError(error)) return "Request cancelled";
  const status = errorStatus(error);
  const messages: string[] = [];
  for (const current of errorChain(error)) {
    if (isErrorObject(current)) {
      const message = errorMessage(current);
      if (message !== "" && message !== "[Thrown Error]") messages.push(message);
    }
    collectErrorText(errorField(current, "error"), messages, 0);
    collectErrorText(errorField(current, "body"), messages, 0);
  }
  const unique = [...new Set(messages.map((message) => message.trim()).filter((message) => message !== ""))];
  const description = unique.slice(0, 3).join(": ") || errorMessage(error);
  return boundedError(status === undefined ? description : `HTTP ${status}: ${description}`);
}

function collectErrorText(value: RuntimeValue, output: string[], depth: number): void {
  if (value === undefined || value === null || depth > 5 || output.length >= 8) return;
  if (Value.Check(STRING_VALUE, value)) {
    output.push(value);
    return;
  }
  if (isObjectValue(value) && isProxy(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 32); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && "value" in descriptor) {
        collectErrorText(descriptor.value, output, depth + 1);
      }
    }
    return;
  }
  for (const name of ["message", "detail", "reason", "error", "body"]) {
    collectErrorText(errorField(value, name), output, depth + 1);
  }
}

function boundedError(value: string): string {
  const redacted = defaultSecretRedactor.redact(sanitizeUnicode(value));
  let text = "";
  for (const character of redacted) {
    const codePoint = character.codePointAt(0) ?? 0;
    const permittedWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
    if (permittedWhitespace || (codePoint >= 0x20 && codePoint !== 0x7f)) text += character;
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_ERROR_BYTES) return text;
  return `${bytes.subarray(0, MAX_ERROR_BYTES).toString("utf8")}…`;
}

function boundedText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maximumBytes
    ? value
    : bytes.subarray(0, maximumBytes).toString("utf8");
}

function isAbortError(error: RuntimeValue): boolean {
  if (!isErrorObject(error)) return false;
  if (errorInstance(error, DOMException)) {
    const getter = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
    return getter?.call(error) === "AbortError";
  }
  return errorField(error, "name") === "AbortError";
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function boundedSdkFetch(fetchImplementation: FetchLike, maximum: number): FetchLike {
  const limitedFetch: FetchLike = async (input, init) => {
    const response = await fetchImplementation(input, { ...init, redirect: "error" });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProtocolError(`Image response exceeded ${maximum} bytes`);
    }
    if (response.body === null) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum) throw new ProtocolError(`Image response exceeded ${maximum} bytes`);
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return limitedFetch;
}

function record<T>(value: T): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  let remaining = milliseconds;
  do {
    const scheduled = remaining > MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : remaining;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason ?? new DOMException("Request cancelled", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, scheduled);
      const abort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new DOMException("Request cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
    remaining -= scheduled;
  } while (remaining > 0);
}
