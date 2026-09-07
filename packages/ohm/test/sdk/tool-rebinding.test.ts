import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager,
  type CreateAgentSessionOptions,
} from "../../src/sdk/index.js";
import { createModels, ModelRuntime, type Provider, type ProviderModel } from "../../src/providers/index.js";
import { createScriptedProvider } from "../../src/testing/index.js";
import { getPluginRuntimeHost } from "../../src/plugins/index.js";
import type { AgentSession } from "../../src/service/agent-session.js";
import type { JsonValue } from "../../src/core/json.js";
import type { HarnessTool, ToolContext } from "../../src/tools/types.js";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ohm-tool-rebinding-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await Promise.all([mkdir(source), mkdir(destination)]);
  const scripted = createScriptedProvider({
    id: "binding-fixture", models: [{ id: "fixture", capabilities: { tools: "supported" } }],
  });
  const model: ProviderModel = {
    provider: "binding-fixture", id: "fixture", name: "Fixture", api: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 16_384, maxTokens: 2_048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream: Provider["stream"] = (selected, request, options = {}) => scripted.stream({
    provider: selected.provider, model: selected.id, api: selected.api,
    messages: request.messages, tools: request.tools ?? [],
  }, options.signal ?? new AbortController().signal);
  const models = createModels();
  models.setProvider({
    id: model.provider, name: "Offline fixture",
    auth: { apiKey: { name: "Fixture", async resolve() { return { auth: { apiKey: "synthetic-fixture" }, source: "fixture" }; } } },
    getModels: () => [model], stream, streamSimple: stream,
  });
  const runtime = await ModelRuntime.create({ models, modelsPath: null, allowModelNetwork: false });
  const sessions: AgentSession[] = [];
  context.after(async () => {
    for (const session of sessions.reverse()) await session.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    source, destination, root,
    async create(cwd: string, options: Partial<CreateAgentSessionOptions> = {}) {
      const created = await createAgentSession({
        cwd, agentDir: join(root, "agent"), modelRuntime: runtime, model,
        sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(), ...options,
      });
      sessions.push(created.session);
      return created.session;
    },
    async run(session: AgentSession, name: string, input: JsonValue) {
      scripted.appendScripts([
        { kind: "turn", content: [{ type: "tool_call", id: "binding-call", name, arguments: input }], terminal: { type: "finish", reason: "tool_calls" } },
        { kind: "turn", content: [{ type: "text", text: "done" }], terminal: { type: "finish", reason: "stop" } },
      ]);
      await session.prompt(`Invoke ${name}.`);
      const result = session.agent.state.messages.findLast((message) => message.role === "toolResult");
      assert.ok(result?.role === "toolResult");
      return result;
    },
  };
}

test("reused read definitions claim and read the receiving workspace while standalone calls remain bound", async (context) => {
  const f = await fixture(context);
  await writeFile(join(f.source, "sentinel.txt"), "source sentinel\n");
  await writeFile(join(f.destination, "sentinel.txt"), "destination sentinel\n");
  const source = await f.create(f.source);
  const definition = source.getToolDefinition("read");
  assert.ok(definition);
  const claims: string[] = [];
  let resourceCalls = 0;
  const destination = await f.create(f.destination, {
    noTools: "builtin", customTools: [{
      ...definition, description: "Reused read", promptGuidelines: ["Preserved edit"],
      resources(input: JsonValue, execution: ToolContext) {
        resourceCalls += 1;
        return definition.resources?.(input, execution) ?? [];
      },
    }],
    toolAuthorizationHandler(request, execution) {
      assert.equal(execution.workspaceRoot, f.destination);
      claims.push(...request.resources.map((resource) => resource.key));
      return { decision: "allow_once" };
    },
  });
  const result = await f.run(destination, "read", { path: "sentinel.txt" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: "text", text: "destination sentinel\n" }]);
  assert.deepEqual(claims, [join(f.destination, "sentinel.txt")]);
  assert.equal(resourceCalls, 1);
  assert.equal(destination.getToolDefinition("read")?.description, "Reused read");
  assert.deepEqual(destination.getToolDefinition("read")?.promptGuidelines, ["Preserved edit"]);
  const standalone = await definition.execute("standalone", { path: "sentinel.txt" }, undefined, undefined, source.createReplacedSessionContext());
  assert.deepEqual(standalone.content, [{ type: "text", text: "source sentinel\n" }]);
});

test("native preparation and execution receive current thread, runner and workspace after a session switch", async (context) => {
  const f = await fixture(context);
  const observed: Array<{ phase: string; workspace: string; threadId: string; runId: string; runner: ToolContext["runner"] }> = [];
  const record = (phase: string, execution: ToolContext) => {
    observed.push({ phase, workspace: execution.workspace.root, threadId: execution.threadId, runId: execution.runId, runner: execution.runner });
  };
  let executions = 0;
  const native: HarnessTool = {
    definition: { name: "context_probe", description: "Context", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
    prepareInput(input, execution) { record("prepare", execution); return input; },
    validate(input) { assert.equal(Value.Check(native.definition.inputSchema, input), true); },
    resources(_input, execution) { record("resources", execution); return []; },
    async execute(_input, execution) { record("execute", execution); executions += 1; return { content: "native result", isError: false, metadata: { intact: true } }; },
  };
  const source = await f.create(f.source, { noTools: "builtin", customTools: [native] });
  const definition = source.getToolDefinition("context_probe");
  assert.ok(definition);
  const destination = await f.create(f.destination, { noTools: "builtin", customTools: [definition] });
  const before = destination.sessionId;
  for (const switched of [false, true]) {
    if (switched) destination.newSession({ id: "replacement-thread" });
    observed.length = 0;
    const result = await f.run(destination, "context_probe", { value: "valid" });
    assert.equal(result.isError, false);
    assert.deepEqual(result.details, { intact: true });
    assert.deepEqual(observed.map((entry) => entry.phase), ["prepare", "resources", "execute"]);
    for (const entry of observed) {
      assert.equal(entry.workspace, f.destination);
      assert.equal(entry.threadId, destination.sessionId);
      assert.ok(!entry.runId.startsWith("direct:"));
      assert.equal(entry.runner, observed[0]!.runner);
    }
  }
  assert.notEqual(before, destination.sessionId);
  const invalid = await f.run(destination, "context_probe", {});
  assert.equal(invalid.isError, true);
  assert.equal(executions, 2);
});

test("SDK-authored callbacks rebind and deliberate execute and preparation replacements are respected", async (context) => {
  const f = await fixture(context);
  let authorCalls = 0;
  const authored = defineTool({
    name: "authored", description: "Authored", parameters: Type.Object({ value: Type.String() }),
    prepareArguments() { return { value: "original preparation" }; },
    async execute(_id, input, _signal, _update, execution) {
      authorCalls += 1;
      return { content: [{ type: "text", text: `${execution.cwd}:${input.value}` }], details: {} };
    },
  });
  const source = await f.create(f.source, { noTools: "builtin", customTools: [authored] });
  const definition = source.getToolDefinition("authored");
  assert.ok(definition);
  // Public definitions are mutable. Reusing a generated callback must not create
  // a provenance cycle through the originally registered authoring object.
  const originalExecute = authored.execute;
  authored.execute = definition.execute;
  const destination = await f.create(f.destination, {
    noTools: "builtin", customTools: [{ ...definition, prepareArguments: () => ({ value: "replaced preparation" }) }],
  });
  const first = await f.run(destination, "authored", { value: "input" });
  assert.deepEqual(first.content, [{ type: "text", text: `${f.destination}:replaced preparation` }]);
  assert.equal(authorCalls, 1);
  authored.execute = originalExecute;
  const replaced = await f.create(f.destination, {
    noTools: "builtin", customTools: [{
      ...definition,
      async execute(_id, input, _signal, _update, execution) {
        return { content: [{ type: "text", text: `${execution.cwd}:replacement` }], details: input };
      },
    }],
  });
  const second = await f.run(replaced, "authored", { value: "input" });
  assert.deepEqual(second.content, [{ type: "text", text: `${f.destination}:replacement` }]);
  assert.equal(authorCalls, 1);
});

for (const invalidation of ["refresh", "close"] as const) {
  test(`reusing a plugin tool never removes its generation guard after source ${invalidation}`, async (context) => {
    const f = await fixture(context);
    let executed = 0;
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: f.source, agentDir: join(f.root, "agent"), settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true,
      pluginFactories: [(api) => { api.registerTool({
        name: "plugin_probe", description: "Plugin", parameters: Type.Object({}),
        async execute() { executed += 1; return { content: [{ type: "text", text: "plugin executed" }], details: {} }; },
      }); }],
    });
    await loader.refresh();
    const source = await f.create(f.source, { noTools: "builtin", resourceLoader: loader, settingsManager: settings });
    const definition = source.getToolDefinition("plugin_probe");
    assert.ok(definition);
    const destination = await f.create(f.destination, { noTools: "builtin", customTools: [definition] });
    const live = await f.run(destination, "plugin_probe", {});
    assert.equal(live.isError, true);
    assert.match(JSON.stringify(live.content), /current session|requested thread|session.*not|only exposes/iu);
    assert.equal(executed, 0);
    if (invalidation === "refresh") await source.refresh();
    else {
      await source.close();
      // A supplied loader is caller-owned; closing its session alone does not dispose it.
      await getPluginRuntimeHost(loader.getPlugins().runtime)?.close();
    }
    const result = await f.run(destination, "plugin_probe", {});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /no longer active|closed|stale|inactive|aborted/iu);
    assert.equal(executed, 0);
  });
}
