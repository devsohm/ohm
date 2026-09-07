import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SessionV4Changes } from "@ohm/kernel/session-v4";
import { SessionManager, type SessionHistoryPageOptions } from "../../src/storage/session-manager.js";
import { SqliteSessionHistoryIndex, type SessionHistoryIndexCommit } from "../../src/storage/session-history-index.js";

const TIME = "2026-09-05T12:00:00.000Z";

function message(id: string, parentId: string | null) {
  return { type: "conversation_node" as const, node: {
    id, parentId, createdAt: TIME, nodeType: "message" as const, role: "assistant" as const,
    content: { id, role: "assistant", createdAt: TIME, content: [
      { type: "text", text: `visible ${id} 🙂` },
      { type: "provider_opaque", provider: "fixture", mediaType: "application/json",
        value: { nested: [id, { preserved: true }] }, serialized: '{ "spacing": true }' },
    ] },
  } };
}

function head(nodeId: string | null) {
  return { type: "head" as const, branchId: "main" as const, nodeId };
}

test("owned SQL history and tree queries preserve native page, branch, label and selection contracts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-contract-"));
  const saved = SessionManager.create(directory, directory);
  const memory = SessionManager.inMemory(directory);
  t.after(() => { saved.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const apply = (changes: SessionV4Changes, timestamp = TIME): void => {
    sequence += 1;
    for (const manager of [saved, memory]) manager.commitChanges(changes, `commit-${sequence}`, timestamp);
  };
  const compare = (): void => {
    assert.deepEqual(saved.getPersistedSelection(), memory.getPersistedSelection());
    assert.equal(saved.getTreeRevision(), memory.getTreeRevision());
    const entries = memory.getEntries();
    const tips = [undefined, ...entries.map((entry) => entry.id)];
    for (const from of tips) {
      const options = from === undefined ? {} : { from };
      const lineage = memory.getHistoryPage({ ...options, limit: 500 }).entries;
      const cases: SessionHistoryPageOptions[] = [options, { ...options, edge: "oldest" }];
      for (const cursor of lineage) cases.push({ ...options, before: cursor.id }, { ...options, after: cursor.id });
      for (const query of cases) for (const limit of [1, 3]) for (const maxBytes of [1, 2 * 1024 * 1024]) {
        const bounded = { ...query, limit, maxBytes };
        assert.deepEqual(saved.getHistoryPage(bounded), memory.getHistoryPage(bounded), JSON.stringify(bounded));
      }
    }
    for (const [offset, limit] of [[0, 3], [2, 2], [99, 4], [1.5, 1.5], [NaN, 3], [1, NaN], [Infinity, 2], [0, Infinity]]) {
      assert.deepEqual(saved.getEntriesPage(offset!, limit!), memory.getEntriesPage(offset!, limit!));
      assert.deepEqual(saved.getEntryProjectionMetadataPage(offset!, limit!), memory.getEntryProjectionMetadataPage(offset!, limit!));
      assert.deepEqual(saved.getTreeEntryPage(offset!, limit!), memory.getTreeEntryPage(offset!, limit!));
      assert.deepEqual(saved.getTreePage(offset!, limit!), memory.getTreePage(offset!, limit!));
      assert.deepEqual(saved.getActiveBranchEntryIdsInPage(offset!, limit!), memory.getActiveBranchEntryIdsInPage(offset!, limit!));
    }
    for (const entry of entries) assert.equal(saved.getEntrySequence(entry.id), memory.getEntrySequence(entry.id));
    assert.equal(saved.getEntrySequence("missing"), undefined);
  };
  compare();
  apply([message("root", null), message("left", "root"), message("left-tail", "left"), head("left-tail")]);
  compare();
  apply([
    { type: "conversation_node", node: { id: "model", parentId: "root", createdAt: TIME,
      nodeType: "model_change", provider: "fixture", model: "model-a" } },
    { type: "conversation_node", node: { id: "thinking", parentId: "model", createdAt: TIME,
      nodeType: "thinking_change", level: "off" } },
    message("right", "thinking"), head("right"),
    { type: "node_label", nodeId: "root", label: "first" },
    { type: "node_label", nodeId: "root", label: "renamed" },
  ]);
  compare();
  assert.throws(() => saved.getHistoryPage({ from: "left-tail", before: "right" }), /not on the selected lineage/u);
  assert.throws(() => saved.getHistoryPage({ from: "absent" }), /not found/u);
  assert.throws(() => saved.getHistoryPage({ before: "absent" }), /not on the selected lineage/u);
  assert.deepEqual(saved.getHistoryPage({ from: "left-tail", limit: 3 }).entries.map((entry) => entry.id), ["root", "left", "left-tail"]);
  apply([{ type: "node_label", nodeId: "root", label: null }, head("left-tail")]);
  compare();
  apply([{ type: "node_label", nodeId: "root", label: "earlier timestamp" }], "2026-09-04T12:00:00.000Z");
  assert.equal(saved.getTreeEntryPage(0, 1)[0]?.labelTimestamp, "2026-09-04T12:00:00.000Z");
  apply([head(null)]);
  compare();
  assert.deepEqual(saved.getPersistedSelection(), { model: null, thinkingLevel: "off", hasPersistedThinking: true });
  apply([
    message("odd\ud800", "right"), message("odd\ud801", "odd\ud800"), head("odd\ud801"),
    { type: "node_label", nodeId: "odd\ud800", label: "label\udc00" },
  ]);
  compare();
  const page = saved.getHistoryPage({ from: "right", limit: 1 });
  const original = saved.getEntry("right");
  page.entries[0]!.parentId = "mutated";
  const entry = page.entries[0];
  if (entry?.type === "message" && entry.message.role === "assistant") entry.message.content = [];
  assert.deepEqual(saved.getEntry("right"), original);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "entryOrderCache")?.value, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "historyOrderCache")?.value, undefined);
});

test("indexed history reads use validated payloads and never trust or persist a journal cache", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-trust-"));
  const manager = SessionManager.create(directory, directory);
  t.after(() => { manager.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  manager.commitChanges([message("root", null), head("root")], "first", TIME);
  const path = manager.getSessionFile()!;
  const expected = manager.getHistoryPage();
  const snapshot = SessionManager.openSnapshot(path);
  const db = new DatabaseSync(path);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
      ["session_commits", "session_header"]);
    const original = db.prepare("SELECT record FROM session_commits WHERE sequence = 1").get()!.record;
    db.prepare("UPDATE session_commits SET record = 'null' WHERE sequence = 1").run();
    assert.deepEqual(manager.getHistoryPage(), expected);
    assert.deepEqual(manager.getTreeEntryPage(0, 1)[0]?.entry, expected.entries[0]);
    assert.deepEqual(snapshot.getHistoryPage(), expected);
    assert.throws(() => SessionManager.openSnapshot(path), /must be an object/u);
    db.prepare("UPDATE session_commits SET record = ? WHERE sequence = 1").run(original!);
  } finally { db.close(); }
  manager.commitChanges([message("later", "root"), head("later")], "second", TIME);
  assert.deepEqual(snapshot.getHistoryPage(), expected);
  assert.deepEqual(manager.getHistoryPage().entries.map((entry) => entry.id), ["root", "later"]);
});

test("query metadata follows accepted appends, idempotency and replacement ownership", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-lifecycle-"));
  const manager = SessionManager.create(directory, directory);
  t.after(() => { manager.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  const firstFile = manager.getSessionFile()!;
  manager.getTreeEntryPage(0, 1);
  const changes = [message("root", null), head("root")] satisfies SessionV4Changes;
  const observed: string[][] = [];
  const remove = manager.onAppend(() => { observed.push(manager.getHistoryPage().entries.map((entry) => entry.id)); });
  manager.commitChanges(changes, "first", TIME);
  assert.deepEqual(observed, [["root"]]);
  const revision = manager.getTreeRevision();
  manager.commitChanges(changes, "first", TIME);
  assert.equal(manager.getTreeRevision(), revision);
  assert.deepEqual(manager.getHistoryPage().entries.map((entry) => entry.id), ["root"]);
  assert.throws(() => manager.commitChanges([head(null)], "first", TIME), /already used/u);
  assert.throws(() => manager.commitChanges([head("absent")], "invalid", TIME), /unknown|not exist/u);
  assert.equal(manager.getTreeRevision(), revision);
  remove();
  manager.newSession();
  assert.deepEqual(manager.getHistoryPage(), { entries: [], hasMoreBefore: false, hasMoreAfter: false });
  manager.commitChanges([message("other", null), head("other")], "other-commit", TIME);
  manager.setSessionFile(firstFile);
  assert.deepEqual(manager.getHistoryPage().entries.map((entry) => entry.id), ["root"]);
  assert.deepEqual(manager.getTreeEntryPage(0, 1).map((node) => node.depth), [0]);
  manager.closeV4Store();
  manager.closeV4Store();
  assert.throws(() => manager.getHistoryPage(), /not initialized/u);
});

test("cold selection and newest pages defer index construction until deeper navigation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-lazy-"));
  const manager = SessionManager.create(directory, directory);
  t.after(() => { manager.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  manager.commitChanges([message("root", null), head("root")], "root-commit", TIME);
  const update = SqliteSessionHistoryIndex.prototype.update;
  const feed = t.mock.method(SqliteSessionHistoryIndex.prototype, "update", function (
    this: SqliteSessionHistoryIndex, commits: Iterable<SessionHistoryIndexCommit>,
  ) { return update.call(this, commits); });
  const selected = manager.getPersistedSelection();
  const newest = manager.getHistoryPage({ maxBytes: 1 });
  manager.commitChanges([message("branch", "root"), head("branch")], "branch-commit", TIME);
  assert.deepEqual(manager.getHistoryPage({ from: "root", maxBytes: 1 }), newest);
  assert.equal(feed.mock.callCount(), 0);
  manager.getTreeEntryPage(0, 1);
  assert.equal(feed.mock.callCount(), 1);
  assert.deepEqual(manager.getPersistedSelection(), selected);
  assert.deepEqual(manager.getHistoryPage({ from: "root", maxBytes: 1 }), newest);
  manager.commitChanges([head(null)], "reset", TIME);
  assert.deepEqual(manager.getHistoryPage(), { entries: [], hasMoreBefore: false, hasMoreAfter: false });
  assert.equal(feed.mock.callCount(), 2);
});

test("query-backed search keeps bounded metadata batches and fixed ownership during yields", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-search-"));
  const saved = SessionManager.create(directory, directory);
  const memory = SessionManager.inMemory(directory);
  t.after(() => { saved.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  const nodes = Array.from({ length: 300 }, (_, index) => message(`n${index}`, index === 0 ? null : `n${index - 1}`));
  for (const manager of [saved, memory]) {
    manager.commitChanges([nodes[0]!, ...nodes.slice(1), message("branch", "n10"), head("branch")], "tree", TIME);
    manager.appendCustomEntry("private", { secret: "hidden needle" });
    manager.appendCustomMessageEntry("private", "hidden needle", false);
  }
  for (const from of [undefined, "n299", "branch"]) {
    const selected = from === undefined ? {} : { from };
    for (const cursor of [undefined, "n0", "n10", from]) {
      const cases = cursor === undefined ? [selected] : [{ ...selected, before: cursor }, { ...selected, after: cursor }];
      for (const options of cases) for (const query of ["visible", "n2", "hidden needle", "no match"]) {
        assert.deepEqual(await saved.searchHistory(query, { ...options, limit: 3 }),
          await memory.searchHistory(query, { ...options, limit: 3 }));
      }
    }
  }
  await assert.rejects(saved.searchHistory("visible", { from: "branch", before: "n299" }), /not in the selected history/u);
  await assert.rejects(saved.searchHistory("visible", { from: "branch", before: "n11" }), /not in the selected history/u);
  const interleaved = saved.searchHistory("n299", { from: "n299", after: "n0" });
  saved.getHistoryPage({ from: "branch", edge: "oldest", limit: 1 });
  assert.deepEqual((await interleaved).matches.map((match) => match.id), ["n299"]);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "entryOrderCache")?.value, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "historyOrderCache")?.value, undefined);

  const controller = new AbortController();
  const cancelled = saved.searchHistory("no match", { signal: controller.signal });
  controller.abort(new Error("stop scan"));
  await assert.rejects(cancelled, /stop scan/u);

  const fixed = saved.searchHistory("not yet present");
  saved.commitChanges([message("not yet present", "branch"), head("not yet present")], "later", TIME);
  assert.deepEqual((await fixed).matches, []);
  assert.equal((await saved.searchHistory("not yet present")).matches.length, 1);

  const switched = saved.searchHistory("no match");
  const path = saved.getSessionFile()!;
  saved.closeV4Store();
  saved.setSessionFile(path);
  await assert.rejects(switched, /Session changed while searching history/u);
});
