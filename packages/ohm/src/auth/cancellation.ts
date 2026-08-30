import { isNativeError } from "node:util/types";

function brandedError<T>(value: T): Error | undefined {
  return isNativeError(value) ? value : undefined;
}

export function authAbortError(signal: AbortSignal, fallback: string): Error {
  return brandedError(signal.reason) ?? new DOMException(fallback, "AbortError");
}

export function authFailureError<T>(value: T, fallback: string): Error {
  return brandedError(value) ?? new Error(fallback);
}
