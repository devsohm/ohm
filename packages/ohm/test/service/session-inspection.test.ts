import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { promptCompositionSource } from "../../src/core/prompt-composition.js";
import type { PromptCompositionMetadata } from "../../src/core/types.js";
import type { PluginAPI } from "../../src/plugins/direct.js";
import { loadDirectPlugins } from "../../src/plugins/runtime.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import { showInteractiveInspection } from "../../src/modes/interactive-inspection.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, inspectAgentSession, type PluginBindings } from "../../src/sdk/index.js";
import { startServeServer } from "../../src/serve/server.js";
import { createServeSessionRuntime } from "../../src/serve/session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

test("SDK, RPC, and HTTP inspect the same real session without transcript or tool bodies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-inspection-"));
  const provider = createScriptedProvider({
    scripts: [
      { kind: "turn", content: [{ type: "tool_call", name: "probe", arguments: { value: "private-input" } }], terminal: { type: "finish", reason: "tool_calls" } },
      { kind: "turn", content: [{ type: "text", text: "private-answer" }] },
    ],
  });
  const replacement = "private-replacement-instructions";
  const host = await loadDirectPlugins([], {
    workspace: cwd,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "prompt-owner",
      factory(api) {
        api.on("before_agent_start", () => ({ systemPrompt: replacement }));
      },
    }],
  });
  const session = await AgentSession.create({
    workspace: cwd,
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    pluginRunner: host,
    model: { provider: provider.id, id: provider.models[0]!.id, api: "openai-chat-completions", info: provider.models[0]! },
    tools: [{
      definition: { name: "probe", description: "private-description", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
      executionMode: "parallel",
      recovery: { mode: "repeatable" },
      validate(input) { assert.deepEqual(input, { value: "private-input" }); },
      resources: () => [],
      async execute() { return { content: "private-tool-result", isError: false }; },
    }],
  });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: {
      session,
      async newSession() { return { cancelled: true }; },
      async switchSession() { return { cancelled: true }; },
      async fork() { return { cancelled: true }; },
      setBeforeSessionInvalidate() {},
      setRebindSession() {},
    },
    output() {},
  });
  const token = "inspection-test-token-0123456789abcdef";
  let server: Awaited<ReturnType<typeof startServeServer>> | undefined;
  try {
    await session.bindPlugins();
    await session.prompt("private-prompt", { noContextFiles: true });
    assert.equal(provider.callCount, 2, JSON.stringify(session.messages));
    const expected = inspectAgentSession(session);
    assert.equal(expected.state, "idle");
    assert.equal(expected.activity.operations.length, 1);
    assert.equal(expected.activity.operations[0]?.finishReason, "stop");
    assert.equal(expected.activity.operations[0]?.errorCategory, null);
    assert.deepEqual(expected.toolPolicy, {
      authorization: { scope: "model_requested_tools", mode: "default_allow" },
      dynamicGates: { pluginToolCall: false, agentBeforeToolCall: false },
    });
    assert.equal(expected.activity.toolEffects.length, 1, JSON.stringify(session.messages));
    assert.equal(expected.activity.toolEffects[0]?.toolName, "probe");
    assert.ok(expected.activity.operations[0]?.finishedAt);
    assert.ok(expected.activity.toolEffects[0]?.finishedAt);
    assert.ok(expected.prompt);
    assert.ok(expected.prompt?.tools.includes("probe"));
    assert.equal(expected.prompt.bytes, Buffer.byteLength(replacement));
    assert.deepEqual(expected.prompt.sources, [promptCompositionSource(
      "additional_instructions", "extension:inline-prompt-owner:before_agent_start", replacement,
    )]);
    assert.equal(expected.tools.find((tool) => tool.name === "probe")?.active, true);
    assert.doesNotMatch(JSON.stringify(expected), /private-(input|answer|description|tool-result|prompt|replacement)/u);

    await dispatcher.start();
    assert.deepEqual(await dispatcher.dispatch({ type: "get_inspection", id: "inspect" }), {
      type: "response", command: "get_inspection", id: "inspect", success: true, data: expected,
    });
    const runtime = createServeSessionRuntime(() => session);
    server = await startServeServer({
      token,
      sessionFactory: { async create() { return runtime; }, async open() { return undefined; } },
    });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const created = await fetch(`${server.origin}/v1/sessions`, { method: "POST", headers, body: "{}" });
    assert.equal(created.status, 201);
    await created.json();
    const url = `${server.origin}/v1/sessions/${session.sessionId}/inspection`;
    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    const invalidMethod = await fetch(url, { method: "POST", headers, body: "{}" });
    assert.equal(invalidMethod.status, 405);
    await invalidMethod.text();

    expected.tools[0]!.name = "modified-snapshot";
    assert.notEqual(inspectAgentSession(session).tools[0]?.name, "modified-snapshot");
    const notices: string[] = [];
    await showInteractiveInspection(session, { async choose(_title, choices) { return choices[4]!.value; }, notify: (message) => { notices.push(message); } }, new AbortController().signal);
    assert.match(notices[0]!, /probe/u);
    assert.match(notices[0]!, /finish: stop/u);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(showInteractiveInspection(session, { async choose(_title, choices) { return choices[0]!.value; }, notify: (message) => { notices.push(message); } }, cancelled.signal), { name: "AbortError" });
    assert.equal(notices.length, 1, "cancelling the section picker must not publish a snapshot");
    await showInteractiveInspection(session, { async choose(_title, choices) { return choices[1]!.value; }, notify: (message) => { notices.push(message); } }, new AbortController().signal);
    assert.match(notices[1]!, /Last composed prompt: 32 bytes/u);
    assert.match(notices[1]!, /extension:inline-prompt-owner:before_agent_start/u);
    assert.doesNotMatch(notices[1]!, /private-replacement/u);
  } finally {
    await dispatcher.close();
    await server?.close();
    await session.close();
    await host.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const mode of ["tui", "print", "json", "rpc", "serve", "sdk"] satisfies NonNullable<PluginBindings["mode"]>[]) {
  test(`${mode} inspection describes live gates without calling them or predicting permission`, async (context) => {
    let plugin: PluginAPI | undefined;
    const host = await loadDirectPlugins([], {
      workspace: process.cwd(),
      activationFailure: "throw",
      inlinePlugins: [{ name: "policy-owner", factory(api) { plugin = api; } }],
    });
    context.after(async () => await host.close());
    const session = await AgentSession.create({
      workspace: process.cwd(),
      sessionManager: SessionManager.inMemory(process.cwd()),
      providers: new ProviderRegistry([]),
      settingsManager: SettingsManager.inMemory(),
      pluginRunner: host,
      toolAuthorizationHandler() { throw new Error("Inspection must not request authorization"); },
    });
    context.after(async () => await session.close());
    await session.bindPlugins({ mode });
    assert.ok(plugin);
    const before = inspectAgentSession(session);
    assert.deepEqual(before.toolPolicy, {
      authorization: { scope: "model_requested_tools", mode: "host_handler" },
      dynamicGates: { pluginToolCall: false, agentBeforeToolCall: false },
    });
    const unsubscribe = plugin.on("tool_call", () => { throw new Error("Inspection must not invoke a plugin gate"); });
    session.agent.beforeToolCall = async () => { throw new Error("Inspection must not invoke an agent gate"); };
    const gated = inspectAgentSession(session);
    assert.deepEqual(gated.toolPolicy.dynamicGates, { pluginToolCall: true, agentBeforeToolCall: true });
    assert.deepEqual(gated.tools, before.tools, "gate presence does not forecast per-tool permission or change ownership");
    gated.toolPolicy.dynamicGates.pluginToolCall = false;
    assert.equal(inspectAgentSession(session).toolPolicy.dynamicGates.pluginToolCall, true);
    const notices: string[] = [];
    await showInteractiveInspection(session, {
      async choose(_title, choices) { return choices[0]!.value; },
      notify(message) { notices.push(message); },
    }, new AbortController().signal);
    assert.match(notices[0]!, /Model tool authorization: host handler/u);
    assert.match(notices[0]!, /Dynamic gates: plugin tool_call, agent beforeToolCall/u);
    unsubscribe();
    session.agent.beforeToolCall = undefined;
    assert.deepEqual(inspectAgentSession(session).toolPolicy, before.toolPolicy);
  });
}

for (const replacements of [
  ["private-first-replacement", "private-final-replacement"],
  ["private-first-replacement", ""],
  ["private-first-replacement", "private-first-replacement"],
  [undefined, undefined],
]) {
  test(`inspection follows accepted before-agent prompt replacements ${JSON.stringify(replacements)}`, async (context) => {
    const cwd = await mkdtemp(join(tmpdir(), "ohm-prompt-inspection-"));
    context.after(async () => await rm(cwd, { recursive: true, force: true }));
    const observed: Array<{ prompt: string; composition: PromptCompositionMetadata | undefined }> = [];
    const host = await loadDirectPlugins([], {
      workspace: cwd,
      activationFailure: "throw",
      inlinePlugins: [
        ...replacements.map((replacement, index) => ({
          name: `prompt-owner-${index}`,
          factory(api: PluginAPI) {
            api.on("before_agent_start", (event) => {
              observed.push({ prompt: event.systemPrompt, composition: event.promptComposition });
              return { systemPrompt: replacement ?? event.systemPrompt };
            });
          },
        })),
        {
          name: "prompt-observer",
          factory(api) {
            api.on("before_agent_start", (event) => {
              observed.push({ prompt: event.systemPrompt, composition: event.promptComposition });
            });
          },
        },
      ],
    });
    context.after(async () => await host.close());
    const provider = createScriptedProvider({ scripts: [{ kind: "turn", content: [{ type: "text", text: "private-answer" }] }] });
    const session = await AgentSession.create({
      workspace: cwd,
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry([provider]),
      settingsManager: SettingsManager.inMemory(),
      baseToolsOverride: {},
      tools: [],
      pluginRunner: host,
      model: { provider: provider.id, id: provider.models[0]!.id, api: "openai-chat-completions", info: provider.models[0]! },
    });
    context.after(async () => await session.close());
    await session.bindPlugins();
    await session.prompt("private-request", { noContextFiles: true });
    const finalPrompt = replacements.at(-1) ?? observed[0]!.prompt;
    const sentPrompt = provider.capturedRequests()[0]!.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text).join("");
    assert.equal(sentPrompt, finalPrompt, "the real provider request uses the final replacement, including an empty one");
    assert.equal(session.systemPrompt, finalPrompt);
    const expected = inspectAgentSession(session);
    assert.ok(expected.prompt);
    assert.equal(expected.prompt.bytes, Buffer.byteLength(sentPrompt));
    assert.equal(expected.prompt.sha256, promptCompositionSource("system_prompt", "unused", sentPrompt).sha256);
    assert.deepEqual(expected.prompt, observed.at(-1)!.composition, "the final observer and session see identical metadata");
    if (replacements[0] === undefined) {
      assert.deepEqual(expected.prompt, observed[0]!.composition, "unchanged instructions retain original provenance");
    } else {
      const finalOwner = replacements[0] === replacements[1] ? 0 : 1;
      assert.equal(expected.prompt.sources[0]?.source, `extension:inline-prompt-owner-${finalOwner}:before_agent_start`);
      assert.equal(observed[1]!.composition?.sources[0]?.source, "extension:inline-prompt-owner-0:before_agent_start");
      assert.equal(observed[1]!.composition?.sha256, promptCompositionSource("system_prompt", "unused", replacements[0]).sha256);
    }
    assert.doesNotMatch(JSON.stringify(expected), /private-(first-replacement|final-replacement|answer|request)/u);
    expected.prompt.sources[0]!.source = "modified-snapshot";
    assert.notEqual(session.getPromptComposition()?.sources[0]?.source, "modified-snapshot");
    observed.at(-1)!.composition!.sources[0]!.source = "modified-listener-snapshot";
    assert.notEqual(session.getPromptComposition()?.sources[0]?.source, "modified-listener-snapshot");
  });
}
