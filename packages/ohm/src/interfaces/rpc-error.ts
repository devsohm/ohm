import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { projectExtensionError } from "../modes/extension-error.js";
import type { RpcExtensionErrorEvent } from "./rpc-protocol.js";
import { Value } from "typebox/value";
import { STRING_VALUE } from "../core/value-schemas.js";

const MAX_RPC_ERROR_BYTES = 4_096;
const MAX_RPC_EXTENSION_ID_BYTES = 1_024;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const TRUNCATION_MARKER = "...";

function inputPrefix(value: string): string {
  // A UTF-16 code unit occupies at least one UTF-8 byte. Keeping the default
  // redactor's full per-secret byte capacity prevents a registered secret that
  // begins before the output cutoff from being split before redaction.
  let end = Math.min(value.length, MAX_RPC_ERROR_BYTES + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < value.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end -= 1;
  return value.slice(0, end);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** @internal Bound untrusted failure input before applying secret-redaction patterns. */
export function boundedRpcErrorMessage<ErrorValue>(error: ErrorValue): string {
  const source = errorMessage(error);
  const selected = inputPrefix(source);
  const redacted = defaultSecretRedactor.redact(selected);
  const truncated = selected.length < source.length || Buffer.byteLength(redacted, "utf8") > MAX_RPC_ERROR_BYTES;
  if (!truncated) return redacted;
  return `${utf8Prefix(redacted, MAX_RPC_ERROR_BYTES - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** @internal Keep extension ownership present and bounded on the public RPC wire. */
export function boundedRpcExtensionId<ValueType>(value: ValueType): string {
  const selected = Value.Check(STRING_VALUE, value) ? value.replaceAll("\0", "") : "";
  if (selected === "") return "runtime";
  return utf8Prefix(selected, MAX_RPC_EXTENSION_ID_BYTES) || "runtime";
}

/** @internal Project one redacted, owner-identified extension failure onto RPC. */
export function createRpcExtensionErrorEvent(error: {
  extensionId?: string;
  extensionPath: string;
  event: string;
  error: string;
}): RpcExtensionErrorEvent {
  return projectExtensionError(error);
}
