import {
  isJsonValue,
  type JsonValue,
} from "@ohm/kernel/runtime/core/json";
import { Value } from "typebox/value";

import { OBJECT_VALUE } from "./value-schemas.js";

export * from "@ohm/kernel/runtime/core/json";

export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject<T>(value: T): value is T & JsonObject {
  return isJsonValue(value) && Value.Check(OBJECT_VALUE, value);
}
