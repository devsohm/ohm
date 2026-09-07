import { defaultSecretRedactor } from "../auth/redaction.js";

const MAX_DIAGNOSTIC_BYTES = 4_096;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const TRUNCATION_MARKER = "...";

export function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Bound diagnostic input before redaction without splitting a cutoff-straddling secret. */
export function boundedRedactedMessage(source: string, maximumBytes = MAX_DIAGNOSTIC_BYTES): string {
  // Keep the default redactor's full per-secret capacity beyond the output cutoff.
  // A UTF-16 code unit occupies at least one UTF-8 byte.
  let end = Math.min(source.length, maximumBytes + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < source.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(source[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(source[end]!)
  ) end -= 1;
  const retained = source.slice(0, end);
  const redacted = defaultSecretRedactor.redact(retained);
  const truncated = retained.length < source.length
    || Buffer.byteLength(redacted, "utf8") > maximumBytes;
  if (!truncated) return redacted;
  return `${utf8Prefix(redacted, maximumBytes - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
