import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { EventBus } from "../../src/core/event-bus.js";
import { STRING_VALUE } from "../../src/core/value-schemas.js";
import type {
  ExtensionAPI,
  ExtensionRegistrationHandle,
} from "../../src/extensions/direct.js";
import {
  loadDirectExtensions,
  type RuntimeDirectActionsHandler,
} from "../../src/extensions/runtime.js";

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  factory: (api: ExtensionAPI) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "ohm-registration-handles-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{ name: "registration-handles", factory }],
  });
  return { host, root };
}

function tool(description: string) {
  return {
    name: "handle_tool",
    label: "Handle tool",
    description,
    parameters: Type.Object({}, { additionalProperties: false }),
    renderShell: "self" as const,
    async execute() {
      return { content: [{ type: "text" as const, text: description }], details: {} };
    },
  };
}

function actions(root: string, providerEvents: string[]): RuntimeDirectActionsHandler {
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
    registerProvider(providerOrName) {
      providerEvents.push(`register:${Value.Check(STRING_VALUE, providerOrName) ? providerOrName : providerOrName.id}`);
    },
    unregisterProvider(name) { providerEvents.push(`unregister:${name}`); },
    getSystemPromptOptions: () => ({ cwd: root }),
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async refresh() {},
  };
}

test("staged registration handles are callable, idempotent, and commit nothing after disposal", async (context) => {
  const handles: ExtensionRegistrationHandle[] = [];
  let disposeCalls = 0;
  let eventCalls = 0;
  const { host } = await fixture(context, (api) => {
    handles.push(
      api.onDispose(() => { disposeCalls += 1; }),
      api.on("session_start", () => { eventCalls += 1; }),
      api.events.on("handle:event", () => { eventCalls += 1; }),
      api.registerTool(tool("staged")),
      api.registerCommand("handle-command", { handler() {} }),
      api.registerShortcut("ctrl+k", { handler() {} }),
      api.registerFlag("handle-flag", { type: "boolean", default: true }),
      api.registerMessageRenderer("handle-message", () => undefined),
      api.registerMarkdownTransformer((markdown) => `changed:${markdown}`),
      api.registerEntryRenderer("handle-entry", () => undefined),
      api.registerProvider("handle-provider", { name: "Handle provider", models: [] }),
    );
    for (const handle of handles) {
      assert.equal(handle.dispose, handle);
      assert.equal(handle.disposed, false);
      handle();
      handle.dispose();
      assert.equal(handle.disposed, true);
    }
  });

  assert.deepEqual(host.tools(), []);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.shortcuts(), []);
  assert.deepEqual(host.flags(), []);
  assert.deepEqual(host.renderers(), []);
  assert.deepEqual(host.directProviderRegistrations(), []);
  assert.equal(host.transformMarkdown("body", {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 80,
  }), "body");
  await host.dispatch("session_start", { reason: "startup", threadId: "handle-thread" });
  assert.equal(eventCalls, 0);
  await host.close();
  assert.equal(disposeCalls, 0);
});

test("committed handles remove exact registrations once and generation close marks survivors disposed", async (context) => {
  const handles: ExtensionRegistrationHandle[] = [];
  let api: ExtensionAPI | undefined;
  let disposeCalls = 0;
  let eventCalls = 0;
  const { host, root } = await fixture(context, (selected) => {
    api = selected;
    handles.push(
      selected.onDispose(() => { disposeCalls += 1; }),
      selected.on("session_start", () => { eventCalls += 1; }),
      selected.events.on("handle:event", () => { eventCalls += 1; }),
      selected.registerTool(tool("committed")),
      selected.registerCommand("handle-command", { handler() {} }),
      selected.registerShortcut("ctrl+k", { handler() {} }),
      selected.registerFlag("handle-flag", { type: "boolean", default: true }),
      selected.registerMessageRenderer("handle-message", () => undefined),
      selected.registerMarkdownTransformer((markdown) => `changed:${markdown}`),
      selected.registerEntryRenderer("handle-entry", () => undefined),
      selected.registerProvider("handle-provider", { name: "Handle provider", models: [] }),
    );
  });
  assert.ok(api);
  const externalTools = [...host.tools()];
  host.setLiveRegistrationHandler({
    registerTool(selected) { externalTools.push(selected); },
    replaceTool(previous, selected) {
      const index = externalTools.indexOf(previous);
      if (index >= 0) externalTools.splice(index, 1, selected);
    },
    unregisterTool(selected) {
      const index = externalTools.indexOf(selected);
      if (index >= 0) externalTools.splice(index, 1);
    },
  });
  const providerEvents: string[] = [];
  host.setDirectActionsHandler(actions(root, providerEvents));

  assert.equal(handles.every((handle) => !handle.disposed), true);
  for (const [index, handle] of handles.entries()) {
    if (index % 2 === 0) handle();
    else handle.dispose();
    handle();
  }
  assert.equal(handles.every((handle) => handle.disposed), true);
  assert.deepEqual(host.tools(), []);
  assert.deepEqual(externalTools, []);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.shortcuts(), []);
  assert.deepEqual(host.flags(), []);
  assert.deepEqual(host.renderers(), []);
  assert.deepEqual(host.directProviderRegistrations(), []);
  assert.deepEqual(providerEvents, ["unregister:handle-provider"]);
  await host.dispatch("session_start", { reason: "startup", threadId: "handle-thread" });
  api.events.emit("handle:event", null);
  assert.equal(eventCalls, 0);
  assert.equal(disposeCalls, 0);

  const survivor = api.on("session_start", () => undefined);
  assert.equal(survivor.disposed, false);
  await host.close();
  assert.equal(survivor.disposed, true);
});

test("host close makes APIs stale, aborts generations, and removes registrations before onDispose", async (context) => {
  const order: string[] = [];
  const handles: ExtensionRegistrationHandle[] = [];
  let activeExternalListeners = 0;
  const eventBus: EventBus = {
    on() {
      activeExternalListeners += 1;
      return () => {
        activeExternalListeners -= 1;
      };
    },
    emit() {},
  };
  let api: ExtensionAPI | undefined;
  let generationSignal: AbortSignal | undefined;
  const root = await mkdtemp(join(tmpdir(), "ohm-registration-close-order-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlineExtensions: [{
      name: "registration-close-order",
      factory(selected) {
        api = selected;
        handles.push(selected.registerCommand("close-order", { handler() {} }));
        handles.push(selected.events.on("close-order", () => undefined));
        handles.push(selected.on("session_start", (_event, eventContext) => {
          generationSignal = eventContext.signal;
        }));
        handles.push(selected.onDispose(() => {
          order.push("dispose");
          assert.equal(generationSignal?.aborted, true);
          assert.equal(handles.every((handle) => handle.disposed), true);
          assert.equal(activeExternalListeners, 0);
          assert.throws(() => selected.getCommands(), /no longer active/u);
        }));
      },
    }],
  });
  assert.ok(api);
  host.addRegistrationCleanup(() => { order.push("registration"); });
  await host.dispatch("session_start", { reason: "startup", threadId: "close-order" });
  assert.equal(generationSignal?.aborted, false);
  assert.equal(activeExternalListeners, 1);

  await host.close();

  assert.deepEqual(order, ["registration", "dispose"]);
});

test("failed activation deactivates staged handles before onDispose", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-registration-failed-order-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const handles: ExtensionRegistrationHandle[] = [];
  let disposed = false;

  await assert.rejects(loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "registration-failed-order",
      factory(api) {
        handles.push(api.registerCommand("failed-order", { handler() {} }));
        handles.push(api.onDispose(() => {
          disposed = true;
          assert.equal(handles.every((handle) => handle.disposed), true);
          assert.throws(() => api.getCommands(), /no longer active/u);
        }));
        throw new Error("activation rejected");
      },
    }],
  }), /activation rejected/u);

  assert.equal(disposed, true);
  assert.equal(handles.every((handle) => handle.disposed), true);
});

test("older live handles cannot remove same-name replacements", async (context) => {
  let api: ExtensionAPI | undefined;
  const { host, root } = await fixture(context, (selected) => { api = selected; });
  assert.ok(api);
  const externalTools: Array<ReturnType<typeof host.tools>[number]> = [];
  host.setLiveRegistrationHandler({
    registerTool(selected) {
      externalTools.push(selected);
      return () => { const index = externalTools.indexOf(selected); if (index >= 0) externalTools.splice(index, 1); };
    },
    replaceTool(previous, selected) {
      const index = externalTools.indexOf(previous);
      if (index >= 0) externalTools.splice(index, 1, selected);
      return () => { const selectedIndex = externalTools.indexOf(selected); if (selectedIndex >= 0) externalTools.splice(selectedIndex, 1); };
    },
    unregisterTool(selected) {
      const index = externalTools.indexOf(selected);
      if (index >= 0) externalTools.splice(index, 1);
    },
  });
  const providerEvents: string[] = [];
  host.setDirectActionsHandler(actions(root, providerEvents));

  const firstTool = api.registerTool(tool("first"));
  const secondTool = api.registerTool(tool("second"));
  const firstCommand = api.registerCommand("replace-command", { handler() { return "first"; } });
  const secondCommand = api.registerCommand("replace-command", { handler() { return "second"; } });
  const firstShortcut = api.registerShortcut("ctrl+j", { description: "first", handler() {} });
  const secondShortcut = api.registerShortcut("ctrl+j", { description: "second", handler() {} });
  const firstFlag = api.registerFlag("replace-flag", { type: "string", default: "first" });
  const secondFlag = api.registerFlag("replace-flag", { type: "string", default: "second" });
  const firstMessage = api.registerMessageRenderer("replace-message", () => undefined);
  const secondMessageRenderer = () => undefined;
  const secondMessage = api.registerMessageRenderer("replace-message", secondMessageRenderer);
  const firstMarkdown = api.registerMarkdownTransformer((markdown) => `first:${markdown}`);
  const secondMarkdown = api.registerMarkdownTransformer((markdown) => `second:${markdown}`);
  const firstEntry = api.registerEntryRenderer("replace-entry", () => undefined);
  const secondEntryRenderer = () => undefined;
  const secondEntry = api.registerEntryRenderer("replace-entry", secondEntryRenderer);
  const firstProvider = api.registerProvider("replace-provider", { name: "First", models: [] });
  const secondProvider = api.registerProvider("replace-provider", { name: "Second", models: [] });

  for (const handle of [
    firstTool,
    firstCommand,
    firstShortcut,
    firstFlag,
    firstMessage,
    firstMarkdown,
    firstEntry,
    firstProvider,
  ]) handle.dispose();

  assert.equal(host.tools()[0]?.definition.description, "second");
  assert.equal(externalTools[0]?.definition.description, "second");
  assert.equal(host.commands()[0]?.baseName, "replace-command");
  assert.equal(host.shortcuts()[0]?.description, "second");
  assert.equal(host.flags()[0]?.default, "second");
  assert.equal(host.messageRenderer("replace-message"), secondMessageRenderer);
  assert.equal(host.entryRenderer("replace-entry"), secondEntryRenderer);
  assert.equal(host.transformMarkdown("body", {
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 80,
  }), "second:body");
  assert.equal(host.directProviderRegistrations()[0]?.name, "replace-provider");

  for (const handle of [
    secondTool,
    secondCommand,
    secondShortcut,
    secondFlag,
    secondMessage,
    secondMarkdown,
    secondEntry,
    secondProvider,
  ]) handle();
  assert.deepEqual(host.tools(), []);
  assert.deepEqual(externalTools, []);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.shortcuts(), []);
  assert.deepEqual(host.flags(), []);
  assert.deepEqual(host.renderers(), []);
  assert.deepEqual(host.directProviderRegistrations(), []);
  assert.deepEqual(providerEvents, [
    "register:replace-provider",
    "register:replace-provider",
    "unregister:replace-provider",
  ]);
  await host.close();
});

test("disposing a shortcut replacement restores the latest surviving owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-registration-shortcut-restore-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let first: ExtensionRegistrationHandle | undefined;
  let second: ExtensionRegistrationHandle | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      {
        name: "shortcut-first",
        factory(api) {
          first = api.registerShortcut("ctrl+k", { description: "first", handler() {} });
        },
      },
      {
        name: "shortcut-second",
        factory(api) {
          second = api.registerShortcut("ctrl+k", { description: "second", handler() {} });
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.ok(first);
  assert.ok(second);
  assert.equal(host.shortcuts()[0]?.description, "second");
  second.dispose();
  assert.equal(host.shortcuts()[0]?.description, "first");
  first.dispose();
  assert.deepEqual(host.shortcuts(), []);
});
