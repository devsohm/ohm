import { Type } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "../core/errors.js";
import { FUNCTION_VALUE, isObjectValue } from "../core/value-schemas.js";
import type { FetchLike } from "./transport.js";

const SDK_SAFE_ERROR_PROTOTYPES = new Set<object>([
  Error.prototype,
  EvalError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  TypeError.prototype,
  URIError.prototype,
]);
const SDK_ERROR_FIELD_VALUE = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.BigInt(),
]);

function safeSdkError<Input>(value: Input, depth = 0): value is Input & Error {
  if (!Error.isError(value) || depth > 8 || !SDK_SAFE_ERROR_PROTOTYPES.has(Object.getPrototypeOf(value))) {
    return false;
  }
  for (const key of ["name", "message", "code", "errno", "syscall", "$metadata", "$retryable"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) return false;
    if (descriptor.value !== null && descriptor.value !== undefined
      && !Value.Check(SDK_ERROR_FIELD_VALUE, descriptor.value)) {
      return false;
    }
  }
  for (const key of ["toString", "valueOf", Symbol.toPrimitive] as const) {
    if (Object.getOwnPropertyDescriptor(value, key) !== undefined) return false;
  }
  const cause = Object.getOwnPropertyDescriptor(value, "cause");
  if (cause === undefined) return true;
  if (!("value" in cause)) return false;
  return cause.value === null || (!isObjectValue(cause.value) && !Value.Check(FUNCTION_VALUE, cause.value))
    || safeSdkError(cause.value, depth + 1);
}

/** @internal Keeps caller-owned fetch failures opaque before third-party SDK handling. */
export async function fetchAtSdkBoundary(
  fetchImplementation: FetchLike,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImplementation(input, init);
  } catch (cause) {
    if (safeSdkError(cause)) throw cause;
    const message = errorMessage(cause);
    throw new TypeError(message, { cause: new Error(message) });
  }
}
