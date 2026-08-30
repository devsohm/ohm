import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { JsonValue } from "../../src/core/json.js";
import { optionalProperties } from "../../src/core/optional-properties.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import { FUNCTION_VALUE } from "../../src/core/value-schemas.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  FULL_TUI_EXTENSION_UI_CAPABILITIES,
  loadDirectExtensions,
  type RuntimeAssistantStreamSnapshot,
  type RuntimeDirectAutocompleteProviderFactory,
  type RuntimeCommandUi,
  type RuntimeDirectEditorFactory,
  type RuntimeDirectTerminalInputHandler,
  type RuntimeDirectUiContext,
  type RuntimeExtensionHost,
} from "../../src/extensions/runtime.js";
import { UNAVAILABLE_EXTENSION_UI_ROUTES } from "../../src/extensions/runtime-internal/ui-route-registrations.js";
import { UNAVAILABLE_EXTENSION_UI_SLOTS } from "../../src/extensions/runtime-internal/ui-slot-registrations.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, type ProviderModel } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { WorkspaceBoundary, type ToolInvocation } from "../../src/tools/index.js";
import { createTheme, type Theme } from "../../src/tui/theme.js";
import { KeybindingsManager, TUI, type Component, type Terminal } from "../../src/tui/index.js";

const exampleNames = [
  "starter",
  "lifecycle-events",
  "command-controls",
  "tool-rendering",
  "input-guard",
  "ui-surfaces",
  "context-compaction",
  "messages-bus",
  "model-controls",
  "provider-override",
  "raw-editor-ui",
  "session-jsonl",
  "session-control",
  "session-metadata",
  "subagent-specialists",
  "dynamic-package",
  "provider-hooks",
  "runtime-catalog",
  "session-lifecycle",
  "provider-catalog",
  "terminal-workbench",
  "project-trust",
  "state-and-policy",
  "mcp-stdio",
] as const;

type ExampleName = (typeof exampleNames)[number];

interface ActionCall {
  name: string;
  values: unknown[];
}

const PACKAGE_JSON_VALUE = Type.Object({
  ohm: Type.Optional(Type.Object({ extensions: Type.Optional(Type.Array(Type.String())) })),
});
const SAVED_STATE_VALUE = Type.Object({
  memories: Type.Array(Type.Unknown()),
  tasks: Type.Array(Type.Unknown()),
});
const SPECIALIST_CATALOG_VALUE = Type.Object({
  profiles: Type.Array(Type.Object({ name: Type.String() })),
});
const DELEGATE_REPORT_VALUE = Type.Object({
  mode: Type.String(),
  reports: Type.Array(Type.Object({ profile: Type.String(), text: Type.String() })),
});
const SPECIALIST_OBSERVATION_VALUE = Type.Object({
  profile: Type.String(),
  task: Type.String(),
  json: Type.Boolean(),
  noSession: Type.Boolean(),
  noExtensions: Type.Boolean(),
  noProjectApproval: Type.Boolean(),
  workspace: Type.String(),
  model: Type.String(),
  thinking: Type.String(),
  tools: Type.String(),
});
const RUNTIME_CATALOG_VALUE = Type.Object({
  activeTools: Type.Array(Type.String()),
  allTools: Type.Array(Type.String()),
  commands: Type.Array(Type.String()),
  resources: Type.Array(Type.String()),
});
const ERROR_CODE_VALUE = Type.Object({ code: Type.Optional(Type.String()) });

function parseJson<Schema extends TSchema>(schema: Schema, source: string): Static<Schema> {
  const value: unknown = JSON.parse(source);
  if (!Value.Check(schema, value)) throw new Error("Fixture JSON does not match its test contract");
  return value;
}

function errorCode<ValueType>(value: ValueType): string | undefined {
  return Value.Check(ERROR_CODE_VALUE, value) ? value.code : undefined;
}

class TestTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

type TestCustomFactory<Result> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: Result) => void,
) => Component | Promise<Component>;

const TEST_THEME = createTheme("mono", { color: false, unicode: false });

function directUiContext(overrides: Partial<RuntimeDirectUiContext> = {}): RuntimeDirectUiContext {
  return Object.assign<RuntimeDirectUiContext, Partial<RuntimeDirectUiContext>>({
    capabilities: FULL_TUI_EXTENSION_UI_CAPABILITIES,
    slots: UNAVAILABLE_EXTENSION_UI_SLOTS,
    routes: UNAVAILABLE_EXTENSION_UI_ROUTES,
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
    setStatus() {},
    setHiddenThinkingLabel() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setBackground() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom<Result>(): Promise<Result> { throw new Error("Custom UI was not configured for this test"); },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() { return ""; },
    async editor() { return undefined; },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() { return undefined; },
  }, overrides);
}

async function loadExample(
  context: TestContext,
  name: ExampleName,
): Promise<{ host: RuntimeExtensionHost; workspace: string; session: SessionManager; calls: ActionCall[] }> {
  const root = await mkdtemp(join(tmpdir(), `ohm-direct-example-${name}-`));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const manager = new DefaultPackageManager({
    cwd: workspace,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const resources = await manager.resolveExtensionSources([resolve("examples", name)], { temporary: true });
  assert.equal(resources.extensions.length, 1);
  const metadata = new Map(resources.extensions.map((entry) => [entry.path, {
    scope: entry.metadata.scope,
    trusted: true,
    ...optionalProperties(entry.metadata.baseDir === undefined
      ? undefined
      : { resourceRoot: entry.metadata.baseDir }),
  }] as const));
  const host = await loadDirectExtensions(resources.extensions.map((entry) => entry.path), {
    workspace,
    mode: "tui",
    projectTrusted: name === "subagent-specialists",
    activationFailure: "throw",
    directPathMetadata: metadata,
  });
  const session = SessionManager.inMemory(workspace, { id: `example-${name}` });
  const calls: ActionCall[] = [];
  const models = createModels();
  const selectedModel: ProviderModel = {
    id: "example-model",
    name: "Example model",
    api: "openai-chat-completions",
    provider: "example-provider",
    baseUrl: "https://provider.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 2_048,
  };
  host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(session),
    modelRegistry: new ModelRegistry(models),
    model: selectedModel,
    scopedModels: [{ model: selectedModel }],
    thinkingLevel: "off",
    isIdle: () => true,
    hasPendingMessages() { calls.push({ name: "hasPendingMessages", values: [] }); return true; },
    abort() { calls.push({ name: "abort", values: [] }); },
    shutdown() { calls.push({ name: "shutdown", values: [] }); },
    getContextUsage: () => ({ tokens: 1200, contextWindow: 8000, percent: 15 }),
    compact(...values) { calls.push({ name: "compact", values }); },
    getSystemPrompt: () => "example system prompt",
  }));
  host.setDirectActionsHandler({
    sendMessage(...values) { calls.push({ name: "sendMessage", values }); },
    sendUserMessage(...values) { calls.push({ name: "sendUserMessage", values }); },
    appendEntry(...values) { calls.push({ name: "appendEntry", values }); },
    setSessionName(...values) { calls.push({ name: "setSessionName", values }); },
    getSessionName: () => session.getSessionName(),
    setLabel(...values) { calls.push({ name: "setLabel", values }); },
    async exec(...values) {
      calls.push({ name: "exec", values });
      return { stdout: "worker output", stderr: "", code: 0, killed: false };
    },
    getActiveTools: () => ["read"],
    getAllTools: () => [{
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object" },
      active: true,
      executionMode: "parallel",
      owner: { kind: "builtin" },
    }],
    setActiveTools(...values) { calls.push({ name: "setActiveTools", values }); },
    async setModel(...values) { calls.push({ name: "setModel", values }); return true; },
    getThinkingLevel: () => "off",
    setThinkingLevel(...values) { calls.push({ name: "setThinkingLevel", values }); },
    registerProvider(providerOrName, config) {
      calls.push({ name: "registerProvider", values: [providerOrName, ...(config === undefined ? [] : [config])] });
    },
    unregisterProvider(...values) { calls.push({ name: "unregisterProvider", values }); },
    getSystemPromptOptions() { calls.push({ name: "getSystemPromptOptions", values: [] }); return { cwd: workspace, selectedTools: ["read"] }; },
    async waitForIdle() { calls.push({ name: "waitForIdle", values: [] }); },
    async newSession(...values) { calls.push({ name: "newSession", values }); return { cancelled: false }; },
    async fork(...values) { calls.push({ name: "fork", values }); return { cancelled: false }; },
    async navigateTree(...values) { calls.push({ name: "navigateTree", values }); return { cancelled: false }; },
    async switchSession(...values) { calls.push({ name: "switchSession", values }); return { cancelled: false }; },
    async refresh() { calls.push({ name: "refresh", values: [] }); },
  });
  host.setDirectDiscoveryHandler(() => ({
    resources: [
      { kind: "command", source: "builtin", name: "help" },
      { kind: "prompt", name: "review", extensionId: "example" },
      { kind: "skill", name: "audit", description: "Audit changes", scope: "workspace", trusted: true, disableModelInvocation: false },
    ],
    truncated: false,
    omitted: { commands: 0, prompts: 0, skills: 0 },
  }));
  context.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(host.diagnostics(), []);
  return { host, workspace, session, calls };
}

function commandUi(notices: string[] = []): RuntimeCommandUi {
  return {
    notify(message) { notices.push(message); },
    setStatus() {},
    setWidget() {},
    setHeader() {},
    setFooter() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setTitle() {},
    async getTheme() { return { name: "mono", available: ["dark"] }; },
    async setTheme(name) { return { name, available: [name] }; },
    async select(_prompt, options) { return options[0]!.value; },
    async confirm() { return true; },
    async input() { return undefined; },
    async editor() { return undefined; },
    setEditorText() {},
    getEditorText() { return ""; },
    async custom<T>(): Promise<T | undefined> { return undefined; },
    showOverlay(): never { throw new Error("overlay not used"); },
  };
}

async function runCommand(
  host: RuntimeExtensionHost,
  name: string,
  args = "",
  notices: string[] = [],
): Promise<AbortSignal> {
  const signal = new AbortController().signal;
  assert.deepEqual(await host.runCommand(name, {
    args,
    threadId: "example-thread",
    branch: "main",
    signal,
    ui: commandUi(notices),
  }), { handled: true });
  return signal;
}

test("the direct example corpus is exactly the documented package.json packages without legacy manifests", async () => {
  const discovered: string[] = [];
  for (const entry of await readdir(resolve("examples"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(resolve("examples", entry.name, "package.json"));
      discovered.push(entry.name);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
    }
  }
  assert.deepEqual(discovered.sort(), [...exampleNames].sort());
  for (const name of exampleNames) {
    const packageRoot = resolve("examples", name);
    const packageJson = parseJson(
      PACKAGE_JSON_VALUE,
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    const entries = packageJson.ohm?.extensions;
    assert.equal(entries?.length, 1);
    assert.match(entries[0]!, /^extensions\/index\.(?:mjs|ts)$/u);
    await readFile(join(packageRoot, entries[0]!));
  }
});

test("lifecycle example observes the complete run lifecycle", async (context) => {
  const { host } = await loadExample(context, "lifecycle-events");
  const scope = {
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
  };
  const message: CanonicalMessage = {
    id: "message-1",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const streamMessage: RuntimeAssistantStreamSnapshot = {
    role: "assistant",
    provider: "openai",
    model: "example-model",
    text: [{ part: 0, text: "done" }],
    reasoning: [],
    toolCalls: [],
  };
  const invocation: ToolInvocation = {
    callId: "call-1",
    name: "read",
    input: {},
    index: 0,
  };
  await host.dispatch("agent_start", {
    ...scope,
    provider: "openai",
    model: "example-model",
  });
  await host.dispatch("turn_start", {
    ...scope,
    step: 1,
    provider: "openai",
    model: "example-model",
    messageCount: 1,
    toolCount: 1,
  });
  await host.dispatch("message_start", {
    ...scope,
    step: 1,
    role: "assistant",
    provider: "openai",
    model: "example-model",
    message: streamMessage,
  });
  await host.dispatch("message_update", {
    ...scope,
    step: 1,
    message: streamMessage,
    kind: "text",
    part: 0,
    delta: "done",
  });
  await host.dispatch("message_end", { ...scope, step: 1, message });
  await host.dispatch("tool_execution_start", { ...scope, step: 1, invocation });
  await host.dispatch("tool_execution_update", {
    ...scope,
    step: 1,
    invocation,
    phase: "progress",
    sequence: 1,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "done",
      stdoutBytes: 4,
      stderrBytes: 0,
    },
  });
  await host.dispatch("tool_execution_end", {
    ...scope,
    step: 1,
    invocation,
    outcome: { status: "completed", isError: false, preview: "done" },
  });
  await host.dispatch("turn_end", {
    ...scope,
    step: 1,
    provider: "openai",
    model: "example-model",
    outcome: { status: "completed", finishReason: "stop" },
    message,
    toolResults: [],
  });
  await host.dispatch("agent_end", {
    ...scope,
    outcome: { status: "completed", finishReason: "stop" },
    messages: [message],
    messagesTruncated: false,
  });
  await host.dispatch("agent_settled", {
    ...scope,
    outcome: { status: "completed", finishReason: "stop" },
    messages: [],
    messagesTruncated: false,
  });
  const notices: string[] = [];
  await runCommand(host, "example-lifecycle-status", "", notices);
  assert.deepEqual(JSON.parse(notices[0]!), {
    agentStart: 1,
    agentEnd: 1,
    agentSettled: 1,
    turnStart: 1,
    turnEnd: 1,
    messageStart: 1,
    messageUpdate: 1,
    messageEnd: 1,
    toolStart: 1,
    toolUpdate: 1,
    toolEnd: 1,
  });
});

test("command controls bind typed flags and normalized shortcuts", async (context) => {
  const { host } = await loadExample(context, "command-controls");
  assert.equal(host.flagValues().get("example-compact-output"), false);
  host.setFlagValue("example-compact-output", true);
  const notices: string[] = [];
  await runCommand(host, "example-controls", "", notices);
  assert.deepEqual(notices, ["Compact output: true"]);
  host.setInteractiveUiHandler(() => commandUi(notices));
  assert.deepEqual(await host.runShortcut("ctrl+alt+e", {
    threadId: "example-thread",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi(notices),
  }), { handled: true });
  assert.deepEqual(notices, ["Compact output: true", "Example shortcut received."]);
});

test("tool rendering example traverses the public source TUI barrel and supplies live renderers", async (context) => {
  const { host, workspace } = await loadExample(context, "tool-rendering");
  await writeFile(join(workspace, "README.md"), "wrapped built-in read\n", "utf8");
  const tool = host.tools().find((entry) => entry.definition.name === "read");
  assert.ok(tool);
  const input = { path: "README.md" };
  tool.validate(input);
  const result = await tool.execute(input, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "example-run",
    threadId: "example-thread",
    toolCallId: "example-call",
  });
  assert.match(result.content, /wrapped built-in read/u);
  const binding = host.toolRendererBinding();
  assert.equal(binding.has("read"), true);
  const rendered = binding.renderCall("read", {
    callId: "example-call",
    name: "read",
    input,
    argsComplete: true,
    executionStarted: false,
    status: "pending",
    expanded: true,
  }, {
    width: 100,
    height: 30,
    focused: false,
    expanded: true,
    theme: { name: "mono", color: true, unicode: true },
  });
  assert.equal(rendered?.lines[0]?.spans[0]?.text.trimEnd(), "Read through extension · README.md");
});

test("MCP stdio discovers and invokes an allowlisted tool through the real managed-process host", async (context) => {
  const { host, workspace } = await loadExample(context, "mcp-stdio");
  await host.dispatch("session_start", { reason: "startup", threadId: "example-thread" });
  const tool = host.tools().find((entry) => entry.definition.name === "example_mcp_echo");
  assert.ok(tool);
  const input = { text: "managed MCP result" };
  tool.validate(input);
  const result = await tool.execute(input, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "example-run",
    threadId: "example-thread",
    toolCallId: "example-call",
  });
  assert.equal(result.content, "managed MCP result");
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "managed MCP result" }]);
  assert.deepEqual(result.metadata, { server: "fixture", remoteTool: "fixture.echo" });
});

test("input guard transforms bounded text and blocks selected shell requests", async (context) => {
  const { host } = await loadExample(context, "input-guard");
  assert.deepEqual(await host.reduceInput({
    threadId: "example-thread",
    branch: "main",
    text: "/example-ignore",
    source: "interactive",
  }), { action: "handled" });
  const long = "x".repeat(5000);
  assert.deepEqual(await host.reduceInput({
    threadId: "example-thread",
    branch: "main",
    text: long,
    source: "interactive",
  }), { action: "transform", text: long.slice(0, 4096) });
  const reduced = await host.reduceToolCall({
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    callId: "example-call",
    name: "bash",
    input: { command: "sudo shutdown now" },
    index: 0,
  });
  assert.equal(reduced.blocked, true);
  assert.match(reduced.reason ?? "", /privileged system commands/u);
});

test("state and policy example persists bounded workspace memory and tasks and blocks protected paths", async (context) => {
  const { host, workspace } = await loadExample(context, "state-and-policy");
  const boundary = await WorkspaceBoundary.create(workspace);
  let ordinal = 0;
  const execute = async (name: string, input: Record<string, JsonValue>) => {
    const tool = host.tools().find((entry) => entry.definition.name === name);
    assert.ok(tool);
    tool.validate(input);
    return await tool.execute(input, {
      workspace: boundary,
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "state-run",
      threadId: "state-thread",
      toolCallId: `state-call-${++ordinal}`,
    });
  };

  assert.deepEqual(JSON.parse((await execute("example_memory", {
    action: "remember",
    text: "Keep the public API stable",
  })).content), {
    saved: { id: 1, text: "Keep the public API stable" },
  });
  assert.deepEqual(JSON.parse((await execute("example_memory", {
    action: "recall",
    query: "public api",
  })).content), {
    memories: [{ id: 1, text: "Keep the public API stable" }],
  });
  assert.deepEqual(JSON.parse((await execute("example_tasks", {
    action: "add",
    text: "Run focused tests",
  })).content), {
    added: { id: 2, text: "Run focused tests", completed: false },
  });
  assert.deepEqual(JSON.parse((await execute("example_tasks", {
    action: "complete",
    id: 2,
  })).content), {
    completed: { id: 2, text: "Run focused tests", completed: true },
  });

  const notices: string[] = [];
  await runCommand(host, "example-state", "", notices);
  await runCommand(host, "example-policy", "", notices);
  assert.deepEqual(notices, ["1 memories, 0 open tasks", "Protected-path policy: on"]);

  const scope = {
    threadId: "state-thread",
    branch: "main",
    runId: "state-run",
    step: 1,
  };
  const protectedCall = await host.reduceToolCall({
    ...scope,
    callId: "protected",
    name: "read",
    input: { path: ".env" },
    index: 0,
  });
  assert.equal(protectedCall.blocked, true);
  assert.match(protectedCall.reason ?? "", /protected or out-of-workspace/u);
  await runCommand(host, "example-policy", "off", notices);
  assert.equal((await host.reduceToolCall({
    ...scope,
    callId: "policy-off",
    name: "read",
    input: { path: ".env" },
    index: 1,
  })).blocked, false);
  await runCommand(host, "example-policy", "on", notices);
  assert.equal((await host.reduceToolCall({
    ...scope,
    callId: "policy-on",
    name: "read",
    input: { path: ".env" },
    index: 2,
  })).blocked, true);
  assert.deepEqual(notices.slice(-2), ["Protected-path policy: off", "Protected-path policy: on"]);
  const safeCall = await host.reduceToolCall({
    ...scope,
    callId: "safe",
    name: "read",
    input: { path: "src/index.ts" },
    index: 3,
  });
  assert.equal(safeCall.blocked, false);

  const sourcePath = host.extensions()[0]?.sourcePath;
  assert.ok(sourcePath);
  const paths = host.extensionDataPaths(sourcePath);
  assert.ok(paths);
  const saved = parseJson(
    SAVED_STATE_VALUE,
    await readFile(join(paths.workspace, "workspace-state.json"), "utf8"),
  );
  assert.equal(saved.memories.length, 1);
  assert.equal(saved.tasks.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(paths.workspace, "config.json"), "utf8")), {
    version: 1,
    protectPaths: true,
  });
});

test("UI surfaces mount ordered slots and wrap autocomplete while preserving the prior provider", async (context) => {
  const { host } = await loadExample(context, "ui-surfaces");
  const operations: string[] = [];
  let autocompleteFactory: RuntimeDirectAutocompleteProviderFactory | undefined;
  host.setHostContext({ mode: "tui" });
  host.setDirectUiHandler(() => directUiContext({
    setStatus() { operations.push("status"); },
    addAutocompleteProvider(factory: RuntimeDirectAutocompleteProviderFactory) {
      autocompleteFactory = factory;
      operations.push("autocomplete");
    },
    async custom<Result>(factory: TestCustomFactory<Result>): Promise<Result> {
      operations.push("overlay");
      return await new Promise<Result>((done, reject) => {
        const tui = new TUI(new TestTerminal());
        const keybindings = new KeybindingsManager({});
        void Promise.resolve(factory(tui, TEST_THEME, keybindings, done)).then((component) => {
          assert.match(component.render(80).join("\n"), /Example overlay · press Enter or Escape/u);
          component.handleInput?.("\r");
        }, reject);
      });
    },
  }));
  host.setAdvancedUiHandler({
    apply(operation) {
      if (operation.type === "slot") operations.push(`slot:${operation.path}`);
    },
    getToolOutputExpanded: () => false,
  });
  await host.dispatch("session_start", { reason: "startup" });
  assert.notEqual(autocompleteFactory, undefined);
  let delegated = 0;
  const selectedAutocompleteFactory = autocompleteFactory;
  if (selectedAutocompleteFactory === undefined) throw new Error("Autocomplete provider was not installed");
  const installed = selectedAutocompleteFactory({
    async getSuggestions() {
      delegated += 1;
      return { prefix: "base", items: [{ value: "baseline", label: "baseline" }] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const result = [...lines];
      const line = result[cursorLine] ?? "";
      result[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(cursorCol)}`;
      return { lines: result, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await installed.getSuggestions(["plain"], 0, 5, { signal }), {
    prefix: "base",
    items: [{ value: "baseline", label: "baseline" }],
  });
  assert.equal(delegated, 1);
  const suggestions = await installed.getSuggestions(["Review :to"], 0, 10, { signal });
  assert.deepEqual(suggestions, {
    prefix: ":to",
    items: [{ value: "TODO: ", label: ":todo", description: "Insert a task marker" }],
  });
  assert.deepEqual(installed.applyCompletion(["Review :to"], 0, 10, suggestions!.items[0]!, suggestions!.prefix), {
    lines: ["Review TODO: "],
    cursorLine: 0,
    cursorCol: 13,
  });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await installed.getSuggestions([":to"], 0, 3, { signal: aborted.signal }), null);
  await runCommand(host, "example-ui-panel");
  await runCommand(host, "example-ui-overlay");
  assert.deepEqual(operations, [
    "autocomplete",
    "status",
    "slot:session.header",
    "slot:session.beforeEditor",
    "overlay",
  ]);
});

test("context example transforms the active prompt and requests host compaction", async (context) => {
  const { host, calls } = await loadExample(context, "context-compaction");
  const reduced = await host.reduceBeforeAgentStart({
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    prompt: "Review",
    systemPrompt: "Base prompt",
    systemPromptOptions: { cwd: process.cwd(), selectedTools: [] },
  });
  assert.match(reduced.systemPrompt, /Base prompt\n\nExample extension instruction/u);
  const notices: string[] = [];
  await runCommand(host, "example-context", "compact", notices);
  assert.deepEqual(calls.filter((entry) => entry.name === "compact"), [{
    name: "compact",
    values: [{ customInstructions: "Preserve active decisions and unresolved work." }],
  }]);
  assert.deepEqual(JSON.parse(notices[0]!), {
    tokens: 1200,
    contextWindow: 8000,
    percent: 15,
    systemPromptCharacters: 21,
  });
});

test("message bus example emits and renders custom messages and transforms Markdown", async (context) => {
  const { host, calls } = await loadExample(context, "messages-bus");
  const owner = host.extensions()[0];
  assert.ok(owner);
  await runCommand(host, "example-message", "hello bus");
  assert.deepEqual(calls.filter((entry) => entry.name === "sendMessage"), [{
    name: "sendMessage",
    values: [{
      customType: "example-note",
      content: "hello bus",
      display: true,
      provenance: {
        schemaVersion: 1,
        extensionId: owner.extensionId,
        sourceSha256: owner.sha256,
      },
    }, undefined],
  }]);
  assert.equal(Value.Check(FUNCTION_VALUE, host.messageRenderer("example-note")), true);
  assert.equal(host.transformMarkdown("Before [[example-note]] after", {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 80,
  }), "Before **Example note:** after");
});

test("model controls read the selected model and delegate thinking selection", async (context) => {
  const { host, calls } = await loadExample(context, "model-controls");
  const notices: string[] = [];
  await runCommand(host, "example-model", "high", notices);
  assert.deepEqual(calls.filter((entry) => entry.name === "setThinkingLevel"), [{
    name: "setThinkingLevel",
    values: ["high"],
  }]);
  assert.match(notices[0]!, / · 1 scoped · off$/u);
});

test("starter activates through package resolution and its tool returns a canonical observation", async (context) => {
  const { host, workspace } = await loadExample(context, "starter");
  assert.equal(host.hasCommand("example-hello"), true);
  const tool = host.tools().find((entry) => entry.definition.name === "example_text_length");
  assert.ok(tool);
  const input = { text: "A🙂" };
  tool.validate(input);
  const result = await tool.execute(input, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "example-run",
    threadId: "example-thread",
    toolCallId: "example-call",
  });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content), { codePoints: 2 });
});

test("specialist delegation stays extension-owned and uses bounded managed child processes", async (context) => {
  const { host, workspace } = await loadExample(context, "subagent-specialists");
  const fixture = join(workspace, "ohm.js");
  await writeFile(fixture, [
    'const args = process.argv.slice(2);',
    'const value = (name) => args[args.indexOf(name) + 1];',
    'const system = value("--append-system-prompt") ?? "";',
    'const profile = system.match(/You are the ([a-z0-9_-]+) specialist\\./u)?.[1] ?? "unknown";',
    'const report = JSON.stringify({',
    '  profile,',
    '  task: args.at(-1),',
    '  json: value("--mode") === "json",',
    '  noSession: args.includes("--no-session"),',
    '  noExtensions: args.includes("--no-extensions"),',
    '  noProjectApproval: args.includes("--no-approve"),',
    '  workspace: value("--workspace"),',
    '  model: value("--model"),',
    '  thinking: value("--thinking"),',
    '  tools: value("--tools"),',
    '});',
    'process.stdout.write(JSON.stringify({',
    '  type: "message_end",',
    '  message: { role: "assistant", content: [{ type: "text", text: report }], stopReason: "stop" },',
    '}) + "\\n");',
  ].join("\n"), "utf8");

  const executionContext = {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "example-run",
    threadId: "example-thread",
    toolCallId: "example-call",
  };
  const list = host.tools().find((entry) => entry.definition.name === "example_list_specialists");
  assert.ok(list);
  const catalog = await list.execute({}, executionContext);
  if (!Value.Check(SPECIALIST_CATALOG_VALUE, catalog.metadata)) {
    throw new Error("Specialist catalog metadata is invalid");
  }
  assert.deepEqual(catalog.metadata.profiles.map(({ name }) => name), [
    "investigator",
    "reviewer",
  ]);

  const delegate = host.tools().find((entry) => entry.definition.name === "example_delegate_specialists");
  assert.ok(delegate);
  assert.equal(delegate.executionMode, "sequential");
  const input = {
    mode: "parallel",
    tasks: [
      { profile: "investigator", task: "Inspect the extension contract" },
      { profile: "reviewer", task: "Review the extension contract" },
    ],
  };
  delegate.validate(input);
  assert.deepEqual(await delegate.resources(input, executionContext), []);
  const originalEntry = process.argv[1];
  process.argv[1] = fixture;
  let result;
  try {
    result = await delegate.execute(input, executionContext);
  } finally {
    if (originalEntry === undefined) process.argv.splice(1, 1);
    else process.argv[1] = originalEntry;
  }
  assert.equal(result.isError, false);
  if (!Value.Check(DELEGATE_REPORT_VALUE, result.metadata)) {
    throw new Error("Specialist delegation metadata is invalid");
  }
  const reports = result.metadata.reports;
  assert.equal(result.metadata.mode, "parallel");
  assert.deepEqual(reports.map(({ profile }) => profile), ["investigator", "reviewer"]);
  const observations = reports.map(({ text }) => parseJson(SPECIALIST_OBSERVATION_VALUE, text));
  assert.deepEqual(observations.map(({ profile, task }) => ({ profile, task })), [
    { profile: "investigator", task: "Inspect the extension contract" },
    { profile: "reviewer", task: "Review the extension contract" },
  ]);
  for (const observation of observations) {
    assert.equal(observation.json, true);
    assert.equal(observation.noSession, true);
    assert.equal(observation.noExtensions, true);
    assert.equal(observation.noProjectApproval, true);
    assert.equal(observation.workspace, workspace);
    assert.equal(observation.model, "example-provider/example-model");
    assert.equal(observation.thinking, "off");
    assert.equal(observation.tools, "read,grep,find,ls");
  }
});

test("provider override registers a replacement and supports explicit removal", async (context) => {
  const { host, calls } = await loadExample(context, "provider-override");
  assert.deepEqual(host.directProviderRegistrations().map((entry) => entry.name), ["ollama"]);
  const owner = host.extensions()[0];
  assert.ok(owner);
  await runCommand(host, "example-provider-disable");
  assert.deepEqual(calls.filter((entry) => entry.name === "unregisterProvider"), [{
    name: "unregisterProvider",
    values: ["ollama", {
      key: `${owner.extensionId}\0${owner.sourcePath}`,
      extensionId: owner.extensionId,
      sourcePath: owner.sourcePath,
    }],
  }]);
});

test("raw editor UI imports the public TUI surface and installs a host-owned editor factory", async (context) => {
  const { host } = await loadExample(context, "raw-editor-ui");
  let editorFactory: RuntimeDirectEditorFactory | undefined;
  const notices: string[] = [];
  host.setDirectUiHandler(() => directUiContext({
    setEditorComponent(factory: RuntimeDirectEditorFactory | undefined) { editorFactory = factory; },
    notify(message: string) { notices.push(message); },
  }));
  await runCommand(host, "example-editor-enable");
  assert.equal(Value.Check(FUNCTION_VALUE, editorFactory), true);
  assert.deepEqual(notices, ["Example editor enabled."]);
  await runCommand(host, "example-editor-disable");
  assert.equal(editorFactory, undefined);
});

test("session JSONL example reads the current session through the read-only manager", async (context) => {
  const { host } = await loadExample(context, "session-jsonl");
  const notices: string[] = [];
  await runCommand(host, "example-session-summary", "", notices);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Session example-session-jsonl: 0 entries; leaf root\./u);
});

test("session-control delegates transitions and direct context lifecycle actions", async (context) => {
  const { host, calls, workspace } = await loadExample(context, "session-control");
  const newSignal = await runCommand(host, "example-session-new");
  const forkSignal = await runCommand(host, "example-session-fork", "entry-7");
  const switchSignal = await runCommand(host, "example-session-switch", "/tmp/session.jsonl");
  const notices: string[] = [];
  await runCommand(host, "example-session-status", "", notices);
  await runCommand(host, "example-session-abort", "", notices);
  await runCommand(host, "example-session-refresh");
  await runCommand(host, "example-session-shutdown");
  const transitions = calls.filter((entry) => ["newSession", "fork", "switchSession"].includes(entry.name));
  assert.deepEqual(transitions.map((entry) => ({ name: entry.name, values: entry.values.slice(0, -1) })), [
    { name: "newSession", values: [undefined] },
    { name: "fork", values: ["entry-7", { position: "at" }] },
    { name: "switchSession", values: ["/tmp/session.jsonl", undefined] },
  ]);
  assert.equal(transitions[0]?.values.at(-1), newSignal);
  assert.equal(transitions[1]?.values.at(-1), forkSignal);
  assert.equal(transitions[2]?.values.at(-1), switchSignal);
  assert.deepEqual(calls.filter((entry) => [
    "hasPendingMessages",
    "getSystemPromptOptions",
    "waitForIdle",
    "abort",
    "refresh",
    "shutdown",
  ].includes(entry.name)), [
    { name: "hasPendingMessages", values: [] },
    { name: "getSystemPromptOptions", values: [] },
    { name: "waitForIdle", values: [] },
    { name: "abort", values: [] },
    { name: "refresh", values: [] },
    { name: "shutdown", values: [] },
  ]);
  assert.deepEqual(notices, [
    JSON.stringify({ pendingMessages: true, promptCwd: workspace, selectedTools: ["read"] }),
    "Cancellation requested.",
  ]);
});

test("session metadata delegates naming, append-only entries, labels, and rendering", async (context) => {
  const { host, calls } = await loadExample(context, "session-metadata");
  const owner = host.extensions()[0];
  assert.ok(owner);
  const notices: string[] = [];
  await runCommand(host, "example-session-metadata", "review entry-4", notices);
  assert.deepEqual(calls.filter((entry) => ["setSessionName", "appendEntry", "setLabel"].includes(entry.name)), [
    { name: "setSessionName", values: ["review"] },
    { name: "appendEntry", values: ["example-session-note", { note: "Named review" }, {
      schemaVersion: 1,
      extensionId: owner.extensionId,
      sourceSha256: owner.sha256,
    }] },
    { name: "setLabel", values: ["entry-4", "Session review"] },
  ]);
  assert.deepEqual(notices, ["Session name: review"]);
  assert.equal(Value.Check(FUNCTION_VALUE, host.entryRenderer("example-session-note")), true);
});

test("dynamic package discovers its skill and prompt from its package root", async (context) => {
  const { host } = await loadExample(context, "dynamic-package");
  const resources = await host.discoverResources("startup");
  assert.deepEqual(resources.skillPaths.map((entry) => entry.path), ["skills"]);
  assert.deepEqual(resources.promptPaths.map((entry) => entry.path), ["prompts"]);
  assert.equal(resources.skillPaths[0]?.resourceRoot, resolve("examples", "dynamic-package"));
});

test("provider hooks transform request metadata and headers while retaining redacted response status", async (context) => {
  const { host } = await loadExample(context, "provider-hooks");
  assert.deepEqual(await host.applyBeforeProviderRequestPayload({ model: "example" }), {
    model: "example",
    metadata: { extensionExample: true },
  });
  const headers: Record<string, string | null> = {};
  await host.applyBeforeProviderHeaders(headers);
  assert.equal(headers["x-ohm-example"], "provider-hooks");
  await host.observeAfterProviderResponse(202, { "x-request-id": "request-7" });
  const notices: string[] = [];
  await runCommand(host, "example-provider-hooks", "", notices);
  assert.deepEqual(JSON.parse(notices[0]!), { status: 202, requestId: "request-7" });
});

test("runtime catalog example discovers resources, selects active state, and delivers a user follow-up", async (context) => {
  const { host, calls } = await loadExample(context, "runtime-catalog");
  const notices: string[] = [];
  await runCommand(host, "example-runtime-catalog", "", notices);
  const catalog = parseJson(RUNTIME_CATALOG_VALUE, notices[0]!);
  assert.deepEqual(catalog.activeTools, ["read"]);
  assert.deepEqual(catalog.allTools, ["read"]);
  assert.equal(catalog.commands.includes("example-runtime-select"), true);
  assert.deepEqual(catalog.resources, ["command:help", "prompt:review", "skill:audit"]);
  await runCommand(host, "example-runtime-select");
  assert.deepEqual(calls.filter((entry) => ["setActiveTools", "setModel", "sendUserMessage"].includes(entry.name)).map((entry) => entry.name), [
    "setActiveTools",
    "setModel",
    "sendUserMessage",
  ]);
  assert.deepEqual(calls.find((entry) => entry.name === "sendUserMessage")?.values, [
    "Review the updated runtime selection.",
    { deliverAs: "followUp" },
  ]);
});

test("session lifecycle example observes guards and delegates tree navigation and compaction", async (context) => {
  const { host, calls } = await loadExample(context, "session-lifecycle");
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "new" }), {});
  assert.deepEqual(await host.reduceSessionBeforeFork({
    sourceThreadId: "example-thread",
    sourceEventId: "entry-1",
    position: "at",
  }), {});
  const signal = new AbortController().signal;
  assert.deepEqual(await host.reduceSessionBeforeTree({
    preparation: { targetId: "entry-1", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false },
    signal,
  }), { customInstructions: "Retain decisions from the selected branch." });
  await host.reduceSessionBeforeCompact({
    preparation: {
      firstKeptEntryId: "entry-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 10,
      fileOps: {
        read: new Set(),
        written: new Set(),
        edited: new Set(),
      },
      settings: { enabled: true, reserveTokens: 4, recentTokens: 4, maxInputTokens: 6 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal,
  });
  await host.dispatch("session_compact", {
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    reason: "manual",
    summary: {
      id: "compact-1",
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      purpose: "compaction",
    },
    sourceMessageIds: ["entry-1"],
    fromExtension: false,
    willRetry: false,
  });
  await host.dispatch("session_tree", {
    threadId: "example-thread",
    previousEventId: "entry-0",
    currentEventId: "entry-1",
  });
  await runCommand(host, "example-session-navigate", "entry-1");
  await runCommand(host, "example-session-compact");
  const navigation = calls.find((entry) => entry.name === "navigateTree");
  assert.ok(navigation !== undefined);
  assert.deepEqual(navigation.values.slice(0, -1), [
    "entry-1",
    { summarize: true, label: "example branch" },
  ]);
  const navigationSignal = navigation.values.at(-1);
  assert.ok(navigationSignal instanceof AbortSignal);
  assert.equal(navigationSignal.aborted, false);
  assert.deepEqual(calls.find((entry) => entry.name === "compact"), {
    name: "compact",
    values: [{ customInstructions: "Preserve decisions and unfinished work." }],
  });
});

test("managed provider example exposes a refreshable catalog and OAuth callbacks without credentials", async (context) => {
  const { host } = await loadExample(context, "provider-catalog");
  const registration = host.directProviderRegistrations()[0];
  assert.ok(registration !== undefined && "config" in registration);
  assert.equal(registration.name, "example-managed");
  assert.equal(registration.config.oauth?.name, "Example subscription");
  assert.deepEqual(await registration.config.refreshModels?.({
    store: {
      async read() { return undefined; },
      async write() {},
      async delete() {},
    },
    allowNetwork: false,
    signal: new AbortController().signal,
  }), registration.config.models);
  assert.equal(registration.config.oauth?.getApiKey({ access: "opaque", refresh: "refresh", expires: Date.now() }), "opaque");
});

test("terminal workbench exercises input interception, editor helpers, themes, and expansion", async (context) => {
  const { host } = await loadExample(context, "terminal-workbench");
  const operations: string[] = [];
  let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let editorText = "draft";
  host.setDirectUiHandler(() => directUiContext({
    onTerminalInput(handler: RuntimeDirectTerminalInputHandler) { terminalHandler = handler; operations.push("terminal"); return () => { operations.push("terminal-stop"); }; },
    getEditorText() { return editorText; },
    setEditorText(value: string) { editorText = value; operations.push("set-editor"); },
    pasteToEditor(value: string) { editorText += value; operations.push("paste"); },
    async editor(_title: string, prefill?: string) { operations.push(`modal:${prefill}`); return prefill; },
    getAllThemes() { return [{ name: "mono", path: undefined }, { name: "light", path: undefined }]; },
    getTheme(name: string) { return name === "light" ? createTheme("mono", { color: true, unicode: true }) : undefined; },
    setTheme(name: string) { operations.push(`theme:${String(name)}`); return { success: true }; },
    getToolsExpanded() { return false; },
    setToolsExpanded(value: boolean) { operations.push(`expanded:${String(value)}`); },
    getEditorComponent() { return undefined; },
    notify(message: string) { operations.push(`notice:${message}`); },
  }));
  await runCommand(host, "example-terminal-workbench", "light");
  assert.deepEqual(terminalHandler?.("\u001b\u0005"), { consume: true });
  assert.deepEqual(terminalHandler?.("x"), { data: "x" });
  assert.deepEqual(operations.slice(0, 6), ["terminal", "set-editor", "paste", "modal:draftworkbench", "theme:light", "expanded:true"]);
});

test("project trust example asks through the restricted trust UI and returns an invocation-only decision", async (context) => {
  const { host, workspace } = await loadExample(context, "project-trust");
  const prompts: string[] = [];
  assert.deepEqual(await host.resolveProjectTrust({ workspace, cwd: workspace }, {
    hasUI: true,
    async confirm(title, message) { prompts.push(`${title}:${message}`); return true; },
  }), { decision: "yes" });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Load executable project resources/u);
});
