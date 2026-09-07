import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { isJsonObject, type JsonObject } from "../../src/core/json.js";
import type { RuntimeInlinePlugin } from "../../src/plugins/runtime.js";
import { RpcRuntimeDispatcher, type RpcRuntimeDispatcherOptions } from "../../src/interfaces/rpc-runtime.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import { providerFromAdapter } from "../../src/providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { AgentSessionRuntime, createAgentSession, SessionManager } from "../../src/sdk/index.js";
import { createAgentSessionRuntimeCommandActions } from "../../src/service/runtime-command-actions.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function fixture(context: TestContext, extensions: RuntimeInlinePlugin[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-mode-command-"));
  const agentDir = join(cwd, ".agent");
  const provider = createScriptedProvider({
    id: "command-fixture",
    models: [{ id: "model", contextTokens: 10_000 }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "abcdefghijklmnopqrstuvwx", fragments: [..."abcdefghijklmnopqrstuvwx"] }],
      eventDelayMs: 1,
    }],
  });
  const models = createModels();
  models.setProvider(providerFromAdapter(provider, {
    initialModels: provider.models.map((model) => ({
      ...model,
      compatibility: {
        protocolFamily: { value: "openai-chat-completions", source: "configuration", observedAt: "2026-01-01T00:00:00.000Z" },
      },
    })),
    auth: { apiKey: { name: "Fixture", async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; } } },
  }));
  const modelRuntime = await ModelRuntime.create({ models, modelsPath: null, allowModelNetwork: false });
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel(provider.id, "model");
  assert.ok(model);
  const settings = SettingsManager.inMemory({ compaction: { reserveTokens: 200, recentTokens: 200 } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    pluginFactories: extensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.refresh();
  const manager = SessionManager.inMemory(cwd);
  const { session, pluginsResult } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    noTools: "all",
  });
  const runtime = new AgentSessionRuntime(session, { cwd, agentDir }, async () => {
    throw new Error("This fixture must not replace its session");
  });
  context.after(async () => {
    await runtime.dispose();
    await modelRuntime.close();
    await rm(cwd, { recursive: true, force: true });
  });
  assert.deepEqual(pluginsResult.errors, []);
  return { session, runtime, provider, manager };
}

test("SDK fork-before resolves one entry without projecting the whole journal", async (context) => {
  const value = await fixture(context, [{ name: "fork-before", factory(api) {
    api.registerCommand("fork-before", { async handler(entryId, command) {
      assert.deepEqual(await command.fork(entryId, { position: "before" }), { cancelled: true });
    } });
  } }]);
  const append = (text: string) => value.manager.appendMessage({
    id: text, role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z",
  });
  const parent = append("first");
  const target = append("second");
  const forks: string[] = [];
  let projections = 0;
  const getEntries = value.manager.getEntries.bind(value.manager);
  value.session.createBranchedSession = (entryId) => { forks.push(entryId); return undefined; };
  value.manager.getEntries = () => { projections += 1; return getEntries(); };
  await value.session.prompt(`/fork-before ${target}`);
  assert.deepEqual(forks, [parent]);
  assert.equal(projections, 0, "Single-entry fork must not project the whole journal");
});

for (const mode of ["sdk", "rpc"] as const) {
  test(`${mode} registered commands run during compaction without admitting model input`, { timeout: 5_000 }, async (context) => {
    const entered = deferred();
    const release = deferred();
    const calls: string[] = [];
    const input: string[] = [];
    let compactionSignal: AbortSignal | undefined;
    const value = await fixture(context, [{
      name: "compaction-commands",
      factory(api) {
        api.on("session_before_compact", async (event) => {
          compactionSignal = event.signal;
          entered.resolve();
          await release.promise;
          return { cancel: true };
        });
        api.on("input", (event) => { input.push(event.text); return { action: "continue" }; });
        api.registerCommand("status", { handler(args, command) {
          assert.equal(command.isIdle(), false);
          calls.push(args);
        } });
        api.registerCommand("forward", { handler() { return "must not enter the model"; } });
        api.registerCommand("stop-compaction", { handler(_args, command) { calls.push("cancel"); command.abort(); } });
      },
    }]);
    const outputs: Array<Parameters<RpcRuntimeDispatcherOptions["output"]>[0]> = [];
    const bind = async (): Promise<void> => await value.session.bindPlugins({
      mode,
      commandContextActions: createAgentSessionRuntimeCommandActions(value.runtime, value.session),
      abortHandler: () => value.session.abortCompaction(),
    });
    const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(event) { outputs.push(event); }, bindSession: bind });
    if (mode === "rpc") await dispatcher.start();
    else await bind();
    for (let turn = 0; turn < 4; turn += 1) {
      value.manager.appendMessage({
        id: `user-${turn}`,
        role: "user",
        content: [{ type: "text", text: `question ${"x".repeat(400)}` }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      value.manager.appendMessage({
        id: `assistant-${turn}`,
        role: "assistant",
        content: [{ type: "text", text: `answer ${"y".repeat(400)}` }],
        createdAt: "2026-01-01T00:00:00.000Z",
        provider: value.provider.id,
        api: "openai-chat-completions",
        model: "model",
        stopReason: "stop",
      });
    }
    const compacting = value.session.compact().then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );
    try {
      await entered.promise;
      const entriesBefore = value.manager.getEntryCount();
      const inputBefore = [...input];
      if (mode === "rpc") {
        assert.equal(await dispatcher.dispatch({ type: "prompt", id: "status", message: "/status working" }), undefined);
        assert.deepEqual(outputs.find((event) => event.type === "response" && event.id === "status"), {
          type: "response", id: "status", command: "prompt", success: true,
        });
        await dispatcher.dispatch({ type: "prompt", id: "ordinary", message: "ordinary input" });
        assert.equal(outputs.some((event) => event.type === "response" && event.id === "ordinary" && !event.success), true);
      } else {
        const admitted: boolean[] = [];
        assert.deepEqual(await value.session.prompt("/status working", { preflightResult: (succeeded) => { admitted.push(succeeded); } }), {
          sessionId: value.session.sessionId, results: [],
        });
        assert.deepEqual(admitted, [true]);
      }
      assert.deepEqual(calls, ["working"]);
      for (const message of ["ordinary input", "/unknown", "/forward"]) {
        await assert.rejects(value.session.prompt(message), /must be idle/u);
      }
      await assert.rejects(value.session.prompt("/status literal", { expandPromptTemplates: false }), /must be idle/u);
      await assert.rejects(value.session.compact(), /already in progress/u);
      assert.throws(() => value.session.newSession(), /must be idle/u);
      assert.deepEqual(input, inputBefore);
      assert.equal(value.manager.getEntryCount(), entriesBefore);
      assert.equal(value.provider.callCount, 0);
      assert.equal(compactionSignal?.aborted, false);
      if (mode === "rpc") {
        await dispatcher.dispatch({ type: "prompt", id: "cancel", message: "/stop-compaction" });
        assert.deepEqual(outputs.find((event) => event.type === "response" && event.id === "cancel"), {
          type: "response", id: "cancel", command: "prompt", success: true,
        });
      } else await value.session.prompt("/stop-compaction");
      assert.deepEqual(calls, ["working", "cancel"]);
      assert.equal(compactionSignal?.aborted, true);
    } finally {
      release.resolve();
      const outcome = await compacting;
      assert.ok("error" in outcome, JSON.stringify(outcome));
      assert.match(outcome.error.message, /Compaction cancelled/u);
      await dispatcher.close();
    }
    assert.equal(value.session.isCompacting, false);
    assert.equal(value.provider.callCount, 0);
    assert.equal(value.manager.getEntries().some((entry) => entry.type === "compaction"), false);
  });
}

test("public JSON mode cancels a real provider run after its output writer fails", async (context) => {
  const value = await fixture(context);
  let updates = 0;
  value.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") updates += 1;
  });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items) => { errors.push(items.join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "json",
      initialMessage: "stream",
      async write(text) {
        if (text.includes('"type":"text_delta"')) throw new Error("output disconnected");
      },
    }), 1);
  } finally {
    console.error = original;
  }
  assert.equal(updates, 1);
  assert.equal(value.provider.callCount, 1);
  assert.deepEqual(errors, ["output disconnected"]);
});

for (const cancelled of [false, true]) {
  test(`manual compaction completion releases prompt admission before listeners (cancelled=${cancelled})`, { timeout: 5_000 }, async (context) => {
    const value = await fixture(context, [(api) => {
      api.on("session_before_compact", (event) => cancelled ? { cancel: true } : {
        compaction: {
          summary: "Earlier exchange summarized",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      });
    }]);
    for (let index = 0; index < 6; index += 1) {
      value.manager.appendMessage({
        id: `compaction-history-${index}`,
        role: "user", content: [{ type: "text", text: `earlier ${index} ${"x".repeat(800)}` }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }
    let idleAtCompletion = false;
    let continued = false;
    let continuationError: Error | undefined;
    let completions = 0;
    value.session.subscribe(async (event) => {
      if (event.type !== "compaction_end" || event.reason !== "manual") return;
      completions += 1;
      idleAtCompletion = value.session.isIdle;
      try {
        await value.session.prompt("Continue after compaction");
        continued = true;
      } catch (error) {
        continuationError = error instanceof Error ? error : new Error("Unexpected continuation failure");
      }
    });
    if (cancelled) await assert.rejects(value.session.compact(), /cancel/iu);
    else await value.session.compact();
    assert.equal(completions, 1);
    assert.equal(idleAtCompletion, true);
    assert.equal(continuationError, undefined);
    assert.equal(continued, true);
    assert.equal(value.session.isIdle, true);
  });
}

for (const mode of ["json", "rpc"] as const) {
  test(`${mode} projects a real session stream without removing SDK snapshots`, async (context) => {
    const value = await fixture(context);
    let sdkSnapshots = 0;
    value.session.subscribe((event) => {
      if (event.type === "message_update" && "partial" in event.assistantMessageEvent) sdkSnapshots += 1;
    });
    const records: JsonObject[] = [];
    const record = (text: string): void => {
      const parsed: unknown = JSON.parse(text);
      assert.ok(isJsonObject(parsed));
      records.push(parsed);
    };
    if (mode === "json") {
      assert.equal(await runPrintMode(value.runtime, { mode, initialMessage: "stream", write: record }), 0);
    } else {
      const dispatcher = new RpcRuntimeDispatcher({
        runtime: value.runtime,
        output: (event) => record(JSON.stringify(event)),
        bindSession: async (session) => await session.bindPlugins({ mode }),
      });
      await dispatcher.start();
      try {
        await dispatcher.dispatch({ type: "prompt", id: "stream", message: "stream" });
        await value.session.waitForIdle();
      }
      finally { await dispatcher.close(); }
    }
    const updates = records.filter((event) => event.type === "message_update");
    assert.ok(sdkSnapshots > 0);
    assert.equal(updates.length, sdkSnapshots);
    let text = "";
    for (const event of updates) {
      assert.equal(event.streamVersion, 1);
      assert.equal("message" in event, false);
      assert.ok(isJsonObject(event.assistantMessageEvent));
      assert.equal("partial" in event.assistantMessageEvent, false);
      if (event.assistantMessageEvent.type === "text_delta") text += event.assistantMessageEvent.delta;
    }
    assert.equal(text, "abcdefghijklmnopqrstuvwx");
  });
}
