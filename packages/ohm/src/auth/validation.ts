import { Type } from "typebox";
import { Value } from "typebox/value";

const STRING_VALUE = Type.String();

export function isStringValue<T>(value: T): value is T & string {
  return Value.Check(STRING_VALUE, value);
}

export function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function hasBidiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined &&
      ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069));
  });
}

export function hasWhitespace(value: string): boolean {
  return [...value].some((character) => character.trim() === "");
}

export function hasWhitespaceOrAsciiControl(value: string): boolean {
  return hasWhitespace(value) || hasAsciiControl(value);
}
