import { isNativeError } from "node:util/types";

import type { FileError } from "./filesystem.js";
import type { ExecutionError } from "./process.js";
import { errorMessage } from "../runtime/core/errors.js";

export type Result<T, E = FileError | ExecutionError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function toError(cause: unknown): Error {
  return isNativeError(cause) ? cause : new Error(errorMessage(cause));
}

export function getOrThrow<T, E extends Error>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}
