import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import * as publicRoot from "../../src/index.js";
import * as publicPlugins from "../../src/plugins/index.js";
import * as publicStorage from "../../src/storage/index.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { createEventBus, type EventBus, type EventHandler } from "../../src/core/event-bus.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core/json.js";
import {
  appendDirectPlugins,
  HEADLESS_PLUGIN_UI_CAPABILITIES,
  loadDirectPlugins,
  type RuntimeAssistantStreamSnapshot,
  type RuntimeDirectUiContext,
  type RuntimePluginHost,
  type RuntimePluginLoadOptions,
} from "../../src/plugins/runtime.js";
import type { PluginAPI, PluginSessionDelivery } from "../../src/plugins/direct.js";
import { UNAVAILABLE_PLUGIN_UI_ROUTES } from "../../src/plugins/runtime-internal/ui-route-registrations.js";
import { UNAVAILABLE_PLUGIN_UI_SLOTS } from "../../src/plugins/runtime-internal/ui-slot-registrations.js";
import { runRuntimeCleanupPhase } from "../../src/plugins/runtime-internal/generation-lifecycle.js";
import { pluginSessionManager } from "../../src/plugins/session-contract.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { sha256 } from "../../src/tools/hash.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";
import { createTheme } from "../../src/tui/theme.js";
import { loadTestDirectExtensions } from "../helpers/direct-plugin-loader.js";

declare global {
  var __directRuntimeApi: PluginAPI | undefined;
  var __directRuntimeEvents: string[] | undefined;
  var __directRuntimeStart: string | undefined;
  var __failedDirectRuntimeApi: PluginAPI | undefined;
  var __invalidCommandDisposals: number | undefined;
  var __reservedCommandRan: boolean | undefined;
  var __timedOutDirectRuntimeApi: PluginAPI | undefined;
  var __toolRegistrationBoundaryCalls: number | undefined;
  var __directRuntimeModules: {
    root: typeof publicRoot;
    plugins: typeof publicPlugins;
    storage: typeof publicStorage;
  } | undefined;
}

const TEST_THEME = createTheme("mono", { color: false, unicode: false });

function directUiContext(
  setStatus: RuntimeDirectUiContext["setStatus"] = () => undefined,
): RuntimeDirectUiContext {
  return {
    capabilities: HEADLESS_PLUGIN_UI_CAPABILITIES,
    slots: UNAVAILABLE_PLUGIN_UI_SLOTS,
    routes: UNAVAILABLE_PLUGIN_UI_ROUTES,
    theme: TEST_THEME,
    getTheme() { return undefined; },
    getAllThemes() { return []; },
    setTheme() { return { success: false }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
    async select() { return undefined; },
    async confirm() { return false; },
    async input() { return undefined; },
    notify() {},
    onTerminalInput() { return () => undefined; },
    setStatus,
    setHiddenThinkingLabel() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setBackground() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() { return undefined; },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() { return ""; },
    async editor() { return undefined; },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() { return undefined; },
  };
}

async function workspace(context: TestContext, prefix = "ohm-direct-runtime-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function loadSource(
  context: TestContext,
  source: string,
  options: RuntimePluginLoadOptions = { workspace: "" },
): Promise<{ host: RuntimePluginHost; root: string; sourcePath: string }> {
  const root = options.workspace === "" ? await workspace(context) : options.workspace;
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadTestDirectExtensions([{
    extensionId: "direct-runtime",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], { ...options, workspace: root });
  return { host, root, sourcePath };
}

function bindContext(host: RuntimePluginHost, root: string): void {
  const sessionManager = SessionManager.inMemory(root, { id: "direct-runtime-session" });
  host.setDirectContextHandler(() => ({
    sessionManager: pluginSessionManager(sessionManager),
    modelRegistry: new ModelRegistry(createModels()),
    thinkingLevel: "off",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "runtime system prompt",
  }));
  host.setDirectActionsHandler({
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    async setModel() { return true; },
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    getSystemPromptOptions: () => ({ cwd: root }),
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async refresh() {},
  });
}

test("unbound direct context exposes safe empty session state", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-unbound-session-");
  let page: unknown;
  let delivery: PluginSessionDelivery | undefined;
  let sessionId: string | undefined;
  let systemPrompt: string | undefined;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      api.on("session_start", (_event, runtime) => {
        page = runtime.sessionManager.getEntriesPage(0, 1);
        delivery = runtime.sessionDelivery;
        sessionId = runtime.sessionManager.getSessionId();
        systemPrompt = runtime.getSystemPrompt();
      });
    }],
  });
  context.after(async () => await host.close());

  await host.dispatch("session_start", { reason: "startup", threadId: "unbound-session" });

  assert.deepEqual(page, { entries: [], totalEntries: 0 });
  assert.equal(sessionId, "unbound");
  assert.equal(systemPrompt, "");
  assert.equal(delivery?.sessionId, "unbound");
  assert.notEqual(delivery, undefined);
  await assert.rejects(
    delivery!.sendMessage({ customType: "unbound", content: "no host", display: false }),
    /Acknowledged session message delivery is unavailable/u,
  );
});

test("direct listeners observe advanced UI state while unavailable terminal input fails closed", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-tool-expansion-");
  let toolsExpanded: boolean | undefined;
  let stopTerminalInput: (() => void) | undefined;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      api.on("session_start", (_event, runtime) => {
        toolsExpanded = runtime.ui.getToolsExpanded();
        stopTerminalInput = runtime.ui.onTerminalInput(() => undefined);
      });
    }],
  });
  context.after(async () => await host.close());
  host.setAdvancedUiHandler({
    apply() {},
    getToolOutputExpanded: () => true,
  });

  await host.dispatch("session_start", { reason: "startup", threadId: "advanced-ui-session" });

  assert.equal(toolsExpanded, true);
  assert.ok(stopTerminalInput !== undefined);
  stopTerminalInput();
});

test("advanced UI operations rejected during handler attachment are not replayed", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-advanced-replay-");
  const host = await loadDirectPlugins([], { workspace: root, activationFailure: "throw" });
  context.after(async () => await host.close());
  host.applyAdvancedUi({
    extensionId: "fixture",
    sourcePath: "<fixture>",
    ownerKey: "fixture:<fixture>",
    signal: new AbortController().signal,
    type: "working_indicator",
    value: { frames: ["."], intervalMs: 80 },
  });

  host.setAdvancedUiHandler({
    apply() { throw new Error("unsupported presentation"); },
    getToolOutputExpanded: () => false,
  });

  assert.equal(host.diagnostics().length, 1);
  assert.match(
    host.diagnostics()[0]?.message ?? "",
    /Advanced UI operation was ignored: unsupported presentation/u,
  );
  let replayed = 0;
  host.setAdvancedUiHandler({
    apply() { replayed += 1; },
    getToolOutputExpanded: () => false,
  });
  assert.equal(replayed, 0);
});

test("trusted modules activate only the direct factory registration contract", async (context) => {
  const source = `export default function (ohm) {
    globalThis.__directRuntimeApi = ohm;
    ohm.registerTool({
      name: "probe_echo",
      label: "Probe echo",
      description: "Echo text",
      promptSnippet: "Echo deterministic text",
      promptGuidelines: ["Use probe_echo for deterministic echoes."],
      constrainedSampling: { type: "json_schema", strict: "require" },
      loading: "deferred",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } }
      },
      async prepareArguments(input) {
        return { text: input.text.trim() };
      },
      async execute(_toolCallId, input) {
        return { content: [{ type: "text", text: "probe:" + input.text }], details: { source: "extension" } };
      }
    });
    ohm.registerCommand("probe", { description: "Probe command", async handler() {} });
    ohm.registerFlag("probe-mode", { type: "string", default: "ready" });
    ohm.registerProvider("probe-provider", { name: "Probe", models: [] });
    ohm.on("session_start", (event) => { globalThis.__directRuntimeStart = event.reason; });
  }\n`;
  const { host, root } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  bindContext(host, root);
  context.after(async () => {
    await host.close();
    Reflect.deleteProperty(globalThis, "__directRuntimeApi");
    Reflect.deleteProperty(globalThis, "__directRuntimeStart");
  });

  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["probe_echo"]);
  assert.equal(host.tools()[0]?.definition.promptSnippet, "Echo deterministic text");
  assert.deepEqual(host.tools()[0]?.definition.promptGuidelines, ["Use probe_echo for deterministic echoes."]);
  assert.deepEqual(host.tools()[0]?.definition.constrainedSampling, {
    type: "json_schema",
    strict: "require",
  });
  assert.equal(host.tools()[0]?.definition.loading, "deferred");
  assert.deepEqual(await host.tools()[0]?.prepareInput?.({ text: "  ready  " }, {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "prepare-input-run",
    threadId: "direct-runtime-session",
  }), { text: "ready" });
  assert.deepEqual(host.commands().map((command) => command.name), ["probe"]);
  assert.equal(host.flagValues().get("probe-mode"), "ready");
  assert.deepEqual(host.directProviderRegistrations().map((entry) => entry.name), ["probe-provider"]);
  await host.dispatch("session_start", { reason: "startup", threadId: "direct-runtime-session" });
  assert.equal(globalThis.__directRuntimeStart, "startup");

  const api = globalThis.__directRuntimeApi;
  assert.ok(api !== undefined);
  await host.close();
  assert.throws(() => api.getCommands(), /no longer active/u);
});

test("tool registration rejects hostile schemas and grammar variants without invoking them", async (context) => {
  const cases = [
    {
      name: "schema",
      source: `const schema = Object.assign(Object.create({
        toJSON() {
          globalThis.__toolRegistrationBoundaryCalls += 1;
          return { type: "object" };
        }
      }), { type: "object" });
      export default (ohm) => ohm.registerTool({
        name: "hostile_schema",
        description: "hostile schema",
        parameters: schema,
        async execute() { return { content: [{ type: "text", text: "unsafe" }] }; }
      });\n`,
    },
    {
      name: "grammar",
      source: `const variants = {};
      Object.defineProperty(variants, "openai_lark", {
        enumerable: true,
        get() {
          globalThis.__toolRegistrationBoundaryCalls += 1;
          return "start: /x/";
        }
      });
      export default (ohm) => ohm.registerTool({
        name: "hostile_grammar",
        description: "hostile grammar",
        parameters: { type: "object" },
        constrainedSampling: { type: "grammar", variants },
        async execute() { return { content: [{ type: "text", text: "unsafe" }] }; }
      });\n`,
    },
  ];
  globalThis.__toolRegistrationBoundaryCalls = 0;

  try {
    for (const selected of cases) {
      await assert.rejects(
        loadSource(context, selected.source, { workspace: "", activationFailure: "throw" })
          .then(async ({ host }) => await host.close()),
        /plain objects|enumerable data properties/u,
        selected.name,
      );
    }
    assert.equal(globalThis.__toolRegistrationBoundaryCalls, 0);
  } finally {
    Reflect.deleteProperty(globalThis, "__toolRegistrationBoundaryCalls");
  }
});

test("message listeners never observe provider traces", async (context) => {
  const source = `export default function (ohm) {
    globalThis.__directRuntimeEvents = [];
    ohm.on("message_update", (entry) => {
      globalThis.__directRuntimeEvents.push(
        entry.assistantMessageEvent.type + ":" +
        entry.message.content.map((block) => block.type + ":" + (block.thinking ?? block.text ?? "")).join("|")
      );
    });
    ohm.on("message_end", (entry) => {
      globalThis.__directRuntimeEvents.push(
        entry.message.content.map((block) => block.type + ":" + (block.thinking ?? block.text ?? "")).join("|")
      );
    });
  }\n`;
  const { host, root } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  bindContext(host, root);
  context.after(async () => {
    await host.close();
    Reflect.deleteProperty(globalThis, "__directRuntimeEvents");
  });
  const base = {
    threadId: "thread_1",
    runId: "run_1",
    branch: "main",
    step: 1,
  };
  const finalMessage = {
    id: "message_1",
    role: "assistant" as const,
    createdAt: "2026-07-28T00:00:00.000Z",
    content: [
      { type: "thinking" as const, thinking: "private durable trace", visibility: "provider_trace" as const },
      { type: "thinking" as const, thinking: "public summary", visibility: "summary" as const },
      { type: "text" as const, text: "answer" },
    ],
  };
  const streamMessage: RuntimeAssistantStreamSnapshot = {
    role: "assistant",
    provider: "fixture",
    model: "fixture-model",
    text: [{ part: 2, text: "answer" }],
    reasoning: [
      { part: 0, text: "private durable trace", visibility: "provider_trace" },
      { part: 1, text: "public summary", visibility: "summary" },
    ],
    toolCalls: [],
  };
  await host.dispatch("message_update", {
    ...base,
    message: streamMessage,
    kind: "reasoning",
    part: 0,
    delta: "private trace",
    visibility: "provider_trace",
  });
  await host.dispatch("message_update", {
    ...base,
    message: streamMessage,
    kind: "reasoning",
    part: 1,
    delta: "public summary",
    visibility: "summary",
  });
  await host.dispatch("message_end", { ...base, message: finalMessage });
  assert.deepEqual(globalThis.__directRuntimeEvents, [
    "thinking_delta:thinking:public summary|text:answer",
    "thinking:public summary|text:answer",
  ]);
});

test("public message-update dispatch keeps semantic assistant-content validation", async (context) => {
  for (const selected of [
    {
      name: "block count",
      text: Array.from({ length: 1_025 }, (_, part) => ({ part, text: "x" })),
      diagnostic: /at most 1024 blocks/u,
    },
    {
      name: "NUL text",
      text: [{ part: 0, text: "before\0after" }],
      diagnostic: /without NUL/u,
    },
  ]) {
    await context.test(selected.name, async (nested) => {
      const root = await workspace(nested, `ohm-direct-runtime-message-bounds-${selected.name.replaceAll(" ", "-")}-`);
      let listenerCalls = 0;
      const host = await loadDirectPlugins([], {
        workspace: root,
        activationFailure: "throw",
        inlinePlugins: [(api) => {
          api.on("message_update", () => { listenerCalls += 1; });
        }],
      });
      nested.after(async () => await host.close());
      const message: RuntimeAssistantStreamSnapshot = {
        role: "assistant",
        provider: "fixture",
        model: "fixture-model",
        text: selected.text,
        reasoning: [],
        toolCalls: [],
      };

      await host.dispatch("message_update", {
        threadId: "thread-bounds",
        runId: "run-bounds",
        branch: "main",
        step: 1,
        message,
        kind: "text",
        part: 0,
        delta: "x",
      });

      assert.equal(listenerCalls, 0);
      assert.equal(host.diagnostics().some((entry) => selected.diagnostic.test(entry.message)), true);
    });
  }
});

test("TypeScript relative imports and CommonJS factories use the same direct API", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-modules-");
  await writeFile(join(root, "helper.ts"), `export enum State { Ready = "ready" }\n`);
  const typescriptPath = join(root, "extension.ts");
  const typescriptSource = `
    import { State } from "./helper";
    export default function (ohm: any) {
      ohm.registerFlag("typescript-state", { type: "string", default: State.Ready });
    }
  `;
  await writeFile(typescriptPath, typescriptSource);
  const commonjsPath = join(root, "extension.cjs");
  const commonjsSource = `module.exports = function (ohm) {
    ohm.registerFlag("commonjs-state", { type: "string", default: "loaded" });
  };\n`;
  await writeFile(commonjsPath, commonjsSource);
  const host = await loadTestDirectExtensions([
    { extensionId: "typescript", sourcePath: typescriptPath, sha256: sha256(typescriptSource), trusted: true },
    { extensionId: "commonjs", sourcePath: commonjsPath, sha256: sha256(commonjsSource), trusted: true },
  ], { workspace: root, activationFailure: "throw" });
  context.after(async () => await host.close());

  assert.deepEqual(host.diagnostics(), []);
  assert.equal(host.flagValues().get("typescript-state"), "ready");
  assert.equal(host.flagValues().get("commonjs-state"), "loaded");
});

test("public host imports retain identity and attachment state across plugin and helper reloads", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-module-identity-");
  const sourcePath = join(root, "plugin.mjs");
  context.after(() => { Reflect.deleteProperty(globalThis, "__directRuntimeModules"); });
  for (const [factoryRevision, helperRevision] of [["one", "one"], ["one", "two"], ["two", "two"]]) {
    await writeFile(join(root, "helper.ts"), `export const revision = "${helperRevision}";\n`);
    await writeFile(sourcePath, `
      import * as root from "ohm";
      import * as plugins from "ohm/plugins";
      import * as storage from "ohm/storage";
      import { revision } from "./helper.ts";
      export default function (api) {
        globalThis.__directRuntimeModules = { root, plugins, storage };
        api.registerFlag("module-revision", { type: "string", default: "${factoryRevision}:" + revision });
      }
    `);
    const host = await loadDirectPlugins([sourcePath], { workspace: root, activationFailure: "throw" });
    try {
      const modules = globalThis.__directRuntimeModules;
      assert.ok(modules !== undefined);
      assert.equal(modules.root.AgentSession, publicRoot.AgentSession);
      assert.equal(modules.root.SessionManager, publicRoot.SessionManager);
      assert.equal(modules.storage.SessionManager, publicStorage.SessionManager);
      assert.equal(modules.plugins.PluginConfigConflictError, publicPlugins.PluginConfigConflictError);
      assert.equal(modules.plugins.createPluginRuntime, publicPlugins.createPluginRuntime);
      const hostRuntime = publicPlugins.createPluginRuntime();
      publicPlugins.attachPluginRuntimeHost(hostRuntime, host);
      assert.equal(modules.plugins.getPluginRuntimeHost(hostRuntime), host);
      const pluginRuntime = modules.plugins.createPluginRuntime();
      modules.plugins.attachPluginRuntimeHost(pluginRuntime, host);
      assert.equal(publicPlugins.getPluginRuntimeHost(pluginRuntime), host);
      assert.equal(host.flagValues().get("module-revision"), `${factoryRevision}:${helperRevision}`);
      assert.deepEqual(host.diagnostics(), []);
    } finally {
      await host.close();
    }
  }
});

test("runtime host attachment preserves unbound lookup and rejects a different generation", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-attachment-");
  const runtime = publicPlugins.createPluginRuntime();
  assert.equal(publicPlugins.getPluginRuntimeHost(runtime), undefined);
  const host = publicPlugins.ensurePluginRuntimeHost(runtime, root);
  context.after(async () => await host.close());
  assert.equal(publicPlugins.getPluginRuntimeHost(runtime), host);
  assert.doesNotThrow(() => publicPlugins.attachPluginRuntimeHost(runtime, host));
  assert.equal(publicPlugins.ensurePluginRuntimeHost(runtime, root), host);

  const other = publicPlugins.ensurePluginRuntimeHost(publicPlugins.createPluginRuntime(), root);
  context.after(async () => await other.close());
  assert.throws(
    () => publicPlugins.attachPluginRuntimeHost(runtime, other),
    /already attached to another host generation/u,
  );
  assert.equal(publicPlugins.getPluginRuntimeHost(runtime), host);
});

test("empty activation groups preserve caller cancellation", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-empty-cancel-");
  const loadController = new AbortController();
  const loadReason = new Error("empty load cancelled");
  loadController.abort(loadReason);
  await assert.rejects(
    loadDirectPlugins([], { workspace: root, signal: loadController.signal }),
    (cause: unknown) => cause === loadReason,
  );

  const host = await loadDirectPlugins([], { workspace: root });
  context.after(async () => await host.close());
  const appendController = new AbortController();
  const appendReason = new Error("empty append cancelled");
  appendController.abort(appendReason);
  await assert.rejects(
    appendDirectPlugins(host, [], { workspace: root, signal: appendController.signal }),
    (cause: unknown) => cause === appendReason,
  );
});

test("failed activation rolls back direct registrations and invalidates the candidate API", async (context) => {
  const source = `export default function (ohm) {
    globalThis.__failedDirectRuntimeApi = ohm;
    ohm.registerCommand("must-not-commit", { async handler() {} });
    throw new Error("direct activation failed");
  }\n`;
  const { host } = await loadSource(context, source);
  context.after(async () => {
    await host.close();
    Reflect.deleteProperty(globalThis, "__failedDirectRuntimeApi");
  });

  assert.deepEqual(host.commands(), []);
  assert.match(host.diagnostics()[0]?.message ?? "", /direct activation failed/u);
  const failedApi = globalThis.__failedDirectRuntimeApi;
  assert.ok(failedApi !== undefined);
  assert.throws(
    () => failedApi.getCommands(),
    /no longer active/u,
  );
});

test("activation cleanup cannot replace the original factory failure with a late timeout", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-cleanup-classification-");
  const sourcePath = join(root, "extension.mjs");
  const source = `export default function (ohm) {
    ohm.onDispose(() => new Promise((resolve) => setTimeout(resolve, 80)));
    throw new Error("original activation failure");
  }\n`;
  await writeFile(sourcePath, source);

  await assert.rejects(loadTestDirectExtensions([{
    extensionId: "cleanup-classification",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    loadTimeoutMs: 5_000,
    shutdownTimeoutMs: 200,
  }), /original activation failure/u);
});

test("slow module load does not consume activation time and a suspended factory becomes stale", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-timeout-");
  const sourcePath = join(root, "timeout.mjs");
  const source = `await new Promise((resolve) => setTimeout(resolve, 75));
export default async function (ohm) {
    globalThis.__timedOutDirectRuntimeApi = ohm;
    await new Promise(() => {});
  }\n`;
  await writeFile(sourcePath, source);
  context.after(() => { Reflect.deleteProperty(globalThis, "__timedOutDirectRuntimeApi"); });

  await assert.rejects(loadTestDirectExtensions([{
    extensionId: "timeout",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    loadTimeoutMs: 5_000,
  }), /activation timed out after 25ms/u);
  const timedOutApi = globalThis.__timedOutDirectRuntimeApi;
  assert.ok(timedOutApi !== undefined, "the factory must run after the slower module evaluation completes");
  assert.throws(
    () => timedOutApi.getCommands(),
    /no longer active/u,
  );
});

test("direct disposers run once in LIFO order after the API becomes stale and isolate failures", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-dispose-");
  const order: string[] = [];
  let capturedApi: import("../../src/plugins/direct.js").PluginAPI | undefined;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      capturedApi = api;
      api.onDispose(() => {
        order.push("first");
        assert.throws(() => api.getCommands(), /no longer active/u);
      });
      api.onDispose(() => {
        order.push("second");
        throw new Error("second cleanup failed");
      });
      api.onDispose(async () => {
        await Promise.resolve();
        order.push("third");
      });
    }],
  });

  await assert.rejects(host.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.match(cause.message, /second cleanup failed/u);
    return true;
  });
  assert.deepEqual(order, ["third", "second", "first"]);
  assert.ok(capturedApi);
  const staleApi = capturedApi;
  assert.throws(() => staleApi.getCommands(), /no longer active/u);
  await host.close();
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("direct cleanup contains hostile thrown objects without inspecting them", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-hostile-dispose-");
  let prototypeTrapCalls = 0;
  let conversionTrapCalls = 0;
  const hostileFailure = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("cleanup failure prototype must not be inspected");
    },
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) conversionTrapCalls += 1;
      throw new Error("cleanup failure conversion must not be invoked");
    },
  });
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      api.onDispose(() => { throw hostileFailure; });
    }],
  });

  await assert.rejects(host.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.match(cause.message, /\[Thrown object\]/u);
    return true;
  });
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(conversionTrapCalls, 0);
});

for (const asynchronous of [false, true]) {
  for (const rollback of [false, true]) {
    test(`${rollback ? "activation rollback" : "host close"} reports ${asynchronous ? "rejected" : "thrown"} undefined cleanup and continues`, async (context) => {
      const root = await workspace(context, "ohm-undefined-cleanup-");
      const order: string[] = [];
      const host = await loadDirectPlugins([], {
        workspace: root,
        inlinePlugins: [(api) => {
          api.onDispose(() => { order.push("after"); });
          api.onDispose(() => {
            order.push("failure");
            if (asynchronous) return Promise.reject(undefined);
            throw undefined;
          });
          if (rollback) throw new Error("factory failure");
        }],
      });
      context.after(async () => await host.close());
      if (rollback) {
        assert.equal(host.diagnostics().some((entry) => /cleanup failed: undefined/u.test(entry.message)), true);
        assert.equal(host.plugins().length, 0);
      } else await assert.rejects(host.close(), /cleanup failed: undefined/u);
      assert.deepEqual(order, ["failure", "after"]);
      await host.close();
      assert.deepEqual(order, ["failure", "after"]);
    });
  }
}

test("pre-aborted runtime waits observe rejected work without changing abort precedence", () => {
  const moduleUrl = new URL("../../src/plugins/runtime-internal/generation-lifecycle.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { withAbort } from ${JSON.stringify(moduleUrl)};
    for (const late of [false, true]) {
      const controller = new AbortController();
      const reason = new Error("selected abort");
      const failure = new Error("hook rejection must be observed");
      let reject;
      const invoke = () => {
        controller.abort(reason);
        return late ? new Promise((_, selected) => { reject = selected; }) : Promise.reject(failure);
      };
      await assert.rejects(withAbort(invoke(), controller.signal), (cause) => cause === reason);
      reject?.(failure);
      await new Promise((resolve) => setImmediate(resolve));
    }
  `;
  const child = spawnSync(process.execPath, [
    "--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", script,
  ], { cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("settled runtime cleanup phases clear their deadline timers", async (context) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<Parameters<typeof clearTimeout>[0]>();
  let scheduled = 0;
  context.mock.method(globalThis, "setTimeout", (
    callback: (...argumentsValue: unknown[]) => void,
    milliseconds?: number,
    ...argumentsValue: unknown[]
  ) => {
    const timer = originalSetTimeout(callback, milliseconds, ...argumentsValue);
    scheduled += 1;
    timers.add(timer);
    return timer;
  });
  context.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
    timers.delete(timer);
    originalClearTimeout(timer);
  });
  const failures = await runRuntimeCleanupPhase([
    async () => undefined,
    async () => { throw new Error("cleanup failure"); },
  ], 1_000, "Test cleanup");
  assert.equal(failures.length, 1);
  assert.equal(scheduled, 2);
  assert.equal(timers.size, 0);
});

test("direct cleanup bounds huge failures and redacts secrets straddling the output cutoff", async (context) => {
  const hugeRoot = await workspace(context, "ohm-direct-runtime-huge-dispose-");
  const hugeHost = await loadDirectPlugins([], {
    workspace: hugeRoot,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      api.onDispose(() => { throw new Error(`retained-${"x".repeat(4 * 1_024 * 1_024)}`); });
    }],
  });
  await assert.rejects(hugeHost.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal(cause.message.startsWith("Runtime plugin disposer cleanup failed: retained-"), true);
    assert.equal(Buffer.byteLength(cause.message, "utf8") <= 4_096, true);
    return true;
  });

  const marker = "LEAK-runtime-cleanup-cutoff-secret-";
  const secret = `${marker}${"s".repeat((64 * 1_024) - marker.length)}`;
  defaultSecretRedactor.register(secret);
  const straddlingRoot = await workspace(context, "ohm-direct-runtime-secret-dispose-");
  const straddlingHost = await loadDirectPlugins([], {
    workspace: straddlingRoot,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      api.onDispose(() => { throw new Error(`${"p".repeat(4_050)}${secret}-tail`); });
    }],
  });
  await assert.rejects(straddlingHost.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal(cause.message.includes(marker), false);
    assert.equal(Buffer.byteLength(cause.message, "utf8") <= 4_096, true);
    return true;
  });
});

test("command completion preserves a hostile abort reason without inspecting it", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-hostile-completion-abort-");
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [(api) => {
      api.registerCommand("complete", {
        getArgumentCompletions() { return new Promise(() => {}); },
        async handler() {},
      });
    }],
  });
  context.after(async () => await host.close());
  let prototypeTrapCalls = 0;
  const hostileReason = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("abort reason prototype must not be inspected");
    },
  });
  const controller = new AbortController();
  controller.abort(hostileReason);

  await assert.rejects(
    host.completeCommandArguments("complete", "", controller.signal),
    (cause: unknown) => cause === hostileReason,
  );
  assert.equal(prototypeTrapCalls, 0);
});

test("a caller signal cannot disable the host shutdown-listener deadline", { timeout: 5_000 }, async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-shutdown-deadline-");
  let invoked = false;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    shutdownTimeoutMs: 25,
    inlinePlugins: [{
      name: "shutdown-deadline",
      factory(api) {
        api.on("session_shutdown", async () => {
          invoked = true;
          await new Promise(() => {});
        });
      },
    }],
  });
  context.after(async () => await host.close());

  await assert.rejects(
    host.dispatch("session_shutdown", { reason: "quit" }, new AbortController().signal),
    /aborted|timeout/iu,
  );
  assert.equal(invoked, true);
});

test("successful lifecycle UI remains generation-owned after its dispatch deadline", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-generation-");
  let status: string | undefined;
  let ownerSignal: AbortSignal | undefined;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    shutdownTimeoutMs: 25,
    inlinePlugins: [{
      name: "generation-ui",
      factory(api) {
        api.on("session_start", (_event, runtime) => runtime.ui.setStatus("phase", "ready"));
      },
    }],
  });
  host.setDirectUiHandler((_extensionId, signal) => directUiContext(
    (_key: string, value: string | undefined) => {
      ownerSignal = signal;
      status = value;
      signal.addEventListener("abort", () => { status = undefined; }, { once: true });
    },
  ));

  await host.dispatch("session_start", {});
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(status, "ready");
  assert.equal(ownerSignal?.aborted, false);

  await host.close();
  assert.equal(ownerSignal?.aborted, true);
  assert.equal(status, undefined);
});

test("in-flight listener cancellation still aborts its UI ownership", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-cancellation-");
  let status: string | undefined;
  let ownerSignal: AbortSignal | undefined;
  let started!: () => void;
  const listenerStarted = new Promise<void>((resolve) => { started = resolve; });
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "cancelled-ui",
      factory(api) {
        api.on("agent_settled", async (_event, runtime) => {
          runtime.ui.setStatus("phase", "waiting");
          started();
          await new Promise(() => {});
        });
      },
    }],
  });
  context.after(async () => await host.close());
  host.setDirectUiHandler((_extensionId, signal) => directUiContext(
    (_key: string, value: string | undefined) => {
      ownerSignal = signal;
      status = value;
      signal.addEventListener("abort", () => { status = undefined; }, { once: true });
    },
  ));
  const caller = new AbortController();
  const dispatch = host.dispatch("agent_settled", {
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    outcome: { status: "completed", finishReason: "stop" },
    messages: [],
    messagesTruncated: false,
  }, caller.signal);

  await listenerStarted;
  assert.equal(status, "waiting");
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(dispatch, /caller cancelled/u);
  assert.equal(ownerSignal?.aborted, true);
  assert.equal(status, undefined);
  assert.equal(host.lifecycleSignal().aborted, false);
});

test("repeated callbacks expose one stable direct UI generation owner", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-owner-");
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "stable-ui-owner",
      factory(api) {
        api.on("agent_settled", () => undefined);
      },
    }],
  });
  context.after(async () => await host.close());
  let callbackCount = 0;
  let previousCallbackSignal: AbortSignal | undefined;
  const generationSignals = new Set<AbortSignal>();
  host.setDirectUiHandler((_extensionId, callbackSignal, _ownerKey, generationSignal) => {
    assert.notEqual(callbackSignal, previousCallbackSignal);
    previousCallbackSignal = callbackSignal;
    callbackCount += 1;
    generationSignals.add(generationSignal);
    assert.notEqual(callbackSignal, generationSignal);
    return directUiContext();
  });
  const event = {
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    outcome: { status: "completed" as const, finishReason: "stop" as const },
    messages: [],
    messagesTruncated: false,
  };

  for (let index = 0; index < 1_000; index += 1) {
    await host.dispatch("agent_settled", event, new AbortController().signal);
  }

  assert.equal(callbackCount, 1_000);
  assert.equal(generationSignals.size, 1);
  assert.ok([...generationSignals][0] instanceof AbortSignal);
});

test("blocking direct UI emits one outer prompt lifecycle without delaying presentation", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-prompt-lifecycle-");
  const events: Array<{ type: string; kind: string; title?: string }> = [];
  let observeStart!: () => void;
  let releaseStart!: () => void;
  let observeEnd!: () => void;
  let releaseEnd!: () => void;
  let releaseDialogs!: () => void;
  const startObserved = new Promise<void>((resolve) => { observeStart = resolve; });
  const startBlocked = new Promise<void>((resolve) => { releaseStart = resolve; });
  const endObserved = new Promise<void>((resolve) => { observeEnd = resolve; });
  const endBlocked = new Promise<void>((resolve) => { releaseEnd = resolve; });
  const dialogsBlocked = new Promise<void>((resolve) => { releaseDialogs = resolve; });
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "prompt-lifecycle",
      factory(api) {
        api.on("ui_prompt_start", async (event) => {
          events.push(event);
          observeStart();
          await startBlocked;
        });
        api.on("ui_prompt_end", async (event) => {
          events.push(event);
          observeEnd();
          await endBlocked;
        });
        api.registerCommand("ask", {
          async handler(_args, runtime) {
            runtime.ui.notify("opening", "info");
            await Promise.all([
              runtime.ui.select("Outer choice", ["one"]),
              runtime.ui.confirm("Overlapping confirmation", "Continue?"),
            ]);
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  bindContext(host, root);
  const dialogCalls: string[] = [];
  host.setDirectUiHandler(() => ({
    ...directUiContext(),
    async select() {
      dialogCalls.push("select");
      await dialogsBlocked;
      return "one";
    },
    async confirm() {
      dialogCalls.push("confirm");
      await dialogsBlocked;
      return true;
    },
  }));

  const command = host.runCommand("ask", {
    args: "",
    threadId: "thread-1",
    branch: "main",
    signal: new AbortController().signal,
  });
  await startObserved;
  assert.deepEqual(dialogCalls, ["select", "confirm"]);
  assert.deepEqual(events, [{
    type: "ui_prompt_start",
    reason: "ui_prompt",
    kind: "select",
    title: "Outer choice",
  }]);

  releaseDialogs();
  assert.deepEqual(await command, { handled: true });
  assert.deepEqual(events, [{
    type: "ui_prompt_start",
    reason: "ui_prompt",
    kind: "select",
    title: "Outer choice",
  }]);
  releaseStart();
  await endObserved;
  assert.deepEqual(events, [
    {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "select",
      title: "Outer choice",
    },
    {
      type: "ui_prompt_end",
      reason: "ui_prompt",
      kind: "select",
      title: "Outer choice",
    },
  ]);
  releaseEnd();
});

test("direct UI prompt lifecycle covers every blocking interaction and closes after rejection", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-prompt-kinds-");
  const events: Array<{ type: string; kind: string; title?: string }> = [];
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "prompt-kinds",
      factory(api) {
        api.on("ui_prompt_start", (event) => { events.push(event); });
        api.on("ui_prompt_end", (event) => { events.push(event); });
        api.registerCommand("all-prompts", {
          async handler(_args, runtime) {
            await runtime.ui.select("Select", ["one"]);
            await runtime.ui.confirm("Confirm", "Continue?");
            await runtime.ui.input("Input");
            await runtime.ui.editor("Editor");
            await runtime.ui.custom(() => ({ render: () => [], invalidate() {} }));
            try { await runtime.ui.input("Rejected"); }
            catch { /* The lifecycle must still close the failed prompt. */ }
            runtime.ui.notify("done");
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  bindContext(host, root);
  let inputs = 0;
  host.setDirectUiHandler(() => ({
    ...directUiContext(),
    async input() {
      inputs += 1;
      if (inputs === 2) throw new Error("dialog rejected");
      return "value";
    },
  }));

  assert.deepEqual(await host.runCommand("all-prompts", {
    args: "",
    threadId: "thread-1",
    branch: "main",
    signal: new AbortController().signal,
  }), { handled: true });
  for (let attempt = 0; attempt < 20 && events.length < 12; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(events.map((event) => [event.type, event.kind, event.title]), [
    ["ui_prompt_start", "select", "Select"],
    ["ui_prompt_end", "select", "Select"],
    ["ui_prompt_start", "confirm", "Confirm"],
    ["ui_prompt_end", "confirm", "Confirm"],
    ["ui_prompt_start", "input", "Input"],
    ["ui_prompt_end", "input", "Input"],
    ["ui_prompt_start", "editor", "Editor"],
    ["ui_prompt_end", "editor", "Editor"],
    ["ui_prompt_start", "custom", undefined],
    ["ui_prompt_end", "custom", undefined],
    ["ui_prompt_start", "input", "Rejected"],
    ["ui_prompt_end", "input", "Rejected"],
  ]);
});

test("direct UI prompt lifecycle preserves observer order behind a slow start listener", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-prompt-order-");
  const events: string[] = [];
  let releaseStart!: () => void;
  const startBlocked = new Promise<void>((resolve) => { releaseStart = resolve; });
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [
      {
        name: "slow-prompt-observer",
        factory(api) {
          api.on("ui_prompt_start", async () => {
            events.push("slow:start");
            await startBlocked;
          });
        },
      },
      {
        name: "ordered-prompt-observer",
        factory(api) {
          api.on("ui_prompt_start", () => { events.push("observer:start"); });
          api.on("ui_prompt_end", () => { events.push("observer:end"); });
        },
      },
      {
        name: "prompt-caller",
        factory(api) {
          api.on("session_start", async (_event, runtime) => {
            await runtime.ui.input("Question");
          });
        },
      },
    ],
  });
  context.after(async () => await host.close());
  host.setDirectUiHandler(() => ({
    ...directUiContext(),
    async input() { return "answer"; },
  }));

  await host.dispatch("session_start", { reason: "startup", threadId: "thread-1" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseStart();
  for (let attempt = 0; attempt < 20 && events.length < 3; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(events, ["slow:start", "observer:start", "observer:end"]);
});

test("session shutdown listeners settle in extension load and registration order", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-shutdown-order-");
  const order: string[] = [];
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [
      {
        name: "shutdown-first",
        factory(api) {
          api.on("session_shutdown", async () => {
            order.push("first:start");
            await new Promise<void>((resolve) => setImmediate(resolve));
            order.push("first:end");
          });
        },
      },
      {
        name: "shutdown-second",
        factory(api) {
          api.on("session_shutdown", () => { order.push("second"); });
        },
      },
    ],
  });
  context.after(async () => await host.close());

  await host.dispatch("session_shutdown", { reason: "quit" });
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("owner-aware direct UI takes precedence over the compatibility session fallback", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-ui-precedence-");
  const directOwners: string[] = [];
  let sessionStatuses = 0;
  const listener = (api: PluginAPI): void => {
    api.on("session_start", (_event, runtime) => runtime.ui.setStatus("phase", "ready"));
  };
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [
      { name: "Alpha", factory: listener },
      { name: "alpha", factory: listener },
    ],
  });
  context.after(async () => await host.close());
  host.setSessionUiHandler(() => directUiContext(() => { sessionStatuses += 1; }));
  host.setDirectUiHandler((_extensionId, _signal, ownerKey) =>
    directUiContext(() => { directOwners.push(ownerKey); }));

  await host.dispatch("session_start", {});
  assert.equal(new Set(directOwners).size, 2);
  assert.equal(sessionStatuses, 0);

  host.setDirectUiHandler(undefined);
  await host.dispatch("session_start", {});
  assert.equal(sessionStatuses, 2);
});

test("invalid command objects and handlers roll back their activation transactions", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-invalid-command-");
  const invalidObjectPath = join(root, "invalid-object.mjs");
  const invalidObjectSource = `export default (api) => {
    api.onDispose(() => { globalThis.__invalidCommandDisposals += 1; });
    api.registerFlag("staged-flag", { type: "boolean", default: true });
    api.registerCommand("broken-object", null);
  };\n`;
  const invalidHandlerPath = join(root, "invalid-handler.mjs");
  const invalidHandlerSource = `export default (api) => {
    api.onDispose(() => { globalThis.__invalidCommandDisposals += 1; });
    api.registerFlag("staged-flag", { type: "boolean", default: true });
    api.registerCommand("broken-handler", { handler: 42 });
  };\n`;
  await writeFile(invalidObjectPath, invalidObjectSource);
  await writeFile(invalidHandlerPath, invalidHandlerSource);
  globalThis.__invalidCommandDisposals = 0;
  const host = await loadTestDirectExtensions([
    {
      extensionId: "invalid-command-object",
      sourcePath: invalidObjectPath,
      sha256: sha256(invalidObjectSource),
      trusted: true,
    },
    {
      extensionId: "invalid-command-handler",
      sourcePath: invalidHandlerPath,
      sha256: sha256(invalidHandlerSource),
      trusted: true,
    },
  ], { workspace: root, activationFailure: "diagnostic" });
  context.after(async () => {
    await host.close();
    Reflect.deleteProperty(globalThis, "__invalidCommandDisposals");
  });

  assert.equal(globalThis.__invalidCommandDisposals, 2);
  assert.deepEqual(host.plugins(), []);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.flags(), []);
  assert.equal(host.diagnostics().some((entry) => /command registration must be an object/iu.test(entry.message)), true);
  assert.equal(host.diagnostics().some((entry) => /command handler must be a function/iu.test(entry.message)), true);
});

test("failed and timed-out activations dispose staged resources in LIFO order", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-staged-dispose-");
  const failedOrder: string[] = [];
  const host = await loadDirectPlugins([], {
    workspace: root,
    inlinePlugins: [(api) => {
      api.onDispose(() => { failedOrder.push("first"); });
      api.onDispose(() => {
        failedOrder.push("second");
        throw new Error("staged cleanup failed");
      });
      throw new Error("staged activation failed");
    }],
  });
  context.after(async () => await host.close());
  assert.deepEqual(failedOrder, ["second", "first"]);
  assert.equal(host.plugins().length, 0);
  assert.equal(host.diagnostics().some((entry) => /staged activation failed/u.test(entry.message)), true);
  assert.equal(host.diagnostics().some((entry) => /staged cleanup failed/u.test(entry.message)), true);

  const timedOutOrder: string[] = [];
  await assert.rejects(loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    inlinePlugins: [{
      name: "timed-out-staged-disposer",
      async factory(api) {
        api.onDispose(() => { timedOutOrder.push("disposed"); });
        await new Promise(() => {});
      },
    }],
  }), /Aborted|timed out/iu);
  assert.deepEqual(timedOutOrder, ["disposed"]);
});

test("inline cleanup cannot replace the original factory failure with a late timeout", async (context) => {
  const root = await workspace(context, "ohm-inline-runtime-cleanup-classification-");
  await assert.rejects(loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    loadTimeoutMs: 5_000,
    shutdownTimeoutMs: 200,
    inlinePlugins: [{
      name: "cleanup-classification",
      factory(api) {
        api.onDispose(() => new Promise((resolve) => setTimeout(resolve, 80)));
        throw new Error("original inline activation failure");
      },
    }],
  }), /original inline activation failure/u);
});

test("inline data-path failures become diagnostics without invoking the factory", async (context) => {
  const root = await workspace(context, "ohm-inline-runtime-data-path-");
  const dataRoot = join(root, "not-a-directory");
  await writeFile(dataRoot, "fixture");
  let invoked = false;
  const host = await loadDirectPlugins([], {
    workspace: root,
    dataRoot,
    inlinePlugins: [{
      name: "data-path-failure",
      factory() { invoked = true; },
    }],
  });
  context.after(async () => await host.close());

  assert.equal(invoked, false);
  assert.equal(host.plugins().length, 0);
  assert.equal(host.diagnostics().length, 1);
  assert.equal(host.diagnostics()[0]?.extensionId, "inline-data-path-failure");
});

test("diagnostic inline load timeout disposes the candidate and skips remaining factories", async (context) => {
  const root = await workspace(context, "ohm-inline-runtime-load-timeout-");
  const order: string[] = [];
  const host = await loadDirectPlugins([], {
    workspace: root,
    loadTimeoutMs: 2_000,
    activationTimeoutMs: 5_000,
    inlinePlugins: [{
      name: "load-timeout",
      async factory(api) {
        order.push("started");
        api.onDispose(() => { order.push("disposed"); });
        await new Promise(() => {});
      },
    }, {
      name: "must-not-run",
      factory() { order.push("unexpected"); },
    }],
  });
  context.after(async () => await host.close());

  assert.deepEqual(order, ["started", "disposed"]);
  assert.equal(host.plugins().length, 0);
  assert.match(host.diagnostics()[0]?.message ?? "", /load timed out after 2000ms/u);
});

test("external cancellation rejects inline activation after disposing and staling its candidate", async (context) => {
  const root = await workspace(context, "ohm-inline-runtime-cancel-");
  const controller = new AbortController();
  const cancellation = Object.freeze({ kind: "external-inline-cancellation" });
  let capturedApi: PluginAPI | undefined;
  let disposals = 0;

  await assert.rejects(loadDirectPlugins([], {
    workspace: root,
    signal: controller.signal,
    loadTimeoutMs: 5_000,
    activationTimeoutMs: 2_000,
    inlinePlugins: [{
      name: "externally-cancelled",
      async factory(api) {
        capturedApi = api;
        api.onDispose(() => { disposals += 1; });
        setTimeout(() => controller.abort(cancellation), 25);
        await new Promise(() => {});
      },
    }],
  }), (cause: unknown) => cause === cancellation);

  assert.equal(disposals, 1);
  assert.ok(capturedApi);
  const staleApi = capturedApi;
  assert.throws(() => staleApi.getCommands(), /no longer active/u);
});

test("hash mismatches stay inert while reserved commands receive a namespaced invocation", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-invalid-");
  const changedPath = join(root, "changed.mjs");
  await writeFile(changedPath, "export default () => {};\n");
  const reservedPath = join(root, "reserved.mjs");
  const reservedSource = `export default (ohm) => {
    ohm.registerCommand("copy", { async handler() { globalThis.__reservedCommandRan = true; } });
  };\n`;
  await writeFile(reservedPath, reservedSource);

  const host = await loadTestDirectExtensions([
    { extensionId: "changed", sourcePath: changedPath, sha256: sha256("different"), trusted: true },
    { extensionId: "reserved", sourcePath: reservedPath, sha256: sha256(reservedSource), trusted: true },
  ], { workspace: root });
  context.after(async () => await host.close());

  bindContext(host, root);
  assert.deepEqual(host.commands().map((command) => [command.name, command.baseName]), [["copy:1", "copy"]]);
  assert.equal(host.hasCommand("copy"), false);
  assert.equal(host.hasCommand("copy:1"), true);
  assert.deepEqual(await host.runCommand("copy:1", {
    args: "",
    threadId: "direct-runtime-session",
    signal: new AbortController().signal,
  }), { handled: true });
  assert.equal(globalThis.__reservedCommandRan, true);
  assert.equal(host.diagnostics().length, 2);
  assert.equal(host.diagnostics().some((entry) => /changed after resolution/u.test(entry.message)), true);
  assert.equal(host.diagnostics().some((entry) => /command copy conflicts with a built-in command.*copy:1/u.test(entry.message)), true);
  Reflect.deleteProperty(globalThis, "__reservedCommandRan");
});

test("shared event topics accept arbitrary nonempty bounded strings", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-event-topic-");
  let sharedEvents: PluginAPI["events"] | undefined;
  let received: unknown;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "event-topic",
      factory(api) {
        sharedEvents = api.events;
        api.events.on("my:notification", (payload) => { received = payload; });
      },
    }],
  });
  context.after(async () => await host.close());

  const events = sharedEvents;
  if (events === undefined) throw new Error("Shared EventBus was not captured");
  events.emit("my:notification", { ready: true });
  assert.deepEqual(received, { ready: true });
  const dispose = events.on("x".repeat(1_024), () => undefined);
  dispose();
  assert.throws(() => events.on("", () => undefined), /non-empty/u);
  assert.throws(() => events.emit("contains\0nul", undefined), /contains NUL/u);
  assert.throws(() => events.emit("x".repeat(1_025), undefined), /1024 bytes/u);
});

test("activation publishes shared listeners and emissions atomically", async (context) => {
  const cases: Array<{ name: string; eventBus?: EventBus }> = [
    { name: "host-local" },
    { name: "supplied", eventBus: createEventBus() },
  ];

  for (const selected of cases) {
    await context.test(selected.name, async (nested) => {
      const root = await workspace(nested, `ohm-direct-runtime-event-transaction-${selected.name}-`);
      const observed: string[] = [];
      const describe = (owner: string, payload: JsonValue): string => {
        const value = isJsonObject(payload) && "value" in payload
          ? String(payload.value)
          : String(payload);
        return `${owner}:${value}`;
      };
      const loadOptions: RuntimePluginLoadOptions = {
        workspace: root,
        activationFailure: "diagnostic",
        inlinePlugins: [
          {
            name: "committed-listener",
            factory(ohm) {
              ohm.events.on("audit:transaction", (payload) => {
                observed.push(describe("committed", payload));
              });
            },
          },
          {
            name: "rejected-emitter",
            factory(ohm) {
              ohm.events.on("audit:transaction", (payload) => {
                observed.push(describe("rejected", payload));
              });
              ohm.events.emit("audit:transaction", "rollback");
              throw new Error("candidate rejected after emit");
            },
          },
          {
            name: "committed-emitter",
            factory(ohm) {
              const disposeBeforeCommit = ohm.events.on("audit:transaction", (payload) => {
                observed.push(describe("disposed", payload));
              });
              disposeBeforeCommit();
              ohm.events.on("audit:transaction", (payload) => {
                observed.push(describe("candidate", payload));
              });
              const first = { value: "first" };
              ohm.events.emit("audit:transaction", first);
              first.value = "mutated-after-emit";
              const array = ["array"];
              ohm.events.emit("audit:transaction", array);
              array[0] = "mutated-after-emit";
              ohm.events.emit("audit:transaction", "second");
            },
          },
        ],
      };
      if (selected.eventBus !== undefined) loadOptions.eventBus = selected.eventBus;
      const host = await loadDirectPlugins([], loadOptions);
      nested.after(async () => await host.close());

      assert.deepEqual(observed, [
        "committed:first",
        "candidate:first",
        "committed:array",
        "candidate:array",
        "committed:second",
        "candidate:second",
      ]);
      assert.deepEqual(host.plugins().map((entry) => entry.extensionId), [
        "inline-committed-listener",
        "inline-committed-emitter",
      ]);
      assert.equal(host.diagnostics().some((entry) => /candidate rejected after emit/u.test(entry.message)), true);
    });
  }
});

test("activation bounds the staged shared event queue", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-event-bounds-");
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    inlinePlugins: [
      {
        name: "count-bound",
        factory(ohm) {
          assert.throws(
            () => ohm.events.emit("audit:bounds", () => undefined),
            /payload must contain only JSON values/u,
          );
          assert.throws(
            () => ohm.events.emit("audit:bounds", "x".repeat(1024 * 1024)),
            /payload exceeds 1048576 (?:UTF-8 )?bytes/u,
          );
          assert.throws(
            () => ohm.events.emit("audit:bounds", "\0".repeat(200_000)),
            /payload exceeds 1048576 (?:UTF-8 )?bytes/u,
          );
          for (let index = 0; index < 1_024; index += 1) ohm.events.emit("audit:bounds", null);
          assert.throws(
            () => ohm.events.emit("audit:bounds", null),
            /emissions exceed 1024/u,
          );
        },
      },
      {
        name: "aggregate-byte-bound",
        factory(ohm) {
          const maximumPayload = "x".repeat((1024 * 1024) - 2);
          for (let index = 0; index < 4; index += 1) {
            ohm.events.emit("audit:bounds", maximumPayload);
          }
          assert.throws(
            () => ohm.events.emit("audit:bounds", "x"),
            /payloads exceed 4194304 bytes/u,
          );
        },
      },
      {
        name: "shape-bounds",
        factory(ohm) {
          assert.throws(
            () => ohm.events.emit("audit:bounds", Array.from({ length: 8_192 }, () => null)),
            /exceeds 8192 JSON values/u,
          );
          assert.throws(
            () => ohm.events.emit("audit:bounds", Array.from({ length: 4_096 }, () => ({}))),
            /exceeds 4096 (?:JSON )?containers/u,
          );
          let deep: JsonObject = {};
          for (let depth = 0; depth <= 59; depth += 1) deep = { child: deep };
          assert.throws(
            () => ohm.events.emit("audit:bounds", deep),
            /exceeds 59 levels/u,
          );
          let accessorCalls = 0;
          const accessorPayload: JsonObject = {};
          Object.defineProperty(accessorPayload, "value", {
            enumerable: true,
            get() {
              accessorCalls += 1;
              return "must-not-run";
            },
          });
          assert.throws(
            () => ohm.events.emit("audit:bounds", accessorPayload),
            /enumerable data properties/u,
          );
          assert.equal(accessorCalls, 0);

          let toJsonCalls = 0;
          const inheritedToJson: JsonObject = { value: "ready" };
          Object.setPrototypeOf(inheritedToJson, {
            toJSON() {
              toJsonCalls += 1;
              return { value: "must-not-run" };
            },
          });
          assert.throws(
            () => ohm.events.emit("audit:bounds", inheritedToJson),
            /plain objects and (?:vanilla )?arrays/u,
          );
          assert.equal(toJsonCalls, 0);

          const sparse: JsonValue[] = [];
          sparse.length = 1;
          assert.throws(
            () => ohm.events.emit("audit:bounds", sparse),
            /dense arrays without extra properties/u,
          );
          const symbolPayload: JsonObject = { value: "ready" };
          Object.defineProperty(symbolPayload, Symbol("hidden"), { value: true });
          assert.throws(
            () => ohm.events.emit("audit:bounds", symbolPayload),
            /symbol keys/u,
          );
          const cyclic: JsonObject = {};
          cyclic.self = cyclic;
          assert.throws(
            () => ohm.events.emit("audit:bounds", cyclic),
            /must not contain cycles/u,
          );
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.diagnostics(), []);
});

test("the default supplied event bus treats error as an ordinary activation and live topic", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-event-error-topic-");
  let events: PluginAPI["events"] | undefined;
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    eventBus: createEventBus(),
    inlinePlugins: [{
      name: "error-emitter",
      factory(ohm) {
        events = ohm.events;
        ohm.events.emit("error", { phase: "activation" });
      },
    }],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.plugins().map((entry) => entry.extensionId), ["inline-error-emitter"]);
  assert.deepEqual(host.diagnostics(), []);
  const capturedEvents = events;
  if (capturedEvents === undefined) throw new Error("Shared event API was not captured");
  assert.doesNotThrow(() => capturedEvents.emit("error", { phase: "live-without-listener" }));
  let live: unknown;
  capturedEvents.on("error", (payload) => { live = payload; });
  capturedEvents.emit("error", { phase: "live" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(live, { phase: "live" });
});

for (const selected of [{
  name: "a supplied event bus cannot leave a half-committed generation",
  topic: "audit:reject",
  reject() { throw new Error("supplied bus rejected subscription"); },
  diagnostic: /supplied bus rejected subscription/u,
}, {
  name: "a supplied event bus with an invalid unsubscribe result rejects and rolls back the candidate",
  topic: "audit:invalid",
  reject() { return undefined; },
  diagnostic: /unsubscribe function/u,
}]) {
  test(selected.name, async (context) => {
    const root = await workspace(context, "ohm-direct-runtime-event-bus-failure-");
    const sourcePath = join(root, "candidate.mjs");
    await writeFile(sourcePath, `export default (ohm) => {
      ohm.events.on("audit:first", () => undefined);
      ohm.events.on(${JSON.stringify(selected.topic)}, () => undefined);
      ohm.registerCommand("must-not-commit", { handler() {} });
    };\n`);
    let activeListeners = 0;
    let unsubscriptions = 0;
    const eventBus = {
      emit() {},
      on() {
        activeListeners += 1;
        return () => {
          activeListeners -= 1;
          unsubscriptions += 1;
        };
      },
    } satisfies EventBus;
    const subscribe = eventBus.on;
    Object.defineProperty(eventBus, "on", {
      value(topic: string) {
        return topic === selected.topic ? selected.reject() : subscribe();
      },
    });
    const host = await loadDirectPlugins([], { workspace: root });
    context.after(async () => await host.close());

    await assert.rejects(
      appendDirectPlugins(host, [sourcePath], {
        workspace: root,
        activationFailure: "throw",
        eventBus,
      }),
      selected.diagnostic,
    );
    assert.equal(activeListeners, 0);
    assert.equal(unsubscriptions, 1);
    assert.deepEqual(host.plugins(), []);
    assert.deepEqual(host.commands(), []);
    await assert.doesNotReject(host.close());
  });
}

test("a reentrant supplied event bus cannot leak a live subscription while closing the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohm-direct-runtime-event-bus-reentrant-"));
  let sharedEvents: PluginAPI["events"] | undefined;
  let closeHost: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let activeListeners = 0;
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() {},
    on() {
      activeListeners += 1;
      closePromise = closeHost?.();
      return () => {
        activeListeners -= 1;
        unsubscriptions += 1;
      };
    },
  };
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlinePlugins: [{
      name: "reentrant-event-bus",
      factory(ohm) { sharedEvents = ohm.events; },
    }],
  });
  closeHost = async () => await host.close();

  const capturedEvents = sharedEvents;
  if (capturedEvents === undefined) throw new Error("Shared event API was not captured");
  assert.throws(
    () => capturedEvents.on("audit:reentrant", () => undefined),
    /Runtime plugin host is closed/u,
  );
  await closePromise;
  assert.equal(activeListeners, 0);
  assert.equal(unsubscriptions, 1);
  await rm(root, { recursive: true, force: true });
});

test("pre-commit shared event disposal releases staged accounting and preserves the active listener cap", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-event-bus-disposed-staging-");
  let sharedEvents: PluginAPI["events"] | undefined;
  let disposeActive: (() => void) | undefined;
  let activeListeners = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() {},
    on() {
      activeListeners += 1;
      subscriptions += 1;
      return () => {
        activeListeners -= 1;
        unsubscriptions += 1;
      };
    },
  };
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlinePlugins: [{
      name: "disposed-staged-events",
      factory(ohm) {
        sharedEvents = ohm.events;
        for (let index = 0; index < 2_000; index += 1) {
          const retained = Array.from({ length: 128 }, () => index);
          const dispose = ohm.events.on(`audit:disposed:${index}`, () => { void retained[0]; });
          dispose();
        }
        for (let index = 0; index < 1_024; index += 1) {
          const dispose = ohm.events.on(`audit:active:${index}`, () => undefined);
          if (index === 0) disposeActive = dispose;
        }
      },
    }],
  });
  context.after(async () => await host.close());

  assert.equal(subscriptions, 1_024);
  assert.equal(activeListeners, 1_024);
  const capturedEvents = sharedEvents;
  if (capturedEvents === undefined || disposeActive === undefined) {
    throw new Error("Shared event API or disposer was not captured");
  }
  assert.throws(
    () => capturedEvents.on("audit:over-cap", () => undefined),
    /listeners exceed 1024/u,
  );
  disposeActive();
  capturedEvents.on("audit:replacement", () => undefined);
  assert.equal(subscriptions, 1_025);
  assert.equal(activeListeners, 1_024);
  await host.close();
  assert.equal(activeListeners, 0);
  assert.equal(unsubscriptions, 1_025);
});

test("live shared event emissions are bounded detached snapshots on local and supplied buses", async (context) => {
  for (const selected of ["host-local", "supplied"] as const) {
    await context.test(selected, async (nested) => {
      const root = await workspace(nested, `ohm-direct-runtime-live-event-${selected}-`);
      const observed: unknown[] = [];
      let sharedEvents: PluginAPI["events"] | undefined;
      const loadOptions: RuntimePluginLoadOptions = {
        workspace: root,
        activationFailure: "throw",
        inlinePlugins: [
          {
            name: "live-listener",
            factory(ohm) {
              ohm.events.on("audit:live-snapshot", async (payload) => {
                await new Promise((resolve) => setImmediate(resolve));
                observed.push(payload);
              });
            },
          },
          {
            name: "live-emitter",
            factory(ohm) { sharedEvents = ohm.events; },
          },
        ],
      };
      if (selected === "supplied") loadOptions.eventBus = createEventBus();
      const host = await loadDirectPlugins([], loadOptions);
      nested.after(async () => await host.close());
      const capturedEvents = sharedEvents;
      if (capturedEvents === undefined) throw new Error("Shared event API was not captured");

      const mutable = { value: "before" };
      capturedEvents.emit("audit:live-snapshot", mutable);
      mutable.value = "after";
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(observed, [{ value: "before" }]);

      let toJsonCalls = 0;
      const hostile: JsonObject = { value: "ready" };
      Object.setPrototypeOf(hostile, {
        toJSON() {
          toJsonCalls += 1;
          return { rewritten: true };
        },
      });
      assert.throws(
        () => capturedEvents.emit("audit:live-snapshot", hostile),
        /plain objects and (?:vanilla )?arrays/u,
      );
      assert.throws(
        () => capturedEvents.emit("audit:live-snapshot", "x".repeat((1024 * 1024) + 1)),
        /exceeds 1048576 (?:UTF-8 )?bytes/u,
      );
      assert.equal(toJsonCalls, 0);
      assert.equal(observed.length, 1);
    });
  }
});

test("supplied event bus inbound payloads are validated before extension listeners run", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-event-bus-inbound-payload-");
  let deliver: EventHandler | undefined;
  let listenerCalls = 0;
  const eventBus: EventBus = {
    emit() {},
    on(_topic, handler) {
      deliver = handler;
      return () => undefined;
    },
  };
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlinePlugins: [{
      name: "inbound-listener",
      factory(ohm) {
        ohm.events.on("audit:inbound", () => { listenerCalls += 1; });
      },
    }],
  });
  context.after(async () => await host.close());
  const capturedDeliver = deliver;
  if (capturedDeliver === undefined) throw new Error("Supplied bus handler was not captured");

  let toJsonCalls = 0;
  const hostile: JsonObject = { value: "ready" };
  Object.setPrototypeOf(hostile, {
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  });
  const diagnosticsBefore = host.diagnostics().length;
  await capturedDeliver(hostile);
  assert.equal(toJsonCalls, 0);
  assert.equal(listenerCalls, 0);
  assert.equal(host.diagnostics().length, diagnosticsBefore + 1);
  assert.match(host.diagnostics().at(-1)?.message ?? "", /shared event audit:inbound/u);
});

test("a supplied event bus emit failure is isolated after commit", async (context) => {
  const root = await workspace(context, "ohm-direct-runtime-event-bus-emit-failure-");
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() { throw new Error("supplied bus rejected emission"); },
    on() {
      return () => { unsubscriptions += 1; };
    },
  };
  const host = await loadDirectPlugins([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlinePlugins: [{
      name: "emit-failure",
      factory(ohm) {
        ohm.events.on("audit:emit", () => undefined);
        ohm.events.emit("audit:emit", { ready: true });
      },
    }],
  });

  assert.deepEqual(host.plugins().map((entry) => entry.extensionId), ["inline-emit-failure"]);
  assert.equal(host.diagnostics().some((entry) => /supplied bus rejected emission/u.test(entry.message)), true);
  await host.close();
  assert.equal(unsubscriptions, 1);
});

test("closing a runtime extension host detaches diagnostic observers", async (context) => {
  const { host } = await loadSource(context, "export default () => {};\n", {
    workspace: "",
    activationFailure: "throw",
  });
  const observed: string[] = [];
  host.onError((diagnostic) => observed.push(diagnostic.message));

  host.addDiagnostic({ extensionId: "probe", sourcePath: "", message: "before close" });
  assert.deepEqual(observed, ["before close"]);

  await host.close();
  host.addDiagnostic({ extensionId: "probe", sourcePath: "", message: "after close" });
  assert.deepEqual(observed, ["before close"]);
  assert.deepEqual(host.diagnostics().map((diagnostic) => diagnostic.message), ["before close", "after close"]);
});

test("direct tools may intentionally replace built-in tool names", async (context) => {
  const source = `export default (ohm) => {
    ohm.registerTool({
      name: "read",
      label: "Replacement read",
      description: "A direct replacement",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() { return { content: [{ type: "text", text: "replacement" }], details: {} }; }
    });
  };\n`;
  const { host } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  context.after(async () => await host.close());
  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["read"]);
});

test("direct extension tools accept nullable array parameters", async (context) => {
  const source = `export default (ohm) => {
    ohm.registerTool({
      name: "nullable_array",
      label: "Nullable array",
      description: "Accept an array or null",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["values"],
        properties: {
          values: { type: ["array", "null"], items: { type: "string" } }
        }
      },
      async execute() {
        return { content: [{ type: "text", text: "accepted" }], details: {} };
      }
    });
  };\n`;
  const { host } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  context.after(async () => await host.close());
  const tool = host.tools()[0];
  assert.ok(tool);
  assert.doesNotThrow(() => tool.validate({ values: null }));
  assert.doesNotThrow(() => tool.validate({ values: ["ready"] }));
  assert.throws(() => tool.validate({ values: [{}] }), /must be string/u);
});
