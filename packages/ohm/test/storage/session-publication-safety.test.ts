import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionManager } from "../../src/storage/session-manager.js";

test("import refuses to publish a staged database whose committed WAL is held by a reader", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ohm-import-reader-"));
  const previous = process.env.OHM_HOME;
  process.env.OHM_HOME = join(root, "home");
  t.after(() => {
    if (previous === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const source = SessionManager.inMemory(root, { id: "imported" });
  for (let index = 0; index < 129; index += 1) source.appendSessionInfo(`phase-${index}`);
  const state = source.getV4State();
  const path = join(root, "source.jsonl");
  const bytes = Buffer.from([state.header, ...state.commits.values()].map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(path, bytes);
  const directory = join(root, "sessions");
  const importing = SessionManager.importJsonl(path, directory);
  const staging = readdirSync(directory).find((name) => name.startsWith(".ohm-import-") && name.endsWith(".tmp"));
  assert.ok(staging);
  const reader = new DatabaseSync(join(directory, staging), { readOnly: true });
  reader.exec("BEGIN");
  assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM session_commits").get()?.count, 128);
  let candidate: SessionManager | undefined;
  let failure: unknown;
  try {
    try { candidate = await importing; }
    catch (error) { failure = error; }
    assert.ok(failure instanceof Error, `published ${candidate?.getV4State().sequence} of ${state.sequence} commits while its WAL was retained`);
    assert.equal(existsSync(join(directory, "imported.sqlite")), false);
    assert.deepEqual(readFileSync(path), bytes);
  } finally {
    reader.close();
    candidate?.closeV4Store();
  }
  const retry = await SessionManager.importJsonl(path, directory);
  try { assert.deepEqual(retry.getV4State(), state); }
  finally { retry.closeV4Store(); }
  assert.deepEqual(readFileSync(path), bytes);
});

test("import validates staged journal bytes before publishing its identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ohm-import-validation-"));
  const previous = process.env.OHM_HOME;
  process.env.OHM_HOME = join(root, "home");
  t.after(() => {
    if (previous === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const source = SessionManager.inMemory(root, { id: "invalid-staging" });
  for (let index = 0; index < 128; index += 1) source.appendSessionInfo(`phase-${index}`);
  const state = source.getV4State();
  source.closeV4Store();
  const bytes = Buffer.from([state.header, ...state.commits.values()].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const path = join(root, "source.jsonl");
  writeFileSync(path, bytes);
  const directory = join(root, "sessions");
  const importing = SessionManager.importJsonl(path, directory);
  const staging = readdirSync(directory).find((name) => name.endsWith(".tmp"));
  assert.ok(staging);
  const db = new DatabaseSync(join(directory, staging));
  try { db.exec("UPDATE session_commits SET record = '{invalid' WHERE sequence = 1"); }
  finally { db.close(); }
  await assert.rejects(importing, SyntaxError);
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(readFileSync(path), bytes);
});
