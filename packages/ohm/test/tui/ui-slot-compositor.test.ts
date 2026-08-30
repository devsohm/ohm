import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionUISlotCompositor,
  MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS_PER_PATH,
  MAX_EXTENSION_UI_SLOT_CONTRIBUTION_BYTES,
} from "../../src/tui/ui-slot-compositor.js";

test("UI slots compose by placement, order, owner load, and registration order", () => {
  const slots = new ExtensionUISlotCompositor();
  const a1 = {};
  const a2 = {};
  const b1 = {};
  const b2 = {};

  slots.set("owner-a", "session.beforeEditor", "first", { lines: ["A0"] }, a1);
  slots.set("owner-b", "session.beforeEditor", "first", { lines: ["B0"] }, b1);
  slots.set("owner-a", "session.beforeEditor", "early", { lines: ["A-1"], order: -1 }, a2);
  slots.set("owner-b", "session.beforeEditor", "prepended", { lines: ["B-pre"], placement: "prepend" }, b2);

  assert.deepEqual(slots.project("session.beforeEditor"), {
    path: "session.beforeEditor",
    lines: ["B-pre", "A-1", "A0", "B0"],
    replacement: false,
  });

  slots.set("owner-b", "session.beforeEditor", "first", { lines: ["B-updated"] }, b1);
  assert.deepEqual(slots.project("session.beforeEditor").lines, ["B-pre", "A-1", "A0", "B-updated"]);
});

test("UI slot replacement falls back deterministically and rejected updates retain the winner", () => {
  const slots = new ExtensionUISlotCompositor();
  const lower = {};
  const winner = {};
  slots.set("owner-a", "session.footer", "lower", {
    lines: ["lower"],
    placement: "replace",
    order: 1,
  }, lower);
  slots.set("owner-b", "session.footer", "winner", {
    lines: ["winner"],
    placement: "replace",
    order: 2,
  }, winner);

  assert.deepEqual(slots.project("session.footer"), {
    path: "session.footer",
    lines: ["winner"],
    replacement: true,
  });
  assert.throws(() => slots.set("owner-b", "session.footer", "winner", {
    lines: ["\u001b[31mbroken"],
    placement: "replace",
    order: 3,
  }, winner), /terminal-safe/u);
  assert.deepEqual(slots.project("session.footer").lines, ["winner"]);
  assert.equal(slots.remove("owner-b", "session.footer", "winner", winner), true);
  assert.deepEqual(slots.project("session.footer").lines, ["lower"]);
  assert.equal(slots.remove("owner-a", "session.footer", "lower", {}), false);
  assert.deepEqual(slots.project("session.footer").lines, ["lower"]);
});

test("UI slots reject replacement at editor boundaries and enforce explicit bounds", () => {
  const slots = new ExtensionUISlotCompositor();
  assert.throws(() => slots.set("owner", "session.afterEditor", "bad", {
    lines: ["bad"],
    placement: "replace",
  }, {}), /Only session\.header and session\.footer/u);
  assert.throws(() => slots.set("owner", "session.header", "bad", {
    lines: ["bad"],
    order: 1.5,
  }, {}), /must be an integer/u);
  assert.throws(() => slots.set("owner", "session.header", "bad", {
    lines: ["x".repeat(MAX_EXTENSION_UI_SLOT_CONTRIBUTION_BYTES + 1)],
  }, {}), /limited to 16384 bytes/u);

  for (let index = 0; index < MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS_PER_PATH; index += 1) {
    slots.set("owner", "session.header", `item-${index}`, { lines: [`item ${index}`] }, {});
  }
  assert.throws(() => slots.set("owner", "session.header", "overflow", { lines: ["overflow"] }, {}), /limited to 16 contributions/u);
});

test("a failed downstream publication can roll back one compositor mutation", () => {
  const slots = new ExtensionUISlotCompositor();
  const first = {};
  slots.set("owner", "session.header", "header", { lines: ["first"] }, first);
  const rollback = slots.set("owner", "session.header", "header", { lines: ["candidate"] }, {});
  rollback();
  assert.deepEqual(slots.project("session.header").lines, ["first"]);

  const staleRollback = slots.set("owner", "session.header", "header", { lines: ["second"] }, {});
  slots.set("owner", "session.footer", "footer", { lines: ["later"] }, {});
  staleRollback();
  assert.deepEqual(slots.project("session.header").lines, ["second"]);
});
