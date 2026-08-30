import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";
import { Type } from "typebox";
import { Check } from "typebox/value";

const STRING_ARRAY_VALUE = Type.Array(STRING_VALUE);

export function inputObject(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) throw new Error("Tool input must be an object");
  return value;
}

export function stringInput(object: JsonObject, key: string, fallback?: string): string {
  const value = object[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Check(STRING_VALUE, value)) throw new Error(`${key} must be a string`);
  return value;
}

export function numberInput(object: JsonObject, key: string, fallback: number): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (!Check(NUMBER_VALUE, value) || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

export function booleanInput(object: JsonObject, key: string, fallback: boolean): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (!Check(BOOLEAN_VALUE, value)) throw new Error(`${key} must be a boolean`);
  return value;
}

export function stringArrayInput(object: JsonObject, key: string): string[] | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Check(STRING_ARRAY_VALUE, value)) throw new Error(`${key} must be an array of strings`);
  return value;
}
