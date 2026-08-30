import { Value } from "typebox/value";

import { STRING_VALUE } from "../core/value-schemas.js";

function isNativeError<Input>(value: Input): value is Input & Error {
  return Error.isError(value);
}

type ErrorChainValue = Error | string | undefined;

function ownErrorValue(error: Error, key: string): ErrorChainValue {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  if (isNativeError(descriptor.value) || Value.Check(STRING_VALUE, descriptor.value)) return descriptor.value;
  return undefined;
}

export function safeTransportCode<Input>(value: Input): string | undefined {
  return Value.Check(STRING_VALUE, value) && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : undefined;
}

/** Returns only a bounded machine code from a native Error cause chain. */
export function transportErrorCode<Input>(error: Input): string | undefined {
  const seen = new Set<Error>();
  let selected: ErrorChainValue = isNativeError(error) ? error : undefined;
  for (let depth = 0; depth < 5 && isNativeError(selected) && !seen.has(selected); depth += 1) {
    seen.add(selected);
    const code = safeTransportCode(ownErrorValue(selected, "code"))
      ?? safeTransportCode(ownErrorValue(selected, "transportCode"));
    if (code !== undefined) return code;
    selected = ownErrorValue(selected, "cause");
  }
  return undefined;
}
