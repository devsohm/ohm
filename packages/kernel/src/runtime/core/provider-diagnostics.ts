import { optionalProperty } from "../../internal/optional-properties.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isJsonObject, type JsonValue } from "./json.js";
import type { AdapterError, ProviderResponseDiagnostics } from "./types.js";
import {
	BOOLEAN_VALUE,
	NUMBER_VALUE,
	replaceControlCharacters,
	STRING_VALUE,
} from "../../internal/value-schemas.js";

const MAX_HEADER_VALUE_BYTES = 2 * 1024;
const MAX_DIAGNOSTIC_HEADER_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_INPUT_BYTES = 32 * 1024;
const MAX_ADAPTER_ERROR_BYTES = 128 * 1024;
const MAX_ADAPTER_ERROR_MESSAGE_BYTES = 16 * 1024;
const MAX_ADAPTER_ERROR_METADATA_BYTES = 4 * 1024;
const MAX_ADAPTER_ERROR_RAW_BYTES = 64 * 1024;
const MAX_ADAPTER_ERROR_VALUES = 8_288;
const MAX_ADAPTER_ERROR_CONTAINERS = 4_100;
const MAX_ADAPTER_ERROR_DEPTH = 61;

const ADAPTER_ERROR_CATEGORY_VALUE = Type.Union([
  Type.Literal("authentication"),
  Type.Literal("permission"),
  Type.Literal("rate_limit"),
  Type.Literal("invalid_request"),
  Type.Literal("not_found"),
  Type.Literal("overloaded"),
  Type.Literal("network"),
  Type.Literal("timeout"),
  Type.Literal("protocol"),
  Type.Literal("cancelled"),
  Type.Literal("provider"),
]);

const ADAPTER_ERROR_FIELDS = new Set([
  "category",
  "message",
  "httpStatus",
  "providerCode",
  "requestId",
  "retryAfterMs",
  "retryable",
  "partial",
  "bodyStarted",
  "diagnostics",
  "raw",
]);

const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "request-id",
  "x-request-id",
  "apim-request-id",
  "x-amzn-requestid",
  "x-amzn-request-id",
  "x-generation-id",
  "x-goog-request-id",
  "cf-ray",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
]);

function boundedHeaderValue(value: string): string {
	const normalized = replaceControlCharacters(value, " ", false).replace(/\s+/gu, " ").trim();
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= MAX_HEADER_VALUE_BYTES) return normalized;
  return bytes.subarray(0, MAX_HEADER_VALUE_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
}

/**
 * Builds the only response-header projection that may leave a provider adapter.
 * Unknown headers—including authorization, cookies, and provider-specific secrets—are dropped.
 */
export function canonicalProviderResponseDiagnostics(
  status: number,
  headers: Iterable<readonly [string, string]>,
): ProviderResponseDiagnostics {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Provider response diagnostic status must be an HTTP status code");
  }
  const selected: Record<string, string> = {};
  let retainedBytes = 0;
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_RESPONSE_HEADERS.has(name) || Object.hasOwn(selected, name)) continue;
    const value = boundedHeaderValue(rawValue);
    const bytes = Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (retainedBytes + bytes > MAX_DIAGNOSTIC_HEADER_BYTES) break;
    selected[name] = value;
    retainedBytes += bytes;
  }
  return { status, headers: selected };
}

/** Revalidates custom-provider diagnostics at the core boundary. */
export function validateProviderResponseDiagnostics<T>(value: T): ProviderResponseDiagnostics {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider response diagnostics",
    maximumBytes: MAX_DIAGNOSTIC_INPUT_BYTES,
    maximumValues: 64,
    maximumContainers: 2,
    maximumDepth: 2,
  }).value;
  if (!isJsonObject(snapshot)) throw new TypeError("Provider response diagnostics must be an object");
  const record = snapshot;
  if (Object.keys(record).some((key) => key !== "status" && key !== "headers")
    || !Object.hasOwn(record, "status") || !Object.hasOwn(record, "headers")) {
    throw new TypeError("Provider response diagnostics contain unsupported fields");
  }
  if (!isJsonObject(record.headers)) {
    throw new TypeError("Provider response diagnostic headers must be an object");
  }
  const headers = Object.entries(record.headers).map(([name, header]) => {
    if (!Check(STRING_VALUE, header)) throw new TypeError("Provider response diagnostic header values must be strings");
    return [name, header] as const;
  });
  if (!Check(NUMBER_VALUE, record.status)) {
    throw new TypeError("Provider response diagnostic status must be an HTTP status code");
  }
  return canonicalProviderResponseDiagnostics(record.status, headers);
}

function adapterErrorText(value: JsonValue | undefined, label: string, maximumBytes: number): string {
  if (!Check(STRING_VALUE, value) || value === "") throw new TypeError(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new TypeError(`${label} exceeds its byte limit`);
  return value;
}

function boundedAdapterErrorMessage(value: JsonValue | undefined): string {
  if (!Check(STRING_VALUE, value) || value === "") {
    throw new TypeError("Provider adapter error message must be a non-empty string");
  }
	const normalized = replaceControlCharacters(value, " ");
  const redacted = defaultSecretRedactor.redact(normalized);
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.byteLength <= MAX_ADAPTER_ERROR_MESSAGE_BYTES) return redacted;
  return encoded.subarray(0, MAX_ADAPTER_ERROR_MESSAGE_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
}

/** Revalidates and detaches an error returned by a custom provider adapter. */
export function validateProviderAdapterError<T>(value: T): AdapterError {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider adapter error",
    maximumBytes: MAX_ADAPTER_ERROR_BYTES,
    maximumValues: MAX_ADAPTER_ERROR_VALUES,
    maximumContainers: MAX_ADAPTER_ERROR_CONTAINERS,
    maximumDepth: MAX_ADAPTER_ERROR_DEPTH,
  }).value;
  if (!isJsonObject(snapshot)) throw new TypeError("Provider adapter error must be an object");
  const record = snapshot;
  if (Object.keys(record).some((key) => !ADAPTER_ERROR_FIELDS.has(key))) {
    throw new TypeError("Provider adapter error contains unsupported fields");
  }
  for (const field of ["category", "message", "retryable", "partial"] as const) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`Provider adapter error ${field} is required`);
  }
  const category = record.category;
  if (!Check(ADAPTER_ERROR_CATEGORY_VALUE, category)) {
    throw new TypeError("Provider adapter error category is invalid");
  }
  const retryable = record.retryable;
  const partial = record.partial;
  if (!Check(BOOLEAN_VALUE, retryable) || !Check(BOOLEAN_VALUE, partial)) {
    throw new TypeError("Provider adapter error flags must be booleans");
  }
  const bodyStarted = record.bodyStarted;
  if (bodyStarted !== undefined && !Check(BOOLEAN_VALUE, bodyStarted)) {
    throw new TypeError("Provider adapter error bodyStarted flag must be a boolean");
  }
  const httpStatus = record.httpStatus;
  if (httpStatus !== undefined && (
    !Check(NUMBER_VALUE, httpStatus) || !Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599
  )) throw new TypeError("Provider adapter error HTTP status is invalid");
  const retryAfterMs = record.retryAfterMs;
  if (retryAfterMs !== undefined && (
    !Check(NUMBER_VALUE, retryAfterMs) || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0
  )) throw new TypeError("Provider adapter error retry delay is invalid");
  const message = boundedAdapterErrorMessage(record.message);
  const providerCode = record.providerCode === undefined
    ? undefined
    : adapterErrorText(record.providerCode, "Provider adapter error code", MAX_ADAPTER_ERROR_METADATA_BYTES);
  const requestId = record.requestId === undefined
    ? undefined
    : adapterErrorText(record.requestId, "Provider adapter request ID", MAX_ADAPTER_ERROR_METADATA_BYTES);
  const diagnostics = record.diagnostics === undefined
    ? undefined
    : validateProviderResponseDiagnostics(record.diagnostics);
  const raw = record.raw === undefined
    ? undefined
    : boundedJsonSnapshot(record.raw, {
        label: "Provider adapter error raw payload",
        maximumBytes: MAX_ADAPTER_ERROR_RAW_BYTES,
        maximumValues: 8_192,
        maximumContainers: 4_096,
        maximumDepth: 59,
      }).value;

  return {
    category,
    message,
    ...optionalProperty("httpStatus", httpStatus),
    ...optionalProperty("providerCode", providerCode),
    ...optionalProperty("requestId", requestId),
    ...optionalProperty("retryAfterMs", retryAfterMs),
    retryable,
    partial,
    ...optionalProperty("bodyStarted", bodyStarted),
    ...optionalProperty("diagnostics", diagnostics),
    ...optionalProperty("raw", raw),
  };
}
