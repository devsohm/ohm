export class HarnessError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, options?: { cause?: unknown; exitCode?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.code = code;
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function errorMessage(cause: unknown): string {
  if (isNativeError(cause)) {
    const message = Object.getOwnPropertyDescriptor(cause, "message");
    return message !== undefined && "value" in message && Check(STRING_VALUE, message.value)
      ? message.value
      : "[Thrown Error]";
  }
  if (Check(STRING_VALUE, cause)) return cause;
  if (cause === null) return "null";
  if (Check(FUNCTION_VALUE, cause)) return "[Thrown function]";
  if (Object(cause) === cause) return "[Thrown object]";
  return String(cause);
}
import { isNativeError } from "node:util/types";
import { Check } from "typebox/value";

import { FUNCTION_VALUE, STRING_VALUE } from "../../internal/value-schemas.js";
