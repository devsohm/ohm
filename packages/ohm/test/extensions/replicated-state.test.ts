import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLICATED_JSON_STATE_PROTOCOL_VERSION,
  createReplicatedJsonState,
} from "../../src/extensions/replicated-state.js";

test("replicated JSON state applies bounded deltas deterministically across replicas", () => {
  const source = createReplicatedJsonState({ tasks: [{ state: "queued" }], count: 1 });
  const replica = createReplicatedJsonState({ tasks: [{ state: "queued" }], count: 1 });
  const observed: number[] = [];
  source.subscribe((delta) => {
    const changed = delta.operations[0] as unknown as { value: { phase: string } };
    changed.value.phase = "corrupt";
  });
  source.subscribe(() => { throw new Error("observer failed"); });
  source.subscribe((delta) => observed.push(delta.revision));

  const first = source.update([
    { type: "set", path: ["tasks", "0", "state"], value: { phase: "running" } },
    { type: "set", path: ["count"], value: 2 },
  ]);
  const second = source.update([{ type: "delete", path: ["tasks", "0"] }]);
  replica.apply(first);
  replica.apply(second);

  assert.deepEqual(replica.snapshot(), source.snapshot());
  assert.deepEqual(source.deltasSince(0), [first, second]);
  assert.deepEqual(observed, [1, 2]);
  assert.equal(first.protocolVersion, REPLICATED_JSON_STATE_PROTOCOL_VERSION);
  assert.throws(() => {
    (first.operations[0] as { value: unknown }).value = "corrupt";
  }, /read only|Cannot assign/iu);
  assert.deepEqual(source.deltasSince(0), [first, second]);

  const detached = source.snapshot();
  assert.throws(() => {
    (detached.value.tasks as unknown[]).push("local-only");
  }, /read only|not extensible/iu);
  assert.deepEqual(source.snapshot().value.tasks, []);
});

test("replicated JSON state rejects stale revisions, unsafe paths, and evicted history", () => {
  const state = createReplicatedJsonState({ value: 0 }, { maxHistoryEntries: 1 });
  state.update([{ type: "set", path: ["value"], value: 1 }]);
  state.update([{ type: "set", path: ["value"], value: 2 }]);
  assert.throws(() => state.deltasSince(0), /outside retained history/u);
  assert.throws(
    () => state.apply({
      protocolVersion: 1,
      baseRevision: 0,
      revision: 1,
      operations: [{ type: "set", path: ["value"], value: 3 }],
    }),
    /expected revision 2/u,
  );
  assert.throws(
    () => state.update([{ type: "set", path: ["__proto__", "escaped"], value: true }]),
    /path\[0\] is invalid/u,
  );
  assert.deepEqual(state.snapshot().value, { value: 2 });
});

test("replicated JSON state bounds listeners and clears retained state on lifecycle abort", () => {
  const lifecycle = new AbortController();
  const state = createReplicatedJsonState({ ready: false }, {
    signal: lifecycle.signal,
    maxListeners: 1,
  });
  const unsubscribe = state.subscribe(() => undefined);
  assert.throws(() => state.subscribe(() => undefined), /exceeds 1 listeners/u);
  unsubscribe();
  assert.doesNotThrow(() => state.subscribe(() => undefined));
  lifecycle.abort(new Error("facet stopped"));
  assert.equal(state.closed, true);
  assert.throws(() => state.snapshot(), /closed/u);
});
