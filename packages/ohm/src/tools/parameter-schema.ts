import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";

import { isJsonObject, type JsonObject } from "../core/json.js";

export function providerInputSchema<Input>(value: Input): JsonObject {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Tool parameter schema",
    maximumBytes: 1024 * 1024,
    maximumValues: 65_536,
    maximumContainers: 16_384,
    maximumDepth: 64,
    ignoredNonEnumerableDataKeys: [
      "~codec",
      "~immutable",
      "~kind",
      "~optional",
      "~readonly",
      "~refine",
      "~unsafe",
    ],
  }).value;
  if (!isJsonObject(snapshot)) throw new TypeError("Tool parameter schema must be an object");
  return snapshot;
}
