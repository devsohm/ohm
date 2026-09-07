import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { access, link, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  deleteSessionFile,
  recoverableDeleteCommand,
} from "../../src/modes/session-file-deletion.js";
import type { CommandResult, ProcessRunner } from "../../src/process/types.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { acquireSessionWriterLeaseSync } from "../../src/storage/session-writer-lease.js";

function result(exitCode: number): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
  };
}

test("recoverable session deletion uses the native platform helper", () => {
  assert.deepEqual(recoverableDeleteCommand("/tmp/session.jsonl", "linux"), {
    argv: ["gio", "trash", "/tmp/session.jsonl"],
  });

  const macos = recoverableDeleteCommand("/tmp/session.jsonl", "darwin");
  assert.deepEqual(macos?.argv.slice(0, 2), ["/usr/bin/osascript", "-e"]);
  assert.deepEqual(macos?.argv.slice(-2), ["--", "/tmp/session.jsonl"]);
  assert.equal(macos?.argv.slice(0, -1).some((part) => part.includes("/tmp/session.jsonl")), false);

  const windows = recoverableDeleteCommand("C:\\sessions\\session.jsonl", "win32");
  assert.deepEqual(windows?.argv.slice(0, 5), [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
  ]);
  assert.equal(windows?.argv.at(-2), "-");
  assert.equal(windows?.argv.at(-1), "C:\\sessions\\session.jsonl");
  assert.equal(windows?.argv.slice(0, -1).some((part) => part.includes("C:\\sessions\\session.jsonl")), false);
  assert.match(windows?.stdin ?? "", /SendToRecycleBin/u);
  assert.doesNotMatch(windows?.stdin ?? "", /C:\\sessions\\session\.jsonl/u);

  assert.equal(recoverableDeleteCommand("/tmp/session.jsonl", "freebsd"), undefined);
});

test("successful native deletion reports trash without permanent fallback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-delete-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "session.jsonl");
  await writeFile(path, "{}\n");
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(spec) {
      calls.push(spec.argv);
      assert.throws(() => acquireSessionWriterLeaseSync(path), /active writer/u);
      await rm(path);
      return result(0);
    },
  };

  assert.equal(await deleteSessionFile(path, {
    cwd: root,
    processRunner: runner,
    platform: "linux",
  }), "trash");
  assert.deepEqual(calls, [["gio", "trash", path]]);
  await assert.rejects(access(path));
  assert.equal(existsSync(`${path}.writer-lock`), false);
});

test("failed or unavailable native deletion falls back to permanent removal", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-delete-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const failedPath = join(root, "failed.jsonl");
  const unavailablePath = join(root, "unavailable.jsonl");
  await writeFile(failedPath, "{}\n");
  await writeFile(unavailablePath, "{}\n");

  assert.equal(await deleteSessionFile(failedPath, {
    cwd: root,
    processRunner: { async run() { return result(1); } },
    platform: "linux",
  }), "permanent");
  assert.equal(await deleteSessionFile(unavailablePath, {
    cwd: root,
    processRunner: { async run() { throw new Error("gio not found"); } },
    platform: "linux",
  }), "permanent");
  await assert.rejects(access(failedPath));
  await assert.rejects(access(unavailablePath));
});

test("session deletion fails closed for active writers and their hard-link aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-delete-active-"));
  const manager = SessionManager.create(root, root, { id: "active" });
  const path = manager.getSessionFile()!;
  const alias = join(root, "active-alias.jsonl");
  try {
    await link(path, alias);
    const runner: ProcessRunner = {
      async run() {
        assert.fail("the recycle helper must not run without writer ownership");
      },
    };
    const options = { cwd: root, processRunner: runner, platform: "freebsd" as const };

    await assert.rejects(deleteSessionFile(path, options), /active writer/u);
    await assert.rejects(deleteSessionFile(alias, options), /multiple hard links/u);
    await access(path);
    await access(alias);
    assert.equal(existsSync(`${alias}.writer-lock`), false);
  } finally {
    manager.closeV4Store();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite recycling checkpoints committed WAL records before moving the main file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-delete-wal-"));
  let manager: SessionManager | undefined;
  let database: DatabaseSync | undefined;
  context.after(async () => {
    if (database?.isOpen) database.close();
    manager?.closeV4Store();
    await rm(root, { recursive: true, force: true });
  });
  manager = SessionManager.create(root, root, { id: "saved" });
  const path = manager.getSessionFile()!;
  const db = new DatabaseSync(path);
  database = db;
  manager.closeV4Store();
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  const commit = { record: "commit", sequence: 1, commitId: "wal-name", committedAt: new Date().toISOString(), changes: [{ type: "session_name", name: "from WAL" }] };
  db.prepare("INSERT INTO session_commits VALUES (?, ?, ?)").run(1, commit.commitId, JSON.stringify(commit));
  assert.equal(existsSync(path + "-wal"), true);
  assert.ok(statSync(path + "-wal").size > 0);
  const recycled = join(root, "recycled.sqlite");
  try {
    assert.equal(await deleteSessionFile(path, {
      cwd: root, platform: "linux", processRunner: { async run() {
        assert.throws(() => acquireSessionWriterLeaseSync(path), /active writer/u);
        assert.equal(statSync(path + "-wal").size, 0);
        db.close();
        await rename(path, recycled);
        return result(0);
      } },
    }), "trash");
    assert.equal(SessionManager.openSnapshot(recycled).getSessionName(), "from WAL");
  } finally { if (db.isOpen) db.close(); }
});

test("SQLite recycling fails closed when a reader prevents a complete WAL checkpoint", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-delete-reader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root, { id: "saved" });
  const path = manager.getSessionFile()!;
  manager.closeV4Store();
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL;");
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM session_header").all();
  writer.prepare("INSERT INTO session_commits VALUES (?, ?, ?)").run(1, "wal-name", JSON.stringify({ record: "commit", sequence: 1, commitId: "wal-name", committedAt: new Date().toISOString(), changes: [{ type: "session_name", name: "retained" }] }));
  try {
    await assert.rejects(deleteSessionFile(path, { cwd: root, processRunner: { async run() { assert.fail("must not move an uncheckpointed session"); } } }), /active database reader/u);
    assert.equal(existsSync(path), true);
  } finally { reader.close(); writer.close(); }
  assert.equal(SessionManager.openSnapshot(path).getSessionName(), "retained");
});
