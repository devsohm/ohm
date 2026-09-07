import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { readSessionV4FileSync } from "@ohm/kernel/session-v4";
import { SqliteSessionStorageBackend } from "../../src/storage/sqlite-session-storage.js";
import { exportSessionFile } from "../../src/storage/session-export.js";
import { acquireSessionWriterLeaseSync } from "../../src/storage/session-writer-lease.js";
import {
  SessionManager,
} from "../../src/storage/index.js";

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "ohm-session-backend-"));
  const previous = process.env.OHM_HOME;
  process.env.OHM_HOME = join(root, "home");
  t.after(() => {
    if (previous === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function append(manager: SessionManager, text: string): string {
  return manager.appendMessage({
    id: `message-${manager.getEntryCount()}`, role: "user",
    createdAt: new Date().toISOString(), content: [{ type: "text", text }],
  });
}

for (const length of [256, 320]) {
  test(`SQLite preserves file identity and WAL writes at a ${length}-character path`, (t) => {
    const root = fixture(t);
    const prefix = join(root, "nested # %", "a".repeat(64));
    const filename = "long-path.sqlite";
    const padding = length - prefix.length - filename.length - 2;
    assert.ok(padding > 0 && padding <= 255, "Fixture must cross the path boundary without exceeding a directory component limit");
    const directory = join(prefix, "b".repeat(padding));
    const path = join(directory, filename);
    assert.equal(path.length, length);
    let manager: SessionManager | undefined;
    let reader: SessionManager | undefined;
    try {
      manager = SessionManager.create(root, directory, { id: "long-path" });
      append(manager, "committed through WAL");
      assert.equal(manager.getSessionFile(), path);
      assert.equal(existsSync(`${path}-wal`), true);
      reader = SessionManager.open(path, undefined, undefined, { readOnly: true });
      assert.equal(reader.getEntryCount(), 1);
      assert.equal(reader.getSessionFile(), path);
      reader.closeV4Store();
      reader = undefined;
      manager.closeV4Store();
      manager = undefined;
      manager = SessionManager.open(path);
      append(manager, "continued after reopen");
      assert.equal(manager.getEntryCount(), 2);
      assert.equal(manager.getSessionFile(), path);
    } finally {
      try { reader?.closeV4Store(); }
      finally { manager?.closeV4Store(); }
    }
  });
}

  test(`SQLite: append/reopen preserves V4 recovery, idempotency and detached snapshots`, (t) => {
    const root = fixture(t);
    const manager = SessionManager.create(root, join(root, "sessions"), { id: "source" });
    const location = manager.getSessionFile()!;
    const first = append(manager, "original");
    const at = new Date().toISOString();
    manager.commitChanges([{ type: "session_name", name: "named" }], "name-change", at);
    manager.commitChanges([{ type: "session_name", name: "named" }], "name-change", at);
    assert.throws(() => manager.commitChanges([{ type: "session_name", name: "wrong" }], "name-change", at));
    manager.commitChanges([{
      type: "run_accepted", branchId: "main", operationId: "operation", promptNodeId: "pending-prompt",
      sourceHeadId: first, acceptedAt: at, request: { prompt: "recover" },
      selection: { provider: "fixture", model: "fixture", api: null, thinkingLevel: "off", toolNames: [], toolsetFingerprint: "empty" },
    }]);
    manager.commitChanges([{
      type: "queue_added", branchId: "main", entryId: "queued", targetNodeId: "future", kind: "follow_up", addedAt: at, message: { prompt: "later" },
    }]);
    const before = manager.getV4State();
    before.nodes.clear();
    assert.equal(manager.getEntryCount(), 1);
    assert.throws(() => SessionManager.open(location), /writer|open|lock/iu);
    manager.closeV4Store();
    manager.closeV4Store();
    assert.equal(manager.getSessionFile(), location);
    const reopened = SessionManager.open(location);
    assert.equal(reopened.getSessionName(), "named");
    assert.equal(reopened.getEntryCount(), 1);
    assert.equal(reopened.getV4RecoverySnapshot().openOperation?.id, "operation");
    assert.deepEqual(reopened.getV4RecoverySnapshot().queue.map((entry) => entry.id), ["queued"]);
    reopened.closeV4Store();
  });

  test(`SQLite: read-only captures never write/create and are independent of later commits`, (t) => {
    const root = fixture(t);
    const manager = SessionManager.create(root, join(root, "sessions"), { id: "readonly" });
    const first = append(manager, "first");
    const location = manager.getSessionFile()!;
    const reader = SessionManager.open(location, undefined, undefined, { readOnly: true });
    append(manager, "second");
    assert.equal(reader.getEntryCount(), 1);
    assert.equal(reader.getEntry(first)?.type, "message");
    assert.throws(() => append(reader, "denied"), /read.only/iu);
    assert.throws(() => reader.newSession(), /read.only/iu);
    reader.closeV4Store();
    manager.closeV4Store();
    const missing = join(root, "sessions", "missing.sqlite");
    assert.throws(() => SessionManager.open(missing, undefined, undefined, { readOnly: true }));
    assert.equal(existsSync(missing), false);
  });

  test(`SQLite: fork/new/branch/switch retain backend and preserve source`, (t) => {
    const root = fixture(t);
    const backend = new SqliteSessionStorageBackend(join(root, "sessions"));
    const source = SessionManager.create(root, join(root, "sessions"), { id: "fork-source" });
    const first = append(source, "first");
    append(source, "second");
    source.appendSessionInfo("original");
    source.appendLabelChange(first, "anchor");
    const sourceLocation = source.getSessionFile()!;
    const fork = SessionManager.forkFrom(sourceLocation, root, join(root, "sessions"), { id: "fork-target" });
    assert.equal(fork.getSessionName(), "original");
    assert.equal(fork.getLabel(first), "anchor");
    assert.equal(fork.getEntryCount(), 2);
    const forkLocation = fork.getSessionFile()!;
    fork.createBranchedSession(first);
    assert.equal(fork.getEntryCount(), 1);
    const branchLocation = fork.getSessionFile()!;
    assert.notEqual(branchLocation, forkLocation);
    fork.setSessionFile(forkLocation);
    assert.equal(fork.getEntryCount(), 2);
    fork.newSession({ id: "fresh" });
    assert.equal(fork.getEntryCount(), 0);
    assert.equal(fork.isPersisted(), true);
    fork.closeV4Store();
    assert.equal(source.getEntryCount(), 2);
    source.closeV4Store();
    const branch = SessionManager.open(branchLocation);
    assert.equal(branch.getEntryCount(), 1);
    branch.closeV4Store();
    backend.remove(branchLocation, statSync(branchLocation, { bigint: true }));
    assert.throws(() => SessionManager.open(branchLocation));
  });

  test(`SQLite: invalid transitions do not mutate storage, active writers cannot be removed`, (t) => {
    const root = fixture(t);
    const backend = new SqliteSessionStorageBackend(join(root, "sessions"));
    const manager = SessionManager.create(root, join(root, "sessions"), { id: "atomic" });
    const location = manager.getSessionFile()!;
    const before = manager.getTreeRevision();
    assert.throws(() => manager.commitChanges([{ type: "head", branchId: "main", nodeId: "absent" }]));
    assert.equal(manager.getTreeRevision(), before);
    append(manager, "still writable");
    assert.throws(() => backend.remove(location, statSync(location, { bigint: true })), /writer|lock/iu);
    manager.closeV4Store();
    const reopened = SessionManager.open(location);
    assert.equal(reopened.getEntryCount(), 1);
    reopened.closeV4Store();
  });
test("SQLite files are private and read-only opening does not change database bytes", (t) => {
  const root = fixture(t);
  const manager = SessionManager.create(root, join(root, "sessions"));
  append(manager, "private");
  const path = manager.getSessionFile()!;
  manager.closeV4Store();
  const before = readFileSync(path);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const snapshot = SessionManager.open(path, undefined, undefined, { readOnly: true });
  snapshot.closeV4Store();
  assert.deepEqual(readFileSync(path), before);
});

test("SQLite aborts a failed insert transaction and can reopen after rollback", (t) => {
  const root = fixture(t);
  const manager = SessionManager.create(root, join(root, "sessions"));
  const path = manager.getSessionFile()!;
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON session_commits BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END;");
  assert.throws(() => append(manager, "not committed"), /fixture insert failure/);
  assert.equal(manager.getEntryCount(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_commits").get()?.count, 0);
  db.exec("DROP TRIGGER fail_append");
  db.close();
  manager.closeV4Store();
  const reopened = SessionManager.open(path);
  append(reopened, "committed after reopen");
  assert.equal(reopened.getEntryCount(), 1);
  reopened.closeV4Store();
});

test("SQLite staged batches are atomic and retain every journal identity", (t) => {
  const root = fixture(t);
  const source = SessionManager.inMemory(root, { id: "staged-batch" });
  source.appendSessionInfo("first");
  source.appendSessionInfo("second");
  const state = source.getV4State();
  const commits = [...state.commits.values()];
  const storage = new SqliteSessionStorageBackend(root).create(state.header);
  const path = storage.path;
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => storage.appendBatch([commits[0]!, { ...commits[1]!, sequence: 99 }]), /sequence conflict/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_commits").get()?.count, 0);
    storage.appendBatch(commits);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_commits").get()?.count, commits.length);
  } finally { db.close(); storage.close(); source.closeV4Store(); }
  const reopened = SessionManager.open(path);
  try { assert.deepEqual(reopened.getV4State(), state); }
  finally { reopened.closeV4Store(); }
});


function legacy(root: string, id = "legacy") {
  const source = SessionManager.inMemory(root, { id });
  append(source, "original");
  const state = source.getV4State();
  const path = join(root, id + ".jsonl");
  const bytes = Buffer.from([state.header, ...state.commits.values()].map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(path, bytes);
  return { path, bytes, state };
}

test("explicit legacy resume preserves every original byte and reuses its matching SQLite copy", async (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const first = SessionManager.open(source.path);
  const path = first.getSessionFile()!;
  assert.match(path, /\.sqlite$/u);
  assert.deepEqual(first.getV4State(), source.state);
  append(first, "continued");
  first.closeV4Store();
  const again = SessionManager.open(source.path);
  assert.equal(again.getSessionFile(), path);
  assert.equal(again.getEntryCount(), 2);
  again.closeV4Store();
  assert.deepEqual(readFileSync(source.path), source.bytes);
  assert.deepEqual((await SessionManager.list(root, root)).map((entry) => entry.path), [path]);
});

test("legacy listing and snapshots never create a durable copy", async (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const before = readdirSync(root);
  const snapshot = SessionManager.open(source.path, undefined, undefined, { readOnly: true });
  assert.equal(snapshot.getEntryCount(), 1);
  snapshot.closeV4Store();
  assert.deepEqual(readdirSync(root), before);
  assert.equal((await SessionManager.list(root, root)).length, 1);
  assert.equal(readdirSync(root).some((name) => name.endsWith(".sqlite")), false);
  assert.deepEqual(readFileSync(source.path), source.bytes);
});

test("divergent same-identity copies stay visible and explicit legacy resume rejects them", async (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const copy = SessionManager.create(root, root, { id: "legacy" });
  append(copy, "different");
  const copyPath = copy.getSessionFile()!;
  copy.closeV4Store();
  const copyBytes = readFileSync(copyPath);
  assert.throws(() => SessionManager.open(source.path), /conflicts/u);
  await assert.rejects(SessionManager.importJsonl(source.path, root), /EEXIST|already exists/u);
  assert.deepEqual(readFileSync(copyPath), copyBytes);
  const listing = await SessionManager.inspect(root, root);
  assert.equal(listing.sessions.length, 2);
  assert.equal(listing.invalid.length, 1);
  assert.deepEqual(readFileSync(source.path), source.bytes);
});

test("resume rejects an active legacy writer, while read-only inspection remains available", (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const lease = acquireSessionWriterLeaseSync(source.path);
  lease.bindToFile();
  try {
    assert.throws(() => SessionManager.open(source.path), /writer|lock/iu);
    assert.equal(SessionManager.openSnapshot(source.path).getEntries().length, 1);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".sqlite")), false);
  } finally { lease.release(); }
});

test("live WAL commits invalidate list metadata and HTML downloads contain JSONL, not database bytes", async (t) => {
  const root = fixture(t);
  const manager = SessionManager.create(root, join(root, "sessions"));
  t.after(() => manager.closeV4Store());
  append(manager, "first");
  assert.equal((await SessionManager.list(root, join(root, "sessions")))[0]?.messageCount, 1);
  append(manager, "second");
  const listing = await SessionManager.list(root, join(root, "sessions"));
  assert.equal(listing[0]?.messageCount, 2);
  const exported = exportSessionFile(manager.getSessionFile()!, join(root, "export.html"), { redact: false });
  const html = readFileSync(exported, "utf8");
  const encoded = html.match(/<script id="session-data" type="application\/octet-stream">([A-Za-z0-9+/=]+)<\/script>/u)?.[1];
  assert.ok(encoded);
  assert.ok(Buffer.from(encoded, "base64").toString("utf8").includes("second"));
  assert.equal(html.includes("SQLite format"), false);
});

test("aborted and malformed JSONL imports publish no candidate and preserve source", async (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const directory = join(root, "sessions");
  const abort = new AbortController();
  abort.abort(new Error("cancel import"));
  await assert.rejects(SessionManager.importJsonl(source.path, directory, { signal: abort.signal }), /cancel import/u);
  assert.equal(existsSync(directory), false);
  writeFileSync(source.path, Buffer.concat([source.bytes, Buffer.from("{broken}\n")]));
  const damaged = readFileSync(source.path);
  await assert.rejects(SessionManager.importJsonl(source.path, directory), /invalid session file/u);
  assert.equal(existsSync(directory), false);
  assert.deepEqual(readFileSync(source.path), damaged);
});

test("cancelling between durable import batches removes only the staged copy", async (t) => {
  const root = fixture(t);
  const source = SessionManager.inMemory(root, { id: "cancelled-import" });
  for (let index = 0; index < 129; index += 1) source.appendSessionInfo(`phase-${index}`);
  const state = source.getV4State();
  source.closeV4Store();
  const bytes = Buffer.from([state.header, ...state.commits.values()].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const path = join(root, "source.jsonl");
  writeFileSync(path, bytes);
  const directory = join(root, "sessions");
  const abort = new AbortController();
  const importing = SessionManager.importJsonl(path, directory, { signal: abort.signal });
  assert.ok(readdirSync(directory).some((name) => name.endsWith(".tmp")));
  abort.abort(new Error("cancel between batches"));
  await assert.rejects(importing, /cancel between batches/u);
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(readFileSync(path), bytes);
  const retry = await SessionManager.importJsonl(path, directory);
  try { assert.deepEqual(retry.getV4State(), state); }
  finally { retry.closeV4Store(); }
});

test("explicit JSONL import preserves the exact journal and no-save import stays memory-only", async (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const ephemeral = await SessionManager.importJsonl(source.path, "");
  assert.equal(ephemeral.isPersisted(), false);
  assert.equal(ephemeral.getSessionFile(), undefined);
  assert.deepEqual(ephemeral.getV4State(), source.state);
  const manager = await SessionManager.importJsonl(source.path, join(root, "sessions"));
  assert.deepEqual(manager.getV4State(), readSessionV4FileSync(source.path).state);
  manager.closeV4Store();
  assert.deepEqual(readFileSync(source.path), source.bytes);
});

test("no-save session switching copies saved history without modifying the database", (t) => {
  const root = fixture(t);
  const saved = SessionManager.create(root, join(root, "sessions"));
  append(saved, "saved history");
  const path = saved.getSessionFile()!;
  saved.closeV4Store();
  const bytes = readFileSync(path);
  const ephemeral = SessionManager.inMemory(root);
  ephemeral.setSessionFile(path);
  assert.equal(ephemeral.isPersisted(), false);
  assert.equal(ephemeral.getSessionFile(), undefined);
  assert.equal(ephemeral.getEntryCount(), 1);
  append(ephemeral, "memory only");
  assert.deepEqual(readFileSync(path), bytes);
});

for (const failedSync of process.platform === "win32" ? [0] : [1, 2]) {
test(`import publication preserves source across directory sync policy ${failedSync}`, (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const directory = join(root, "sessions");
  const module = new URL("../../src/storage/session-manager.ts", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.fsyncSync;
    let directorySyncs = 0;
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory() && ++directorySyncs === ${failedSync}) {
        throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
      }
      original(fd);
    };
    syncBuiltinESMExports();
    const { SessionManager } = await import(${JSON.stringify(module)});
    try {
      const imported = await SessionManager.importJsonl(process.argv[1], process.argv[2]);
      imported.closeV4Store();
      if (${failedSync} !== 0) process.exitCode = 1;
    } catch (error) {
      if (${failedSync} === 0 || !String(error).includes("injected publication failure")) throw error;
    }
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, source.path, directory]);
  if (failedSync === 0) {
    const reopened = SessionManager.open(join(directory, "legacy.sqlite"));
    try { assert.deepEqual(reopened.getV4State(), source.state); }
    finally { reopened.closeV4Store(); }
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  } else assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(readFileSync(source.path), source.bytes);
});
}

test("failed publication restores the staged name after removing its temporary hard link", (t) => {
  const root = fixture(t);
  const source = legacy(root);
  const backend = new SqliteSessionStorageBackend(join(root, "sessions"));
  const staging = backend.pathFor("staging");
  backend.create(source.state.header, staging).close();
  const before = readFileSync(staging);
  const failure = new Error("injected target open failure");
  const original = DatabaseSync.prototype.prepare;
  const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA application_id") throw failure;
    return original.call(this, sql);
  });
  try { assert.throws(() => backend.publish(staging, source.state.header.sessionId), (error) => error === failure); }
  finally { mocked.mock.restore(); }
  assert.deepEqual(readFileSync(staging), before);
  assert.equal(statSync(staging).nlink, 1);
  assert.equal(existsSync(backend.pathFor(source.state.header.sessionId)), false);
  const reopened = backend.open(staging);
  reopened.close();
});

for (const targetState of ["owned", "absent", "replaced"] as const) {
  test(`post-publication replay failure cleans only the owned SQLite target: ${targetState}`, async (t) => {
    const root = fixture(t);
    const source = legacy(root);
    const directory = join(root, "sessions");
    const target = new SqliteSessionStorageBackend(directory).pathFor(source.state.header.sessionId);
    const relocated = join(root, "relocated.sqlite");
    const expected = new Error("injected post-publication replay failure");
    const prepare = DatabaseSync.prototype.prepare;
    let replays = 0;
    let renameUnsupported = false;
    let sidecars: string[] = [];
    const mocked = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.endsWith("FROM session_commits ORDER BY sequence") && ++replays === 2) {
        assert.equal(existsSync(target), true, "The failure must occur after publication");
        assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
        if (targetState !== "owned") {
          sidecars = ["legacy.sqlite-shm", "legacy.sqlite-wal"].filter((name) => existsSync(join(directory, name)));
          try { renameSync(target, relocated); }
          catch (error) {
            if (process.platform !== "win32" || !(error instanceof Error) || !("code" in error)
              || !["EACCES", "EPERM", "EBUSY"].includes(String(error.code))) throw error;
            renameUnsupported = true;
            throw expected;
          }
        }
        if (targetState === "replaced") writeFileSync(target, "unrelated replacement", { flag: "wx" });
        throw expected;
      }
      return prepare.call(this, sql);
    });
    try {
      await assert.rejects(SessionManager.importJsonl(source.path, directory), (error) => error === expected);
    } finally { mocked.mock.restore(); }
    if (renameUnsupported) {
      t.skip("The filesystem cannot rename an open SQLite database");
      return;
    }
    assert.equal(replays, 2);
    assert.deepEqual(readFileSync(source.path), source.bytes);
    assert.deepEqual(readdirSync(directory).sort(), [...sidecars, ...(targetState === "replaced" ? ["legacy.sqlite"] : [])].sort());
    if (targetState === "replaced") assert.equal(readFileSync(target, "utf8"), "unrelated replacement");
    if (targetState !== "owned") assert.ok(statSync(relocated).isFile());
    if (targetState === "owned") {
      const retry = await SessionManager.importJsonl(source.path, directory);
      try { assert.deepEqual(retry.getV4State(), source.state); }
      finally { retry.closeV4Store(); }
    }
  });
}
