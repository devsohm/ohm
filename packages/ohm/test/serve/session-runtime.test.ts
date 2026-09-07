import assert from "node:assert/strict";
import test from "node:test";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { createServeSessionRuntime } from "../../src/serve/session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";

async function createSession() {
  return AgentSession.create({
    workspace: process.cwd(),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory(),
    providers: new ProviderRegistry([]),
    tools: [],
  });
}

test("serve session adapter reads live detached history and defaults to session-owned cleanup", async (t) => {
  const session = await createSession();
  t.after(() => session.close());
  const runtime = createServeSessionRuntime(() => session);
  assert.equal(runtime.sessionId, session.sessionId);
  assert.equal(runtime.start, undefined, "the adapter does not invent host startup");
  assert.equal(runtime.summary.messageCount, 0);
  assert.equal(runtime.summary.toolCount, session.state.tools.length);
  assert.equal(runtime.suspendedRun, undefined);
  assert.deepEqual(await runtime.recoverInterruptedRun(), { recovered: false, blocked: [] });
  session.nativeSessionManager.appendMessage({ id: "adapter-user", role: "user",
    content: [{ type: "text", text: "saved message" }], createdAt: new Date(0).toISOString() });
  const page = runtime.getEntriesPage!(0, 1);
  assert.equal(runtime.summary.messageCount, 1);
  assert.equal(page.totalEntries, 1);
  assert.equal(page.leafId, page.entries[0]!.id);
  session.nativeSessionManager.appendLabelChange(page.leafId!, "bookmark");
  assert.ok(runtime.getEntriesPage!(0, 1).revision > page.revision);
  page.entries[0]!.id = "changed snapshot";
  assert.notEqual(runtime.getEntriesPage!(0, 1).entries[0]!.id, "changed snapshot");
  assert.equal(runtime.inspect!().sessionId, session.sessionId);
  assert.deepEqual(runtime.listPortablePresentations!(), []);
  assert.deepEqual(runtime.listPluginWireServices!(), []);
  await runtime.abort("idle caller cancellation");
  await runtime.close();
  await runtime.close();
  await assert.rejects(runtime.prompt("closed"), /closed/u);
});

test("serve adapter preserves explicit lifecycle ownership, arguments and failures", async (t) => {
  const session = await createSession();
  t.after(() => session.close());
  const failure = new Error("host lifecycle failure");
  const signal = new AbortController().signal;
  const lifecycle = {
    calls: 0,
    async start(received: AbortSignal) {
      this.calls += 1;
      assert.equal(received, signal);
      throw failure;
    },
    async recoverInterruptedRun(options?: Parameters<AgentSession["recoverInterruptedRun"]>[0]) {
      this.calls += 1;
      assert.equal(options?.signal, signal);
      throw failure;
    },
    async close() { this.calls += 1; throw failure; },
  };
  const runtime = createServeSessionRuntime(() => session, lifecycle);
  await assert.rejects(runtime.start!(signal), (error) => error === failure);
  await assert.rejects(runtime.recoverInterruptedRun({ signal }), (error) => error === failure);
  await assert.rejects(runtime.close(), (error) => error === failure);
  assert.equal(lifecycle.calls, 3);
  assert.equal(session.sessionId, runtime.sessionId);
});
