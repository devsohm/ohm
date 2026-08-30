import { defaultSecretRedactor } from "../auth/redaction.js";
import type { ExtensionError } from "../extensions/direct.js";
import { escapeTerminal } from "../tools/output.js";
import { byteTruncate, sanitizeTerminalText } from "../tui/unicode.js";

export interface ProjectedExtensionError {
  readonly type: "extension_error";
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly event: string;
  readonly error: string;
}

function redactedField(value: string, maximumBytes: number): string {
  return byteTruncate(defaultSecretRedactor.redact(value.replaceAll("\0", "")), maximumBytes);
}

function field(value: string, maximumBytes: number): string {
  return byteTruncate(sanitizeTerminalText(redactedField(value, maximumBytes)), maximumBytes);
}

/** Project one bounded, redacted extension failure for host presentation. */
export function projectExtensionError(failure: ExtensionError): ProjectedExtensionError {
  return {
    type: "extension_error",
    extensionId: field(failure.extensionId ?? "runtime", 1_024) || "runtime",
    extensionPath: field(failure.extensionPath, 4_096),
    event: field(failure.event, 1_024),
    error: field(failure.error, 4_096),
  };
}

/** Format one terminal-safe extension failure without exposing registered secrets. */
export function formatExtensionError(failure: ExtensionError): string {
  const extensionId = redactedField(failure.extensionId ?? "runtime", 1_024) || "runtime";
  const extensionPath = redactedField(failure.extensionPath, 4_096);
  const event = redactedField(failure.event, 1_024);
  const error = redactedField(failure.error, 4_096);
  return byteTruncate(escapeTerminal(
    `Extension error (${extensionId}, ${extensionPath}, ${event}): ${error}`,
  ), 8 * 1_024);
}
