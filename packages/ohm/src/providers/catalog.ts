import { Value } from "typebox/value";

import { NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";

export function catalogId<Input>(value: Input): string | undefined {
  if (!Value.Check(STRING_VALUE, value)) return undefined;
  const id = value.trim();
  return id === "" ? undefined : id;
}

export function catalogLimit<Input>(value: Input): number | undefined {
  return Value.Check(NUMBER_VALUE, value) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
