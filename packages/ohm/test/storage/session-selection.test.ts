import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../../src/storage/session-manager.js";

function appendMessage(manager: SessionManager, id: string): string {
  return manager.appendMessage({ id, role: "user", createdAt: "2026-09-05T12:00:00.000Z",
    content: [{ type: "text", text: id }] });
}

test("persisted selection preserves active-lineage values and whole-journal thinking defaults", () => {
  const manager = SessionManager.inMemory();
  assert.deepEqual(manager.getPersistedSelection(), { model: null, thinkingLevel: "off", hasPersistedThinking: false });
  const root = appendMessage(manager, "root");
  manager.appendModelChange("first-provider", "first-model");
  assert.deepEqual(manager.getPersistedSelection(), {
    model: { provider: "first-provider", modelId: "first-model" }, thinkingLevel: "off", hasPersistedThinking: false,
  });
  manager.appendThinkingLevelChange("high");
  const selected = appendMessage(manager, "selected");
  manager.appendModelChange("second-provider", "second-model");
  manager.appendThinkingLevelChange("off");
  const other = appendMessage(manager, "other");
  assert.deepEqual(manager.getPersistedSelection(), {
    model: { provider: "second-provider", modelId: "second-model" }, thinkingLevel: "off", hasPersistedThinking: true,
  });
  for (const head of [selected, root, null, other]) {
    if (head === null) manager.resetLeaf();
    else manager.branch(head);
    const context = manager.buildSessionContext();
    assert.deepEqual(manager.getPersistedSelection(), {
      model: context.model, thinkingLevel: context.thinkingLevel, hasPersistedThinking: true,
    });
  }
  const detached = manager.getPersistedSelection();
  assert.ok(detached.model);
  detached.model.modelId = "changed outside";
  assert.equal(manager.getPersistedSelection().model?.modelId, "second-model");
});

test("compaction and instructions do not erase earlier model or thinking selections", () => {
  const manager = SessionManager.inMemory();
  manager.appendModelChange("provider", "model");
  manager.appendThinkingLevelChange("max");
  manager.appendMessage({ id: "instructions", role: "system", purpose: "instructions",
    createdAt: "2026-09-05T12:00:00.000Z", content: [{ type: "text", text: "instructions" }] });
  appendMessage(manager, "old");
  const kept = appendMessage(manager, "kept");
  manager.appendCompaction("summary", kept, 100);
  manager.appendCustomEntry("private", { hidden: "metadata" });
  appendMessage(manager, "tail");
  const context = manager.buildSessionContext();
  assert.deepEqual(manager.getPersistedSelection(), {
    model: context.model, thinkingLevel: context.thinkingLevel, hasPersistedThinking: true,
  });
  assert.deepEqual(context.model, { provider: "provider", modelId: "model" });
  assert.equal(context.thinkingLevel, "max");
});

test("selection reads node metadata without full history projection or cloning", (t) => {
  const manager = SessionManager.inMemory();
  manager.appendModelChange("provider", "model");
  manager.appendThinkingLevelChange("low");
  appendMessage(manager, "tail");
  const expected = { model: { provider: "provider", modelId: "model" }, thinkingLevel: "low", hasPersistedThinking: true };
  t.mock.method(manager, "getBranch", () => assert.fail("selection projected the branch"));
  t.mock.method(manager, "getEntries", () => assert.fail("selection projected all entries"));
  t.mock.method(manager, "buildSessionContext", () => assert.fail("selection projected model context"));
  t.mock.method(globalThis, "structuredClone", () => assert.fail("selection cloned stored values"));
  assert.deepEqual(manager.getPersistedSelection(), expected);
});
