import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { createAgentSession, defineTool, SessionManager } from "../../src/sdk/index.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { optionalProperties } from "../../src/core/optional-properties.js";
import type { JsonValue } from "../../src/core/json.js";

for (const replacement of ["state", "base"] as const) {
  test(`native ${replacement} tools keep standalone execution without an extension loader`, async () => {
    let prepared = 0;
    let executed = 0;
    const tool = {
      name: "read", label: "Read", description: "Native tool replacement",
      parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      async prepareArguments(raw: JsonValue) { prepared += 1; return { value: String(raw) }; },
      async execute(_id: string, input: { value: string }) {
        executed += 1;
        return { content: [{ type: "text" as const, text: input.value }], details: {} };
      },
    };
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(process.cwd()), providers: new ProviderRegistry(),
      settingsManager: SettingsManager.inMemory(),
      ...optionalProperties(replacement === "base" ? { baseToolsOverride: { read: tool } } : undefined),
    });
    try {
      if (replacement === "state") session.agent.state.tools = [tool];
      const publicTool = session.agent.state.tools.find((entry) => entry.name === "read");
      assert.ok(publicTool);
      const input = await publicTool.prepareArguments?.("prepared value");
      const result = await publicTool.execute("native-call", input);
      assert.deepEqual(result.content, [{ type: "text", text: "prepared value" }]);
      assert.equal(prepared, 1);
      assert.equal(executed, 1);
      await assert.rejects(publicTool.execute("bad-input", {}), /parameter schema/u);
      await assert.rejects(publicTool.execute("cancelled", { value: "no" }, AbortSignal.abort(new Error("cancelled tool"))), /cancelled tool/u);
      assert.equal(executed, 1);
    } finally {
      await session.close();
    }
  });
}

for (const registration of ["sdk", "extension"] as const) {
  test(`${registration} tool inspection and agent replacement preserve authoring metadata`, async (context) => {
    const cwd = await mkdtemp(join(tmpdir(), "ohm-tool-composition-"));
    context.after(() => rm(cwd, { recursive: true, force: true }));
    const modelRuntime = await ModelRuntime.create({ models: createModels(), modelsPath: null, allowModelNetwork: false });
    context.after(() => modelRuntime.close());
    const parameters = Type.Object({ value: Type.String() });
    const definition = defineTool({
      name: "composition", description: "A composable custom tool", parameters,
      promptSnippet: "Use composition", promptGuidelines: ["Keep this instruction"],
      constrainedSampling: false, loading: "eager", renderShell: "self",
      recovery: { mode: "repeatable" }, executionMode: "sequential",
      renderCall: () => ({ render: () => ["custom call"], invalidate() {} }),
      renderResult: () => ({ render: () => ["custom result"], invalidate() {} }),
      async execute(_id, input, _signal, _update, toolContext) {
        return { content: [{ type: "text", text: `${toolContext.cwd}:${input.value}` }], details: {} };
      },
    });
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir: join(cwd, "agent"), settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true,
      pluginFactories: registration === "extension" ? [(api) => { api.registerTool(definition); }] : [],
    });
    await loader.refresh();
    const { session } = await createAgentSession({
      cwd, agentDir: join(cwd, "agent"), modelRuntime, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd), settingsManager: settings,
      noTools: "builtin", customTools: registration === "sdk" ? [definition] : [],
    });
    context.after(() => session.close());
    for (let roundtrip = 0; roundtrip < 2; roundtrip += 1) {
      const inspected = session.getToolDefinition("composition");
      assert.ok(inspected);
      assert.equal(inspected.renderCall, definition.renderCall);
      assert.equal(inspected.renderResult, definition.renderResult);
      assert.equal(inspected.renderShell, "self");
      assert.deepEqual(inspected.promptGuidelines, definition.promptGuidelines);
      assert.equal(inspected.promptSnippet, definition.promptSnippet);
      assert.equal(inspected.constrainedSampling, false);
      assert.equal(inspected.loading, "eager");
      assert.deepEqual(inspected.recovery, { mode: "repeatable" });
      assert.equal(inspected.executionMode, "sequential");
      const reusableTools = session.agent.state.tools;
      session.agent.state.tools = reusableTools;
    }
    const native = session.getNativeToolDefinition("composition");
    assert.deepEqual(native?.promptGuidelines, ["Keep this instruction"]);
    const tool = session.agent.state.tools.find((entry) => entry.name === "composition");
    assert.ok(tool);
    const result = await tool.execute("direct-call", { value: "ok" });
    assert.deepEqual(result.content, [{ type: "text", text: `${cwd}:ok` }]);
    const binding = session.toolRendererBinding();
    assert.ok(binding);
    const view = {
      callId: "reused", name: "composition", input: { value: "ok" },
      argsComplete: true, executionStarted: true, status: "running" as const, expanded: true,
    };
    const renderContext = {
      width: 80, height: 24, focused: false, expanded: true,
      theme: { name: "mono", color: true, unicode: true },
    };
    assert.equal(binding.renderCall("composition", view, renderContext)?.lines[0]?.spans[0]?.text, "custom call");
    let disposed = 0;
    session.agent.state.tools = [{
      ...tool,
      renderCall: () => ({ render: () => ["replacement call"], invalidate() {}, dispose() { disposed += 1; } }),
    }];
    assert.equal(binding.renderCall("composition", view, renderContext)?.lines[0]?.spans[0]?.text, "replacement call");
    const { renderCall: _call, renderResult: _result, renderShell: _shell, ...plainTool } = tool;
    session.agent.state.tools = [plainTool];
    assert.equal(disposed, 1);
    assert.equal(binding.has("composition"), false);
    assert.equal(binding.renderCall("composition", view, renderContext), undefined);
  });
}
