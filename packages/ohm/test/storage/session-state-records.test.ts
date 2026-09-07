import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SESSION_V4_MAX_RECORD_BYTES, cloneSessionV4State, type SessionV4Commit, type SessionV4ConversationNode, type SessionV4Header } from "@ohm/kernel/session-v4";
import { SessionStorageJournal } from "../../src/storage/session-storage.js";
import { SqliteSessionStateRecords } from "../../src/storage/session-state-records.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const TIME = "2026-09-06T12:00:00.000Z";
const HEADER: SessionV4Header = {
  record: "session", version: 4, sessionId: "payload-test", createdAt: TIME, workspace: "/workspace", cwd: "/workspace",
};

function node(id: string, content = "payload"): Extract<SessionV4ConversationNode, { nodeType: "message" }> {
  return { id, parentId: null, createdAt: TIME, nodeType: "message", role: "assistant", content };
}

function fixture(durable: SessionV4Commit[] = [], afterAppend?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  const records = new SqliteSessionStateRecords(db);
  const journal = new SessionStorageJournal({
    path: "/private/payload-test", readOnly: false,
    read: () => ({ header: HEADER, commits: durable }),
    createStateRecords: () => records,
    append(commit) { durable.push(structuredClone(commit)); afterAppend?.(db); },
    close() { records.close(); db.close(); },
  });
  return { db, records, durable, journal };
}

test("private replay accounts accepted UTF-8 bytes without hydrating commits again", (t) => {
  const input: SessionV4Commit = {
    record: "commit", sequence: 1, commitId: "large", committedAt: TIME,
    changes: [{ type: "conversation_node", node: node("large", "😀\ud800\0".repeat(400_000)) }],
  };
  const second: SessionV4Commit = { record: "commit", sequence: 2, commitId: "second", committedAt: TIME,
    changes: [{ type: "session_name", name: "名" }], };
  const db = new DatabaseSync(":memory:");
  const records = new SqliteSessionStateRecords(db);
  const hydrate = t.mock.method(records.collections.commits, "values");
  const journal = new SessionStorageJournal({
    path: "/private/replay-bytes", readOnly: false,
    read: () => ({ header: HEADER, commits: [input, second] }), createStateRecords: () => records,
    append() { throw new Error("replay-only fixture"); },
    close() { records.close(); db.close(); },
  });
  try {
    assert.equal(hydrate.mock.callCount(), 0, "accepted TEMP bytes must not decode the oversized commit again");
    assert.equal(journal.bytes, Buffer.byteLength([HEADER, input, second].map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8"));
    assert.deepEqual(records.collections.commits.get("large"), input);
    assert.equal(records.replayCommitBytes(2), Buffer.byteLength(JSON.stringify(second), "utf8") + 1);
    assert.throws(() => records.replayCommitBytes(1), /lost its accepted commit byte count/u);
    assert.throws(() => journal.inspectState((state) => state.sequence), /faulted/u);
  } finally { journal.close(); }

  input.changes = [{ type: "conversation_node", node: node("too-large", "x".repeat(SESSION_V4_MAX_RECORD_BYTES)) }];
  assert.throws(() => fixture([input]), /record exceeds its byte limit/u);
});

test("private records bound cached payload weight/count and preserve UTF-16 and live iteration", () => {
  const db = new DatabaseSync(":memory:");
  const records = new SqliteSessionStateRecords(db);
  try {
    assert.equal(db.prepare("PRAGMA temp_store").get()?.temp_store, 1);
    assert.equal(db.prepare("PRAGMA temp.cache_size").get()?.cache_size, -2048);
    const nodes = records.collections.nodes;
    const first = node("first\ud800", "opaque\ud801\0tail");
    nodes.set(first.id, first);
    const iterator = nodes.values();
    assert.equal(iterator.next().value, first);
    for (let index = 0; index < 33; index += 1) nodes.set(`node-${index}`, node(`node-${index}`));
    assert.deepEqual(iterator.next().value, node("node-0"));
    const reloaded = nodes.get(first.id);
    assert.notEqual(reloaded, first);
    assert.deepEqual(reloaded, first);
    assert.equal(nodes.get("first\ud801"), undefined);
    const weighted = node("weighted", "x".repeat(1200 * 1024));
    nodes.set(weighted.id, weighted);
    nodes.set("another-weighted", node("another-weighted", "y".repeat(1200 * 1024)));
    assert.notEqual(nodes.get(weighted.id), weighted);
    const oversized = node("oversized", "z".repeat(2 * 1024 * 1024));
    nodes.set(oversized.id, oversized);
    assert.notEqual(nodes.get(oversized.id), nodes.get(oversized.id));
    assert.deepEqual(nodes.get(oversized.id), oversized);
    db.prepare("DELETE FROM temp.ohm_session_state_records WHERE kind = 'nodes' AND id = ?").run(JSON.stringify(first.id));
    assert.throws(() => nodes.get(first.id), /Validated session record is missing/u);
    assert.throws(() => nodes.get(oversized.id), /faulted/u);
    assert.throws(() => records.getEntryProjectionMetadataPage(0, 1), /faulted/u);
    records.close();
    assert.throws(() => nodes.get(first.id), /closed/u);
    assert.throws(() => records.getEntryProjectionMetadataPage(0, 1), /closed/u);
  } finally { records.close(); db.close(); }
});

test("private projection metadata preserves nested roles and tool batches without loading payloads", (t) => {
  const db = new DatabaseSync(":memory:");
  const records = new SqliteSessionStateRecords(db);
  const results = [
    { type: "tool_result", callId: "first", name: "one", content: "one", isError: false },
    { type: "tool_result", callId: "second", name: "two", content: "two", isError: false },
  ];
  const values: SessionV4ConversationNode[] = [
    { ...node("nested-tool"), content: { id: "nested-tool", role: "tool", createdAt: TIME, content: results } },
    { ...node("nested-user"), role: "tool", content: { id: "nested-user", role: "user", createdAt: TIME, content: results } },
    { ...node("array-tool"), role: "tool", content: results },
    { ...node("empty-tool"), role: "tool", content: [] },
    { id: "custom-tool", parentId: "nested-tool", nodeType: "extension_context", createdAt: TIME,
      extensionId: "ohm.session.message-custom", context: { id: "custom-tool", role: "tool", createdAt: TIME, content: results } },
    { id: "other-context", parentId: "custom-tool", nodeType: "extension_context", createdAt: TIME,
      extensionId: "other", context: { id: "other-context", role: "tool", createdAt: TIME, content: results } },
  ];
  try {
    for (const value of values) records.collections.nodes.set(value.id, value);
    for (let index = 0; index < 40; index += 1) records.collections.nodes.set(`padding-${index}`, node(`padding-${index}`));
    const hydrate = t.mock.method(records.collections.nodes, "get");
    const expected = values.map((value, index) => ({
      id: value.id, parentId: value.parentId, projectedEntryCount: [2, 1, 2, 1, 2, 1][index],
    }));
    assert.deepEqual(records.getEntryProjectionMetadataPage(0, values.length), expected);
    assert.deepEqual(records.getEntryProjectionMetadataPage(1, 3), expected.slice(1, 4));
    const detached = records.getEntryProjectionMetadataPage(0, 1);
    detached[0]!.id = "mutated";
    detached[0]!.projectedEntryCount = 99;
    assert.deepEqual(records.getEntryProjectionMetadataPage(0, 1), expected.slice(0, 1));
    assert.equal(hydrate.mock.callCount(), 0);
  } finally { records.close(); db.close(); }
});

test("validation rollback removes tentative TEMP records and leaves ordinary rejected appends usable", () => {
  const { db, records, durable, journal } = fixture();
  try {
    const input = { commitId: "accepted", committedAt: TIME, changes: [{ type: "conversation_node", node: node("accepted") }] } satisfies Parameters<SessionStorageJournal["append"]>[0];
    journal.append(input);
    const before = journal.inspectState(cloneSessionV4State);
    const projectionBefore = journal.getEntryProjectionMetadataPage(0, 100);
    assert.throws(() => journal.append({
      commitId: "invalid", committedAt: TIME, changes: [
        { type: "conversation_node", node: node("tentative") },
        { type: "head", branchId: "main", nodeId: "missing" },
      ],
    }), /unknown node/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM temp.ohm_session_state_records WHERE id = ?").get(JSON.stringify("tentative"))?.count, 0);
    assert.deepEqual(journal.inspectState(cloneSessionV4State), before);
    assert.deepEqual(journal.getEntryProjectionMetadataPage(0, 100), projectionBefore);
    const iterator = records.collections.commits.values();
    assert.deepEqual(iterator.next().value, durable[0]);
    for (let index = 0; index < 35; index += 1) journal.append({
      commitId: `next-${index}`, committedAt: TIME,
      changes: [{ type: "conversation_node", node: node(`next-${index}`) }],
    });
    assert.deepEqual(iterator.next().value, durable[1]);
    assert.deepEqual(journal.append(input), durable[0]);
    assert.equal(durable.length, 36);
    assert.equal(journal.bytes, Buffer.byteLength([HEADER, ...durable].map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8"));
    assert.deepEqual(records.collections.nodes.get("accepted"), node("accepted"));
    const snapshot = journal.inspectState(cloneSessionV4State);
    assert.ok(snapshot.nodes instanceof Map);
    assert.ok(snapshot.commits instanceof Map);
    snapshot.nodes.clear();
    assert.equal(records.collections.nodes.size, 36);
    assert.equal(journal.getEntryProjectionMetadataPage(0, 100)?.length, 36);
  } finally { journal.close(); }
});

test("validation rollback restores an evicted mutable TEMP record after replacement", () => {
  const { records, durable, journal } = fixture();
  try {
    for (let index = 0; index < 18; index += 1) journal.append({
      commitId: `queue-${index}`, committedAt: TIME, changes: [{
        type: "queue_added", branchId: "main", entryId: `queue-${index}`, targetNodeId: `prompt-${index}`,
        kind: "next_run", addedAt: TIME, message: { text: `work-${index}` },
      }],
    });
    const before = journal.inspectState(cloneSessionV4State);
    assert.throws(() => journal.append({
      commitId: "invalid-replacement", committedAt: TIME, changes: [
        { type: "queue_finished", branchId: "main", entryId: "queue-0", finishedAt: TIME, outcome: "cancelled" },
        { type: "head", branchId: "main", nodeId: "missing" },
      ],
    }), /unknown node/u);
    // Reload all later records to evict the undone value, proving the restored
    // value comes from TEMP rather than a surviving pre-validation cache alias.
    for (let index = 1; index < 18; index += 1) records.collections.queue.get(`queue-${index}`);
    assert.deepEqual(records.collections.queue.get("queue-0"), before.queue.get("queue-0"));
    assert.deepEqual(journal.inspectState(cloneSessionV4State), before);
    journal.append({ commitId: "valid-replacement", committedAt: TIME, changes: [
      { type: "queue_finished", branchId: "main", entryId: "queue-0", finishedAt: TIME, outcome: "cancelled" },
    ] });
    assert.equal(records.collections.queue.get("queue-0")?.status, "cancelled");
    assert.equal(durable.length, 19);
  } finally { journal.close(); }
});

test("TEMP write and undo failures poison the owner before a durable append can be acknowledged", () => {
  for (const failure of ["write", "undo"]) {
    const { db, records, durable, journal } = fixture();
    try {
      journal.append({ commitId: "accepted", committedAt: TIME, changes: [{ type: "conversation_node", node: node("accepted") }] });
      db.exec(failure === "write"
        ? `CREATE TEMP TRIGGER reject_write BEFORE INSERT ON ohm_session_state_records
          WHEN NEW.id = '"tentative"' BEGIN SELECT RAISE(FAIL, 'injected TEMP write failure'); END;`
        : `CREATE TEMP TRIGGER reject_undo BEFORE DELETE ON ohm_session_state_records
          WHEN OLD.id = '"tentative"' BEGIN SELECT RAISE(FAIL, 'injected TEMP undo failure'); END;`);
      assert.throws(() => journal.append({ commitId: "rejected", committedAt: TIME, changes: [
        { type: "conversation_node", node: node("tentative") },
        { type: "head", branchId: "main", nodeId: "missing" },
      ] }), /injected TEMP|faulted/u);
      assert.equal(durable.length, 1);
      assert.throws(() => journal.inspectState((state) => state.sequence), /faulted/u);
      assert.throws(() => records.replayCommitBytes(1), /faulted/u);
      assert.throws(() => records.collections.nodes.get("accepted"), /faulted/u);
      assert.throws(() => journal.append({ commitId: "after-fault", committedAt: TIME, changes: [{ type: "session_name", name: "must not persist" }] }), /faulted/u);
      assert.equal(durable.length, 1);
    } finally { journal.close(); }
  }
});

test("TEMP failure after durable append faults the owner and replay recovers the commit exactly once", () => {
  const durable: SessionV4Commit[] = [];
  const failed = fixture(durable, (db) => db.exec(`CREATE TEMP TRIGGER reject_applied_write
    BEFORE INSERT ON ohm_session_state_records WHEN NEW.id = '"committed"'
    BEGIN SELECT RAISE(FAIL, 'injected post-durable TEMP failure'); END;`));
  const input = { commitId: "committed", committedAt: TIME, changes: [
    { type: "conversation_node", node: node("committed") },
  ] } satisfies Parameters<SessionStorageJournal["append"]>[0];
  try {
    assert.throws(() => failed.journal.append(input), /injected post-durable TEMP failure/u);
    assert.equal(durable.length, 1);
    assert.throws(() => failed.journal.inspectState((state) => state.sequence), /faulted/u);
    assert.throws(() => failed.journal.append(input), /faulted/u);
    assert.equal(durable.length, 1);
  } finally { failed.journal.close(); }
  const recovered = fixture(durable);
  try {
    assert.equal(recovered.journal.inspectState((state) => state.sequence), 1);
    assert.deepEqual(recovered.records.collections.nodes.get("committed"), node("committed"));
    assert.deepEqual(recovered.journal.append(input), durable[0]);
    assert.equal(recovered.records.collections.nodes.size, 1);
    assert.equal(durable.length, 1);
  } finally { recovered.journal.close(); }
});

test("owned historical reads use validated TEMP values after main-row tampering and snapshots close detached", () => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-payload-trust-"));
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  let external: DatabaseSync | undefined;
  try {
    const first = manager.appendCustomEntry("opaque", { value: "preserved\ud800\0value" });
    for (let index = 0; index < 40; index += 1) manager.appendCustomEntry("padding", { index });
    const file = manager.getSessionFile();
    assert.ok(file !== undefined);
    const snapshot = SessionManager.openSnapshot(file);
    const expected = snapshot.getEntry(first);
    external = new DatabaseSync(file);
    external.exec("UPDATE session_commits SET record = 'null' WHERE sequence = 1");
    assert.deepEqual(manager.getEntry(first), expected);
    assert.deepEqual(snapshot.getEntry(first), expected);
    manager.closeV4Store();
    assert.deepEqual(snapshot.getEntry(first), expected);
    assert.throws(() => SessionManager.open(file), /must be an object/u);
  } finally {
    external?.close();
    manager.closeV4Store();
    rmSync(directory, { recursive: true, force: true });
  }
});
