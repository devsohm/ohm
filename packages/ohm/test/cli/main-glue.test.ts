import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  caughtProcessFailure,
  InteractiveExtensionUiBinder,
  isStructuredOutputFailure,
  loginInteractively,
  parseInteractiveModelReference,
  pickModel,
  runtimeUi,
  type InteractiveLoginRuntime,
  type InteractiveUiRuntime,
  type ModelPickerRuntime,
} from "../../src/cli/main.js";
import { interactiveRuntimeCommandUi } from "../../src/modes/interactive-runtime-ui.js";
import { ProviderAuthRegistry } from "../../src/auth/registry.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  attachExtensionRuntimeHost,
  createExtensionRuntime,
  ExtensionRunner,
} from "../../src/extensions/compat-runtime.js";
import {
  RuntimeExtensionHost,
  type RuntimeDirectUiHandler,
} from "../../src/extensions/runtime.js";
import type { TerminalPrompter } from "../../src/interfaces/terminal.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, createProvider } from "../../src/providers/models.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { TuiController } from "../../src/tui/controller.js";
import {
  isRecordValue,
  isStringValue,
  type RuntimeValue,
} from "../../src/tui/value-guards.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

function runtimeWithModels(input: {
  models?: Array<{ id: string; displayName?: string; description?: string; contextTokens?: number }>;
  refresh?: { ok: true } | { ok: false; status: { error?: { message: string } } };
}): ModelPickerRuntime {
  return {
    providers: {
      refreshModels: async () => input.refresh ?? { ok: true },
      listModels: async () => input.models ?? [],
    },
  };
}

test("structured-output classification does not inspect hostile thrown objects", () => {
  let prototypeTrapCalls = 0;
  let descriptorTrapCalls = 0;
  let conversionTrapCalls = 0;
  const hostileFailure = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("top-level failure prototype must not be inspected");
    },
    getOwnPropertyDescriptor() {
      descriptorTrapCalls += 1;
      throw new Error("top-level failure descriptors must not be inspected");
    },
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) conversionTrapCalls += 1;
      throw new Error("top-level failure conversion must not be invoked");
    },
  });

  assert.equal(isStructuredOutputFailure(hostileFailure), false);
  assert.deepEqual(caughtProcessFailure(hostileFailure), { exitCode: 1, message: "[Thrown object]" });
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(descriptorTrapCalls, 0);
  assert.equal(conversionTrapCalls, 0);

  const branded = Object.assign(new Error("branded failure"), { exitCode: 23 });
  assert.deepEqual(caughtProcessFailure(branded), { exitCode: 23, message: "branded failure" });
});

test("explicit provider/model references override the current provider without splitting provider-owned slash model IDs", () => {
  assert.deepEqual(parseInteractiveModelReference("anthropic/claude-sonnet", "openai", ["openai", "anthropic", "openrouter"]), {
    provider: "anthropic",
    model: "claude-sonnet",
  });
  assert.deepEqual(parseInteractiveModelReference("moonshotai/kimi", "openrouter", ["openai", "anthropic", "openrouter"]), {
    provider: "openrouter",
    model: "moonshotai/kimi",
  });
  assert.deepEqual(parseInteractiveModelReference(undefined, "openai", ["openai"]), {
    provider: "openai",
    model: undefined,
  });
});

test("model picker uses verified catalogs and falls back to an exact deployment ID", async () => {
  const prompts: string[] = [];
  const terminal: TerminalPrompter = {
    async choose<T>(prompt: string, choices: Array<{ value: T }>): Promise<T> {
      prompts.push(prompt);
      return choices.at(-1)!.value;
    },
    async question(prompt: string): Promise<string> {
      prompts.push(prompt);
      return " private-deployment ";
    },
  };

  assert.equal(await pickModel(runtimeWithModels({
    models: [
      { id: "alpha", displayName: "Alpha", contextTokens: 32_000 },
      { id: "beta", description: "Beta model", contextTokens: 64_000 },
    ],
  }), "fixture", terminal), "beta");
  assert.equal(prompts[0], "Select fixture model");

  prompts.length = 0;
  assert.equal(await pickModel(runtimeWithModels({
    refresh: { ok: false, status: { error: { message: "catalog unavailable" } } },
  }), "fixture", terminal), "private-deployment");
  assert.deepEqual(prompts, ["Exact model/deployment ID: "]);

  await assert.rejects(
    pickModel(runtimeWithModels({ models: [] }), "fixture", {
      ...terminal,
      question: async () => "  ",
    }),
    /Model is required/u,
  );
});

test("extension command UI scopes resources and forwards bounded interactions", async () => {
  const calls: Array<{ name: string; values: RuntimeValue[] }> = [];
  let theme = "mono";
  let editorText = "draft";
  const record = (name: string, ...values: RuntimeValue[]): void => { calls.push({ name, values }); };
  const terminal = Object.assign(new TuiController({ mode: "accessible", handleSignals: false }), {
    notify: (...values: RuntimeValue[]) => record("notify", ...values),
    setExtensionStatus: (...values: RuntimeValue[]) => record("status", ...values),
    setExtensionWidget: (...values: RuntimeValue[]) => record("widget", ...values),
    setExtensionHeader: (...values: RuntimeValue[]) => record("header", ...values),
    setExtensionFooter: (...values: RuntimeValue[]) => record("footer", ...values),
    setExtensionWorkingMessage: (...values: RuntimeValue[]) => record("working-message", ...values),
    setExtensionWorkingVisible: (...values: RuntimeValue[]) => record("working-visible", ...values),
    setTitle: (...values: RuntimeValue[]) => record("title", ...values),
    setKeyedTitle: (...values: RuntimeValue[]) => record("keyed-title", ...values),
    selectedThemeName: () => theme,
    themeNames: () => ["mono", "ocean"],
    setTheme: (value: string) => { theme = value; record("theme", value); },
    choose: async <T>(_prompt: string, choices: Array<{ value: T }>, signal?: AbortSignal): Promise<T> => {
      signal?.throwIfAborted();
      return choices[0]!.value;
    },
    requestInput: async () => "typed input",
    editor: async () => "edited text",
    setEditorText: (value: string) => { editorText = value; },
    getEditorText: () => editorText,
    custom: async () => "custom result",
    showOverlay: () => ({ close: () => record("overlay-close") }),
  });
  const lifecycle = new AbortController();
  const interaction = new AbortController();
  const ui = runtimeUi(terminal, "fixture", lifecycle.signal, interaction.signal, "fixture-owner");

  ui.notify("ready", "status");
  ui.setStatus("phase", "running");
  ui.setWidget("panel", "widget");
  ui.setHeader("head", "header");
  ui.setFooter("foot", "footer");
  ui.setWorkingMessage("working");
  ui.setWorkingVisible(true);
  ui.setTitle("Fixture title");
  assert.deepEqual(await ui.getTheme(), { name: "mono", available: ["mono", "ocean"] });
  assert.deepEqual(await ui.setTheme("ocean"), { name: "ocean", available: ["mono", "ocean"] });
  assert.equal(await ui.select("Pick", [{ label: "One", value: 1 }]), 1);
  assert.equal(await ui.confirm("Confirm", "Proceed"), true);
  assert.equal(await ui.input("Input", "placeholder"), "typed input");
  assert.equal(await ui.editor("Editor", "prefill"), "edited text");
  ui.setEditorText("replacement");
  assert.equal(ui.getEditorText(), "replacement");
  assert.equal(await ui.custom(() => ({ render: () => ({ lines: [] }), handleKey: () => false })), "custom result");
  ui.showOverlay(() => ({ render: () => ({ lines: [] }), handleKey: () => false })).close();

  assert.deepEqual(calls.filter((entry) => ["status", "widget", "header", "footer"].includes(entry.name)), [
    { name: "status", values: ["fixture-owner:phase", "running", lifecycle.signal] },
    { name: "widget", values: ["fixture-owner:panel", "widget", lifecycle.signal] },
    { name: "header", values: ["fixture-owner:head", "header", lifecycle.signal] },
    { name: "footer", values: ["fixture-owner:foot", "footer", lifecycle.signal] },
  ]);
  assert.deepEqual(calls.find((entry) => entry.name === "working-message")?.values, ["fixture-owner", "working", lifecycle.signal]);
  assert.deepEqual(calls.find((entry) => entry.name === "working-visible")?.values, ["fixture-owner", true, lifecycle.signal]);
  assert.deepEqual(calls.find((entry) => entry.name === "keyed-title")?.values, ["fixture-owner:title", "Fixture title", lifecycle.signal]);
  interaction.abort(new Error("interaction ended"));
  await assert.rejects(ui.select("Pick", [{ label: "One", value: 1 }]), /interaction ended/u);
  lifecycle.abort();
  assert.throws(() => ui.notify("late"), /no longer active/u);
  terminal.close();
});

test("both interactive extension UI handlers enforce the fallback notification bound", () => {
  const notices: string[] = [];
  const terminal = Object.assign(new TuiController({ mode: "accessible", handleSignals: false }), {
    notify(message: string) { notices.push(message); },
  });
  const generation = new AbortController();
  const handlers = [
    runtimeUi(terminal, "legacy", generation.signal),
    interactiveRuntimeCommandUi(terminal, "public", generation.signal),
  ];
  const exact = "🙂".repeat(2 * 1024);

  for (const ui of handlers) {
    ui.notify(exact);
    const before = notices.length;
    assert.throws(() => ui.notify(`${exact}x`), /Notification exceeds 8192 bytes/u);
    assert.throws(() => ui.notify("before\0after"), /Notification exceeds 8192 bytes or contains NUL/u);
    assert.equal(notices.length, before, "rejected notices must not reach the terminal");
  }
  assert.deepEqual(notices, [exact, exact]);
  terminal.close();
});

test("CLI and public interactive mode share one extension UI host binding path", async () => {
  const [cli, mode, shared] = await Promise.all([
    readFile(new URL("../../src/cli/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/modes/interactive-mode.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/modes/interactive-runtime-ui.ts", import.meta.url), "utf8"),
  ]);
  const hostSetter = /\.(?:setUiHandler|setAdvancedUiHandler|setNativeUiHandler|setUnsafeTerminalHandler|setInteractiveUiHandler|setDirectUiHandler)\s*\(/u;

  assert.match(cli, /bindInteractiveRuntimeUi\s*\(/u);
  assert.match(mode, /bindInteractiveRuntimeUi\s*\(/u);
  assert.doesNotMatch(cli, hostSetter);
  assert.doesNotMatch(mode, hostSetter);
  assert.match(shared, hostSetter);
});

test("CLI runtime replacement factories forward cancellation into runtime loading", async () => {
  const rpc = await readFile(new URL("../../src/cli/rpc.ts", import.meta.url), "utf8");
  const start = rpc.indexOf("async function createRuntimeOwner");
  const end = rpc.indexOf("  let owner:", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const factory = rpc.slice(start, end);

  assert.match(factory, /sessionStartEvent, signal/u);
  assert.match(factory, /signal\?: AbortSignal/u);
  assert.match(factory, /optionalProperties\(signal === undefined \? undefined : \{ signal \}\)/u);
});

test("CLI TUI bindings share one extension error projection", async () => {
  const cli = await readFile(new URL("../../src/cli/main.ts", import.meta.url), "utf8");
  assert.match(cli, /onError: reportExtensionError/u);
  assert.doesNotMatch(cli, /(?:bindExtensions|updateExtensionBindings)\(\{\s*mode: "tui"/su);
  assert.equal((cli.match(/interactiveExtensionBindings\(/gu) ?? []).length, 4);
});

test("interactive extension UI binds every host surface across startup, refresh, resume, and workspace replacement", () => {
  const calls: Array<{ name: string; values: RuntimeValue[] }> = [];
  const terminal = new Proxy(new TuiController({ mode: "accessible", handleSignals: false }), {
    get(_target, property) {
      if (property === "selectedThemeName") return () => "mono";
      if (property === "themeNames") return () => ["mono"];
      if (property === "getToolOutputExpanded") return () => false;
      if (property === "actionsForKey") return () => [];
      if (property === "onThemeChange" || property === "registerUnsafeTerminalInputHandler") {
        return (...values: RuntimeValue[]) => {
          calls.push({ name: String(property), values });
          return () => undefined;
        };
      }
      return (...values: RuntimeValue[]) => { calls.push({ name: String(property), values }); };
    },
  });

  interface HandlerRegistry {
    ui?: Parameters<RuntimeExtensionHost["setUiHandler"]>[0];
    advanced?: Parameters<RuntimeExtensionHost["setAdvancedUiHandler"]>[0];
    native?: Parameters<RuntimeExtensionHost["setNativeUiHandler"]>[0];
    unsafe?: Parameters<RuntimeExtensionHost["setUnsafeTerminalHandler"]>[0];
    interactive?: Parameters<RuntimeExtensionHost["setInteractiveUiHandler"]>[0];
    direct?: Parameters<RuntimeExtensionHost["setDirectUiHandler"]>[0];
  }
  type FixtureExtensionChange = Parameters<Parameters<RuntimeExtensionHost["onChange"]>[0]>[0];

  function fixtureHost(id: string) {
    const lifecycle = new AbortController();
    const handlers: HandlerRegistry = {};
    const changes = new Set<Parameters<RuntimeExtensionHost["onChange"]>[0]>();
    let toolBindingRequests = 0;
    const host = new RuntimeExtensionHost(`/tmp/${id}`);
    const toolBinding = host.toolRendererBinding();
    const setUiHandler = host.setUiHandler.bind(host);
    const setAdvancedUiHandler = host.setAdvancedUiHandler.bind(host);
    const setNativeUiHandler = host.setNativeUiHandler.bind(host);
    const setUnsafeTerminalHandler = host.setUnsafeTerminalHandler.bind(host);
    const setInteractiveUiHandler = host.setInteractiveUiHandler.bind(host);
    const setDirectUiHandler = host.setDirectUiHandler.bind(host);
    Object.assign(host, {
      lifecycleSignal: (): AbortSignal => lifecycle.signal,
      toolRendererBinding: () => {
        toolBindingRequests += 1;
        return toolBinding;
      },
      onChange: (listener: Parameters<RuntimeExtensionHost["onChange"]>[0]) => {
        changes.add(listener);
        return () => { changes.delete(listener); };
      },
      initialUi: (): ReturnType<RuntimeExtensionHost["initialUi"]> => [{
        extensionId: id,
        sourcePath: `/tmp/${id}`,
        ownerKey: `${id}:owner`,
        signal: lifecycle.signal,
        type: "status",
        key: "phase",
        value: "ready",
      }],
      setUiHandler: (value: Parameters<RuntimeExtensionHost["setUiHandler"]>[0]) => {
        handlers.ui = value;
        setUiHandler(value);
      },
      setAdvancedUiHandler: (value: Parameters<RuntimeExtensionHost["setAdvancedUiHandler"]>[0]) => {
        handlers.advanced = value;
        setAdvancedUiHandler(value);
      },
      setNativeUiHandler: (value: Parameters<RuntimeExtensionHost["setNativeUiHandler"]>[0]) => {
        handlers.native = value;
        setNativeUiHandler(value);
      },
      setUnsafeTerminalHandler: (value: Parameters<RuntimeExtensionHost["setUnsafeTerminalHandler"]>[0]) => {
        handlers.unsafe = value;
        setUnsafeTerminalHandler(value);
      },
      setInteractiveUiHandler: (value: Parameters<RuntimeExtensionHost["setInteractiveUiHandler"]>[0]) => {
        handlers.interactive = value;
        setInteractiveUiHandler(value);
      },
      setDirectUiHandler: (value: Parameters<RuntimeExtensionHost["setDirectUiHandler"]>[0]) => {
        handlers.direct = value;
        setDirectUiHandler(value);
      },
    });
    return {
      id,
      host,
      lifecycle,
      handlers,
      toolBinding,
      toolBindingRequests: () => toolBindingRequests,
      changed: (value: FixtureExtensionChange) => { for (const change of changes) change(value); },
      changeListeners: () => changes.size,
    };
  }

  const runtime = (
    fixture: ReturnType<typeof fixtureHost>,
    workspace: string,
    enableSkillCommands = true,
    promptIds: readonly string[] = ["static-prompt"],
  ): InteractiveUiRuntime => {
    const extensionRuntime = createExtensionRuntime();
    attachExtensionRuntimeHost(extensionRuntime, fixture.host);
    const extensionRunner = new ExtensionRunner(
      [],
      extensionRuntime,
      workspace,
      SessionManager.inMemory(workspace),
      new ModelRegistry(createModels()),
    );
    return {
      workspace,
      settings: SettingsManager.inMemory({
        treeFilterMode: "all",
        outputPad: 0,
        autocompleteMaxVisible: 10,
        terminal: { showImages: true, imageWidthCells: 40, clearOnShrink: true },
        markdown: { codeBlockIndent: "" },
        theme: "mono",
        enableSkillCommands,
      }),
      resourceLoader: {
        getSkills: () => ({
          skills: [
            {
              name: "review",
              description: "Review the current changes",
              filePath: "/skills/review/SKILL.md",
            },
            {
              name: "static-prompt",
              description: "Prompt-owned skill",
              filePath: "/skills/static-prompt/SKILL.md",
            },
          ],
        }),
      },
      session: {
        toolRendererBinding: () => fixture.host.toolRendererBinding(),
        extensionRunner,
      },
      runtimeExtensions: fixture.host,
      extensions: {
        bundle: () => ({
          commands: [{ extensionId: fixture.id, name: "static-command" }],
          prompts: promptIds.map((id) => ({ extensionId: fixture.id, id })),
          themes: [],
        }),
      },
    };
  };

  const startup = fixtureHost("startup");
  const binder = new InteractiveExtensionUiBinder(terminal);
  const startupRuntime = runtime(startup, "/workspace-a", false);
  assert.equal(binder.bind(startupRuntime), true);
  assert.ok(["setToolRenderers", "setSessionRenderers", "setExtensionShortcuts",
    "setCommandCompletionProvider", "setCommandItems",
    "setCustomThemes", "setExtensionStatus"].every((name) => calls.some((call) => call.name === name)), calls.map((call) => call.name).join(", "));
  const latestValue = (name: string, index: number): RuntimeValue =>
    calls.findLast((call) => call.name === name)?.values[index];
  const commandValues = (): string[] => {
    const items = latestValue("setCommandItems", 0);
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!isRecordValue(item)) return [];
      const value = item["value"];
      return isStringValue(value) ? [value] : [];
    });
  };
  assert.equal(commandValues().includes("/skill:review"), false, "disabled skill commands stay out of installed CLI completion");
  startupRuntime.settings.setEnableSkillCommands(true);
  binder.refreshCommands(startupRuntime);
  assert.equal(commandValues().includes("/skill:review"), true, "enabling skill commands updates installed CLI completion");
  assert.equal(commandValues().includes("/static-prompt"), true, "the prompt remains the canonical visible command");
  assert.equal(commandValues().includes("/skill:static-prompt"), false, "a matching prompt hides the redundant skill command");
  startupRuntime.settings.setEnableSkillCommands(false);
  binder.refreshCommands(startupRuntime);
  assert.equal(commandValues().includes("/skill:review"), false, "disabling skill commands removes installed CLI completion");
  assert.equal(latestValue("setToolRenderers", 0), startup.toolBinding);
  const startupSessionRenderers = latestValue("setSessionRenderers", 0);
  assert.ok(isRecordValue(startupSessionRenderers));
  assert.equal(startupSessionRenderers["transformMarkdown"], undefined, "an absent Markdown extension must not claim the transcript");
  const startupBindingSignal = latestValue("setToolRenderers", 1);
  assert.ok(startupBindingSignal instanceof AbortSignal);
  assert.notEqual(startupBindingSignal, startup.lifecycle.signal);
  assert.equal(startupBindingSignal.aborted, false);
  assert.equal(startup.changeListeners(), 1);
  assert.equal(startup.toolBindingRequests(), 1);
  assert.deepEqual(Object.keys(startup.handlers).sort(), ["advanced", "direct", "interactive", "native", "ui", "unsafe"]);
  const direct = startup.handlers.direct;
  assert.ok(direct !== undefined);
  const stressGeneration = new AbortController();
  const themeListenersBeforeStress = calls.filter((call) => call.name === "onThemeChange").length;
  const inputHandlersBeforeStress = calls.filter((call) => call.name === "registerUnsafeTerminalInputHandler").length;
  let firstStressContext: ReturnType<typeof direct> | undefined;
  let lastStressContext: ReturnType<typeof direct> | undefined;
  for (let index = 0; index < 1_000; index += 1) {
    const callback = new AbortController();
    const selected = direct("stress-extension", callback.signal, "stress-extension:source", stressGeneration.signal);
    firstStressContext ??= selected;
    lastStressContext = selected;
  }
  assert.notEqual(firstStressContext, lastStressContext, "each callback receives a lightweight cancellation facade");
  assert.equal(
    calls.filter((call) => call.name === "onThemeChange").length - themeListenersBeforeStress,
    1,
    "one generation creates one heavy theme listener",
  );
  assert.equal(
    calls.filter((call) => call.name === "registerUnsafeTerminalInputHandler").length - inputHandlersBeforeStress,
    1,
    "one generation creates one heavy raw input handler",
  );
  stressGeneration.abort(new Error("stress generation ended"));
  const presentationGeneration = new AbortController();
  const presentationCallback = new AbortController();
  const presentationUi = direct(
    "presentation-extension",
    presentationCallback.signal,
    "presentation-extension:source",
    presentationGeneration.signal,
  );
  presentationUi.onTerminalInput(() => undefined);
  const presentationRegistrationSignal = latestValue("registerUnsafeTerminalInputHandler", 1);
  assert.ok(presentationRegistrationSignal instanceof AbortSignal);
  assert.equal(presentationRegistrationSignal.aborted, false);
  presentationCallback.abort(new Error("callback cancelled"));
  assert.equal(presentationRegistrationSignal.aborted, true, "callback cancellation releases its presentation input");
  assert.equal(presentationGeneration.signal.aborted, false);
  presentationGeneration.abort(new Error("presentation generation ended"));
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const firstDirect = direct("same-extension", firstGeneration.signal, "same-extension:source-a", firstGeneration.signal);
  assert.equal(direct("same-extension", firstGeneration.signal, "same-extension:source-a", firstGeneration.signal), firstDirect);
  firstDirect.onTerminalInput(() => undefined);
  const firstDirectRegistrationSignal = latestValue("registerUnsafeTerminalInputHandler", 1);
  assert.ok(firstDirectRegistrationSignal instanceof AbortSignal);
  const secondDirect = direct("same-extension", secondGeneration.signal, "same-extension:source-a", secondGeneration.signal);
  assert.notEqual(secondDirect, firstDirect, "a replacement extension generation receives a fresh UI context");
  const otherSourceGeneration = new AbortController();
  assert.notEqual(
    direct("same-extension", otherSourceGeneration.signal, "same-extension:source-b", otherSourceGeneration.signal),
    secondDirect,
    "distinct active sources sharing a declared ID receive independent UI contexts",
  );
  secondDirect.onTerminalInput(() => undefined);
  const directRegistrationSignal = latestValue("registerUnsafeTerminalInputHandler", 1);
  assert.ok(directRegistrationSignal instanceof AbortSignal);
  assert.notEqual(directRegistrationSignal, secondGeneration.signal);
  assert.equal(directRegistrationSignal.aborted, false);
  secondGeneration.abort(new Error("extension generation replaced"));
  assert.equal(directRegistrationSignal.aborted, true, "direct terminal registrations follow the extension generation");
  const genericSessionUi: RuntimeDirectUiHandler = (...parameters) => direct(...parameters);
  startup.host.setDirectUiHandler(genericSessionUi);
  assert.equal(startup.handlers.direct, genericSessionUi);
  binder.restoreDirectContext(startupRuntime);
  assert.notEqual(
    startup.handlers.direct,
    genericSessionUi,
    "session binding cannot permanently replace the extension-scoped direct UI handler",
  );

  const toolBindings = () => calls.filter((call) => call.name === "setToolRenderers").length;
  const beforeResume = toolBindings();
  assert.equal(binder.bind(startupRuntime), false, "in-place resume keeps the active generation");
  assert.equal(toolBindings(), beforeResume);
  assert.equal(startup.changeListeners(), 1);
  const unavailable = fixtureHost("unavailable");
  unavailable.lifecycle.abort(new Error("candidate host is unavailable"));
  assert.throws(
    () => binder.bind(runtime(unavailable, "/workspace-b")),
    /candidate host is unavailable/u,
  );
  assert.equal(startup.changeListeners(), 1, "an invalid candidate does not release the current binding");
  startup.changed("tool_renderer");
  assert.equal(toolBindings(), beforeResume + 1, "live registrations rebind the renderer adapter");
  assert.equal(startup.toolBindingRequests(), 1, "live registrations reuse the generation-owned renderer binding");

  assert.equal(binder.bind(startupRuntime, true), true, "in-place refresh replaces its UI binding");
  assert.equal(startupBindingSignal.aborted, true);
  assert.equal(firstDirectRegistrationSignal.aborted, true);
  assert.equal(startup.changeListeners(), 1, "in-place refresh does not retain the previous change listener");

  const refreshed = fixtureHost("refresh");
  assert.equal(binder.bind(runtime(refreshed, "/workspace-a", true, [])), true, "refresh binds the replacement generation");
  assert.equal(startup.changeListeners(), 0);
  assert.equal(refreshed.changeListeners(), 1);
  assert.equal(commandValues().includes("/skill:review"), true, "refresh rebinds enabled discovered skills");
  assert.equal(commandValues().includes("/skill:static-prompt"), true, "refresh reveals a skill after its matching prompt is removed");
  assert.equal(calls.filter((call) => call.name === "clearExtensionUi").length, 3);
  const replacement = fixtureHost("workspace");
  assert.equal(binder.bind(runtime(replacement, "/workspace-b")), true, "cross-workspace resume binds the replacement runtime");
  assert.equal(refreshed.changeListeners(), 0);
  assert.equal(replacement.changeListeners(), 1);
  assert.equal(calls.filter((call) => call.name === "clearExtensionUi").length, 4);
  binder.close();
  assert.equal(replacement.changeListeners(), 0);
  assert.deepEqual(Object.values(replacement.handlers), Array(6).fill(undefined));
});

test("interactive login routes direct extension providers through the model registry credential store", async () => {
  const progress: string[] = [];
  const loginTypes: string[] = [];
  const promptAnswers: string[] = [];
  const questionPrompts: string[] = [];
  const secretPrompts: string[] = [];
  const provider = createProvider({
    id: "direct-oauth",
    name: "Direct OAuth",
    auth: { oauth: {
      name: "Direct subscription",
      loginLabel: "Connect subscription",
      async login(interaction) {
        loginTypes.push("oauth");
        interaction.notify({ type: "progress", message: "Direct provider login" });
        promptAnswers.push(
          await interaction.prompt({ type: "manual_code", message: "Paste authorization code: " }),
          await interaction.prompt({ type: "text", message: "Account label: " }),
        );
        return { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60 * 60_000 };
      },
      async refresh(credential) { return credential; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
    models: [],
    api: { async *stream() {} },
  });
  const models = createModels();
  models.setProvider(provider);
  const modelRegistry = new ModelRegistry(models);
  const refresh = modelRegistry.refresh.bind(modelRegistry);
  Object.assign(modelRegistry, {
    async refresh(options?: Parameters<ModelRegistry["refresh"]>[0]) {
      progress.push("refreshed");
      return await refresh(options);
    },
  });
  const runtime = {
    providers: new ProviderRegistry(),
    auth: new ProviderAuthRegistry({ bindings: [], store: new InMemoryCredentialStore() }),
    modelRegistry,
    network: { fetch },
  } satisfies InteractiveLoginRuntime;
  const terminal = Object.assign(new TuiController({ mode: "accessible", handleSignals: false }), {
    notify(message: string) { progress.push(message); },
    async choose<T>(_message: string, choices: Array<{ value: T }>) { return choices[0]!.value; },
    async question(prompt: string) {
      questionPrompts.push(prompt);
      return "answer";
    },
    async readSecret(prompt: string) {
      secretPrompts.push(prompt);
      return "secret";
    },
  });

  assert.equal(await loginInteractively(runtime, terminal, undefined, undefined, true), provider.id);
  assert.deepEqual(loginTypes, ["oauth"]);
  assert.deepEqual(promptAnswers, ["secret", "answer"]);
  assert.deepEqual(secretPrompts, ["Paste authorization code: "]);
  assert.deepEqual(questionPrompts, ["Account label: "]);
  assert.deepEqual(progress, ["Direct provider login", "refreshed"]);
  terminal.close();
});
