import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionUISlotContribution, ExtensionUISlotPath } from "../../src/extensions/capabilities/ui-slots.js";
import {
  RuntimeUISlotRegistrations,
  type RuntimeUISlotOperationSink,
} from "../../src/extensions/runtime-internal/ui-slot-registrations.js";

test("UI slot handles update and dispose only their exact registration", () => {
  const operations: string[] = [];
  const live = new Map<string, object>();
  const sink: RuntimeUISlotOperationSink = {
    set(path, key, contribution, token) {
      live.set(`${path}:${key}`, token);
      operations.push(`set:${path}:${key}:${contribution.lines.join("|")}`);
    },
    remove(path, key, token) {
      if (live.get(`${path}:${key}`) !== token) return;
      live.delete(`${path}:${key}`);
      operations.push(`remove:${path}:${key}`);
    },
  };
  const generation = new AbortController();
  const registrations = new RuntimeUISlotRegistrations(generation.signal, sink);
  const slots = registrations.service(true);
  const first = slots.set("session.header", "summary", { lines: ["first"] });
  const second = slots.set("session.header", "summary", { lines: ["second"] });

  assert.equal(first.disposed, true);
  first.dispose();
  assert.equal(live.size, 1);
  second.update({ lines: ["updated"], order: 1 });
  second.dispose();
  assert.equal(second.disposed, true);
  assert.equal(live.size, 0);
  assert.deepEqual(operations, [
    "set:session.header:summary:first",
    "set:session.header:summary:second",
    "set:session.header:summary:updated",
    "remove:session.header:summary",
  ]);
});

test("UI slot updates validate before changing the active contribution", () => {
  let selected: { path: ExtensionUISlotPath; value: ExtensionUISlotContribution; token: object } | undefined;
  const generation = new AbortController();
  const registrations = new RuntimeUISlotRegistrations(generation.signal, {
    set(path, _key, value, token) { selected = { path, value, token }; },
    remove() { selected = undefined; },
  });
  const handle = registrations.service(true).set("session.footer", "status", {
    lines: ["safe"],
    placement: "replace",
  });

  assert.throws(() => handle.update({ lines: ["\u001b[31munsafe"] }), /terminal-safe/u);
  assert.deepEqual(selected?.value.lines, ["safe"]);
  assert.equal(handle.disposed, false);
});

test("unavailable and stale UI slot services fail closed", () => {
  const generation = new AbortController();
  const registrations = new RuntimeUISlotRegistrations(generation.signal, {
    set() { throw new Error("unexpected set"); },
    remove() { throw new Error("unexpected remove"); },
  });
  assert.throws(() => registrations.service(false).set("session.header", "x", { lines: ["x"] }), /full rich TUI/u);
  generation.abort(new Error("refresh"));
  assert.throws(() => registrations.service(true).set("session.header", "x", { lines: ["x"] }), /refresh/u);
});
