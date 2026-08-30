import { Value } from "typebox/value";

import { OBJECT_VALUE, STRING_VALUE } from "./value-schemas.js";

export * from "@ohm/kernel/runtime/core/errors";

/** Read a string error code without invoking properties on an untrusted thrown value. */
export function errorCode<T>(cause: T): string | undefined {
  if (!Value.Check(OBJECT_VALUE, cause)) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(cause, "code");
  return descriptor !== undefined
    && "value" in descriptor
    && Value.Check(STRING_VALUE, descriptor.value)
    ? descriptor.value
    : undefined;
}
