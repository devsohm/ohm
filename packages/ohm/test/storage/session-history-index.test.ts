import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteSessionHistoryIndex, type SessionHistoryIndexCommit } from "../../src/storage/session-history-index.js";

function node(id: string, parentId: string | null, isModel = false, isThinking = false): SessionHistoryIndexCommit["changes"][number] {
  return { type: "node", id, parentId, isModel, isThinking };
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  const index = new SqliteSessionHistoryIndex(db);
  index.update([{ sequence: 1, changes: [
    node("root", null, true), node("thinking", "root", false, true),
    node("left", "thinking"), node("left-tip", "left"),
    node("right", "thinking", true), node("right-tip", "right", false, true),
    node("other-root", null),
  ] }]);
  return { db, index };
}

test("history index derives immutable lineage selection, ordinal, depth and current labels", () => {
  const { db, index } = fixture();
  try {
    assert.deepEqual(index.getNode("right-tip"), {
      id: "right-tip", parentId: "right", ordinal: 5, depth: 3,
      nearestModelId: "right", nearestThinkingId: "right-tip", label: null, labelTimestamp: null,
    });
    assert.equal(index.getNode("left-tip")?.nearestModelId, "root");
    assert.equal(index.getNode("left-tip")?.nearestThinkingId, "thinking");
    assert.equal(index.getNode("left")?.depth, index.getNode("right")?.depth);
    assert.equal(index.getNode("other-root")?.nearestThinkingId, null);
    assert.equal(index.hasThinkingChange(), true);
    index.update([{ sequence: 2, changes: [{ type: "label", nodeId: "left", label: "newer", timestamp: "2030" }] },
      { sequence: 3, changes: [] },
      { sequence: 4, changes: [{ type: "label", nodeId: "left", label: "last committed", timestamp: "2000" }] }]);
    assert.equal(index.getNode("left")?.label, "last committed");
    assert.equal(index.getNode("left")?.labelTimestamp, "2000");
    index.update([{ sequence: 5, changes: [{ type: "label", nodeId: "left", label: null, timestamp: "2040" }] }]);
    assert.equal(index.getNode("left")?.label, null);
    assert.equal(index.getNode("left")?.labelTimestamp, null);
    assert.deepEqual(index.getNodesPage(3, 2).map((entry) => entry.id), ["left-tip", "right"]);
    const changed = index.getNode("root");
    assert.ok(changed);
    changed.depth = 100;
    assert.equal(index.getNode("root")?.depth, 0);
    assert.equal(index.getNode("missing"), undefined);
  } finally { db.close(); }
});

test("node insertion inherits encoded metadata and extends a cached path without decoding parent rows", (context) => {
  const db = new DatabaseSync(":memory:");
  const index = new SqliteSessionHistoryIndex(db);
  const ids = ["root\ud800", "model\ud801", "thinking\udc00", "message\0tail"];
  try {
    index.update([{ sequence: 1, changes: [node(ids[0]!, null)] }]);
    index.getHistoryRange(ids[0]!, 0, 1);
    const lookup = context.mock.method(index, "getNode", () => { throw new Error("Parent metadata must stay in SQLite"); });
    assert.throws(() => index.update([{ sequence: 2, changes: [node("unaccepted", "missing", false, true)] }]), /Entry missing not found/u);
    assert.equal(index.hasThinkingChange(), false);
    assert.equal(index.getNodesPage(0, 5).length, 1);
    index.update([{ sequence: 2, changes: [
      node(ids[1]!, ids[0]!, true), node(ids[2]!, ids[1]!, false, true), node(ids[3]!, ids[2]!),
    ] }]);
    assert.equal(lookup.mock.callCount(), 0);
    lookup.mock.restore();
    assert.deepEqual(index.getNode(ids[3]!), {
      id: ids[3], parentId: ids[2], ordinal: 3, depth: 3,
      nearestModelId: ids[1], nearestThinkingId: ids[2], label: null, labelTimestamp: null,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM temp.ohm_session_history_path").get()?.count, 4);
    assert.deepEqual(index.getHistoryRange(ids[3]!, 0, 4), { ids, total: 4 });
  } finally { db.close(); }
});

test("history index preserves distinct UTF-16 identities and labels through every query", () => {
  const db = new DatabaseSync(":memory:");
  const index = new SqliteSessionHistoryIndex(db);
  const ids = ["node\ud800", "node\ud801", "node\udc00", "node\ufffd", "node\0tail", "node🙂\\\""];
  const label = "label\ud800\udc00\ud801\0tail\\\"";
  const timestamp = "2026-09-05T12:00:00.000Z";
  try {
    index.update([{ sequence: 1, changes: [
      ...ids.map((id, ordinal) => node(id, ids[ordinal - 1] ?? null, ordinal === 0, ordinal === 1)),
      { type: "label", nodeId: ids[0]!, label, timestamp },
    ] }]);
    assert.deepEqual(index.getNodesPage(0, ids.length).map((entry) => entry.id), ids);
    for (const [ordinal, id] of ids.entries()) {
      const selected = index.getNode(id);
      assert.ok(selected);
      assert.equal(selected.id, id);
      assert.equal(selected.parentId, ids[ordinal - 1] ?? null);
      assert.equal(selected.nearestModelId, ids[0]);
      assert.equal(selected.nearestThinkingId, ordinal === 0 ? null : ids[1]);
    }
    assert.equal(index.getNode(ids[0]!)?.label, label);
    assert.equal(index.getNode(ids[0]!)?.labelTimestamp, timestamp);
    for (const [ordinal, cursor] of ids.entries()) {
      assert.deepEqual(index.getHistoryPage(ids.at(-1)!, { direction: "before", cursor, limit: 2 }).ids,
        ids.slice(Math.max(0, ordinal - 2), ordinal));
      assert.deepEqual(index.getHistoryPage(ids.at(-1)!, { direction: "after", cursor, limit: 2 }).ids,
        ids.slice(ordinal + 1, ordinal + 3));
    }
    assert.deepEqual(index.getActiveIds(1, 3, ids.at(-1)!), ids.slice(1, 4));
    assert.deepEqual(index.getHistoryRange(ids.at(-1)!, 1, 3), { ids: ids.slice(1, 4), total: ids.length });
    index.update([{ sequence: 2, changes: [{ type: "label", nodeId: ids[0]!, label: null, timestamp }] }]);
    assert.equal(index.getNode(ids[0]!)?.label, null);
    assert.equal(index.getNode(ids[0]!)?.labelTimestamp, null);
  } finally { db.close(); }
});

test("history index cursor pages match selected lineages including empty boundary offsets", () => {
  const { db, index } = fixture();
  try {
    for (const ids of [["root", "thinking", "left", "left-tip"], ["root", "thinking", "right", "right-tip"], ["other-root"]]) {
      const from = ids.at(-1)!;
      for (const limit of [1, 2, 8]) {
        assert.deepEqual(index.getHistoryPage(from, { direction: "newest", limit }), {
          ids: ids.slice(-limit), offset: Math.max(0, ids.length - limit), total: ids.length,
        });
        assert.deepEqual(index.getHistoryPage(from, { direction: "oldest", limit }), {
          ids: ids.slice(0, limit), offset: 0, total: ids.length,
        });
        for (const [at, cursor] of ids.entries()) {
          const offset = Math.max(0, at - limit);
          assert.deepEqual(index.getHistoryPage(from, { direction: "before", cursor, limit }), {
            ids: ids.slice(offset, at), offset, total: ids.length,
          });
          assert.deepEqual(index.getHistoryPage(from, { direction: "after", cursor, limit }), {
            ids: ids.slice(at + 1, at + 1 + limit), offset: at + 1, total: ids.length,
          });
        }
      }
    }
    for (const cursor of ["right", "right-tip", "other-root", "missing"]) {
      assert.throws(() => index.getHistoryPage("left-tip", { direction: "before", cursor, limit: 2 }), /not on the selected lineage/u);
      assert.throws(() => index.getHistoryPage("left-tip", { direction: "after", cursor, limit: 2 }), /not on the selected lineage/u);
    }
    assert.throws(() => index.getHistoryPage("missing", { direction: "newest", limit: 2 }), /Entry missing not found/u);
    assert.throws(() => index.getHistoryPage(null, { direction: "before", cursor: "root", limit: 2 }), /not on the selected lineage/u);
    assert.deepEqual(index.getActiveIds(1, 4, "right-tip"), ["thinking", "right"]);
    assert.deepEqual(index.getActiveIds(0, 7, "left-tip"), ["root", "thinking", "left", "left-tip"]);
    assert.deepEqual(index.getActiveIds(20, 5, "left-tip"), []);
  } finally { db.close(); }
});

test("history index transaction failures restore prior metadata, sequence and ordinal", () => {
  const { db, index } = fixture();
  try {
    const before = index.getNodesPage(0, 20);
    assert.throws(() => index.update([{ sequence: 2, changes: [
      node("rollback", "left-tip"), { type: "label", nodeId: "root", label: "rollback", timestamp: "2000" }, node("root", null),
    ] }]), /UNIQUE/u);
    assert.deepEqual(index.getNodesPage(0, 20), before);
    assert.throws(() => index.update([{ sequence: 2, changes: [node("child", "future"), node("future", null)] }]), /not found/u);
    assert.throws(() => index.update([{ sequence: 2, changes: [{ type: "label", nodeId: "missing", label: "x", timestamp: "2000" }] }]), /not found/u);
    function* interrupted(): Iterable<SessionHistoryIndexCommit> {
      yield { sequence: 2, changes: [node("interrupted", "root")] };
      throw new Error("interrupted iterator");
    }
    assert.throws(() => index.update(interrupted()), /interrupted iterator/u);
    assert.deepEqual(index.getNodesPage(0, 20), before);
    assert.throws(() => index.update([{ sequence: 3, changes: [] }]), /contiguous/u);
    index.update([{ sequence: 2, changes: [node("committed", "root")] }]);
    assert.equal(index.getNode("committed")?.ordinal, 7);
    assert.equal(index.getNode("committed")?.depth, 1);
  } finally { db.close(); }
});

test("empty metadata index is connection-local and accepts commits without nodes", () => {
  const db = new DatabaseSync(":memory:");
  const index = new SqliteSessionHistoryIndex(db);
  try {
    index.update([{ sequence: 1, changes: [] }]);
    assert.equal(index.hasThinkingChange(), false);
    assert.deepEqual(index.getNodesPage(0, 10), []);
    assert.deepEqual(index.getNodesPage(0, 0), []);
    assert.deepEqual(index.getHistoryPage(null, { direction: "newest", limit: 5 }), { ids: [], offset: 0, total: 0 });
    assert.deepEqual(index.getHistoryPage(null, { direction: "oldest", limit: 5 }), { ids: [], offset: 0, total: 0 });
    assert.deepEqual(index.getActiveIds(0, 10, null), []);
    index.update([{ sequence: 2, changes: [node("root", null)] }]);
    assert.deepEqual(index.getNodesPage(1, 10), []);
    assert.deepEqual(db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table'").all(), []);
  } finally { db.close(); }
  assert.throws(() => index.getNode("root"));
});

test("the owner can rebuild a failed index without changing a same-named persistent table", () => {
  const { db, index } = fixture();
  try {
    db.exec("CREATE TABLE main.ohm_session_history_nodes (marker TEXT); INSERT INTO main.ohm_session_history_nodes VALUES ('preserved')");
    assert.throws(() => index.update([{ sequence: 2, changes: [node("new", "root"), node("root", null)] }]), /UNIQUE/u);
    const rebuilt = new SqliteSessionHistoryIndex(db);
    assert.deepEqual(rebuilt.getNodesPage(0, 20), []);
    rebuilt.update([{ sequence: 1, changes: [node("replacement", null, false, true)] }]);
    assert.equal(rebuilt.getNode("replacement")?.ordinal, 0);
    assert.equal(rebuilt.hasThinkingChange(), true);
    assert.equal(db.prepare("SELECT marker FROM main.ohm_session_history_nodes").get()?.marker, "preserved");
  } finally { db.close(); }
});

test("one SQL path stays lazy for bounded reads and distinguishes ancestor heads from sibling branches", () => {
  const db = new DatabaseSync(":memory:");
  const index = new SqliteSessionHistoryIndex(db);
  const ids = Array.from({ length: 20 }, (_, at) => `node-${at}`);
  const pathCount = () => db.prepare("SELECT COUNT(*) AS count FROM temp.ohm_session_history_path").get()?.count;
  try {
    index.update([{ sequence: 1, changes: ids.map((id, at) => node(id, ids[at - 1] ?? null)) }]);
    assert.deepEqual(index.getHistoryPage(ids[19]!, { direction: "newest", limit: 3 }).ids, ids.slice(17));
    assert.deepEqual(index.getHistoryPage(ids[19]!, { direction: "before", cursor: ids[18]!, limit: 3 }).ids, ids.slice(15, 18));
    assert.deepEqual(index.getHistoryPage(ids[19]!, { direction: "after", cursor: ids[18]!, limit: 3 }).ids, ids.slice(19));
    assert.deepEqual(index.getActiveIds(17, 3, ids[19]!), ids.slice(17));
    assert.equal(pathCount(), 0, "page-bounded recursion must not populate the whole path");
    assert.deepEqual(index.getHistoryPage(ids[19]!, { direction: "oldest", limit: 3 }).ids, ids.slice(0, 3));
    assert.equal(pathCount(), 20);
    db.exec(`CREATE TEMP TRIGGER reject_path_rebuild BEFORE DELETE ON ohm_session_history_path
      BEGIN SELECT RAISE(ABORT, 'unexpected path rebuild'); END`);
    assert.deepEqual(index.getHistoryRange(ids[9]!, 8, 10), { ids: ids.slice(8, 10), total: 10 });
    assert.equal(pathCount(), 20, "an ancestor query reuses but does not expose its cached descendants");
    assert.deepEqual(index.getHistoryPage(ids[9]!, { direction: "after", cursor: ids[0]!, limit: 3 }).ids, ids.slice(1, 4));
    assert.deepEqual(index.getActiveIds(0, 3, ids[9]!), ids.slice(0, 3));
    db.exec("DROP TRIGGER temp.reject_path_rebuild");
    index.update([{ sequence: 2, changes: [node("sibling", ids[8]!)] }]);
    assert.deepEqual(index.getHistoryRange("sibling", 8, 10), { ids: [ids[8], "sibling"], total: 10 });
    assert.equal(pathCount(), 10);
    assert.deepEqual(index.getHistoryRange(ids[9]!, 8, 10), { ids: ids.slice(8, 10), total: 10 });
    assert.deepEqual(index.getHistoryRange(null, 0, 3), { ids: [], total: 0 });
    assert.deepEqual(index.getHistoryRange(ids[9]!, 10, 3), { ids: [], total: 10 });
    assert.deepEqual(index.getHistoryRange(ids[9]!, 0, 0), { ids: [], total: 10 });
    assert.throws(() => index.getHistoryRange("missing", 0, 3), /Entry missing not found/u);
  } finally { db.close(); }
});

test("cached SQL path extensions roll back with failed metadata updates and remain appendable", () => {
  const { db, index } = fixture();
  const pathCount = () => db.prepare("SELECT COUNT(*) AS count FROM temp.ohm_session_history_path").get()?.count;
  try {
    index.getHistoryRange("left-tip", 0, 4);
    index.update([{ sequence: 2, changes: [node("extended", "left-tip"), node("further", "extended")] }]);
    assert.equal(pathCount(), 6, "validated children extend the existing path without a rebuild");
    assert.deepEqual(index.getHistoryRange("left-tip", 2, 20), { ids: ["left", "left-tip"], total: 4 });
    assert.equal(pathCount(), 6);
    assert.throws(() => index.update([{ sequence: 3, changes: [node("rollback", "further"), node("root", null)] }]), /UNIQUE/u);
    assert.equal(pathCount(), 6);
    assert.equal(index.getNode("rollback"), undefined);
    index.update([{ sequence: 3, changes: [node("accepted", "further")] }]);
    assert.equal(pathCount(), 7, "rollback restores the cached tip as well as its SQL rows");
    assert.deepEqual(index.getHistoryRange("accepted", 4, 20), { ids: ["extended", "further", "accepted"], total: 7 });
    index.update([{ sequence: 4, changes: [{ type: "label", nodeId: "root", label: "label", timestamp: "2000" }] }]);
    assert.equal(pathCount(), 7);
    const rebuilt = new SqliteSessionHistoryIndex(db);
    assert.equal(pathCount(), 0);
    rebuilt.update([{ sequence: 1, changes: [node("new-root", null)] }]);
    assert.deepEqual(rebuilt.getHistoryRange("new-root", 0, 2), { ids: ["new-root"], total: 1 });
  } finally { db.close(); }
});
