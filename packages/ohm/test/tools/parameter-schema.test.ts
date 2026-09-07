import assert from "node:assert/strict";
import test from "node:test";

import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { providerInputSchema } from "../../src/tools/parameter-schema.js";
import { assertSchema } from "../../src/tools/schema.js";

test("parameter snapshots strip TypeBox metadata without changing JSON, coercion, or bounds", () => {
  const parameters = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Optional count." })),
  });
  const schema = providerInputSchema(parameters);
  assert.equal(JSON.stringify(schema), JSON.stringify(parameters));
  assert.deepEqual(boundedJsonSnapshot(schema, {
    label: "Plain parameter schema",
    maximumBytes: 1024,
    maximumValues: 100,
    maximumContainers: 10,
    maximumDepth: 10,
  }).value, schema, "provider schemas are plain bounded JSON without ignored metadata keys");

  assert.deepEqual(assertSchema(schema, {}), {}, "optional fields do not gain defaults");
  assert.deepEqual(assertSchema(schema, { limit: "1001", extra: true }), { limit: 1001, extra: true });
  assert.ok(Check(parameters, assertSchema(schema, { limit: "1001" })));
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(Check(parameters, { limit }), false);
    assert.throws(() => assertSchema(schema, { limit }));
  }
});

test("parameter snapshots retain the existing byte and descriptor safety boundaries", () => {
  assert.throws(() => providerInputSchema(Type.String({ description: "x".repeat(1024 * 1024) })), /byte/iu);
  let getterCalls = 0;
  const parameters = Object.defineProperty({ type: "object" }, "~kind", {
    get() { getterCalls++; return "Object"; },
  });
  assert.throws(() => providerInputSchema(parameters), /only enumerable data properties/u);
  assert.equal(getterCalls, 0);
});
