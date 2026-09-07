import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { optionalProperties } from "../../src/core/optional-properties.js";
import type { SessionEntry } from "../../src/plugins/session-contract.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { startServeServer, type ServeServer, type ServeSessionRuntime } from "../../src/serve/server.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const TOKEN = "history-fixture-token-0123456789abcdef";
const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const PAGE_VALUE = Type.Object({
  entries: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: true })),
  totalEntries: Type.Number(), leafId: Type.Union([Type.String(), Type.Null()]),
  sequenceStart: Type.Number(), nextSequence: Type.Number(), hasMore: Type.Boolean(),
  snapshot: Type.String(), eventCursor: Type.Number(), streamId: Type.String(),
}, { additionalProperties: true });

async function readPage(response: Response) {
  assert.equal(response.status, 200);
  return Value.Parse(PAGE_VALUE, await response.json());
}

function entry(id: string, parentId: string | null, text = id): SessionEntry {
  return { type: "message", id, parentId, timestamp: "2026-09-05T00:00:00.000Z", message: {
    role: "user", content: text, timestamp: 0,
  } };
}

function fixture() {
  const entries = [entry("one", null), entry("two", "one"), entry("three", "two")];
  const listeners = new Set<Parameters<ServeSessionRuntime["onEvent"]>[0]>();
  const reads: Array<[number, number]> = [];
  const state = { revision: 0 };
  const runtime = {
    sessionId: "history-fixture",
    summary: { thinkingLevel: "off", isStreaming: false, isCompacting: false, isRetrying: false,
      pendingMessageCount: 0, messageCount: entries.length, toolCount: 0, hasSuspendedRun: false },
    suspendedRun: undefined,
    onEvent(listener: Parameters<ServeSessionRuntime["onEvent"]>[0]) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getEntriesPage(offset: number, limit: number) {
      reads.push([offset, limit]);
      return { entries: entries.slice(offset, offset + limit), totalEntries: entries.length,
        leafId: entries.at(-1)?.id ?? null, revision: state.revision };
    },
    async prompt() {},
    async recoverInterruptedRun() { return { recovered: false, blocked: [] }; },
    async abort() {},
    async close() {},
  } satisfies ServeSessionRuntime;
  return { runtime, entries, reads, listeners, state };
}

test("serve history pages recover entries after an SSE replay gap", async (t) => {
  const { runtime, listeners, reads } = fixture();
  const server = await startServeServer({ token: TOKEN, maxReplayEvents: 1, sessionFactory: {
    async create() { return runtime; }, async open() { return runtime; },
  } });
  t.after(async () => await server.close());
  await fetch(`${server.origin}/v1/sessions`, { method: "POST", headers: HEADERS, body: "{}" });
  for (const sequence of [1, 2]) {
    for (const listener of listeners) await listener({ eventId: `event-${sequence}`, threadId: runtime.sessionId,
      runId: "run", sequence, timestamp: "2026-09-05T00:00:00.000Z", schemaVersion: 1,
      event: { type: "run_state", state: "streaming" } });
  }
  const replay = await fetch(`${server.origin}/v1/sessions/${runtime.sessionId}/events`, {
    headers: { ...HEADERS, "last-event-id": "0" },
  });
  assert.ok(replay.body);
  const reader = replay.body.getReader();
  let replayText = "";
  while (!replayText.includes("id: 2\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    replayText += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  assert.match(replayText, /event: replay_gap/u);
  const response = await fetch(`${server.origin}/v1/sessions/${runtime.sessionId}/entries?limit=1`, { headers: HEADERS });
  const page = await readPage(response);
  assert.deepEqual(page.entries, [entry("one", null)]);
  assert.equal(page.nextSequence, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.eventCursor, 2);
  assert.match(page.snapshot, /^[a-f0-9]{64}$/u);
  const next = await fetch(`${server.origin}/v1/sessions/${runtime.sessionId}/entries?afterSequence=1&snapshot=${page.snapshot}`, { headers: HEADERS });
  const remaining = await readPage(next);
  assert.deepEqual(remaining.entries.map((value) => value.id), ["two", "three"]);
  assert.equal(remaining.hasMore, false);
  assert.equal(remaining.nextSequence, 3);
  assert.ok(reads.every(([, limit]) => limit === 1), "projection is read incrementally within the byte budget");
});

test("serve history rejects invalid queries, changed snapshots, and old runtime incarnations", async (t) => {
  const { runtime, entries, state, reads } = fixture();
  const server = await startServeServer({ token: TOKEN, sessionFactory: {
    async create() { return runtime; }, async open() { return runtime; },
  } });
  t.after(async () => await server.close());
  const base = `${server.origin}/v1/sessions`;
  await fetch(base, { method: "POST", headers: HEADERS, body: "{}" });
  const url = `${base}/${runtime.sessionId}/entries`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(reads.length, 0, "authentication precedes history reads");
  assert.equal((await fetch(url, { method: "POST", headers: HEADERS })).status, 405);
  for (const query of ["limit=0", "limit=501", "limit=1&limit=2", "afterSequence=-1", "afterSequence=1.5",
    "afterSequence=9007199254740992", "afterSequence=1", "snapshot=bad", "unknown=1"]) {
    assert.equal((await fetch(`${url}?${query}`, { headers: HEADERS })).status, 400, query);
  }
  const initial = await readPage(await fetch(`${url}?limit=1`, { headers: HEADERS }));
  assert.equal((await fetch(`${url}?afterSequence=4&snapshot=${initial.snapshot}`, { headers: HEADERS })).status, 400);
  entries.push(entry("four", "three"));
  assert.equal((await fetch(`${url}?afterSequence=1&snapshot=${initial.snapshot}`, { headers: HEADERS })).status, 409);
  const appended = await readPage(await fetch(`${url}?limit=1`, { headers: HEADERS }));
  state.revision += 1;
  assert.equal((await fetch(`${url}?afterSequence=1&snapshot=${appended.snapshot}`, { headers: HEADERS })).status, 409);
  const current = await readPage(await fetch(`${url}?limit=1`, { headers: HEADERS }));
  await fetch(`${base}/${runtime.sessionId}`, { method: "DELETE", headers: HEADERS });
  await fetch(`${base}/open`, { method: "POST", headers: HEADERS, body: JSON.stringify({ sessionId: runtime.sessionId }) });
  assert.equal((await fetch(`${url}?afterSequence=1&snapshot=${current.snapshot}`, { headers: HEADERS })).status, 409);
  const reopened = await readPage(await fetch(url, { headers: HEADERS }));
  assert.equal(reopened.entries.length, 4);
  assert.equal(reopened.eventCursor, 0);
  assert.notEqual(reopened.snapshot, current.snapshot);
});

test("serve fences reconnect cursors to the runtime that issued them", async (t) => {
  const { runtime, listeners } = fixture();
  const server = await startServeServer({ token: TOKEN, sessionFactory: {
    async create() { return runtime; }, async open() { return runtime; },
  } });
  t.after(async () => await server.close());
  const base = `${server.origin}/v1/sessions`;
  const sessionUrl = `${base}/${runtime.sessionId}`;
  await fetch(base, { method: "POST", headers: HEADERS, body: "{}" });
  const emit = async (sequence: number) => {
    for (const listener of listeners) await listener({ eventId: `event-${sequence}`, threadId: runtime.sessionId,
      runId: "run", sequence, timestamp: "2026-09-05T00:00:00.000Z", schemaVersion: 1,
      event: { type: "run_state", state: "streaming" } });
  };
  const connect = (cursor: number, streamId?: string) => fetch(`${sessionUrl}/events`, {
    headers: { ...HEADERS, "last-event-id": String(cursor),
      ...optionalProperties(streamId === undefined ? undefined : { "x-ohm-stream-id": streamId }) },
    signal: AbortSignal.timeout(5_000),
  });
  await emit(1);
  const initial = await connect(1);
  const streamId = initial.headers.get("x-ohm-stream-id");
  await initial.body?.cancel();
  // An unknown identity must fail before replay, even when its numeric cursor exists.
  const wrong = await connect(1, "00000000-0000-4000-8000-000000000000");
  await wrong.body?.cancel();
  assert.equal(wrong.status, 409);
  assert.ok(streamId);
  const history = await fetch(`${sessionUrl}/entries`, { headers: HEADERS });
  const identity = Value.Parse(Type.Object({ streamId: Type.String() }, { additionalProperties: true }), await history.json());
  assert.equal(identity.streamId, streamId);
  const matching = await connect(1, streamId);
  await matching.body?.cancel();
  assert.equal(matching.status, 200);
  const unauthorized = await fetch(`${sessionUrl}/events`, { headers: { "x-ohm-stream-id": "invalid" } });
  assert.equal(unauthorized.status, 401, "authentication precedes cursor validation");
  for (const invalid of ["", "not-an-identity", `${streamId}, ${streamId}`]) {
    const response = await connect(1, invalid);
    await response.body?.cancel();
    assert.equal(response.status, 400);
  }

  await fetch(sessionUrl, { method: "DELETE", headers: HEADERS });
  await fetch(`${base}/open`, { method: "POST", headers: HEADERS, body: JSON.stringify({ sessionId: runtime.sessionId }) });
  await emit(1);
  await emit(2);
  const stale = await connect(1, streamId);
  await stale.body?.cancel();
  assert.equal(stale.status, 409, "a coincidentally valid cursor cannot cross a close/reopen boundary");
  const restarted = await connect(0);
  assert.notEqual(restarted.headers.get("x-ohm-stream-id"), streamId);
  assert.ok(restarted.body);
  const reader = restarted.body.getReader();
  let replay = "";
  const decoder = new TextDecoder();
  while (!replay.includes("id: 2\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    replay += decoder.decode(chunk.value, { stream: true });
    assert.ok(replay.length < 4_096);
  }
  await reader.cancel();
  assert.match(replay, /id: 1\n/u);
  assert.match(replay, /id: 2\n/u);
});

test("serve history respects the serialized response bound without truncating entries", async (t) => {
  const { runtime, entries, reads } = fixture();
  const server = await startServeServer({ token: TOKEN, sessionFactory: {
    async create() { return runtime; }, async open() { return runtime; },
  } });
  t.after(async () => await server.close());
  await fetch(`${server.origin}/v1/sessions`, { method: "POST", headers: HEADERS, body: "{}" });
  const url = `${server.origin}/v1/sessions/${runtime.sessionId}/entries`;
  const large = "x".repeat(1200 * 1024);
  entries.splice(0, entries.length, entry("one", null, large), entry("two", "one", large), entry("three", "two"));
  const response = await fetch(url, { headers: HEADERS });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) < 2 * 1024 * 1024);
  const page = Value.Parse(PAGE_VALUE, JSON.parse(text));
  assert.deepEqual(page.entries, [entries[0]]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(reads, [[0, 1], [1, 1]], "does not materialize later entries after the budget is exhausted");
  const next = await readPage(await fetch(`${url}?afterSequence=1&snapshot=${page.snapshot}`, { headers: HEADERS }));
  assert.deepEqual(next.entries, entries.slice(1));
  entries.splice(0, entries.length, entry("small", null), entry("large", "small", "x".repeat(2 * 1024 * 1024)));
  const beforeLarge = await readPage(await fetch(url, { headers: HEADERS }));
  assert.deepEqual(beforeLarge.entries, [entries[0]]);
  assert.equal(beforeLarge.hasMore, true);
  assert.equal((await fetch(`${url}?afterSequence=1&snapshot=${beforeLarge.snapshot}`, { headers: HEADERS })).status, 413);
  entries.splice(0, entries.length, entry("oversized", null, "x".repeat(2 * 1024 * 1024)));
  assert.equal((await fetch(url, { headers: HEADERS })).status, 413);
  entries.splice(0, entries.length, entry("escaped", null, "\0".repeat(400_000)));
  assert.equal((await fetch(url, { headers: HEADERS })).status, 413, "serialized escaping counts toward the bound");
  entries.splice(0, entries.length, { type: "custom", id: "complex", parentId: null,
    timestamp: "2026-09-05T00:00:00.000Z", customType: "history.complex", data: Array.from({ length: 10_001 }, () => 0) });
  assert.equal((await fetch(url, { headers: HEADERS })).status, 413, "complexity is rejected instead of redactor truncation");
  defaultSecretRedactor.register("Zq9!");
  entries.splice(0, entries.length, entry("redaction-expansion", null, "Zq9!".repeat(230_000)));
  assert.equal((await fetch(url, { headers: HEADERS })).status, 413, "redaction expansion cannot exceed the response cap");
});

test("serve history handles empty and unavailable history and rejects inconsistent runtime pages", async (t) => {
  const { runtime, entries, state } = fixture();
  const server = await startServeServer({ token: TOKEN, sessionFactory: {
    async create() { return runtime; }, async open() { return runtime; },
  } });
  t.after(async () => await server.close());
  await fetch(`${server.origin}/v1/sessions`, { method: "POST", headers: HEADERS, body: "{}" });
  const url = `${server.origin}/v1/sessions/${runtime.sessionId}/entries`;
  const original = runtime.getEntriesPage;
  const optional: ServeSessionRuntime = runtime;
  delete optional.getEntriesPage;
  assert.equal((await fetch(url, { headers: HEADERS })).status, 501);
  runtime.getEntriesPage = (offset, limit) => ({ ...original(offset, limit), totalEntries: -1 });
  assert.equal((await fetch(url, { headers: HEADERS })).status, 500);
  runtime.getEntriesPage = (offset, limit) => ({ ...original(offset, limit), entries: [] });
  assert.equal((await fetch(url, { headers: HEADERS })).status, 500);
  runtime.getEntriesPage = (offset, limit) => {
    if (offset === 1) state.revision += 1;
    return original(offset, limit);
  };
  assert.equal((await fetch(url, { headers: HEADERS })).status, 409);
  runtime.getEntriesPage = (offset, limit) => {
    runtime.sessionId = "changed-during-read";
    return original(offset, limit);
  };
  assert.equal((await fetch(url, { headers: HEADERS })).status, 409);
  assert.equal((await fetch(url, { headers: HEADERS })).status, 409);
  runtime.sessionId = "history-fixture";
  runtime.getEntriesPage = original;
  entries.splice(0);
  const empty = await readPage(await fetch(url, { headers: HEADERS }));
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.totalEntries, 0);
  assert.equal(empty.leafId, null);
  assert.equal(empty.sequenceStart, 0);
  assert.equal(empty.hasMore, false);
});

test("serve history reopens durable SQLite entries without exposing private provider state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-http-history-"));
  let manager: SessionManager | undefined;
  let server: ServeServer | undefined;
  t.after(async () => {
    await server?.close();
    manager?.closeV4Store();
    await rm(root, { recursive: true, force: true });
  });
  manager = SessionManager.create(root, join(root, "sessions"), { id: "durable-history" });
  const userId = manager.appendMessage({ id: "user-message", role: "user", content: [{ type: "text", text: "durable question" }], createdAt: "2026-09-05T00:00:00.000Z" });
  const secret = "history-fixture-registered-secret";
  defaultSecretRedactor.register(secret);
  manager.appendMessage({ id: "assistant-message", role: "assistant", content: [
    { type: "thinking", thinking: "hidden-provider-trace", visibility: "provider_trace" },
    { type: "thinking", thinking: "visible reasoning", thinkingSignature: "opaque-thinking-signature" },
    { type: "text", text: `durable answer ${secret}`, textSignature: "opaque-text-signature" },
    { type: "tool_call", callId: "call", name: "read", arguments: {
      providerState: "user-defined argument", [secret]: "secret-bearing key", api_key: "local-key-value",
    }, thoughtSignature: "opaque-tool-signature" },
  ], providerState: { kind: "openai_responses", outputItems: [{ private: "opaque-provider-data" }] },
  createdAt: "2026-09-05T00:00:01.000Z", stopReason: "stop" });
  const path = manager.getSessionFile();
  assert.ok(path);
  manager.closeV4Store();
  let current: AgentSession | undefined;
  const open = async (): Promise<ServeSessionRuntime> => {
    const session = await AgentSession.create({ sessionManager: SessionManager.open(path),
      providers: new ProviderRegistry([]), settingsManager: SettingsManager.inMemory(), tools: [] });
    current = session;
    return { ...fixture().runtime, sessionId: session.sessionId,
      onEvent: (listener) => session.onEvent(listener),
      getEntriesPage(offset, limit) {
        return { ...session.sessionManager.getEntriesPage(offset, limit), leafId: session.sessionManager.getLeafId(),
          revision: session.nativeSessionManager.getTreeRevision() };
      },
      async close() { await session.close(); },
    };
  };
  server = await startServeServer({ token: TOKEN, sessionFactory: { create: open, open } });
  const base = `${server.origin}/v1/sessions`;
  const openSession = async () => await fetch(`${base}/open`, {
    method: "POST", headers: HEADERS, body: JSON.stringify({ sessionId: "durable-history" }),
  });
  assert.equal((await openSession()).status, 200);
  const url = `${base}/durable-history/entries`;
  const first = await readPage(await fetch(`${url}?limit=1`, { headers: HEADERS }));
  assert.deepEqual(first.entries.map((value) => value.id), [userId]);
  const full = await readPage(await fetch(url, { headers: HEADERS }));
  assert.equal(full.totalEntries, 2);
  assert.match(JSON.stringify(full.entries), /durable answer \[REDACTED\]/u);
  assert.match(JSON.stringify(full.entries), /visible reasoning|user-defined argument/u);
  assert.doesNotMatch(JSON.stringify(full), /hidden-provider-trace|opaque-provider-data|history-fixture-registered-secret|local-key-value|secret-bearing key|opaque-(?:thinking|text|tool)-signature/u);
  assert.ok(current);
  const stored = JSON.stringify(current.nativeSessionManager.getEntries());
  assert.match(stored, /hidden-provider-trace/u);
  assert.match(stored, /opaque-provider-data/u);
  assert.match(stored, /opaque-thinking-signature/u);
  assert.match(stored, /history-fixture-registered-secret/u);
  assert.match(stored, /local-key-value/u);
  current.nativeSessionManager.branch(userId);
  assert.equal((await fetch(`${url}?afterSequence=1&snapshot=${first.snapshot}`, { headers: HEADERS })).status, 409);
  const branched = await readPage(await fetch(url, { headers: HEADERS }));
  await fetch(`${base}/durable-history`, { method: "DELETE", headers: HEADERS });
  assert.equal((await openSession()).status, 200);
  assert.equal((await fetch(`${url}?afterSequence=1&snapshot=${branched.snapshot}`, { headers: HEADERS })).status, 409);
  const reopened = await readPage(await fetch(url, { headers: HEADERS }));
  assert.deepEqual(reopened.entries, full.entries);
  assert.equal(reopened.leafId, userId);
});
