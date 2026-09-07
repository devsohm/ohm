import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@ohm/models";

import { loadRuntime } from "../../src/cli/runtime.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import type { PluginAPI, SessionStartEvent } from "../../src/plugins/direct.js";
import type {
  RuntimePluginHost,
  RuntimePluginListenerContext,
} from "../../src/plugins/runtime.js";
import { RpcPluginUiBridge } from "../../src/interfaces/rpc-plugin-ui.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";
import { AgentSession, type PluginBindings } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

declare global {
  var __ohmDirectApis: PluginAPI[] | undefined;
}

function extensionUiContext() {
  return new RpcPluginUiBridge({ emit() {} }).context(
    "runtime-direct-test",
    "runtime-direct-test",
    new AbortController().signal,
  );
}

test("interactive startup can hydrate model state without waiting for live discovery", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-deferred-model-refresh-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const networkModes: boolean[] = [];
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "deferred-model-refresh-probe",
      factory(api) {
        api.registerProvider("deferred-model-refresh-probe", {
          api: "openai-completions",
          apiKey: "local-test",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{
            id: "probe-model",
            name: "Cached probe model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 2_048,
          }],
          async refreshModels(refresh) {
            networkModes.push(refresh.allowNetwork);
            return [{
              id: "probe-model",
              name: "Probe model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_192,
              maxTokens: 2_048,
            }];
          },
        });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    deferModelNetworkRefresh: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.equal(networkModes.includes(true), false);
  assert.equal(runtime.modelRegistry.find("deferred-model-refresh-probe", "probe-model")?.id, "probe-model");
  await runtime.modelRegistry.refresh({ force: true, signal: runtime.generationSignal });
  assert.equal(networkModes.includes(true), true);
});

test("empty direct runtime starts and refreshes before provider lifecycle bindings become live", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-empty-direct-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.deepEqual(runtime.runtimePlugins.plugins(), []);
  const maintained = await runtime.session.resolveModel("gpt-5.6-sol", { provider: "openai" });
  assert.equal(maintained.api, "openai-responses");
  assert.equal(maintained.info?.contextTokens, 1_050_000);
  assert.deepEqual(maintained.info?.compatibility?.reasoningEfforts?.value, [
    "off", "low", "medium", "high", "xhigh", "max",
  ]);
  assert.deepEqual((await runtime.refresh()).warnings, []);
  assert.deepEqual(runtime.runtimePlugins.plugins(), []);
});

test("CLI-bound callback completion stays outside an enclosing provider lifecycle scope", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-callback-completion-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "callback-completion-scope-probe",
      factory(api) {
        api.on("session_start", async (event, extensionContext) => {
          if (event.reason !== "resume") return;
          const model = extensionContext.modelRegistry.getAll()[0];
          assert.ok(model !== undefined);
          await extensionContext.modelRegistry.complete(model, { messages: [] });
        });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  assert.ok(runtime.providerWireLifecycle instanceof ProviderWireInterceptorRegistry);
  const wire = runtime.providerWireLifecycle;
  let lifecycleCalls = 0;
  const unregister = wire.registerLifecycle({
    beforeRequest() { lifecycleCalls += 1; },
  });
  context.after(unregister);
  const modelRuntime = runtime.session.modelRuntime;
  const originalComplete = modelRuntime.complete;
  modelRuntime.complete = async (model, _modelContext, options): Promise<AssistantMessage> => {
    const fetch = wire.wrapFetch(model.provider, async () => new Response("{}"));
    const request: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    if (options?.signal !== undefined) request.signal = options.signal;
    await fetch("https://provider.example/v1/responses", request);
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {},
      stopReason: "stop",
      timestamp: 0,
    };
  };
  context.after(() => { modelRuntime.complete = originalComplete; });

  await wire.withScope({
    threadId: runtime.session.sessionId,
    runId: "callback-completion-scope",
    branch: "root",
    step: 0,
  }, async () => {
    await runtime.runtimePlugins.dispatch("session_start", {
      reason: "resume",
      threadId: runtime.session.sessionId,
    });
  });

  assert.equal(lifecycleCalls, 0);
});

test("CLI-bound extension tools retain the active run branch after journal advancement and refresh", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-tool-run-branch-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let providerCalls = 0;
  let toolCalls = 0;
  let policyCalls = 0;
  let shutdownCalls = 0;
  const runtime = await loadRuntime({
    workspace,
    agentDirectory: join(root, "agent"),
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "tool-run-branch-probe",
      factory(api) {
        api.on("tool_call", () => { policyCalls += 1; });
        api.registerCommand("branch-probe-shutdown", {
          async handler(_args, extensionContext) { extensionContext.shutdown(); },
        });
        api.registerTool({
          name: "branch_probe",
          description: "Return a host-computed test marker",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute(_callId, _input, _signal, _update, extensionContext) {
            assert.equal(extensionContext.isIdle(), false);
            toolCalls += 1;
            return { content: [{ type: "text", text: "branch marker" }], details: {} };
          },
        });
        api.registerProvider("tool-run-branch-probe", {
          api: "openai-chat-completions",
          apiKey: "local-test",
          baseUrl: "https://example.invalid/v1",
          models: [{
            id: "probe-model",
            name: "Probe model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 2_048,
          }],
          streamSimple(model) {
            providerCalls += 1;
            const callTool = providerCalls % 2 === 1;
            const reason = callTool ? "toolUse" : "stop";
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
              const message: AssistantMessage = {
                role: "assistant",
                content: callTool
                  ? [{ type: "toolCall", id: `probe-${providerCalls}`, name: "branch_probe", arguments: {} }]
                  : [{ type: "text", text: "complete" }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {},
                stopReason: reason,
                timestamp: 0,
              };
              stream.push({ type: "start", partial: { ...message, content: [] } });
              stream.push({ type: "done", reason, message });
            });
            return stream;
          },
        });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close());
  runtime.setPluginShutdownHandler(() => { shutdownCalls += 1; });
  await runtime.session.setModel(await runtime.session.resolveModel("probe-model", { provider: "tool-run-branch-probe" }));

  for (let run = 1; run <= 2; run += 1) {
    const sourceBranch = runtime.sessionManager.getLeafId();
    assert.ok(sourceBranch !== null);
    const result = await runtime.session.prompt("Call branch_probe", { allowedTools: ["branch_probe"], maxSteps: 2 });
    const toolResult = runtime.sessionManager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "tool"
        ? entry.message.content.filter((block) => block.type === "tool_result")
        : []).at(-1);
    assert.ok(toolResult !== undefined);
    assert.equal(toolResult.isError, false, toolResult.content);
    assert.equal(toolResult.content, "branch marker");
    assert.equal(toolCalls, run);
    assert.equal(policyCalls, run);
    assert.equal(providerCalls, run * 2);
    assert.equal(result.results.at(-1)?.finalText, "complete");
    assert.notEqual(runtime.sessionManager.getLeafId(), sourceBranch);
    await assert.rejects(runtime.runtimePlugins.reduceToolCall({
      threadId: runtime.session.sessionId,
      runId: "stale-run",
      branch: sourceBranch,
      callId: "stale-call",
      name: "branch_probe",
      input: {},
      index: 0,
    }), /only exposes the current branch/u);
    await runtime.session.prompt("/branch-probe-shutdown");
    assert.equal(shutdownCalls, run);
    if (run === 1) assert.deepEqual((await runtime.refresh()).warnings, []);
  }
});

test("inline extension factories are reactivated for each committed runtime generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-inline-extension-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  let activations = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "inline-generation-probe",
      factory(api) {
        activations += 1;
        api.registerCommand(`inline-generation-${activations}`, { async handler() {} });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.equal(activations, 1);
  assert.deepEqual(runtime.runtimePlugins.commands().map((entry) => entry.name), ["inline-generation-1"]);
  await runtime.refresh();
  assert.equal(activations, 2);
  assert.deepEqual(runtime.runtimePlugins.commands().map((entry) => entry.name), ["inline-generation-2"]);
});

test("persistent runtime refresh transfers ownership of the active session store", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-persistent-refresh-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    pluginCode: false,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const sessionId = runtime.session.sessionId;
  const sessionFile = runtime.sessionManager.getSessionFile();
  runtime.session.setModelScope(["fixture/one"]);
  runtime.sessionManager.appendCustomEntry("refresh-store", { phase: "before" });

  await runtime.refresh();
  assert.equal(runtime.session.sessionId, sessionId);
  assert.equal(runtime.sessionManager.getSessionFile(), sessionFile);
  assert.deepEqual(runtime.session.modelScopeOverride, ["fixture/one"]);
  runtime.sessionManager.appendCustomEntry("refresh-store", { phase: "after" });

  assert.deepEqual(
    runtime.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "refresh-store")
      .map((entry) => entry.type === "custom" ? entry.data : undefined),
    [{ phase: "before" }, { phase: "after" }],
  );
});

test("runtime refresh rejects a changed session directory without replacing the active writer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-session-directory-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const initialSessionDir = join(root, "sessions-before");
  const changedSessionDir = join(root, "sessions-after");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.json"), JSON.stringify({ sessionDir: initialSessionDir }));
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const lifecycle: string[] = [];
  let generation = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: false,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "refresh-session-directory-probe",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
        api.on("session_start", (event) => { lifecycle.push(`${current}:start:${event.reason}`); });
        api.onDispose(() => { lifecycle.push(`${current}:dispose`); });
        api.registerCommand(`refresh-session-directory-${current}`, { async handler() {} });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const activeSession = runtime.session;
  const activeGeneration = runtime.generationSignal;
  const activeExtensions = runtime.runtimePlugins;
  const sessionId = activeSession.sessionId;
  const sessionFile = runtime.sessionManager.getSessionFile();
  assert.ok(sessionFile !== undefined);
  runtime.sessionManager.appendCustomEntry("refresh-session-directory", { phase: "before" });

  await writeFile(join(agentDir, "config.json"), JSON.stringify({ sessionDir: changedSessionDir }));
  await assert.rejects(
    runtime.refresh(),
    /sessionDirectory cannot change during \/refresh/u,
  );

  assert.equal(runtime.session, activeSession);
  assert.equal(runtime.generationSignal, activeGeneration);
  assert.equal(activeGeneration.aborted, false);
  assert.equal(runtime.runtimePlugins, activeExtensions);
  assert.equal(runtime.session.sessionId, sessionId);
  assert.equal(runtime.sessionManager.getSessionFile(), sessionFile);
  assert.throws(() => SessionManager.open(sessionFile), /active writer/u);
  runtime.sessionManager.appendCustomEntry("refresh-session-directory", { phase: "after" });
  assert.deepEqual(
    runtime.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "refresh-session-directory")
      .map((entry) => entry.type === "custom" ? entry.data : undefined),
    [{ phase: "before" }, { phase: "after" }],
  );
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:shutdown:refresh",
    "2:activate",
    "2:dispose",
    "1:start:refresh",
  ]);
  assert.deepEqual(
    runtime.runtimePlugins.commands().map((entry) => entry.name),
    ["refresh-session-directory-1"],
  );
});

test("failed runtime replacement construction preserves the active session writer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-failed-refresh-writer-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    pluginCode: false,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const sessionFile = runtime.sessionManager.getSessionFile();
  assert.ok(sessionFile !== undefined);

  const create = AgentSession.create;
  AgentSession.create = async (options, ownership) => {
    assert.equal(ownership?.sessionStore, "host");
    options.model = { provider: "missing-provider", api: "openai-responses", id: "missing-model" };
    return await create.call(AgentSession, options, ownership);
  };
  try {
    await assert.rejects(runtime.refresh(), /Provider adapter is not registered: missing-provider/u);
  } finally {
    AgentSession.create = create;
  }

  assert.throws(() => SessionManager.open(sessionFile), /active writer/u);
  runtime.sessionManager.appendCustomEntry("refresh-store", { phase: "after-failure" });
  assert.deepEqual(
    runtime.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "refresh-store")
      .map((entry) => entry.type === "custom" ? entry.data : undefined),
    [{ phase: "after-failure" }],
  );
});

test("runtime refresh announces shutdown before activating the replacement extension generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-order-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const lifecycle: string[] = [];
  let generation = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "refresh-order-probe",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  await runtime.refresh();

  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:shutdown:refresh",
    "2:activate",
  ]);
});

test("runtime refresh completes its UI commit when old-session cleanup fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-session-cleanup-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const previousSession = runtime.session;
  const closePreviousSession = previousSession.close.bind(previousSession);
  previousSession.close = async () => { throw new Error("old session cleanup fixture"); };
  let uiCommitted = false;

  const result = await runtime.refresh({ onCommit() { uiCommitted = true; } });

  assert.equal(uiCommitted, true);
  assert.notEqual(runtime.session, previousSession);
  assert.deepEqual(result.warnings, ["Old session cleanup failed: old session cleanup fixture"]);
  await closePreviousSession();
});

test("runtime refresh contains hostile committed callback failures without inspecting them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-hostile-refresh-callback-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const previousSession = runtime.session;
  let prototypeTrapCalls = 0;
  let conversionTrapCalls = 0;
  const hostileFailure = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("refresh failure prototype must not be inspected");
    },
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) conversionTrapCalls += 1;
      throw new Error("refresh failure conversion must not be invoked");
    },
  });

  const result = await runtime.refresh({ onCommit() { throw hostileFailure; } });

  assert.notEqual(runtime.session, previousSession);
  assert.deepEqual(result.warnings, ["Refreshed resources but UI refresh failed: [Thrown object]"]);
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(conversionTrapCalls, 0);
});

test("runtime refresh installs interactive bindings before replacement session_start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-bindings-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const lifecycle: string[] = [];
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "refresh-binding-probe",
      factory(api) {
        api.on("session_start", (_event, extensionContext) => {
          lifecycle.push(`start:${extensionContext.mode}:${String(extensionContext.hasUI)}`);
        });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  await runtime.refresh({
    beforeSessionStart(session) {
      lifecycle.push("bind");
      session.updatePluginBindings({
        mode: "tui",
        uiContext: extensionUiContext(),
      });
    },
  });

  assert.deepEqual(lifecycle, ["bind", "start:tui:true"]);
});

test("runtime refresh quarantines a cancelled partial extension generation and recovers with a fresh one", {
  timeout: 10_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-incomplete-generation-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  let generation = 0;
  let partialContext: RuntimePluginListenerContext | undefined;
  let markPartialRegistration!: () => void;
  const partialRegistration = new Promise<void>((resolve) => { markPartialRegistration = resolve; });
  let rejectSessionStart!: (error: Error) => void;
  const sessionStartGate = new Promise<void>((_resolve, reject) => { rejectSessionStart = reject; });
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "refresh-incomplete-generation-probe",
      factory(api) {
        const current = ++generation;
        api.registerCommand(`refresh-generation-${current}`, { async handler() {} });
        api.on("session_start", async (_event, extensionContext) => {
          if (current !== 2) return;
          partialContext = extensionContext;
          api.registerCommand("partial-refresh-generation-2", { async handler() {} });
          markPartialRegistration();
          await sessionStartGate;
        });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  const controller = new AbortController();
  const refresh = runtime.refresh({ signal: controller.signal });
  await partialRegistration;
  const incompleteSession = runtime.session;
  const incompleteExtensions = runtime.runtimePlugins;
  controller.abort(new Error("cancel incomplete runtime generation"));
  setTimeout(() => { rejectSessionStart(new Error("reject incomplete runtime generation")); }, 0);
  const result = await refresh;

  assert.match(result.warnings.join("\n"), /Plugin session restart failed:/u);
  assert.equal(runtime.session, incompleteSession);
  assert.equal(runtime.runtimePlugins, incompleteExtensions);
  assert.equal(incompleteExtensions.lifecycleSignal().aborted, true);
  assert.deepEqual(incompleteExtensions.commands(), []);
  assert.equal(incompleteSession.isIdle, true);
  assert.equal(incompleteSession.hasPluginHandlers("session_start"), false);
  assert.throws(
    () => incompleteSession.pluginRunner,
    /did not finish starting.*fresh generation/u,
  );
  assert.throws(() => partialContext?.isIdle(), /Runtime extension host is closed/u);

  await runtime.refresh();

  assert.equal(generation, 3);
  assert.notEqual(runtime.session, incompleteSession);
  assert.equal(runtime.runtimePlugins.lifecycleSignal().aborted, false);
  assert.deepEqual(
    runtime.runtimePlugins.commands().map((entry) => entry.name),
    ["refresh-generation-3"],
  );
  assert.equal(runtime.session.pluginRunner.createContext().isIdle(), true);
});

test("runtime refresh quarantines a replacement aborted after commit but before session_start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-pre-start-abort-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  let generation = 0;
  const starts: string[] = [];
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "refresh-pre-start-abort-probe",
      factory(api) {
        const current = ++generation;
        api.registerCommand(`pre-start-generation-${current}`, { async handler() {} });
        api.on("session_start", (event) => { starts.push(`${current}:${event.reason}`); });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  const controller = new AbortController();
  let incompleteSession: AgentSession | undefined;
  let incompleteExtensions: RuntimePluginHost | undefined;
  const result = await runtime.refresh({
    signal: controller.signal,
    beforeSessionStart(session) {
      incompleteSession = session;
      incompleteExtensions = runtime.runtimePlugins;
      controller.abort(new Error("cancel before replacement session_start"));
    },
  });

  assert.ok(incompleteSession);
  assert.ok(incompleteExtensions);
  const failedSession = incompleteSession;
  const failedExtensions = incompleteExtensions;
  assert.match(result.warnings.join("\n"), /Plugin session restart failed:/u);
  assert.deepEqual(starts, []);
  assert.equal(runtime.session, failedSession);
  assert.equal(runtime.runtimePlugins, failedExtensions);
  assert.equal(failedExtensions.lifecycleSignal().aborted, true);
  assert.deepEqual(failedExtensions.commands(), []);
  assert.equal(failedSession.hasPluginHandlers("session_start"), false);
  assert.throws(
    () => failedSession.pluginRunner,
    /did not finish starting.*fresh generation/u,
  );

  await runtime.refresh();

  assert.equal(generation, 3);
  assert.deepEqual(starts, ["3:refresh"]);
  assert.equal(runtime.runtimePlugins.lifecycleSignal().aborted, false);
  assert.deepEqual(
    runtime.runtimePlugins.commands().map((entry) => entry.name),
    ["pre-start-generation-3"],
  );
});

test("a failed runtime refresh disposes its candidate and restarts the previous generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-recovery-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const lifecycle: string[] = [];
  let generation = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginFactories: [{
      name: "refresh-recovery-probe",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
        api.on("session_start", (event) => { lifecycle.push(`${current}:start:${event.reason}`); });
        api.onDispose(() => { lifecycle.push(`${current}:dispose`); });
        api.registerCommand(`refresh-recovery-${current}`, { async handler() {} });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  await assert.rejects(runtime.refresh({
    preparePlugins() { throw new Error("candidate rejected"); },
  }), /candidate rejected/u);

  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:shutdown:refresh",
    "2:activate",
    "2:dispose",
    "1:start:refresh",
  ]);
  assert.deepEqual(runtime.runtimePlugins.commands().map((entry) => entry.name), ["refresh-recovery-1"]);
});

test("a failed runtime refresh reports candidate cleanup and previous-generation restart failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-refresh-restart-failure-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const previousSession = runtime.session;
  const bindPreviousExtensions = previousSession.bindPlugins.bind(previousSession);
  let restartAttempts = 0;
  previousSession.bindPlugins = async (
    options?: PluginBindings | Omit<SessionStartEvent, "type">,
    signal?: AbortSignal,
  ): Promise<void> => {
    const reason = options !== undefined && "reason" in options ? options.reason : undefined;
    if (reason === "refresh") {
      restartAttempts += 1;
      throw new Error("previous generation restart rejected");
    }
    if (options === undefined) await bindPreviousExtensions();
    else if ("reason" in options) await bindPreviousExtensions(options, signal);
    else await bindPreviousExtensions(options, signal);
  };

  await assert.rejects(
    runtime.refresh({
      preparePlugins(extensions) {
        const closeCandidate = extensions.close.bind(extensions);
        extensions.close = async () => {
          await closeCandidate();
          throw new Error("candidate cleanup rejected");
        };
        throw new Error("candidate rejected");
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure instanceof Error ? failure.message : String(failure)),
        ["candidate rejected", "candidate cleanup rejected", "previous generation restart rejected"],
      );
      return true;
    },
  );

  assert.equal(restartAttempts, 1);
  assert.equal(runtime.session, previousSession);
});

test("runtime startup and refresh use direct package factories as one resource generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-direct-extension-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(agentDir, "extensions", "direct-package");
  const extensionPath = join(packageRoot, "index.ts");
  const promptPath = join(packageRoot, "prompts", "inspect.md");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "direct-package",
    ohm: { extensions: ["index.ts"], prompts: ["prompts"] },
  }));
  await writeFile(promptPath, "Inspect $ARGUMENTS\n");
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__ohmDirectApis ??= [];
    globalThis.__ohmDirectApis.push(api);
    api.registerCommand("generation-one", { handler() {} });
  };\n`);
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const originalResolve = DefaultPackageManager.prototype.resolve;
  let resolveCalls = 0;
  DefaultPackageManager.prototype.resolve = async function(resolveMissing) {
    resolveCalls += 1;
    return await originalResolve.call(this, resolveMissing);
  };
  context.after(async () => {
    DefaultPackageManager.prototype.resolve = originalResolve;
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    Reflect.deleteProperty(globalThis, "__ohmDirectApis");
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: true,
    pluginRuntime: true,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  assert.equal(resolveCalls, 1);
  assert.deepEqual(runtime.runtimePlugins.commands().map((entry) => entry.name), ["generation-one"]);
  assert.equal(runtime.resourceLoader.getPrompts().prompts.some((entry) => entry.name === "inspect"), true);
  assert.equal(runtime.plugins.prompt("inspect")?.template, "Inspect $ARGUMENTS\n");

  const firstApi = globalThis.__ohmDirectApis?.[0];
  assert.ok(firstApi);
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__ohmDirectApis.push(api);
    api.registerCommand("generation-two", { handler() {} });
  };\n`);
  await runtime.refresh();

  assert.equal(resolveCalls, 2);
  assert.deepEqual(runtime.runtimePlugins.commands().map((entry) => entry.name), ["generation-two"]);
  assert.throws(() => firstApi.getAllTools(), /no longer active|stale/iu);
  assert.equal(globalThis.__ohmDirectApis?.length, 2);
  assert.equal(runtime.plugins.list().length, 1);
  assert.equal(runtime.plugins.list()[0]?.status, "active");
});

test("invocation-only package sources activate direct factories and companion resources without persistence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-invocation-package-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "invocation-package");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "invocation-package",
    ohm: { extensions: ["index.mjs"], prompts: ["prompts"] },
  }));
  await writeFile(join(packageRoot, "index.mjs"), `export default (api) => {
    api.registerCommand("invocation-command", { handler() {} });
  };\n`);
  await writeFile(join(packageRoot, "prompts", "invocation-prompt.md"), "Invocation $ARGUMENTS\n");
  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true,
    ephemeral: true,
    pluginCode: false,
    pluginRuntime: true,
    pluginPaths: [packageRoot],
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.deepEqual(runtime.runtimePlugins.commands().map((entry) => entry.name), ["invocation-command"]);
  assert.equal(runtime.runtimePlugins.plugins()[0]?.scope, "invocation");
  assert.equal(runtime.plugins.prompt("invocation-prompt")?.template, "Invocation $ARGUMENTS\n");
});
