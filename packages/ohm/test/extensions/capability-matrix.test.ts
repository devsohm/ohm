import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { STRING_VALUE } from "../../src/core/value-schemas.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEventResultMap,
  ExtensionMode,
  ExtensionUIContext,
} from "../../src/extensions/direct.js";
import {
  loadDirectExtensions,
  type RuntimeExtensionChange,
} from "../../src/extensions/runtime.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALL_HOSTS = ["tui", "print", "json", "rpc", "serve", "sdk"] as const satisfies readonly ExtensionMode[];
type MissingExtensionMode = Exclude<ExtensionMode, (typeof ALL_HOSTS)[number]>;
const extensionModeInventoryIsComplete: Record<MissingExtensionMode, never> = {};
void extensionModeInventoryIsComplete;
const RUNTIME_CHANGE_CATEGORIES = [
  "tool",
  "command",
  "shortcut",
  "flag",
  "session_renderer",
  "tool_renderer",
] as const satisfies readonly RuntimeExtensionChange[];
type MissingRuntimeChangeCategory = Exclude<RuntimeExtensionChange, (typeof RUNTIME_CHANGE_CATEGORIES)[number]>;
const runtimeChangeCategoryInventoryIsComplete: Record<MissingRuntimeChangeCategory, never> = {};
void runtimeChangeCategoryInventoryIsComplete;

const EVENT_RESULT_TYPES = {
  resources_discover: "ResourcesDiscoverResult | void",
  project_trust: "ProjectTrustEventResult | void",
  session_start: "void",
  session_info_changed: "void",
  session_before_switch: "SessionBeforeSwitchResult | void",
  session_before_fork: "SessionBeforeForkResult | void",
  session_before_tree: "SessionBeforeTreeResult | void",
  session_tree: "void",
  session_before_compact: "SessionBeforeCompactResult | void",
  session_compact: "void",
  session_compact_failed: "void",
  session_shutdown: "void",
  context: "ContextEventResult | void",
  before_provider_request: "BeforeProviderRequestEventResult | void",
  before_provider_headers: "void",
  after_provider_response: "void",
  before_agent_start: "BeforeAgentStartEventResult | void",
  agent_start: "void",
  agent_end: "void",
  agent_settled: "void",
  turn_start: "void",
  turn_end: "void",
  message_start: "void",
  message_update: "void",
  message_end: "MessageEndEventResult | void",
  tool_execution_start: "void",
  tool_execution_update: "void",
  tool_execution_end: "void",
  model_select: "void",
  thinking_level_select: "void",
  input: "InputEventResult | void",
  ui_prompt_start: "void",
  ui_prompt_end: "void",
  user_bash: "UserBashEventResult | void",
  tool_call: "ToolCallEventResult | void",
  tool_result: "ToolResultEventResult | void",
} as const satisfies Record<keyof ExtensionEventResultMap, string>;

const EXTENSION_MODE_VALUE = Type.Union([
  Type.Literal("tui"),
  Type.Literal("print"),
  Type.Literal("json"),
  Type.Literal("rpc"),
  Type.Literal("serve"),
  Type.Literal("sdk"),
]);
const PACKAGE_MANIFEST_VALUE = Type.Object({
  ohm: Type.Optional(Type.Object({ extensions: Type.Optional(Type.Array(Type.String())) })),
});
const CAPABILITY_MATRIX_VALUE = Type.Object({
  schemaVersion: Type.Literal(1),
  hosts: Type.Array(EXTENSION_MODE_VALUE),
  capabilities: Type.Array(Type.Object({
    id: Type.String(),
    status: Type.Literal("implemented"),
    authoring: Type.Boolean(),
    hosts: Type.Array(EXTENSION_MODE_VALUE),
    apiMembers: Type.Array(Type.String()),
    eventContracts: Type.Optional(Type.Array(Type.Object({
      name: Type.String(),
      resultType: Type.String(),
    }))),
    docs: Type.Array(Type.String()),
    examples: Type.Array(Type.String()),
    tests: Type.Array(Type.String()),
  })),
});
const ERROR_CODE_VALUE = Type.Object({ code: Type.Optional(Type.String()) });

function parseJson<Schema extends TSchema>(schema: Schema, source: string): Static<Schema> {
  const value: unknown = JSON.parse(source);
  if (!Value.Check(schema, value)) throw new Error("Capability JSON does not match its test contract");
  return value;
}

function errorCode<ValueType>(value: ValueType): string | undefined {
  return Value.Check(ERROR_CODE_VALUE, value) ? value.code : undefined;
}

const DOCUMENTED_API_MEMBERS = [
  "appendEntry",
  "childSessions",
  "config",
  "events",
  "exec",
  "facets",
  "getActiveTools",
  "getAllTools",
  "getCommands",
  "getDiscoveryView",
  "getFlag",
  "getSessionName",
  "getThinkingLevel",
  "jobs",
  "on",
  "onDispose",
  "processes",
  "registerCommand",
  "registerEntryRenderer",
  "registerFlag",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerProvider",
  "registerShortcut",
  "registerTool",
  "sendMessage",
  "sendUserMessage",
  "services",
  "setActiveTools",
  "setLabel",
  "setModel",
  "setSessionName",
  "setThinkingLevel",
  "unregisterProvider",
] as const satisfies readonly (keyof ExtensionAPI)[];

type UndocumentedExtensionApiMember = Exclude<keyof ExtensionAPI, (typeof DOCUMENTED_API_MEMBERS)[number]>;
const extensionApiMemberInventoryIsComplete: Record<UndocumentedExtensionApiMember, never> = {};
void extensionApiMemberInventoryIsComplete;

type CapabilityApiMember =
  | keyof ExtensionAPI
  | keyof ExtensionContext
  | keyof ExtensionCommandContext
  | keyof ExtensionUIContext;

const CAPABILITY_API_MEMBERS = [
  "abort",
  "addAutocompleteProvider",
  "appendEntry",
  "childSessions",
  "capabilities",
  "compact",
  "confirm",
  "config",
  "custom",
  "cwd",
  "editor",
  "events",
  "exec",
  "facets",
  "fork",
  "getActiveTools",
  "getAllTools",
  "getAllThemes",
  "getCommands",
  "getContextUsage",
  "getDiscoveryView",
  "getEditorComponent",
  "getEditorText",
  "getFlag",
  "getSessionName",
  "getSystemPrompt",
  "getSystemPromptOptions",
  "getTheme",
  "getThinkingLevel",
  "getToolsExpanded",
  "hasPendingMessages",
  "hasUI",
  "input",
  "isIdle",
  "isProjectTrusted",
  "jobs",
  "mode",
  "model",
  "modelRegistry",
  "navigateTree",
  "newSession",
  "notify",
  "on",
  "onDispose",
  "onTerminalInput",
  "pasteToEditor",
  "paths",
  "processes",
  "refresh",
  "registerCommand",
  "registerEntryRenderer",
  "registerFlag",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerProvider",
  "registerShortcut",
  "registerTool",
  "sendMessage",
  "sendUserMessage",
  "services",
  "sessionManager",
  "sessionDelivery",
  "setBackground",
  "scopedModels",
  "routes",
  "select",
  "setFooter",
  "setHeader",
  "setHiddenThinkingLabel",
  "slots",
  "setActiveTools",
  "setEditorComponent",
  "setEditorText",
  "setLabel",
  "setModel",
  "setSessionName",
  "setStatus",
  "setTheme",
  "setThinkingLevel",
  "setTitle",
  "setToolsExpanded",
  "setWidget",
  "setWorkingIndicator",
  "setWorkingMessage",
  "setWorkingVisible",
  "shutdown",
  "signal",
  "switchSession",
  "theme",
  "thinkingLevel",
  "ui",
  "unregisterProvider",
  "waitForIdle",
] as const satisfies readonly CapabilityApiMember[];

type MissingCapabilityApiMember = Exclude<CapabilityApiMember, (typeof CAPABILITY_API_MEMBERS)[number]>;
const capabilityApiMemberInventoryIsComplete: Record<MissingCapabilityApiMember, never> = {};
void capabilityApiMemberInventoryIsComplete;

const TUI_ONLY_CAPABILITIES = new Set([
  "interactive-shortcuts",
  "extension-ui-routes",
  "ordered-session-ui-slots",
  "trusted-ui-surfaces",
  "trusted-editor-ui",
  "terminal-workbench-ui",
]);

const TEST_ONLY_API_EVIDENCE = new Map<string, ReadonlyMap<string, string>>([
  ["bounded-process-execution", new Map([
    ["exec", "test/extensions/direct-factory-contract.test.ts"],
  ])],
  ["durable-jobs-and-child-sessions", new Map([
    ["jobs", "test/extensions/durable-jobs.test.ts"],
    ["childSessions", "test/extensions/durable-jobs.test.ts"],
  ])],
  ["optional-facets-portable-presentations-and-wire-services", new Map([
    ["facets", "test/extensions/facets.test.ts"],
  ])],
  ["callback-context-contract", new Map([
    ["abort", "test/extensions/runtime-authoring.test.ts"],
    ["cwd", "test/extensions/runtime-authoring.test.ts"],
    ["getSystemPromptOptions", "test/extensions/runtime-authoring.test.ts"],
    ["hasPendingMessages", "test/service/agent-session.test.ts"],
    ["hasUI", "test/extensions/runtime-authoring.test.ts"],
    ["isIdle", "test/service/agent-session.test.ts"],
    ["isProjectTrusted", "test/extensions/runtime-authoring.test.ts"],
    ["mode", "test/extensions/runtime-authoring.test.ts"],
    ["model", "test/service/agent-session.test.ts"],
    ["modelRegistry", "test/extensions/runtime-authoring.test.ts"],
    ["sessionDelivery", "test/extensions/session-delivery-runtime.test.ts"],
    ["shutdown", "test/service/agent-session.test.ts"],
    ["signal", "test/extensions/runtime-authoring.test.ts"],
    ["thinkingLevel", "test/service/agent-session.test.ts"],
    ["waitForIdle", "test/extensions/runtime-authoring.test.ts"],
  ])],
  ["terminal-workbench-ui", new Map([
    "addAutocompleteProvider",
    "confirm",
    "custom",
    "editor",
    "getAllThemes",
    "getEditorComponent",
    "getEditorText",
    "getTheme",
    "getToolsExpanded",
    "input",
    "notify",
    "onTerminalInput",
    "pasteToEditor",
    "select",
    "setBackground",
    "setEditorText",
    "setFooter",
    "setHeader",
    "setHiddenThinkingLabel",
    "setStatus",
    "setTheme",
    "setTitle",
    "setToolsExpanded",
    "setWidget",
    "setWorkingIndicator",
    "setWorkingMessage",
    "setWorkingVisible",
    "theme",
  ].map((member) => [member, "test/extensions/runtime-authoring.test.ts"] as const))],
]);

test("direct factories receive the complete documented generation API", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-extension-api-surface-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const observed: string[][] = [];
  const host = await loadDirectExtensions([], {
    workspace,
    inlineExtensions: [{
      name: "surface",
      factory(api) {
      observed.push(Reflect.ownKeys(api).filter((key): key is string => Value.Check(STRING_VALUE, key)).sort());
      },
    }],
  });
  context.after(async () => await host.close());

  assert.equal(observed.length, 1);
  for (const member of DOCUMENTED_API_MEMBERS) {
    assert.equal(observed[0]!.includes(member), true, member);
  }
  assert.equal(observed[0]!.includes("ui"), false, "UI is callback-scoped");
});

test("the public callback mode union covers every host-facing execution mode", () => {
  assert.deepEqual([...ALL_HOSTS], ["tui", "print", "json", "rpc", "serve", "sdk"]);
});

test("the runtime change union matches every emitted category", async () => {
  const source = await readFile(join(packageRoot, "src/extensions/runtime.ts"), "utf8");
  const emitted = [...source.matchAll(/this\.#changed\("([a-z_]+)"/gu)]
    .map((match) => match[1]!)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  assert.deepEqual(emitted, [...RUNTIME_CHANGE_CATEGORIES].sort());
});

function unique(values: readonly string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

async function assertPackagePath(relativePath: string): Promise<void> {
  assert.equal(relativePath.startsWith("/") || relativePath.includes("\\"), false, relativePath);
  const path = resolve(packageRoot, relativePath);
  assert.equal(path.startsWith(`${packageRoot}${sep}`), true, `${relativePath} escapes the package root`);
  await access(path);
}

async function exampleAccessedMembers(relativeRoot: string): Promise<Set<string>> {
  const root = join(packageRoot, relativeRoot);
  const manifest = parseJson(
    PACKAGE_MANIFEST_VALUE,
    await readFile(join(root, "package.json"), "utf8"),
  );
  const entries = manifest.ohm?.extensions;
  assert.notEqual(entries, undefined, `${relativeRoot} has no extension entries`);
  const members = new Set<string>();
  for (const entry of entries ?? []) {
    const source = await readFile(join(root, entry), "utf8");
    for (const match of source.matchAll(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/gu)) members.add(match[1]!);
  }
  return members;
}

async function sourceAccessedMembers(relativePath: string): Promise<Set<string>> {
  const source = await readFile(join(packageRoot, relativePath), "utf8");
  return new Set([...source.matchAll(/\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/gu)].map((match) => match[1]!));
}

test("extension capability metadata validates every referenced artifact and example package", async () => {
  const matrix = parseJson(
    CAPABILITY_MATRIX_VALUE,
    await readFile(join(packageRoot, "docs/extension-capabilities.json"), "utf8"),
  );
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(matrix.hosts, [...ALL_HOSTS]);
  unique(matrix.hosts, "host inventory");
  unique(matrix.capabilities.map((capability) => capability.id), "capability ids");

  const documentedMembers = new Set<string>();
  const documentedEvents = new Set<string>();
  const documentedExamples = new Set<string>();
  const exampleMembers = new Map<string, Set<string>>();
  for (const capability of matrix.capabilities) {
    assert.match(capability.id, /^[a-z][a-z0-9-]*$/u);
    assert.equal(capability.status, "implemented", capability.id);
    assert.equal(capability.authoring, true, capability.id);
    assert.equal(capability.hosts.length > 0, true, capability.id);
    unique(capability.hosts, `${capability.id} hosts`);
    for (const host of capability.hosts) {
      assert.equal(ALL_HOSTS.includes(host), true, `${capability.id} has unknown host ${host}`);
    }
    const expectedHosts = TUI_ONLY_CAPABILITIES.has(capability.id)
      ? ["tui"]
      : capability.id === "session-flow-controls"
        ? ALL_HOSTS.filter((host) => host !== "serve")
        : [...ALL_HOSTS];
    assert.deepEqual(capability.hosts, expectedHosts, `${capability.id} host coverage drifted`);
    for (const member of capability.apiMembers) documentedMembers.add(member);
    for (const contract of capability.eventContracts ?? []) {
      assert.equal(documentedEvents.has(contract.name), false, `${contract.name} has multiple capability owners`);
      documentedEvents.add(contract.name);
      const expectedResult = Object.entries(EVENT_RESULT_TYPES)
        .find(([name]) => name === contract.name)?.[1];
      assert.notEqual(expectedResult, undefined, `${contract.name} is not a public event`);
      assert.equal(contract.resultType, expectedResult, `${contract.name} result contract drifted`);
      assert.equal(
        capability.docs.includes("docs/extension-events.md"),
        true,
        `${contract.name} has no event documentation claim`,
      );
    }
    for (const example of capability.examples) documentedExamples.add(example);
    for (const path of [...capability.docs, ...capability.examples, ...capability.tests]) {
      await assertPackagePath(path);
    }
    const accessed = new Set<string>();
    for (const example of capability.examples) {
      let members = exampleMembers.get(example);
      if (members === undefined) {
        members = await exampleAccessedMembers(example);
        exampleMembers.set(example, members);
      }
      for (const member of members) accessed.add(member);
    }
    for (const member of capability.apiMembers) {
      if (accessed.has(member)) continue;
      const testPath = TEST_ONLY_API_EVIDENCE.get(capability.id)?.get(member);
      assert.notEqual(testPath, undefined, `${capability.id} examples do not exercise ${member}`);
      assert.equal(capability.tests.includes(testPath!), true, `${capability.id} omits ${member} test evidence`);
      assert.equal(
        (await sourceAccessedMembers(testPath!)).has(member),
        true,
        `${capability.id} test evidence does not exercise ${member}`,
      );
    }
  }

  for (const member of DOCUMENTED_API_MEMBERS) {
    assert.equal(documentedMembers.has(member), true, `${member} is absent from the capability matrix`);
  }
  assert.deepEqual(
    [...documentedEvents].sort(),
    Object.keys(EVENT_RESULT_TYPES).sort(),
    "the capability matrix must own every public event and result contract exactly once",
  );
  const shortcut = matrix.capabilities.find((capability) => capability.apiMembers.includes("registerShortcut"));
  assert.deepEqual(shortcut?.hosts, ["tui"]);
  assert.deepEqual([...documentedMembers].sort(), [...CAPABILITY_API_MEMBERS].sort());

  const packageExamples: string[] = [];
  for (const entry of await readdir(join(packageRoot, "examples"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(packageRoot, "examples", entry.name, "package.json"));
      packageExamples.push(`examples/${entry.name}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  assert.deepEqual([...documentedExamples].sort(), packageExamples.sort());
});
