/**
 * Provider APIs commonly reject lone UTF-16 surrogate code units even though
 * JavaScript's JSON encoder can escape them. Preserve valid pairs and remove
 * unpaired code units before an outbound JSON serialization boundary.
 */
export function sanitizeUnicode(value: string): string {
  let output = "";
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(index, index + 2);
        index += 1;
      } else {
        changed = true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      changed = true;
    } else {
      output += value.charAt(index);
    }
  }
  return changed ? output : value;
}

export function stringifyProviderJson<Input>(value: Input): string {
  const sanitized = sanitizeJsonValue(value, new WeakSet<object>());
  const serialized = JSON.stringify(sanitized);
  if (serialized === undefined) throw new TypeError("Provider request body is not JSON serializable");
  return serialized;
}

function sanitizeJsonValue<Input>(value: Input, ancestors: WeakSet<object>): SanitizedProviderValue {
  if (Value.Check(STRING_VALUE, value)) return sanitizeUnicode(value);
  if (value === null) return null;
  if (Value.Check(BOOLEAN_VALUE, value)) return value;
  if (Value.Check(NUMBER_VALUE, value)) return value;
  if (Value.Check(BIGINT_VALUE, value)) return value;
  if (!isObjectValue(value)) return undefined;
  if (ancestors.has(value)) throw new TypeError("Provider request body contains a circular value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry, ancestors));
    const output: { [key: string]: SanitizedProviderValue } = Object.create(null);
    for (const [rawKey, entry] of Object.entries(value)) {
      const key = sanitizeUnicode(rawKey);
      if (Object.hasOwn(output, key)) {
        throw new TypeError("Provider request contains property names that collide after Unicode sanitization");
      }
      output[key] = sanitizeJsonValue(entry, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
import { Value } from "typebox/value";

import {
  BIGINT_VALUE,
  BOOLEAN_VALUE,
  isObjectValue,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";

type SanitizedProviderValue =
  | null
  | string
  | number
  | boolean
  | bigint
  | undefined
  | SanitizedProviderValue[]
  | { [key: string]: SanitizedProviderValue };
