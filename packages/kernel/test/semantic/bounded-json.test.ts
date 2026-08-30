import assert from "node:assert/strict";
import test from "node:test";

import { boundedJsonSnapshot } from "../../src/runtime/core/bounded-json.js";
import { isJsonObject, type JsonValue } from "../../src/runtime/core/json.js";

const DEFAULT_LIMITS = {
  label: "Provider payload",
  maximumBytes: 1_024,
  maximumValues: 64,
  maximumContainers: 32,
  maximumDepth: 8,
} as const;

test("boundedJsonSnapshot returns detached JSON with exact serialized UTF-8 bytes", () => {
  const source: { 'quote"': string; nested: Array<boolean | number | null> } = Object.assign(Object.create(null), {
    'quote"': "é\n\ud800",
    nested: [true, -0, null],
  });
  const expected = JSON.stringify(source);
  const snapshot = boundedJsonSnapshot(source, {
    ...DEFAULT_LIMITS,
    maximumBytes: Buffer.byteLength(expected, "utf8"),
  });

  assert.equal(snapshot.serialized, expected);
  assert.equal(snapshot.bytes, Buffer.byteLength(expected, "utf8"));
  assert.deepEqual(JSON.parse(snapshot.serialized), JSON.parse(expected));
  assert.equal(Object.getPrototypeOf(snapshot.value), null);
  assert.notEqual(snapshot.value, source);
  assert.ok(isJsonObject(snapshot.value));
  const nested = snapshot.value.nested;
  assert.ok(Array.isArray(nested));
  assert.equal(Object.is(nested[1], -0), false);

  source.nested[0] = false;
  assert.equal(JSON.parse(snapshot.serialized).nested[0], true);
});

test("boundedJsonSnapshot accepts exact inclusive byte, value, container, and depth limits", () => {
  const value = { outer: [{ ok: true }] };
  const serialized = JSON.stringify(value);
  const snapshot = boundedJsonSnapshot(value, {
    label: "Exact payload",
    maximumBytes: Buffer.byteLength(serialized),
    maximumValues: 4,
    maximumContainers: 3,
    maximumDepth: 3,
  });

  assert.equal(snapshot.serialized, serialized);
  assert.equal(snapshot.bytes, Buffer.byteLength(serialized));
});

test("boundedJsonSnapshot rejects every exceeded limit before returning a snapshot", () => {
  const value = { outer: [{ ok: true }] };
  const serializedBytes = Buffer.byteLength(JSON.stringify(value));

  assert.throws(() => boundedJsonSnapshot(value, {
    ...DEFAULT_LIMITS,
    maximumBytes: serializedBytes - 1,
  }), { name: "TypeError", message: /Provider payload exceeds .* UTF-8 bytes/u });
  assert.throws(() => boundedJsonSnapshot(value, {
    ...DEFAULT_LIMITS,
    maximumValues: 3,
  }), { name: "TypeError", message: /Provider payload exceeds 3 JSON values/u });
  assert.throws(() => boundedJsonSnapshot(value, {
    ...DEFAULT_LIMITS,
    maximumContainers: 2,
  }), { name: "TypeError", message: /Provider payload exceeds 2 JSON containers/u });
  assert.throws(() => boundedJsonSnapshot(value, {
    ...DEFAULT_LIMITS,
    maximumDepth: 2,
  }), { name: "TypeError", message: /Provider payload exceeds 2 levels/u });
});

test("boundedJsonSnapshot rejects cycles but duplicates repeated acyclic values", () => {
  interface CyclicValue { self?: CyclicValue }
  const cyclic: CyclicValue = {};
  cyclic.self = cyclic;
  assert.throws(() => boundedJsonSnapshot(cyclic, DEFAULT_LIMITS), {
    name: "TypeError",
    message: /Provider payload must not contain cycles/u,
  });

  const shared = { value: true };
  const snapshot = boundedJsonSnapshot({ left: shared, right: shared }, DEFAULT_LIMITS);
  assert.ok(isJsonObject(snapshot.value));
  const selected = snapshot.value;
  assert.deepEqual(JSON.parse(snapshot.serialized), { left: { value: true }, right: { value: true } });
  assert.notEqual(selected.left, selected.right);
});

test("boundedJsonSnapshot traverses deeply nested bounded input without recursion", () => {
  let source: JsonValue = null;
  for (let depth = 0; depth < 5_000; depth += 1) source = [source];

  const snapshot = boundedJsonSnapshot(source, {
    label: "Deep payload",
    maximumBytes: 10_004,
    maximumValues: 5_001,
    maximumContainers: 5_000,
    maximumDepth: 5_000,
  });
  assert.equal(snapshot.bytes, 10_004);
  assert.equal(snapshot.serialized.length, 10_004);
});

test("boundedJsonSnapshot never invokes accessors, toJSON methods, or proxy traps", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  assert.throws(() => boundedJsonSnapshot(accessor, DEFAULT_LIMITS), TypeError);
  assert.equal(getterCalls, 0);

  const accessorArray = [true];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  assert.throws(() => boundedJsonSnapshot(accessorArray, DEFAULT_LIMITS), TypeError);
  assert.equal(getterCalls, 0);

  let toJsonCalls = 0;
  const withToJson = {
    value: true,
    toJSON() {
      toJsonCalls += 1;
      return { leaked: true };
    },
  };
  assert.throws(() => boundedJsonSnapshot(withToJson, DEFAULT_LIMITS), TypeError);
  assert.equal(toJsonCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTrapCalls += 1;
      return [];
    },
  });
  assert.throws(() => boundedJsonSnapshot(proxy, DEFAULT_LIMITS), TypeError);
  assert.equal(proxyTrapCalls, 0);
});

test("boundedJsonSnapshot permits only plain records and dense vanilla arrays", () => {
  const customPrototype: { value?: boolean } = Object.create({ inherited: true });
  customPrototype.value = true;
  assert.throws(() => boundedJsonSnapshot(customPrototype, DEFAULT_LIMITS), TypeError);

  const subclass = new class extends Array<JsonValue> {}();
  assert.throws(() => boundedJsonSnapshot(subclass, DEFAULT_LIMITS), TypeError);

	const sparse: JsonValue[] = [];
	sparse.length = 1;
  assert.throws(() => boundedJsonSnapshot(sparse, DEFAULT_LIMITS), TypeError);

  const arrayWithExtra = Object.assign([true], { extra: true });
  assert.throws(() => boundedJsonSnapshot(arrayWithExtra, DEFAULT_LIMITS), TypeError);

  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
  assert.throws(() => boundedJsonSnapshot(hidden, DEFAULT_LIMITS), TypeError);

  const symbolic = { visible: true };
  Object.defineProperty(symbolic, Symbol("hidden"), { enumerable: true, value: true });
  assert.throws(() => boundedJsonSnapshot(symbolic, DEFAULT_LIMITS), TypeError);
});

test("boundedJsonSnapshot can ignore an exact bounded list of hidden data metadata keys", () => {
  const nested = { type: "string" };
  Object.defineProperty(nested, "~kind", { enumerable: false, value: "String" });
  const source = { type: "object", properties: { value: nested } };
  Object.defineProperty(source, "~kind", { enumerable: false, value: "Object" });

  const snapshot = boundedJsonSnapshot(source, {
    ...DEFAULT_LIMITS,
    ignoredNonEnumerableDataKeys: ["~kind"],
  });
  assert.deepEqual(JSON.parse(snapshot.serialized), {
    type: "object",
    properties: { value: { type: "string" } },
  });

  let getterCalls = 0;
  const hiddenAccessor = { type: "string" };
  Object.defineProperty(hiddenAccessor, "~kind", {
    enumerable: false,
    get() {
      getterCalls += 1;
      return "String";
    },
  });
  assert.throws(() => boundedJsonSnapshot(hiddenAccessor, {
    ...DEFAULT_LIMITS,
    ignoredNonEnumerableDataKeys: ["~kind"],
  }), TypeError);
  assert.equal(getterCalls, 0);

  const unlisted = { type: "string" };
  Object.defineProperty(unlisted, "hidden", { enumerable: false, value: "metadata" });
  assert.throws(() => boundedJsonSnapshot(unlisted, {
    ...DEFAULT_LIMITS,
    ignoredNonEnumerableDataKeys: ["~kind"],
  }), TypeError);

  const enumerable = { type: "string", "~kind": "visible" };
  const enumerableSnapshot = boundedJsonSnapshot(enumerable, {
    ...DEFAULT_LIMITS,
    ignoredNonEnumerableDataKeys: ["~kind"],
  });
  assert.deepEqual(JSON.parse(enumerableSnapshot.serialized), enumerable);
});

test("boundedJsonSnapshot rejects unsupported primitives and non-finite numbers", () => {
  for (const value of [undefined, 1n, Symbol("value"), () => true, Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => boundedJsonSnapshot(value, DEFAULT_LIMITS), TypeError);
  }
});

test("boundedJsonSnapshot validates its caller-supplied limits", () => {
  assert.throws(() => boundedJsonSnapshot(null, { ...DEFAULT_LIMITS, label: "" }), TypeError);
  assert.throws(() => boundedJsonSnapshot(null, { ...DEFAULT_LIMITS, label: "x".repeat(257) }), TypeError);
  assert.throws(() => boundedJsonSnapshot(null, { ...DEFAULT_LIMITS, label: "unsafe\nlabel" }), TypeError);
  for (const field of ["maximumBytes", "maximumValues", "maximumContainers", "maximumDepth"] as const) {
    assert.throws(() => boundedJsonSnapshot(null, { ...DEFAULT_LIMITS, [field]: -1 }), TypeError);
    assert.throws(() => boundedJsonSnapshot(null, { ...DEFAULT_LIMITS, [field]: 1.5 }), TypeError);
  }
	const sparseIgnoredKeys: string[] = [];
	sparseIgnoredKeys.length = 1;
	for (const ignoredNonEnumerableDataKeys of [
    ["duplicate", "duplicate"],
    [""],
    ["x".repeat(257)],
    Array.from({ length: 17 }, (_, index) => `key-${index}`),
		sparseIgnoredKeys,
  ]) {
    assert.throws(() => boundedJsonSnapshot(null, {
      ...DEFAULT_LIMITS,
      ignoredNonEnumerableDataKeys,
    }), TypeError);
  }
});
