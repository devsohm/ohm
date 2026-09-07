import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../../src/storage/session-manager.js";

function history(count: number) {
  const manager = SessionManager.inMemory();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(manager.appendMessage({ id: `message-${index}`, role: "user", createdAt: new Date().toISOString(), content: [{ type: "text", text: `needle ${index}` }] }));
  }
  return { manager, ids };
}

test("history pages traverse both directions, oldest edge and byte limits without loss", () => {
  const { manager, ids } = history(15);
  const last = manager.getHistoryPage({ limit: 5 });
  assert.deepEqual(last.entries.map((entry) => entry.id), ids.slice(10));
  assert.equal(last.hasMoreBefore, true);
  assert.equal(last.hasMoreAfter, false);
  const middle = manager.getHistoryPage({ before: last.entries[0]!.id, limit: 5 });
  assert.deepEqual(middle.entries.map((entry) => entry.id), ids.slice(5, 10));
  assert.equal(middle.hasMoreBefore, true);
  assert.equal(middle.hasMoreAfter, true);
  const first = manager.getHistoryPage({ edge: "oldest", limit: 5 });
  assert.deepEqual(first.entries.map((entry) => entry.id), ids.slice(0, 5));
  assert.equal(first.hasMoreBefore, false);
  assert.deepEqual(manager.getHistoryPage({ after: first.entries.at(-1)!.id, limit: 5 }).entries, middle.entries);
  assert.equal(manager.getHistoryPage({ maxBytes: 1 }).entries.length, 1);
  assert.throws(() => manager.getHistoryPage({ before: "absent" }));
  assert.throws(() => manager.getHistoryPage({ before: ids[0]!, after: ids[1]! }));
  first.entries[0]!.parentId = "mutated";
  assert.equal(manager.getEntry(ids[0]!)?.parentId, null);
});

test("newest history pages only visit their bounded tail and preserve later full-lineage reads", () => {
  const { manager, ids } = history(512);
  const state = manager.getV4State();
  Object.defineProperty(manager, "memoryState", { configurable: true, value: state, writable: true });
  const get = state.nodes.get.bind(state.nodes);
  let reads = 0;
  state.nodes.get = (id) => { reads += 1; return get(id); };
  for (const from of [undefined, ids[300]]) {
    reads = 0;
    const page = manager.getHistoryPage(from === undefined ? { limit: 32 } : { from, limit: 32 });
    const end = from === undefined ? ids.length : 301;
    assert.deepEqual(page.entries.map((entry) => entry.id), ids.slice(end - 32, end));
    assert.equal(page.hasMoreBefore, true);
    assert.equal(page.hasMoreAfter, false);
    assert.ok(reads <= 65, `a 32-entry page read ${reads} journal nodes`);
  }
  const oldest = manager.getHistoryPage({ edge: "oldest", limit: 32 });
  assert.deepEqual(oldest.entries.map((entry) => entry.id), ids.slice(0, 32));
  assert.equal(oldest.hasMoreBefore, false);
  assert.equal(oldest.hasMoreAfter, true);
  manager.branch(ids[1]!);
  assert.deepEqual(manager.getHistoryPage({ limit: 32 }), {
    entries: ids.slice(0, 2).map((id) => manager.getEntry(id)), hasMoreBefore: false, hasMoreAfter: false,
  });
  manager.resetLeaf();
  assert.deepEqual(manager.getHistoryPage(), { entries: [], hasMoreBefore: false, hasMoreAfter: false });
  assert.throws(() => manager.getHistoryPage({ from: "absent" }), /not found/u);
});

test("history search reaches all branches with stable next/previous cursors", async () => {
  const { manager, ids } = history(10);
  manager.branch(ids[2]!);
  const branch = manager.appendMessage({ id: "branch", role: "user", createdAt: new Date().toISOString(), content: [{ type: "text", text: "branch needle" }] });
  const matches = await manager.searchHistory("needle", { limit: 3 });
  assert.deepEqual(matches.matches.map((match) => match.id), [branch, ids[9], ids[8]]);
  assert.ok(matches.cursor);
  const older = await manager.searchHistory("needle", { before: matches.cursor, limit: 1 });
  assert.deepEqual(older.matches.map((match) => match.id), [ids[7]]);
  assert.ok(older.cursor);
  const newer = await manager.searchHistory("needle", { after: older.cursor, limit: 1 });
  assert.deepEqual(newer.matches.map((match) => match.id), [ids[8]]);
  const lineage = await manager.searchHistory("needle", { from: branch });
  assert.deepEqual(lineage.matches.map((match) => match.id), [branch, ids[2], ids[1], ids[0]]);
  assert.equal(lineage.hasMore, false);
  assert.deepEqual(manager.getHistoryPage({ from: ids[9]!, edge: "oldest", limit: 2 }).entries.map((entry) => entry.id), ids.slice(0, 2));
});

test("history search is cancellable and excludes hidden metadata", async () => {
  const { manager } = history(300);
  manager.appendCustomEntry("private", { secret: "hidden needle" });
  manager.appendCustomMessageEntry("private", "hidden needle", false);
  assert.equal((await manager.searchHistory("hidden needle")).matches.length, 0);
  const controller = new AbortController();
  const searching = manager.searchHistory("does not match", { signal: controller.signal });
  controller.abort(new Error("cancelled search"));
  await assert.rejects(searching, /cancelled search/);
  const switched = manager.searchHistory("does not match");
  manager.newSession();
  await assert.rejects(switched, /Session changed/);
});
