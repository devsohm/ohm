import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { optionalProperties } from "../../src/core/optional-properties.js";
import { getPluginRuntimeHost } from "../../src/plugins/compat.js";
import { HEADLESS_PLUGIN_UI_CAPABILITIES, loadDirectPlugins } from "../../src/plugins/runtime.js";
import { InteractiveMode } from "../../src/modes/interactive-mode.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, createAgentSession, createAgentSessionRuntime, SessionManager } from "../../src/sdk/index.js";
import { createRichTuiController } from "../../src/tui/rich-frame-projector.js";
import type { TuiInput, TuiOutput } from "../../src/tui/types.js";

async function fixture(context: TestContext, suppliedLoader = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-host-binding-"));
  const agentDir = join(cwd, ".agent");
  const extensionPath = join(cwd, "lifecycle.mjs");
  const logPath = join(cwd, "lifecycle.log");
  await writeFile(logPath, "");
  await writeFile(extensionPath, `
    import { appendFile } from "node:fs/promises";
    const log = (text) => appendFile(${JSON.stringify(logPath)}, text + "\\n");
    export default async function(api) {
      await log("factory");
      for (const kind of ["worker", "session", "rich-tui"]) {
        await api.facets.register({ apiVersion: 1, name: kind, kind, async setup(facet) {
          await log("facet-start:" + kind + ":" + facet.mode);
          if (kind === "rich-tui") facet.session.ui.setWidget("facet-probe", ["facet-ui-ready"]);
          return async () => await log("facet-stop:" + kind + ":" + facet.mode);
        }});
      }
      api.on("session_start", async (event, ctx) => {
        await log("start:" + ctx.mode + ":" + event.reason);
        if (ctx.mode === "tui") ctx.ui.setStatus("legacy-probe", "legacy-ui-ready");
      });
      api.on("session_shutdown", async (event, ctx) => await log("stop:" + ctx.mode + ":" + event.reason));
    }
  `);
  const settingsManager = SettingsManager.inMemory({ extensions: [extensionPath] }, { projectTrusted: true });
  const modelRuntime = await ModelRuntime.create({ models: createModels(), modelsPath: null, allowModelNetwork: false });
  const loader = suppliedLoader ? new DefaultResourceLoader({ cwd, agentDir, settingsManager }) : undefined;
  await loader?.refresh();
  const runtime = await createAgentSessionRuntime(async (options) => ({
    ...await createAgentSession({
      ...options,
      modelRuntime,
      settingsManager,
      ...optionalProperties(loader === undefined ? undefined : { resourceLoader: loader }),
    }),
    services: { cwd, agentDir },
  }), { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  context.after(async () => {
    await runtime.dispose();
    if (loader !== undefined) await getPluginRuntimeHost(loader.getPlugins().runtime)?.close();
    await modelRuntime.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { runtime, extensionPath, async records() { return (await readFile(logPath, "utf8")).trim().split("\n"); } };
}

test("default SDK to print balances host lifecycle without reloading extension files", async (context) => {
  const value = await fixture(context);
  await writeFile(value.extensionPath, "throw new Error('host attachment must not reload extension files');\n");
  assert.equal(await runPrintMode(value.runtime, { mode: "text", write() {} }), 0);
  const records = await value.records();
  assert.deepEqual(records.filter((entry) => entry.startsWith("start:") || entry.startsWith("stop:")), [
    "start:sdk:startup", "stop:sdk:refresh", "start:print:refresh", "stop:print:quit",
  ]);
  assert.equal(records.filter((entry) => entry === "factory").length, 1);
  assert.equal(records.filter((entry) => entry === "facet-start:worker:worker").length, 1);
  assert.equal(records.filter((entry) => entry === "facet-stop:worker:worker").length, 1);
});

class FixtureInput extends PassThrough implements TuiInput {
  isTTY = true;
  isRaw = false;
  setRawMode(enabled: boolean): this { this.isRaw = enabled; return this; }
}

class FixtureOutput extends PassThrough implements TuiOutput {
  columns = 100;
  rows = 30;
  isTTY = true;
}

test("SDK to interactive and a detached TUI reattach initialize UI while preserving worker facets", async (context) => {
  const value = await fixture(context);
  const output = new FixtureOutput();
  let screen = "";
  output.on("data", (chunk: Buffer) => { screen += chunk.toString(); });
  let terminal = createRichTuiController({ input: new FixtureInput(), output, mode: "full", handleSignals: false });
  let mode = new InteractiveMode(value.runtime, { terminal });
  try {
    await mode.init();
    terminal.renderNow();
    const records = await value.records();
    assert.deepEqual(records.filter((entry) => entry.startsWith("start:") || entry.startsWith("stop:")), [
      "start:sdk:startup", "stop:sdk:refresh", "start:tui:refresh",
    ]);
    assert.equal(records.filter((entry) => entry === "facet-start:worker:worker").length, 1);
    assert.equal(records.includes("facet-stop:worker:worker"), false);
    assert.equal(records.includes("facet-stop:session:sdk"), true);
    assert.equal(records.includes("facet-start:session:tui"), true);
    assert.equal(records.includes("facet-start:rich-tui:tui"), true);
    assert.match(screen, /legacy-ui-ready/u);
    assert.match(screen, /facet-ui-ready/u);
    mode.stop();
    screen = "";
    terminal = createRichTuiController({ input: new FixtureInput(), output, mode: "full", handleSignals: false });
    mode = new InteractiveMode(value.runtime, { terminal });
    await mode.init();
    terminal.renderNow();
    const reattached = await value.records();
    assert.deepEqual(reattached.filter((entry) => entry.startsWith("start:") || entry.startsWith("stop:")), [
      "start:sdk:startup", "stop:sdk:refresh", "start:tui:refresh", "stop:tui:refresh", "start:tui:refresh",
    ]);
    assert.equal(reattached.filter((entry) => entry === "facet-start:worker:worker").length, 1);
    assert.equal(reattached.filter((entry) => entry === "facet-start:rich-tui:tui").length, 2);
    assert.match(screen, /legacy-ui-ready/u);
    assert.match(screen, /facet-ui-ready/u);
  } finally {
    await value.runtime.dispose();
    mode.stop();
  }
});

test("a supplied loader starts only when its first host binds", async (context) => {
  const value = await fixture(context, true);
  assert.equal((await value.records()).some((entry) => entry.startsWith("start:")), false);
  assert.equal(await runPrintMode(value.runtime, { mode: "text", write() {} }), 0);
  assert.deepEqual((await value.records()).filter((entry) => entry.startsWith("start:") || entry.startsWith("stop:")), [
    "start:print:startup", "stop:print:quit",
  ]);
});

test("a cancelled first host binding quarantines its unstarted generation", async (context) => {
  const value = await fixture(context, true);
  const session = value.runtime.session;
  const host = getPluginRuntimeHost(session.resourceLoader.getPlugins().runtime)!;
  await assert.rejects(
    session.bindPlugins({ mode: "sdk" }, AbortSignal.abort(new Error("first binding cancelled"))),
    /first binding cancelled/u,
  );
  assert.equal(host.lifecycleSignal().aborted, true);
  assert.equal((await value.records()).some((entry) => entry.startsWith("start:")), false);
  assert.throws(() => session.pluginRunner, /generation did not finish starting/u);
  const quarantined = await value.records();
  assert.equal(quarantined.filter((entry) => entry === "facet-start:worker:worker").length, 1);
  assert.equal(quarantined.filter((entry) => entry === "facet-stop:worker:worker").length, 1);
  await value.runtime.dispose();
  await value.runtime.dispose();
  assert.deepEqual(await value.records(), quarantined);
});

test("same-mode rebinding is quiet but explicit refresh still restarts the session lifecycle", async (context) => {
  const value = await fixture(context);
  await value.runtime.session.bindPlugins({ mode: "sdk", abortHandler() {} });
  assert.equal((await value.records()).filter((entry) => entry.startsWith("start:")).length, 1);
  await value.runtime.session.pluginRunner?.emit({ type: "session_shutdown", reason: "refresh" });
  await value.runtime.session.bindPlugins({ reason: "refresh" });
  assert.deepEqual((await value.records()).filter((entry) => entry.startsWith("start:") || entry.startsWith("stop:")), [
    "start:sdk:startup", "stop:sdk:refresh", "start:sdk:refresh",
  ]);
});

for (const mode of ["tui", "rpc"] as const) test(`${mode} to SDK replaces departed host callbacks while same-mode updates retain them`, async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-host-transfer-"));
  const lifecycle: string[] = [];
  const calls: string[] = [];
  const host = await loadDirectPlugins([], { workspace: cwd, inlinePlugins: [{ name: "transfer", factory(api) {
    api.on("session_start", (_event, ctx) => { lifecycle.push(`start:${ctx.mode}:${ctx.ui.capabilities?.dialogs}`); });
    api.on("session_shutdown", (_event, ctx) => { lifecycle.push(`stop:${ctx.mode}`); });
  } }] });
  const session = await AgentSession.create({ sessionManager: SessionManager.inMemory(cwd), providers: new ProviderRegistry(), settingsManager: SettingsManager.inMemory(), pluginRunner: host });
  context.after(async () => { await session.close(); await host.close(); await rm(cwd, { recursive: true, force: true }); });
  const ownerAction = async () => { calls.push("owner"); return { cancelled: true }; };
  await session.bindPlugins({
    mode,
    uiContext: {
      ...session.pluginRunner.getUIContext(),
      capabilities: Object.freeze({ ...HEADLESS_PLUGIN_UI_CAPABILITIES, dialogs: true, notifications: true }),
      notify() { calls.push("notify"); },
    },
    abortHandler() { calls.push("abort"); },
    shutdownHandler() { calls.push("shutdown"); },
    commandContextActions: {
      async waitForIdle() { calls.push("wait"); },
      newSession: ownerAction,
      fork: ownerAction,
      navigateTree: ownerAction,
      switchSession: ownerAction,
      async refresh() { calls.push("refresh"); },
    },
  });
  await session.bindPlugins({ mode, onError() {} });
  const previous = session.pluginRunner.createCommandContext();
  previous.ui.notify("same host");
  previous.abort();
  previous.shutdown();
  await previous.waitForIdle();
  assert.deepEqual(await previous.newSession(), { cancelled: true });
  assert.deepEqual(calls, ["notify", "abort", "shutdown", "wait", "owner"]);

  await session.bindPlugins({ mode: "sdk" });
  assert.deepEqual(lifecycle, [`start:${mode}:true`, `stop:${mode}`, "start:sdk:false"]);
  const next = session.pluginRunner.createCommandContext();
  assert.equal(next.hasUI, false);
  assert.deepEqual(next.ui.capabilities, HEADLESS_PLUGIN_UI_CAPABILITIES);
  next.ui.notify("headless");
  next.abort();
  await next.waitForIdle();
  const previousSessionId = session.sessionId;
  assert.deepEqual(await next.newSession(), { cancelled: false });
  assert.notEqual(session.sessionId, previousSessionId);
  next.shutdown();
  await session.close();
  assert.deepEqual(calls, ["notify", "abort", "shutdown", "wait", "owner"]);
});

test("a rejected concurrent binder does not disable the active generation or block startup mutations", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-host-binding-concurrent-"));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let session!: AgentSession;
  let commands = 0;
  const host = await loadDirectPlugins([], { workspace: cwd, inlinePlugins: [{ name: "binding", factory(api) {
    api.registerCommand("probe", { handler() { commands += 1; } });
    api.on("session_start", async () => {
      entered();
      await gate;
      await session.prompt("/probe");
      await session.sendCustomMessage({ customType: "startup", content: "ready", display: false });
    });
  } }] });
  session = await AgentSession.create({ sessionManager: SessionManager.inMemory(cwd), providers: new ProviderRegistry(), settingsManager: SettingsManager.inMemory(), pluginRunner: host });
  context.after(async () => { release(); await session.close(); await host.close(); await rm(cwd, { recursive: true, force: true }); });
  const binding = session.bindPlugins({ mode: "sdk" });
  await started;
  try {
    await assert.rejects(session.bindPlugins({ mode: "rpc" }), /binding is already in progress/u);
    await assert.rejects(session.refresh(), /binding is already in progress/u);
  } finally {
    release();
    await binding;
  }
  await session.prompt("/probe");
  assert.equal(commands, 2);
  assert.equal(session.nativeSessionManager.getEntries().some((entry) => entry.type === "custom_message"), true);
});

test("host transfer rejects busy admission safely and fails closed when cancelled after shutdown", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-host-binding-admission-"));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const lifecycle: string[] = [];
  const host = await loadDirectPlugins([], { workspace: cwd, inlinePlugins: [{ name: "admission", factory(api) {
    api.registerCommand("hold", { async handler() { entered(); await gate; } });
    api.on("session_start", (_event, ctx) => { lifecycle.push(`start:${ctx.mode}`); });
    api.on("session_shutdown", (_event, ctx) => {
      lifecycle.push(`stop:${ctx.mode}`);
      controller.abort(new Error("handoff cancelled"));
    });
  } }] });
  const session = await AgentSession.create({ sessionManager: SessionManager.inMemory(cwd), providers: new ProviderRegistry(), settingsManager: SettingsManager.inMemory(), pluginRunner: host });
  context.after(async () => { release(); await session.close(); await host.close(); await rm(cwd, { recursive: true, force: true }); });
  await session.bindPlugins({ mode: "sdk" });
  const runner = session.pluginRunner;
  await assert.rejects(session.bindPlugins({ mode: "rpc" }, AbortSignal.abort(new Error("not attached"))), /not attached/u);
  assert.equal(session.pluginRunner, runner);
  const command = session.prompt("/hold");
  await started;
  try {
    await assert.rejects(session.bindPlugins({ mode: "rpc" }), /Session must be idle/u);
    assert.equal(session.pluginRunner, runner);
    assert.deepEqual(lifecycle, ["start:sdk"]);
  } finally {
    release();
    await command;
  }
  await assert.rejects(session.bindPlugins({ mode: "rpc" }, controller.signal), /handoff cancelled/u);
  assert.deepEqual(lifecycle, ["start:sdk", "stop:sdk"]);
  assert.throws(() => session.pluginRunner, /generation did not finish starting/u);
});

test("refresh staging and startup exclude concurrent refresh and public host attachment", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-host-binding-refresh-"));
  let entered!: () => void;
  let release!: () => void;
  let gate: Promise<void>;
  let blockStart = false;
  const lifecycle: string[] = [];
  const host = await loadDirectPlugins([], { workspace: cwd, inlinePlugins: [{ name: "refresh", factory(api) {
    api.on("session_start", async (event, ctx) => {
      lifecycle.push(`start:${ctx.mode}:${event.reason}`);
      if (event.reason === "refresh" && blockStart) { entered(); await gate; }
    });
    api.on("session_shutdown", (event, ctx) => { lifecycle.push(`stop:${ctx.mode}:${event.reason}`); });
  } }] });
  const session = await AgentSession.create({ sessionManager: SessionManager.inMemory(cwd), providers: new ProviderRegistry(), settingsManager: SettingsManager.inMemory(), pluginRunner: host });
  context.after(async () => { release(); await session.close(); await host.close(); await rm(cwd, { recursive: true, force: true }); });
  await session.bindPlugins({ mode: "sdk" });
  const runner = session.pluginRunner;
  for (const phase of ["staging", "startup"]) {
    blockStart = phase === "startup";
    const started = new Promise<void>((resolve) => { entered = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    const refreshing = session.refresh({ beforeSessionStart: async () => {
      if (!blockStart) { entered(); await gate; }
    } });
    await started;
    try {
      await assert.rejects(session.bindPlugins({ mode: "rpc" }), /already in progress/u);
      await assert.rejects(session.refresh(), /already in progress/u);
    } finally {
      release();
      await refreshing;
    }
    assert.equal(session.pluginRunner, runner);
  }
  assert.deepEqual(lifecycle, ["start:sdk:startup", "stop:sdk:refresh", "start:sdk:refresh", "stop:sdk:refresh", "start:sdk:refresh"]);
});
