import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMap } from "node:util/types";
import test from "node:test";
import { SESSION_V4_MAX_RECORD_BYTES, type SessionV4Commit, type SessionV4Header } from "@ohm/kernel/session-v4";
import { isObjectValue } from "../../src/core/value-schemas.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { SessionStorageJournal } from "../../src/storage/session-storage.js";
import { SqliteSessionHistoryIndex, type SessionHistoryIndexCommit } from "../../src/storage/session-history-index.js";

const TIME = "2026-09-05T12:00:00.000Z";
const HEADER: SessionV4Header = {
  record: "session", version: 4, sessionId: "replay", createdAt: TIME,
  workspace: "/workspace", cwd: "/workspace",
};

function record(): SessionV4Commit {
  return {
    record: "commit", sequence: 1, commitId: "first", committedAt: TIME,
    changes: [{
      type: "conversation_node",
      node: { id: "node", parentId: null, createdAt: TIME, nodeType: "message", role: "assistant",
        content: { visible: "hello", opaque: { provider: "fixture", bytes: "AAECAw==" } } },
    }, { type: "head", branchId: "main", nodeId: "node" }],
  };
}

test("journal replay owns parsed values even when storage mutates reused inputs", () => {
  const header = structuredClone(HEADER);
  const input = record();
  const expected = structuredClone(input);
  const second: SessionV4Commit = {
    record: "commit", sequence: 2, commitId: "second", committedAt: TIME,
    changes: [{ type: "session_name", name: "named" }],
  };
  let closed = 0;
  const journal = new SessionStorageJournal({
    path: "/unused", readOnly: true,
    read: () => ({ header, commits: (function* () {
      yield input;
      header.cwd = "/changed";
      Object.assign(input, structuredClone(second));
      yield input;
      input.changes.splice(0);
    })() }),
    append: () => { throw new Error("read-only fixture"); },
    close: () => { closed += 1; },
  });
  assert.deepEqual(journal.inspectState((state) => state.header), HEADER);
  assert.deepEqual(journal.inspectState((state) => state.commits.get("first")), expected);
  assert.deepEqual(journal.inspectState((state) => state.commits.get("second")), second);
  assert.equal(journal.bytes, Buffer.byteLength([HEADER, expected, second].map((item) => JSON.stringify(item)).join("\n") + "\n"));
  journal.close();
  assert.equal(closed, 1);
});

test("journal replay rejects malformed values, duplicate commits and invalid transitions before exposing state", () => {
  const malformed = record();
  Reflect.set(malformed, "sequence", "1");
  const transition = record();
  transition.changes = [{ type: "head", branchId: "main", nodeId: "missing" }];
  for (const commits of [[null], [malformed], [record(), record()], [transition]]) {
    let closed = 0;
    assert.throws(() => new SessionStorageJournal({
      path: "/unused", readOnly: true,
      read: () => ({ header: HEADER, commits }),
      append: () => { throw new Error("read-only fixture"); },
      close: () => { closed += 1; },
    }));
    assert.equal(closed, 1);
  }
});

test("journal replay rejects a record above the logical byte bound and closes storage", () => {
  const oversized = record();
  oversized.changes = [{ type: "conversation_node", node: {
    id: "large", parentId: null, createdAt: TIME, nodeType: "message", role: "user",
    content: "x".repeat(SESSION_V4_MAX_RECORD_BYTES),
  } }];
  let closed = 0;
  assert.throws(() => new SessionStorageJournal({
    path: "/unused", readOnly: true,
    read: () => ({ header: HEADER, commits: [oversized] }),
    append: () => { throw new Error("read-only fixture"); },
    close: () => { closed += 1; },
  }), /record exceeds its byte limit/u);
  assert.equal(closed, 1);
});

test("SQLite replay rejects malformed persisted records and releases writer ownership", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-replay-malformed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  const path = manager.getSessionFile()!;
  manager.closeV4Store();
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const malformed = record();
  Reflect.set(malformed, "sequence", "1");
  db.prepare("INSERT INTO session_commits (sequence, commit_id, record) VALUES (1, 'first', ?)")
    .run(JSON.stringify(malformed));
  assert.throws(() => SessionManager.open(path), /sequence.*integer/u);
  assert.throws(() => SessionManager.openSnapshot(path), /sequence.*integer/u);
  for (const primitive of ["null", "[]", "false"]) {
    db.prepare("UPDATE session_commits SET record = ? WHERE sequence = 1").run(primitive);
    assert.throws(() => SessionManager.open(path), /must be an object/u);
  }
  db.prepare("UPDATE session_commits SET record = ? WHERE sequence = 1").run(JSON.stringify(record()));
  const repaired = SessionManager.open(path);
  assert.equal(repaired.getEntryCount(), 1);
  repaired.closeV4Store();
});

test("SQLite replay preserves its original failure after an automatic rollback", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-replay-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  manager.commitChanges(record().changes, "first", TIME);
  const path = manager.getSessionFile()!;
  const expected = manager.getV4State();
  manager.closeV4Store();
  const prepare = DatabaseSync.prototype.prepare;
  for (const action of ["ABORT", "ROLLBACK"]) {
    const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.endsWith("FROM session_commits ORDER BY sequence")) {
        assert.equal(this.isTransaction, true);
        this.exec(`CREATE TEMP TABLE replay_failure(value);
          CREATE TEMP TRIGGER fail_replay BEFORE INSERT ON replay_failure
          BEGIN SELECT RAISE(${action}, 'injected replay failure'); END;
          INSERT INTO replay_failure VALUES (1);`);
      }
      return prepare.call(this, sql);
    });
    assert.throws(() => SessionManager.open(path), /injected replay failure/u);
    mocked.mock.restore();
    const reopened = SessionManager.open(path);
    assert.deepEqual(reopened.getV4State(), expected);
    reopened.closeV4Store();
  }
});

test("SQLite successful replay still requires its transaction to commit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-replay-commit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  const path = manager.getSessionFile()!;
  manager.closeV4Store();
  const prepare = DatabaseSync.prototype.prepare;
  const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.endsWith("FROM session_commits ORDER BY sequence")) this.exec("ROLLBACK");
    return prepare.call(this, sql);
  });
  assert.throws(() => SessionManager.open(path), /cannot commit - no transaction is active/u);
  mocked.mock.restore();
  const reopened = SessionManager.open(path);
  reopened.closeV4Store();
});

test("fresh snapshot ownership avoids cloning complete replayed state and public results stay detached", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-replay-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = SessionManager.create(directory, directory);
  t.after(() => writer.closeV4Store());
  writer.commitChanges(record().changes, "first", TIME);
  const path = writer.getSessionFile()!;
  const full = writer.getV4State();
  const bytes = Buffer.from([full.header, ...full.commits.values()].map((item) => JSON.stringify(item)).join("\n") + "\n");
  let fullStateClones = 0;
  const clone = globalThis.structuredClone;
  const mocked = t.mock.method(globalThis, "structuredClone", <T>(value: T): T => {
    if (isObjectValue(value) && "nodes" in value && "commits" in value
      && isMap(value.nodes) && isMap(value.commits)) fullStateClones += 1;
    return clone(value);
  });
  const snapshot = SessionManager.open(path, undefined, undefined, { readOnly: true });
  const fromBytes = SessionManager.openSnapshotBytes(join(directory, "transfer.jsonl"), bytes);
  mocked.mock.restore();
  assert.equal(fullStateClones, 0, "opening privately owned replay results must not clone the full journal");
  bytes.fill(0);
  const exposed = snapshot.getV4State();
  exposed.nodes.clear();
  exposed.commits.clear();
  writer.appendSessionInfo("later name");
  assert.equal(snapshot.getSessionName(), undefined);
  assert.deepEqual(snapshot.getV4State(), full);
  assert.deepEqual(fromBytes.getV4State(), full);
  snapshot.closeV4Store();
  fromBytes.closeV4Store();
});

function indexedJournal(commits: SessionV4Commit[] = []) {
  const db = new DatabaseSync(":memory:");
  const accepted = structuredClone(commits);
  const indexes: SqliteSessionHistoryIndex[] = [];
  const batches: SessionHistoryIndexCommit[][] = [];
  let closed = 0;
  const journal = new SessionStorageJournal({
    path: "/index-fixture", readOnly: false,
    read: () => ({ header: HEADER, commits: accepted }),
    append: (commit) => { accepted.push(structuredClone(commit)); },
    createHistoryIndex: () => {
      const index = new SqliteSessionHistoryIndex(db);
      const update = index.update.bind(index);
      index.update = (commits) => {
        const batch: SessionHistoryIndexCommit[] = [];
        batches.push(batch);
        update((function* () {
          for (const commit of commits) {
            batch.push(structuredClone(commit));
            yield commit;
          }
        })());
      };
      indexes.push(index);
      return index;
    },
    close: () => { closed += 1; db.close(); },
  });
  return { journal, accepted, indexes, batches, get closed() { return closed; } };
}

test("journal history index stays lazy and catches up only newly acknowledged commits", (t) => {
  const fixture = indexedJournal();
  const { journal, indexes, batches, accepted } = fixture;
  t.after(() => journal.close());
  assert.equal(indexes.length, 0);
  assert.equal(journal.getHistoryIndex(false), undefined);
  const index = journal.getHistoryIndex();
  assert.ok(index);
  assert.deepEqual(index.getNodesPage(0, 10), []);
  assert.equal(journal.getHistoryIndex(), index);
  assert.deepEqual(batches, []);

  const first = journal.append({ commitId: "first", committedAt: TIME, changes: record().changes });
  assert.equal(index.getNode("node"), undefined, "append does not eagerly update presentation metadata");
  assert.deepEqual(accepted, [first]);
  assert.equal(journal.getHistoryIndex(false), index);
  assert.equal(index.getNode("node")?.ordinal, 0);
  assert.deepEqual(batches, [[{ sequence: 1, changes: [
    { type: "node", id: "node", parentId: null, isModel: false, isThinking: false },
  ] }]]);

  journal.append({ commitId: "name", committedAt: TIME, changes: [{ type: "session_name", name: "renamed" }] });
  const label = { commitId: "label", committedAt: TIME,
    changes: [{ type: "node_label", nodeId: "node", label: "bookmark" }] } satisfies Parameters<SessionStorageJournal["append"]>[0];
  journal.append(label);
  assert.equal(journal.getHistoryIndex(false), index);
  assert.deepEqual(batches[1], [
    { sequence: 2, changes: [] },
    { sequence: 3, changes: [{ type: "label", nodeId: "node", label: "bookmark", timestamp: TIME }] },
  ]);
  assert.equal(index.getNode("node")?.label, "bookmark");
  const bytes = journal.bytes;
  assert.deepEqual(journal.append(label), accepted[2]);
  assert.equal(journal.bytes, bytes);
  assert.equal(accepted.length, 3);
  assert.equal(journal.getHistoryIndex(), index);
  assert.equal(batches.length, 2, "idempotent retries and unchanged reads must not refeed the index");

  journal.append({ commitId: "head", committedAt: TIME, changes: [{ type: "head", branchId: "main", nodeId: null }] });
  assert.equal(journal.getHistoryIndex(), index);
  assert.deepEqual(batches[2], [{ sequence: 4, changes: [] }]);
  assert.equal(indexes.length, 1);
  journal.close();
  journal.close();
  assert.equal(fixture.closed, 1);
  assert.throws(() => journal.getHistoryIndex(), /closed/u);
  assert.throws(() => journal.getHistoryIndex(false), /closed/u);
  assert.throws(() => journal.inspectState((state) => state.sequence), /closed/u);
  assert.throws(() => index.getNode("node"));
});

test("failed lazy index catch-up rolls back metadata and rebuilds from canonical accepted history", (t) => {
  const fixture = indexedJournal([record()]);
  const { journal, accepted, indexes, batches } = fixture;
  t.after(() => journal.close());
  const index = journal.getHistoryIndex();
  assert.ok(index);
  assert.equal(index.hasThinkingChange(), false);
  journal.append({ commitId: "thinking", committedAt: TIME, changes: [{ type: "conversation_node", node: {
    id: "thinking", parentId: "node", createdAt: TIME, nodeType: "thinking_change", level: "high",
  } }, { type: "head", branchId: "main", nodeId: "thinking" }] });
  journal.append({ commitId: "name", committedAt: TIME, changes: [{ type: "session_name", name: "acknowledged" }] });
  const before = journal.inspectState((state) => structuredClone(state));
  const durable = structuredClone(accepted);
  const bytes = journal.bytes;
  const update = index.update.bind(index);
  const interrupted = t.mock.method(index, "update", (commits: Iterable<SessionHistoryIndexCommit>) => {
    update((function* () {
      for (const commit of commits) {
        yield commit;
        throw new Error("interrupted after applied metadata");
      }
    })());
  });
  assert.throws(() => journal.getHistoryIndex(), /interrupted after applied metadata/u);
  interrupted.mock.restore();
  assert.equal(journal.getHistoryIndex(false), undefined);
  assert.equal(index.hasThinkingChange(), false);
  assert.equal(index.getNode("thinking"), undefined);
  assert.equal(index.getNode("node")?.ordinal, 0);
  assert.deepEqual(journal.inspectState((state) => state), before);
  assert.deepEqual(accepted, durable);
  assert.equal(journal.bytes, bytes);
  assert.deepEqual(batches[1]?.map((commit) => commit.sequence), [2]);

  journal.append({ commitId: "after-failure", committedAt: TIME, changes: [{ type: "session_name", name: "still writable" }] });
  const rebuilt = journal.getHistoryIndex();
  assert.ok(rebuilt);
  assert.notEqual(rebuilt, index);
  assert.equal(indexes.length, 2);
  assert.deepEqual(batches[2]?.map((commit) => commit.sequence), [1, 2, 3, 4]);
  assert.equal(rebuilt.getNode("thinking")?.ordinal, 1);
  assert.equal(rebuilt.getNode("thinking")?.nearestThinkingId, "thinking");
  assert.equal(rebuilt.hasThinkingChange(), true);
  journal.append({ commitId: "reset", committedAt: TIME, changes: [{ type: "head", branchId: "main", nodeId: null }] });
  assert.equal(journal.getHistoryIndex(), rebuilt);
  assert.deepEqual(batches[3]?.map((commit) => commit.sequence), [5]);
  assert.equal(rebuilt.hasThinkingChange(), true, "thinking presence covers the whole journal, not only its current head");

  const reopened = new SessionStorageJournal({
    path: "/index-fixture", readOnly: true,
    read: () => ({ header: HEADER, commits: structuredClone(accepted) }),
    append: () => { throw new Error("read-only fixture"); }, close: () => {},
  });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.inspectState((state) => state), journal.inspectState((state) => state));
  assert.equal(reopened.getHistoryIndex(), undefined);
});
