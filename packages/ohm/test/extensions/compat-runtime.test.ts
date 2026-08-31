import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { UserMessage } from "@ohm/kernel";
import type { Api, AssistantMessage, Model } from "@ohm/models";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core/json.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import {
  attachExtensionRuntimeHost,
  createExtensionRuntime,
  ExtensionRunner,
  getExtensionRuntimeHost,
} from "../../src/extensions/compat-runtime.js";
import { projectLoadedExtensionHost } from "../../src/extensions/compat.js";
import {
  extensionModelRegistry,
  type ExtensionModelCompletion,
} from "../../src/extensions/model-boundary.js";
import type {
  Extension,
  ExtensionActions,
  ExtensionContextActions,
  ExtensionEventMap,
  ExtensionHandler,
} from "../../src/extensions/direct.js";
import {
  loadDirectExtensions,
  type RuntimeDirectActionsHandler,
} from "../../src/extensions/runtime.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const roots = new Set<string>();
const COUNT_PAYLOAD_VALUE = Type.Object({ count: Type.Number() });
const GUARD_EVENTS = ["session_before_switch", "session_before_fork"] as const;
const TEST_MODEL: Model<Api> = {
  id: "compat-runtime-model",
  name: "Compatibility runtime model",
  api: "openai-completions",
  provider: "compat-runtime",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
};

type GuardEvent = (typeof GUARD_EVENTS)[number];

interface GuardBoundaryCandidate {
  cancel?: boolean | string;
  reason?: number | string;
  extra?: boolean;
  toJSON?(): { cancel: boolean };
}

type GuardBoundaryResult = "throw" | GuardBoundaryCandidate;

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-compat-runtime-"));
  roots.add(cwd);
  return cwd;
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function extension(path: string): Extension {
  return {
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, { source: "test" }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function on<K extends keyof ExtensionEventMap>(
  selected: Extension,
  event: K,
  handler: ExtensionHandler<K>,
): void {
  const handlers = selected.handlers.get(event) ?? [];
  // SAFETY: The erased handler map is keyed by the same event K used to type this handler.
  handlers.push(handler as ExtensionHandler);
  selected.handlers.set(event, handlers);
}

function onGuardBoundary(
  selected: Extension,
  event: GuardEvent,
  handler: () => GuardBoundaryResult,
): void {
  const handlers = selected.handlers.get(event) ?? [];
  // SAFETY: This hardening test deliberately injects malformed guard results at the erased runtime boundary.
  handlers.push(handler as ExtensionHandler);
  selected.handlers.set(event, handlers);
}

function requireCountPayload(value: JsonValue): { count: number } {
  if (!Value.Check(COUNT_PAYLOAD_VALUE, value)) throw new Error("Count payload fixture is invalid");
  return value;
}

function requireJsonObject<ValueType>(value: ValueType): JsonObject {
  if (!isJsonObject(value)) throw new Error("Provider request fixture must be a JSON object");
  return value;
}

function command(selected: Extension, name: string) {
  return {
    name,
    sourceInfo: selected.sourceInfo,
    async handler() {},
  };
}

function actions(): ExtensionActions {
  return {
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    getActiveTools: () => ["read"],
    getAllTools: () => [],
    setActiveTools() {},
    refreshTools() {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
  };
}

function contextActions(): ExtensionContextActions {
  return {
    getModel: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "system",
  };
}

function directActions(cwd: string): RuntimeDirectActionsHandler {
  return {
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
    getSystemPromptOptions: () => ({ cwd }),
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async refresh() {},
  };
}

test("compatibility runner exposes ordered Markdown transformers", async () => {
  const cwd = await workspace();
  const first = extension("/first.ts");
  const second = extension("/second.ts");
  first.markdownTransformer = (markdown) => `first:${markdown}`;
  second.markdownTransformer = (markdown) => `${markdown}:second`;
  const runner = new ExtensionRunner(
    [first, second],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const transformed = runner.getMarkdownTransformers().reduce(
    (markdown, transform) => transform(markdown, {
      messageType: "assistant",
      isStreaming: false,
      availableWidth: 80,
    }),
    "body",
  );
  assert.equal(transformed, "first:body:second");
});

test("zero-argument runtime preserves pre-bind actions, provider queues, and staleness", async () => {
  const runtime = createExtensionRuntime();
  assert.equal(getExtensionRuntimeHost(runtime), undefined);
  assert.throws(() => runtime.getActiveTools(), /before the session host is bound/u);
  await assert.rejects(runtime.setModel(TEST_MODEL), /before the session host is bound/u);
  assert.doesNotThrow(() => runtime.refreshTools());

  runtime.registerProvider("queued", {}, "/queued.ts");
  assert.deepEqual(runtime.pendingProviderRegistrations, [{ name: "queued", config: {}, extensionPath: "/queued.ts" }]);
  runtime.unregisterProvider("queued");
  assert.deepEqual(runtime.pendingProviderRegistrations, []);

  runtime.invalidate("stale test runtime");
  assert.throws(() => runtime.getCommands(), /stale test runtime/u);
});

test("five-argument runner binds actions and keeps projection resolution deterministic", async () => {
  const cwd = await workspace();
  const runtime = createExtensionRuntime();
  const first = extension("/first.ts");
  const second = extension("/second.ts");
  first.flags.set("mode", {
    name: "mode",
    type: "string",
    default: "first",
    extensionPath: first.path,
  });
  second.flags.set("mode", {
    name: "mode",
    type: "string",
    default: "second",
    extensionPath: second.path,
  });
  const command = (owner: Extension, description: string) => ({
    name: "probe",
    description,
    sourceInfo: owner.sourceInfo,
    async handler() {},
  });
  first.commands.set("probe", command(first, "first"));
  second.commands.set("probe", command(second, "second"));

  runtime.registerProvider("queued", {}, first.path);
  const registered: string[] = [];
  const runner = new ExtensionRunner(
    [first, second],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  let acknowledgedDeliveries = 0;
  runner.bindCore(actions(), {
    ...contextActions(),
    getSessionDelivery: () => ({
      sessionId: "compat-session",
      async sendMessage() { acknowledgedDeliveries += 1; },
      async sendUserMessage() { acknowledgedDeliveries += 1; },
    }),
  }, {
    registerProvider(name) { registered.push(name); },
  });

  assert.deepEqual(registered, ["queued"]);
  assert.deepEqual(runner.getActiveTools(), ["read"]);
  assert.equal(runner.createContext().getSystemPrompt(), "system");
  assert.equal(runner.createContext().thinkingLevel, "off");
  assert.equal(runner.getFlags().get("mode")?.default, "first");
  assert.deepEqual(runner.getRegisteredCommands().map((entry) => entry.invocationName), ["probe:1", "probe:2"]);
  const pathsSnapshot = runner.getExtensionPaths();
  const activeToolsSnapshot = runner.getActiveTools();
  const flagsSnapshot = runner.getFlags();
  pathsSnapshot.length = 0;
  activeToolsSnapshot.length = 0;
  flagsSnapshot.clear();
  assert.deepEqual(runner.getExtensionPaths(), [first.path, second.path]);
  assert.deepEqual(runner.getActiveTools(), ["read"]);
  assert.equal(runner.getFlags().get("mode")?.default, "first");

  const failures: string[] = [];
  const unsubscribe = runner.onError((error) => failures.push(error.error));
  runner.emitError({ extensionPath: first.path, event: "probe", error: "failure" });
  unsubscribe();
  assert.deepEqual(failures, ["failure"]);

  const context = runner.createContext();
  const delivery = context.sessionDelivery;
  assert.equal(delivery.sessionId, "compat-session");
  await delivery.sendMessage({ customType: "compat", content: "accepted", display: false });
  assert.equal(acknowledgedDeliveries, 1);
  runner.invalidate("stale runner");
  assert.throws(() => context.isIdle(), /stale runner/u);
  await assert.rejects(
    delivery.sendUserMessage("late"),
    /stale runner/u,
  );
  assert.equal(acknowledgedDeliveries, 1);
});

test("compat callback model completion is bound to callback and runner lifetime", async (context) => {
  const cwd = await workspace();
  const runtime = createExtensionRuntime();
  const modelRegistry = new ModelRegistry(createModels());
  const publicRegistry = extensionModelRegistry(modelRegistry);
  const callbackSignals = [new AbortController(), new AbortController(), new AbortController()];
  let activeCallback = callbackSignals[0]!;
  const observedSignals: AbortSignal[] = [];
  const completion: AssistantMessage = {
    role: "assistant",
    content: [],
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: {},
    stopReason: "stop",
    timestamp: 0,
  };
  const completeModel: ExtensionModelCompletion = (_model, _modelContext, options) => {
    const signal = options?.signal;
    assert.ok(signal);
    observedSignals.push(signal);
    if (observedSignals.length < 3) return Promise.resolve(completion);
    return new Promise((_resolve, reject) => {
      const fail = (): void => { reject(signal.reason); };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  };
  publicRegistry.complete = completeModel;
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    modelRegistry,
  );
  context.after(async () => await getExtensionRuntimeHost(runtime)?.close());
  runner.bindCore(actions(), {
    ...contextActions(),
    getSignal: () => activeCallback.signal,
    completeModel,
  });

  const caller = new AbortController();
  const firstComplete = runner.createContext().modelRegistry.complete;
  await firstComplete(TEST_MODEL, { messages: [] }, { signal: caller.signal });
  assert.notStrictEqual(observedSignals[0], caller.signal);
  assert.notStrictEqual(observedSignals[0], callbackSignals[0]!.signal);
  caller.abort(new Error("caller completion cancelled"));
  assert.equal(observedSignals[0]?.aborted, true);
  assert.match(String(observedSignals[0]?.reason), /caller completion cancelled/u);

  activeCallback = callbackSignals[1]!;
  const secondComplete = runner.createContext().modelRegistry.complete;
  await secondComplete(TEST_MODEL, { messages: [] });
  assert.notStrictEqual(observedSignals[1], callbackSignals[1]!.signal);
  callbackSignals[1]!.abort(new Error("callback completion cancelled"));
  assert.equal(observedSignals[1]?.aborted, true);
  assert.match(String(observedSignals[1]?.reason), /callback completion cancelled/u);

  activeCallback = callbackSignals[2]!;
  const retainedComplete = runner.createContext().modelRegistry.complete;
  const pending = retainedComplete(TEST_MODEL, { messages: [] });
  runner.invalidate("stale compat completion");
  await assert.rejects(pending, /stale compat completion/u);
  assert.equal(observedSignals[2]?.aborted, true);
  assert.throws(
    () => { void retainedComplete(TEST_MODEL, { messages: [] }); },
    /stale compat completion/u,
  );
  assert.equal(observedSignals.length, 3);
});

test("command resolution terminates through nested invocation-name collisions", async () => {
  const cwd = await workspace();
  const selected = extension("/commands.ts");
  selected.commands.set("first", command(selected, "probe"));
  selected.commands.set("second", command(selected, "probe"));
  selected.commands.set("nested", command(selected, "probe:1:2"));
  selected.commands.set("literal", command(selected, "probe:1"));
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  assert.deepEqual(runner.getRegisteredCommands().map((entry) => entry.invocationName), [
    "probe:1",
    "probe:2",
    "probe:1:2",
    "probe:1:3",
  ]);
});

test("command collision names remain stable when literal suffixes are registered first", async () => {
  const cwd = await workspace();
  const selected = extension("/grouped-commands.ts");
  selected.commands.set("literal-one", command(selected, "probe:1"));
  selected.commands.set("first", command(selected, "probe"));
  selected.commands.set("second", command(selected, "probe"));
  selected.commands.set("third", command(selected, "probe"));
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  assert.deepEqual(runner.getRegisteredCommands().map((entry) => entry.invocationName), [
    "probe:1",
    "probe:2",
    "probe:3",
    "probe:4",
  ]);
});

test("shortcut conflicts are deterministic and visible without an interactive UI", async () => {
  const cwd = await workspace();
  const secret = "registered-compat-shortcut-secret";
  defaultSecretRedactor.register(secret);
  const first = extension(`/first-${secret}\u001b[31m.ts`);
  const second = extension("/second.ts");
  first.shortcuts.set("ctrl+d", {
    shortcut: "ctrl+d",
    extensionPath: first.path,
    handler() {},
  });
  first.shortcuts.set("alt+x", {
    shortcut: "alt+x",
    extensionPath: first.path,
    handler() {},
  });
  second.shortcuts.set("alt+x", {
    shortcut: "alt+x",
    extensionPath: second.path,
    handler() {},
  });
  const runner = new ExtensionRunner(
    [first, second],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const shortcuts = runner.getShortcuts({ "app.exit": "ctrl+d", "custom.open": "alt+x" });
    assert.equal(shortcuts.get("alt+x")?.extensionPath, second.path);
    assert.equal(shortcuts.has("ctrl+d"), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [
    "Reserved key 'ctrl+d' cannot be assigned by /first-[REDACTED].ts; that registration was ignored.",
    "Key 'alt+x' normally runs custom.open; /first-[REDACTED].ts now owns it.",
    "Key 'alt+x' normally runs custom.open; /second.ts now owns it.",
    "Key 'alt+x' was claimed by /first-[REDACTED].ts and /second.ts; the later registration takes precedence.",
  ]);
  assert.deepEqual(runner.getShortcutDiagnostics().map((entry) => entry.message), warnings);
});

test("standalone projections reduce generic guards and isolate handler failures", async () => {
  const cwd = await workspace();
  const selected = extension("/standalone.ts");
  const observed: string[] = [];
  on(selected, "session_before_switch", () => ({ cancel: false }));
  on(selected, "session_before_switch", () => { throw new Error("guard failed"); });
  on(selected, "session_before_switch", () => ({ cancel: true }));
  on(selected, "session_before_switch", () => { observed.push("after cancel"); });
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));

  assert.equal(runner.hasHandlers("session_before_switch"), true);
  assert.deepEqual(await runner.emit({ type: "session_before_switch", reason: "new" }), { cancel: true });
  assert.deepEqual(observed, []);
  assert.deepEqual(errors, [{ event: "session_before_switch", error: "guard failed" }]);
});

test("compatibility error observers cannot interrupt diagnostics or later handlers", async () => {
  const cwd = await workspace();
  const selected = extension("/observer-isolation.ts");
  const handled: string[] = [];
  let inspected = 0;
  const failure = new Proxy(new Error("handler failed"), {
    getPrototypeOf() {
      inspected += 1;
      throw new Error("hostile rejection was inspected");
    },
  });
  on(selected, "session_start", () => { throw failure; });
  on(selected, "session_start", () => { handled.push("later handler"); });
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const observed: string[] = [];
  runner.onError(() => { throw new Error("observer failed"); });
  runner.onError((entry) => observed.push(entry.error));

  await assert.doesNotReject(runner.emit({ type: "session_start", reason: "startup" }));
  assert.deepEqual(handled, ["later handler"]);
  assert.deepEqual(observed, ["[Thrown object]"]);
  assert.equal(inspected, 0);
  assert.doesNotThrow(() => runner.emitError({
    extensionPath: selected.path,
    event: "probe",
    error: "direct diagnostic",
  }));
  assert.deepEqual(observed, ["[Thrown object]", "direct diagnostic"]);
});

test("standalone switch and fork guards fail closed on malformed results", async () => {
  const cwd = await workspace();
  const selected = extension("/standalone-guards.ts");
  const results = new Map<GuardEvent, GuardBoundaryResult>();
  const later = {
    session_before_switch: 0,
    session_before_fork: 0,
  };
  for (const event of GUARD_EVENTS) {
    onGuardBoundary(selected, event, () => {
      const result = results.get(event);
      if (result === undefined) throw new Error("Guard fixture result is missing");
      if (result === "throw") throw new Error("ordinary guard failure");
      return result;
    });
    on(selected, event, () => {
      later[event] = (later[event] ?? 0) + 1;
      return { cancel: false };
    });
  }
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));
  const invocations = {
    session_before_switch: async () => await runner.emit({ type: "session_before_switch", reason: "new" }),
    session_before_fork: async () => await runner.emit({ type: "session_before_fork", entryId: "entry-1", position: "at" }),
  } as const;
  const malformed = [
    { value: { cancel: "yes" }, diagnostic: /cancel must be a boolean/u },
    { value: { reason: 42 }, diagnostic: /reason must be a string/u },
    { value: { cancel: false, extra: true }, diagnostic: /unknown or owner-controlled field/u },
    { value: { cancel: false, reason: "x".repeat(16 * 1024 + 1) }, diagnostic: /exceeds 16384 (?:UTF-8 )?bytes/u },
  ];
  for (const event of GUARD_EVENTS) {
    const invoke = invocations[event];
    for (const value of malformed) {
      results.set(event, value.value);
      const errorsBefore = errors.length;
      assert.deepEqual(await invoke(), { cancel: true });
      assert.equal(later[event], 0);
      assert.match(errors[errorsBefore]?.error ?? "", value.diagnostic);
    }

    let toJSONCalls = 0;
    const inheritedJsonCandidate: GuardBoundaryCandidate = { cancel: false };
    Object.setPrototypeOf(inheritedJsonCandidate, {
      toJSON() {
        toJSONCalls += 1;
        return { cancel: false };
      },
    });
    results.set(event, inheritedJsonCandidate);
    assert.deepEqual(await invoke(), { cancel: true });
    assert.equal(toJSONCalls, 0);
    assert.equal(later[event], 0);

    let accessorCalls = 0;
    const accessorCandidate: GuardBoundaryCandidate = {};
    Object.defineProperty(accessorCandidate, "cancel", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return false;
      },
    });
    results.set(event, accessorCandidate);
    assert.deepEqual(await invoke(), { cancel: true });
    assert.equal(accessorCalls, 0);
    assert.equal(later[event], 0);

    let proxyTraps = 0;
    const proxyCandidate = new Proxy<GuardBoundaryCandidate>({}, {
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error("proxy trap must not run");
      },
    });
    results.set(event, proxyCandidate);
    assert.deepEqual(await invoke(), { cancel: true });
    assert.equal(proxyTraps, 0);
    assert.equal(later[event], 0);

    results.set(event, { cancel: true, reason: `${event} policy` });
    assert.deepEqual(await invoke(), { cancel: true, reason: `${event} policy` });
    assert.equal(later[event], 0);

    results.set(event, "throw");
    const errorsBefore = errors.length;
    assert.deepEqual(await invoke(), { cancel: false });
    assert.equal(later[event], 1);
    assert.match(errors[errorsBefore]?.error ?? "", /ordinary guard failure/u);
  }
  runner.invalidate("done");
});

test("standalone callbacks and registrations receive stable owner-specific data paths", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [
      { name: "path-owner-one", factory() {} },
      { name: "path-owner-two", factory() {} },
    ],
  });
  const entries = host.extensions();
  const first = extension(entries[0]!.sourcePath);
  const second = extension(entries[1]!.sourcePath);
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [first, second],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const observed = new Map<string, Array<{ userData: string; workspaceData: string }>>();
  const capture = (owner: string, paths: { userData: string; workspaceData: string }): void => {
    const selected = observed.get(owner) ?? [];
    selected.push(paths);
    observed.set(owner, selected);
  };
  for (const [index, selected] of [first, second].entries()) {
    const owner = `owner-${index + 1}`;
    on(selected, "session_start", (_event, context) => {
      capture(`${owner}:event`, context.paths);
    });
    selected.commands.set(owner, {
      name: owner,
      sourceInfo: selected.sourceInfo,
      async handler(_args, context) { capture(`${owner}:command`, context.paths); },
    });
    selected.shortcuts.set(`alt+${index + 1}`, {
      shortcut: `alt+${index + 1}`,
      extensionPath: selected.path,
      handler(context) {
        if (context === undefined) throw new Error("shortcut context is required");
        capture(`${owner}:shortcut`, context.paths);
      },
    });
    selected.tools.set(owner, {
      sourceInfo: selected.sourceInfo,
      definition: {
        name: owner,
        label: owner,
        description: owner,
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, context) {
          capture(`${owner}:tool`, context.paths);
          return { content: [{ type: "text", text: "ok" }], details: undefined };
        },
      },
    });
  }

  await runner.emit({ type: "session_start", reason: "startup" });
  await runner.emit({ type: "session_start", reason: "refresh" });
  for (const selected of runner.getRegisteredCommands()) await selected.handler("");
  for (const selected of runner.getShortcuts({}).values()) await selected.handler();
  for (const selected of runner.getAllRegisteredTools()) {
    await selected.definition.execute("call", {}, undefined, undefined, runner.createContext());
  }

  const expected = entries.map((entry) => {
    const paths = host.extensionDataPaths(entry.sourcePath);
    assert.ok(paths);
    return { userData: paths.user, workspaceData: paths.workspace };
  });
  assert.notDeepEqual(expected[0], expected[1]);
  for (const [index, owner] of ["owner-1", "owner-2"].entries()) {
    assert.deepEqual(observed.get(`${owner}:event`), [expected[index], expected[index]]);
    assert.deepEqual(observed.get(`${owner}:command`), [expected[index]]);
    assert.deepEqual(observed.get(`${owner}:shortcut`), [expected[index]]);
    assert.deepEqual(observed.get(`${owner}:tool`), [expected[index]]);
  }
  await host.close();
});

test("standalone projection reducers chain payloads, prompts, input, and resources", async () => {
  const cwd = await workspace();
  const first = extension("/first.ts");
  const second = extension("/second.ts");
  const seenPrompts: string[] = [];
  on(first, "before_provider_request", (event) => {
    const payload = requireCountPayload(event.payload);
    return { count: payload.count + 1 };
  });
  on(second, "before_provider_request", (event) => {
    const payload = requireCountPayload(event.payload);
    return { count: payload.count + 1 };
  });
  on(first, "before_provider_headers", (event) => {
    event.headers["x-first"] = "yes";
  });
  on(first, "before_agent_start", (_event, context) => {
    seenPrompts.push(context.getSystemPrompt());
    return { systemPrompt: "second", message: { customType: "notice", content: "one", display: true } };
  });
  on(second, "before_agent_start", (_event, context) => {
    seenPrompts.push(context.getSystemPrompt());
    return { systemPrompt: "third" };
  });
  on(first, "resources_discover", () => ({ skillPaths: ["skill.md"], promptPaths: ["prompt.md"] }));
  on(second, "resources_discover", () => ({ themePaths: ["theme.json"] }));
  on(first, "input", (event) => {
    return { action: "transform", text: `${event.text}-first` };
  });
  on(second, "input", (event) => {
    return { action: "transform", text: `${event.text}-second` };
  });
  const runner = new ExtensionRunner(
    [first, second],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  assert.deepEqual(await runner.emitBeforeProviderRequest({ count: 0 }), { count: 2 });
  assert.deepEqual(await runner.emitBeforeProviderHeaders({ authorization: null }), {
    authorization: null,
    "x-first": "yes",
  });
  assert.deepEqual(await runner.emitBeforeAgentStart("hello", undefined, "first", { cwd }), {
    messages: [{ customType: "notice", content: "one", display: true }],
    systemPrompt: "third",
  });
  assert.deepEqual(seenPrompts, ["first", "second"]);
  assert.deepEqual(await runner.emitResourcesDiscover(cwd, "startup"), {
    skillPaths: [{ path: "skill.md", extensionPath: first.path }],
    promptPaths: [{ path: "prompt.md", extensionPath: first.path }],
    themePaths: [{ path: "theme.json", extensionPath: second.path }],
  });
  assert.deepEqual(await runner.emitInput("start", undefined, "interactive"), {
    action: "transform",
    text: "start-first-second",
  });
});

test("standalone message, context, tool, and shell reducers preserve their contracts", async () => {
  const cwd = await workspace();
  const selected = extension("/reducers.ts");
  const errors: Array<{ event: string; error: string }> = [];
  on(selected, "message_end", (event) => ({ message: event.message }));
  on(selected, "context", (event) => {
    const firstMessage = event.messages[0];
    if (firstMessage?.role !== "user") throw new Error("User-message fixture is missing");
    firstMessage.content = "changed";
    return { messages: event.messages };
  });
  on(selected, "tool_result", () => ({
    content: [{ type: "text", text: "replacement" }],
    isError: true,
  }));
  on(selected, "tool_call", () => ({ block: false }));
  on(selected, "tool_call", () => ({ block: true, reason: "blocked", terminate: true }));
  on(selected, "user_bash", () => ({
    result: { output: "handled", exitCode: 0, cancelled: false, truncated: false },
  }));
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));
  const message: UserMessage = { role: "user", content: "original", timestamp: 1 };
  const messages = [message];

  assert.equal(await runner.emitMessageEnd({ type: "message_end", message }), message);
  assert.deepEqual(await runner.emitContext(messages), [{ role: "user", content: "changed", timestamp: 1 }]);
  assert.equal(messages[0]?.content, "original");
  assert.deepEqual(await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "custom",
    input: {},
    content: [{ type: "text", text: "initial" }],
    details: undefined,
    isError: false,
  }), {
    content: [{ type: "text", text: "replacement" }],
    details: undefined,
    isError: true,
  });
  assert.deepEqual(await runner.emitToolCall({
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "custom",
    input: {},
  }), { block: true, reason: "blocked", terminate: true });
  assert.deepEqual(await runner.emitUserBash({
    type: "user_bash",
    command: "true",
    cwd,
    excludeFromContext: false,
  }), { result: { output: "handled", exitCode: 0, cancelled: false, truncated: false } });
  assert.deepEqual(errors, []);
});

test("runner dispatches through the attached native host instead of a second listener registry", async () => {
  const cwd = await workspace();
  const transformedCwd = join(cwd, "transformed");
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "compat-observer",
      factory(api) {
        api.on("session_start", (event) => { observed.push(`start:${event.reason}`); });
        api.on("before_provider_request", (event) => ({
          ...requireJsonObject(event.payload),
          tagged: true,
        }));
        api.on("input", (event) => ({ action: "transform", text: event.text.toUpperCase() }));
        api.on("tool_call", () => ({ block: true, reason: "native blocked", terminate: true }));
      },
    }],
  });
  const reduceBeforeUserShell = host.reduceBeforeUserShell.bind(host);
  const replacement: typeof host.reduceBeforeUserShell = async (event, signal) => {
    if (event.command === "transform shell") {
      return { action: "execute", command: "printf transformed", cwd: transformedCwd };
    }
    if (event.command === "timeout shell") {
      return {
        action: "handled",
        command: "handled timeout",
        cwd: transformedCwd,
        result: {
          text: "timeout preview",
          exitCode: null,
          isError: false,
          cancelled: false,
          timedOut: true,
        },
      };
    }
    return await reduceBeforeUserShell(event, signal);
  };
  Object.defineProperty(host, "reduceBeforeUserShell", {
    configurable: true,
    value: replacement,
  });
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(observed, ["start:startup"]);
  assert.deepEqual(await runner.emitBeforeProviderRequest({ prompt: "hello" }), { prompt: "hello", tagged: true });
  assert.deepEqual(await runner.emitInput("hello", undefined, "interactive"), {
    action: "transform",
    text: "HELLO",
  });
  assert.deepEqual(await runner.emitToolCall({
    type: "tool_call",
    toolCallId: "native-blocked",
    toolName: "read",
    input: {},
  }), { block: true, reason: "native blocked", terminate: true });
  assert.deepEqual(await runner.emitUserBash({
    type: "user_bash",
    command: "transform shell",
    cwd,
    excludeFromContext: false,
  }), {
    command: "printf transformed",
    cwd: transformedCwd,
  });
  assert.deepEqual(await runner.emitUserBash({
    type: "user_bash",
    command: "timeout shell",
    cwd,
    excludeFromContext: false,
  }), {
    command: "handled timeout",
    cwd: transformedCwd,
    result: {
      output: "timeout preview",
      isError: true,
      cancelled: false,
      timedOut: true,
      truncated: false,
    },
  });
  await host.close();
});

test("standalone runner binds native actions, context, commands, exec, and no-op UI", async () => {
  const cwd = await workspace();
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "native-bridge",
      factory(api) {
        api.on("session_start", (_event, ctx) => {
          api.setSessionName("native-name");
          api.setActiveTools(["native-tool"]);
          observed.push(ctx.sessionManager.getSessionId(), ctx.getSystemPrompt(), ctx.ui.theme.name);
          ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
          ctx.ui.setEditorComponent(() => ({
            render: () => [],
            invalidate() {},
            handleInput() {},
            getText: () => "",
            getExpandedText: () => "",
            setText() {},
          }));
        });
        api.on("session_shutdown", async () => {
          const result = await api.exec(process.execPath, ["-e", "process.stdout.write('native-exec')"]);
          observed.push(result.stdout);
        });
        api.registerCommand("native-command", {
          async handler(_args, ctx) { await ctx.refresh(); },
        });
      },
    }],
  });
  const projected = projectLoadedExtensionHost(host);
  const session = SessionManager.inMemory(cwd);
  let sessionName: string | undefined;
  let activeTools: string[] = [];
  let refreshes = 0;
  const runner = new ExtensionRunner(
    projected.extensions,
    projected.runtime,
    cwd,
    session,
    new ModelRegistry(createModels()),
  );
  runner.bindCore({
    ...actions(),
    setSessionName(name) { sessionName = name; },
    getSessionName: () => sessionName,
    getActiveTools: () => [...activeTools],
    setActiveTools(names) { activeTools = [...names]; },
  }, contextActions());
  runner.bindCommandContext({
    refresh: async () => { refreshes += 1; },
    switchSession: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    waitForIdle: async () => {},
  });
  const capabilities = runner.getUIContext().capabilities;
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.keys(capabilities ?? {}).length, 17);
  assert.equal(Object.values(capabilities ?? {}).every((value) => value === false), true);

  const errors: string[] = [];
  runner.onError((entry) => errors.push(entry.error));
  await runner.emit({ type: "session_start", reason: "startup" });
  assert.equal(sessionName, "native-name");
  assert.deepEqual(activeTools, ["native-tool"]);
  assert.deepEqual(observed.slice(0, 3), [session.getSessionId(), "system", "mono"]);

  assert.deepEqual(await host.runCommand("native-command", {
    args: "",
    threadId: session.getSessionId(),
    branch: "main",
    signal: new AbortController().signal,
  }), { handled: true });
  assert.equal(refreshes, 1);

  await runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(observed.at(-1), "native-exec");
  assert.deepEqual(errors, []);
  await host.close();
});

test("standalone defaults do not replace richer native actions bound after construction", async () => {
  const cwd = await workspace();
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "rich-actions",
      factory(api) {
        api.on("session_start", () => { observed.push(api.getSessionName() ?? "missing"); });
      },
    }],
  });
  const projected = projectLoadedExtensionHost(host);
  const runner = new ExtensionRunner(
    projected.extensions,
    projected.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  host.setDirectActionsHandler({ ...directActions(cwd), getSessionName: () => "rich" });
  runner.bindCore({ ...actions(), getSessionName: () => "public" }, contextActions());

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(observed, ["rich"]);
  await host.close();
});

test("native lifecycle failures are isolated and reported through the public runner", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "failing-lifecycle",
      factory(api) {
        api.on("session_start", () => { throw new Error("start failed"); });
      },
    }],
  });
  const projected = projectLoadedExtensionHost(host);
  const runner = new ExtensionRunner(
    projected.extensions,
    projected.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.bindCore(actions(), contextActions());
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));

  await assert.doesNotReject(runner.emit({ type: "session_start", reason: "startup" }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.event, "session_start");
  assert.match(errors[0]?.error ?? "", /start failed/u);
  await host.close();
});

test("native handler diagnostics retain their public event identity", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "failing-context",
      factory(api) {
        api.on("context", () => { throw new Error("context failed"); });
      },
    }],
  });
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));

  assert.deepEqual(await runner.emitContext([]), []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.event, "context");
  assert.match(errors[0]?.error ?? "", /context failed/u);
  await host.close();
});

test("runner invalidation detaches native diagnostics once and stales captured contexts and actions", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], { workspace: cwd });
  const subscribe = host.onError.bind(host);
  let unsubscribeCalls = 0;
  Object.defineProperty(host, "onError", {
    configurable: true,
    value(listener: Parameters<typeof host.onError>[0]) {
      const unsubscribe = subscribe(listener);
      return () => {
        unsubscribeCalls += 1;
        unsubscribe();
      };
    },
  });

  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.bindCore(actions(), contextActions());
  runner.bindCommandContext();
  const context = runner.createContext();
  const commandContext = runner.createCommandContext();
  const getActiveTools = runtime.getActiveTools;
  const diagnostics: string[] = [];
  runner.onError((entry) => diagnostics.push(entry.error));

  host.addDiagnostic({ extensionId: "test", sourcePath: "/before.ts", message: "before invalidation" });
  assert.deepEqual(diagnostics, ["before invalidation"]);

  runner.invalidate("stale generation");
  runner.invalidate("ignored second invalidation");
  assert.equal(unsubscribeCalls, 1);

  host.addDiagnostic({ extensionId: "test", sourcePath: "/after.ts", message: "after invalidation" });
  assert.deepEqual(diagnostics, ["before invalidation"]);
  assert.throws(() => context.cwd, /stale generation/u);
  assert.throws(() => commandContext.cwd, /stale generation/u);
  assert.throws(() => commandContext.refresh(), /stale generation/u);
  assert.throws(() => getActiveTools(), /stale generation/u);

  await host.close();
});
