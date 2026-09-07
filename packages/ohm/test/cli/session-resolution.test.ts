import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { resolveSessionFile, resolveSessionTarget } from "../../src/cli/session-resolution.js";
import { SessionManager } from "../../src/storage/session-manager.js";

test("explicit SQLite basenames resolve without discovery or changing the session", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-session-resolution-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd, cwd);
  const path = manager.getSessionFile();
  assert.ok(path);
  assert.ok(path.endsWith(".sqlite"));
  manager.closeV4Store();
  const before = await readFile(path);
  const files = await readdir(cwd);
  const input = { cwd, reference: basename(path), sessionDirectory: join(cwd, "undiscovered") };

  assert.deepEqual(await resolveSessionTarget(input), { type: "path", path });
  assert.equal((await resolveSessionFile(input)).path, path);
  assert.deepEqual(await readFile(path), before);
  const after = await readdir(cwd);
  assert.deepEqual(after.filter((file) => !file.endsWith("-wal") && !file.endsWith("-shm")), files);
});
