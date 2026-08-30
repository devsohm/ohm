import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { JsonValue } from "../../src/core/json.js";
import { loadIndexedSessionInfos } from "../../src/storage/session-catalog-index.js";
import type { SessionInfo } from "../../src/storage/types.js";

const INDEX_FILE = ".ohm-session-catalog-v1.json";
const PERSISTED_INDEX_VALUE = Type.Object({
  entries: Type.Array(Type.Object({ path: Type.String() }, { additionalProperties: true })),
}, { additionalProperties: true });

async function fixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-catalog-index-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function session(path: string, text: string): SessionInfo {
  return {
    path,
    id: text,
    cwd: "/workspace",
    created: new Date("2026-08-21T00:00:00.000Z"),
    modified: new Date("2026-08-21T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: text,
    allMessagesText: text,
  };
}

test("an empty session directory does not gain a catalog artifact", async (context) => {
  const root = await fixture(context);
  const result = await loadIndexedSessionInfos(root, [], async () => {
    throw new Error("empty catalogs must not load a journal");
  });

  assert.deepEqual(result, { sessions: [], invalid: [] });
  await assert.rejects(access(join(root, INDEX_FILE)), /ENOENT/u);
});

test("unchanged page and search scans reuse indexed projections without journal loads", async (context) => {
  const root = await fixture(context);
  const files = [join(root, "alpha.jsonl"), join(root, "bravo.jsonl"), join(root, "charlie.jsonl")];
  await Promise.all(files.map(async (path) => await writeFile(path, basename(path), { mode: 0o600 })));
  let loads = 0;
  const load = async (path: string): Promise<SessionInfo> => {
    loads += 1;
    return session(path, await readFile(path, "utf8"));
  };

  const first = await loadIndexedSessionInfos(root, files, load);
  assert.equal(loads, 3);
  assert.deepEqual(first.sessions.slice(0, 1).map((entry) => entry.id), ["alpha.jsonl"]);

  let parses = 0;
  let serializes = 0;
  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  const parseMock = context.mock.method(
    JSON,
    "parse",
    (...args: Parameters<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
      parses += 1;
      return originalParse(...args);
    },
  );
  const stringifyMock = context.mock.method(
    JSON,
    "stringify",
    (...args: Parameters<typeof JSON.stringify>): ReturnType<typeof JSON.stringify> => {
      serializes += 1;
      return originalStringify(...args);
    },
  );
  let second;
  try {
    second = await loadIndexedSessionInfos(root, files, load);
  } finally {
    stringifyMock.mock.restore();
    parseMock.mock.restore();
  }
  assert.equal(loads, 3, "a second page must reuse every unchanged projection");
  assert.equal(parses, 0, "an unchanged index must reuse its validated in-process snapshot");
  assert.equal(serializes, 0, "an identity-unchanged index must not be serialized again");
  assert.deepEqual(second.sessions.slice(1, 2).map((entry) => entry.id), ["bravo.jsonl"]);

  const searched = await loadIndexedSessionInfos(root, files, load);
  assert.equal(loads, 3, "a repeated query must not reread unchanged journals");
  assert.deepEqual(
    searched.sessions.filter((entry) => entry.allMessagesText.includes("charlie")).map((entry) => entry.id),
    ["charlie.jsonl"],
  );
});

test("cached projections preserve linked-session lineage metadata", async (context) => {
  const root = await fixture(context);
  const journal = join(root, "child.jsonl");
  await writeFile(journal, "child", { mode: 0o600 });
  let loads = 0;
  const load = async (path: string): Promise<SessionInfo> => {
    loads += 1;
    return {
      ...session(path, "child"),
      parentSessionPath: "parent-session",
      parentPurpose: "child-run",
    };
  };

  const first = await loadIndexedSessionInfos(root, [journal], load);
  const second = await loadIndexedSessionInfos(root, [journal], load);

  assert.equal(loads, 1);
  assert.equal(first.sessions[0]?.parentPurpose, "child-run");
  assert.equal(second.sessions[0]?.parentPurpose, "child-run");
  assert.equal(second.sessions[0]?.parentSessionPath, "parent-session");
});

test("an unchanged journal retries a transient load failure", async (context) => {
  const root = await fixture(context);
  const journal = join(root, "retry.jsonl");
  await writeFile(journal, "retry", { mode: 0o600 });
  let loads = 0;
  const load = async (path: string): Promise<SessionInfo> => {
    loads += 1;
    if (loads === 1) throw new Error("transient read failure");
    return session(path, await readFile(path, "utf8"));
  };

  const failed = await loadIndexedSessionInfos(root, [journal], load);
  assert.deepEqual(failed.sessions, []);
  assert.match(failed.invalid[0]?.error ?? "", /transient read failure/u);

  const recovered = await loadIndexedSessionInfos(root, [journal], load);
  assert.equal(loads, 2);
  assert.deepEqual(recovered.invalid, []);
  assert.deepEqual(recovered.sessions.map((entry) => entry.id), ["retry"]);
});

test("changed and new journals invalidate individually while deleted journals leave the snapshot", async (context) => {
  const root = await fixture(context);
  const alpha = join(root, "alpha.jsonl");
  const bravo = join(root, "bravo.jsonl");
  const charlie = join(root, "charlie.jsonl");
  await writeFile(alpha, "alpha", { mode: 0o600 });
  await writeFile(bravo, "bravo", { mode: 0o600 });
  let loads = 0;
  const load = async (path: string): Promise<SessionInfo> => {
    loads += 1;
    return session(path, await readFile(path, "utf8"));
  };

  await loadIndexedSessionInfos(root, [alpha, bravo], load);
  assert.equal(loads, 2);
  await unlink(alpha);
  await writeFile(bravo, "bravo-version-two", { mode: 0o600 });
  await writeFile(charlie, "charlie", { mode: 0o600 });

  const refreshed = await loadIndexedSessionInfos(root, [bravo, charlie], load);
  assert.equal(loads, 4, "only the changed and new journals should be loaded");
  assert.deepEqual(refreshed.sessions.map((entry) => entry.id), ["bravo-version-two", "charlie"]);
  const persisted: JsonValue = JSON.parse(await readFile(join(root, INDEX_FILE), "utf8"));
  assert.ok(Value.Check(PERSISTED_INDEX_VALUE, persisted));
  assert.deepEqual(persisted.entries.map((entry) => entry.path), [bravo, charlie]);

  await loadIndexedSessionInfos(root, [bravo, charlie], load);
  assert.equal(loads, 4);
});

test("corrupt and stale snapshots rebuild atomically with private permissions", async (context) => {
  const root = await fixture(context);
  const journal = join(root, "session.jsonl");
  const path = join(root, INDEX_FILE);
  await writeFile(journal, "session", { mode: 0o600 });
  let loads = 0;
  const load = async (file: string): Promise<SessionInfo> => {
    loads += 1;
    return session(file, await readFile(file, "utf8"));
  };

  await loadIndexedSessionInfos(root, [journal], load);
  assert.equal(loads, 1);
  await writeFile(path, "{broken\n", { mode: 0o600 });
  await loadIndexedSessionInfos(root, [journal], load);
  assert.equal(loads, 2, "a corrupt snapshot must rebuild from the journal");
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);

  await writeFile(path, `${JSON.stringify({ version: 0, scope: root, entries: [] })}\n`, { mode: 0o600 });
  await loadIndexedSessionInfos(root, [journal], load);
  assert.equal(loads, 3, "an unknown snapshot version must rebuild from the journal");
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});
