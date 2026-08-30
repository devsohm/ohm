import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core/json.js";
import { STRING_VALUE } from "../../src/core/value-schemas.js";
import { Check } from "typebox/value";

export function parseJsonObject(source: string, label: string): JsonObject {
  const parsed: JsonValue = JSON.parse(source);
  if (!isJsonObject(parsed)) throw new Error(`${label} must contain an object`);
  return parsed;
}

export function parseStringArray(source: string, label: string): string[] {
  const parsed: JsonValue = JSON.parse(source);
  if (!Array.isArray(parsed)) throw new Error(`${label} must contain a string array`);
  const values: string[] = [];
  for (const entry of parsed) {
    if (!Check(STRING_VALUE, entry)) throw new Error(`${label} must contain a string array`);
    values.push(entry);
  }
  return values;
}

export function requiredObjectProperty(object: JsonObject, key: string, label: string): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) throw new Error(`${label}.${key} must be an object`);
  return value;
}
