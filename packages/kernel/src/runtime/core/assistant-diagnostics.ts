import { optionalProperty } from "../../internal/optional-properties.js";
import { providerResponseDiagnostic, type AssistantMessageDiagnostic } from "@ohm/models";
import { Check } from "typebox/value";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { validateProviderResponseDiagnostics } from "./provider-diagnostics.js";
import type { ProviderResponseDiagnostics } from "./types.js";
import { NUMBER_VALUE, STRING_VALUE } from "../../internal/value-schemas.js";

const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
const MAX_TYPE_BYTES = 256;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const MAX_DIAGNOSTICS_ENVELOPE_BYTES = 512 * 1024;
const MAX_DIAGNOSTICS_ENVELOPE_VALUES = 64 * 1024;
const MAX_DIAGNOSTICS_ENVELOPE_CONTAINERS = 32 * 1024;
const MAX_DIAGNOSTICS_ENVELOPE_DEPTH = 66;

function record(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function text(value: JsonValue | undefined, label: string, maximumBytes: number): string {
  if (!Check(STRING_VALUE, value) || value === "") throw new TypeError(`${label} must be a non-empty string`);
  const redacted = defaultSecretRedactor.redact(value).replaceAll("\0", "�");
  if (Buffer.byteLength(redacted, "utf8") > maximumBytes) {
    throw new TypeError(`${label} exceeds its byte limit`);
  }
  return redacted;
}

function diagnosticError(value: JsonValue | undefined): NonNullable<AssistantMessageDiagnostic["error"]> {
  const selected = record(value, "Assistant diagnostic error");
  exactKeys(selected, new Set(["name", "message", "stack", "code", "status"]), "Assistant diagnostic error");
  const status = selected.status;
  if (status !== undefined && (!Check(NUMBER_VALUE, status) || !Number.isFinite(status))) {
    throw new TypeError("Assistant diagnostic error status must be finite");
  }
  const code = selected.code;
  if (
    code !== undefined
    && !Check(STRING_VALUE, code)
    && (!Check(NUMBER_VALUE, code) || !Number.isFinite(code))
  ) {
    throw new TypeError("Assistant diagnostic error code must be a string or finite number");
  }
  const normalizedCode = code === undefined
    ? undefined
    : Check(STRING_VALUE, code)
      ? text(code, "Assistant diagnostic error code", MAX_TYPE_BYTES)
      : code;
  return {
    ...optionalProperty(
      "name",
      selected.name === undefined ? undefined : text(selected.name, "Assistant diagnostic error name", MAX_TYPE_BYTES),
    ),
    message: text(selected.message, "Assistant diagnostic error message", MAX_ERROR_TEXT_BYTES),
    ...optionalProperty(
      "stack",
      selected.stack === undefined ? undefined : text(selected.stack, "Assistant diagnostic error stack", MAX_ERROR_TEXT_BYTES),
    ),
    ...optionalProperty("code", normalizedCode),
    ...optionalProperty("status", status),
  };
}

function diagnosticDetails(value: JsonValue | undefined): JsonObject {
  const redacted = defaultSecretRedactor.redactPayloadValue(value);
  if (!isJsonObject(redacted)) {
    throw new TypeError("Assistant diagnostic details must be a JSON-safe object");
  }
  return structuredClone(redacted);
}

/**
 * Validates, detaches, bounds, and redacts assistant diagnostics before they
 * enter durable history or cross an extension boundary.
 */
export function canonicalAssistantDiagnostics<T>(value: T): AssistantMessageDiagnostic[] | undefined {
  if (value === undefined) return undefined;
  const source = boundedJsonSnapshot(value, {
    label: "Assistant diagnostics",
    maximumBytes: MAX_DIAGNOSTICS_ENVELOPE_BYTES,
    maximumValues: MAX_DIAGNOSTICS_ENVELOPE_VALUES,
    maximumContainers: MAX_DIAGNOSTICS_ENVELOPE_CONTAINERS,
    maximumDepth: MAX_DIAGNOSTICS_ENVELOPE_DEPTH,
  }).value;
  if (!Array.isArray(source)) throw new TypeError("Assistant diagnostics must be an array");
  if (source.length > MAX_DIAGNOSTICS) throw new TypeError("Assistant diagnostics exceed their item limit");

  const diagnostics: AssistantMessageDiagnostic[] = [];
  let totalBytes = 0;
  for (const [index, item] of source.entries()) {
    const selected = record(item, `Assistant diagnostic ${index}`);
    exactKeys(selected, new Set(["type", "message", "error", "details", "timestamp"]), `Assistant diagnostic ${index}`);
    if (!Check(NUMBER_VALUE, selected.timestamp) || !Number.isFinite(selected.timestamp) || selected.timestamp < 0) {
      throw new TypeError(`Assistant diagnostic ${index} timestamp must be a non-negative finite number`);
    }
    const diagnostic: AssistantMessageDiagnostic = {
      type: text(selected.type, `Assistant diagnostic ${index} type`, MAX_TYPE_BYTES),
      ...optionalProperty(
        "message",
        selected.message === undefined
          ? undefined
          : text(selected.message, `Assistant diagnostic ${index} message`, MAX_MESSAGE_BYTES),
      ),
      ...optionalProperty("error", selected.error === undefined ? undefined : diagnosticError(selected.error)),
      ...optionalProperty("details", selected.details === undefined ? undefined : diagnosticDetails(selected.details)),
      timestamp: selected.timestamp,
    };
    const bytes = Buffer.byteLength(JSON.stringify(diagnostic), "utf8");
    if (bytes > MAX_DIAGNOSTIC_BYTES) throw new TypeError(`Assistant diagnostic ${index} exceeds its byte limit`);
    totalBytes += bytes;
    if (totalBytes > MAX_DIAGNOSTICS_BYTES) throw new TypeError("Assistant diagnostics exceed their total byte limit");
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** Creates the canonical public diagnostic for an allowlisted provider response. */
export function assistantDiagnosticsFromProviderResponse(
  response: ProviderResponseDiagnostics | undefined,
): AssistantMessageDiagnostic[] | undefined {
  return response === undefined
    ? undefined
    : canonicalAssistantDiagnostics([
        providerResponseDiagnostic(validateProviderResponseDiagnostics(response)),
      ]);
}
