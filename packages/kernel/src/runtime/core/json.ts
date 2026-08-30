import { isProxy } from "node:util/types";
import { Check } from "typebox/value";

import {
	BOOLEAN_VALUE,
	isObjectValue,
	NUMBER_VALUE,
  STRING_VALUE,
} from "../../internal/value-schemas.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

type JsonValidationFrame =
  | { kind: "value"; value: unknown }
  | { kind: "exit"; value: object };

function arrayIndex(key: string, length: number): number | undefined {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key
    ? index
    : undefined;
}

export function isJsonValue<T>(value: T): value is T & JsonValue {
  const active = new WeakSet<object>();
  const pending: JsonValidationFrame[] = [{ kind: "value", value }];
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined) break;
      if (frame.kind === "exit") {
        active.delete(frame.value);
        continue;
      }
      const current = frame.value;
      if (current === null || Check(STRING_VALUE, current) || Check(BOOLEAN_VALUE, current)) continue;
      if (Check(NUMBER_VALUE, current)) {
        if (!Number.isFinite(current)) return false;
        continue;
      }
			if (isProxy(current)) return false;
			if (!isObjectValue(current) || active.has(current)) return false;
      const array = Array.isArray(current);
      const prototype: object | null = Object.getPrototypeOf(current);
      if ((array && prototype !== Array.prototype)
        || (!array && prototype !== Object.prototype && prototype !== null)) return false;
      active.add(current);
      pending.push({ kind: "exit", value: current });

      const keys = Reflect.ownKeys(current);
      if (array) {
        const lengthDescriptor = Reflect.getOwnPropertyDescriptor(current, "length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return false;
        const length = lengthDescriptor.value;
        if (!Check(NUMBER_VALUE, length)) return false;
        let elements = 0;
        for (const key of keys) {
          if (key === "length") continue;
          if (!Check(STRING_VALUE, key) || arrayIndex(key, length) === undefined) return false;
          const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
          if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
          elements += 1;
          pending.push({ kind: "value", value: descriptor.value });
        }
        if (elements !== length || keys.length !== length + 1) return false;
        continue;
      }

      for (const key of keys) {
        if (!Check(STRING_VALUE, key)) return false;
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
        pending.push({ kind: "value", value: descriptor.value });
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return isJsonValue(value) && isObjectValue(value) && !Array.isArray(value);
}

export function toJsonValue<T>(value: T): JsonValue {
  if (!isJsonValue(value)) throw new TypeError("Value is not JSON-serializable");
  return value;
}
