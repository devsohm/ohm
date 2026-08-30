import { Type } from "typebox";
import { Check } from "typebox/value";

export const BOOLEAN_VALUE = Type.Boolean();
export const BIGINT_VALUE = Type.BigInt();
export const FUNCTION_VALUE = Type.Function([], Type.Unknown());
export const JSON_CONTAINER_VALUE = Type.Union([
  Type.Array(Type.Unknown()),
  Type.Object({}, { additionalProperties: true }),
]);
export const NUMBER_VALUE = Type.Number();
export const OBJECT_VALUE = Type.Object({}, { additionalProperties: true });
export const STRING_VALUE = Type.String();
export const STRING_RECORD_VALUE = Type.Record(Type.String(), Type.String());
export const SYMBOL_VALUE = Type.Symbol();

export function isObjectValue<Value>(value: Value): value is Value & object {
  return value !== null && Object(value) === value && !Check(FUNCTION_VALUE, value);
}

function isControlCodePoint(code: number, includeC1: boolean): boolean {
  return code <= 0x1f || code === 0x7f || (includeC1 && code >= 0x80 && code <= 0x9f);
}

export function hasControlCharacters(value: string, includeC1 = true): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && isControlCodePoint(code, includeC1)) return true;
  }
  return false;
}
