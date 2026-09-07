import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { createInMemoryHarness } from "../../src/embedding/index.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { createAgentSession, defineTool, SessionManager } from "../../src/sdk/index.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";
import type { AgentSessionTool } from "../../src/tools/direct-tool.js";
import type { HarnessTool } from "../../src/tools/types.js";

async function createSession(
  context: TestContext,
  entrypoint: "sdk" | "embedding",
  customTools: AgentSessionTool[],
): Promise<AgentSession> {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-custom-tool-inventory-"));
  const close: Array<() => Promise<void>> = [];
  context.after(async () => {
    try {
      for (const dispose of close.reverse()) await dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  if (entrypoint === "sdk") {
    const modelRuntime = await ModelRuntime.create({ models: createModels(), modelsPath: null, allowModelNetwork: false });
    close.push(() => modelRuntime.close());
    const { session } = await createAgentSession({
      cwd, agentDir: join(cwd, "agent"), modelRuntime, customTools, noTools: "builtin",
      sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
    });
    close.push(() => session.close());
    return session;
  }
  let session: AgentSession | undefined;
  const create = AgentSession.create;
  context.mock.method(AgentSession, "create", async (...args: Parameters<typeof create>) => {
    session = await create(...args);
    return session;
  });
  const harness = await createInMemoryHarness({
    workspace: cwd, customTools, noTools: "builtin", model: "fixture", api: "openai-chat-completions",
    provider: createScriptedProvider({ models: [{ id: "fixture" }], scripts: [] }),
  });
  close.push(() => harness.close());
  assert.ok(session);
  return session;
}

for (const entrypoint of ["sdk", "embedding"] as const) {
  for (const winner of ["native", "public"] as const) {
    test(`${entrypoint} custom tools use the last ${winner} definition for execution and rendering`, async (context) => {
      const calls: string[] = [];
      const definition = defineTool({
        name: "inventory_probe", description: "Public definition", parameters: Type.Object({ value: Type.String() }),
        promptSnippet: "Public guidance", promptGuidelines: ["Preserve public metadata"],
        executionMode: "sequential", recovery: { mode: "repeatable" }, renderShell: "self",
        renderCall: () => ({ render: () => ["public renderer"], invalidate() {} }),
        async execute(_id, input) {
          calls.push("public");
          return { content: [{ type: "text", text: input.value }], details: {} };
        },
      });
      const native: HarnessTool = {
        definition: {
          name: definition.name, description: "Native definition", inputSchema: { type: "object", properties: {} },
          promptSnippet: "Native guidance",
        },
        validate() {}, resources: () => [],
        async execute() {
          calls.push("native");
          return { content: "native value", isError: false };
        },
      };
      const customTools = winner === "native" ? [definition, native] : [native, definition];
      const session = await createSession(context, entrypoint, customTools);
      assert.deepEqual(session.getActiveTools(), [definition.name]);
      const selected = session.getToolDefinition(definition.name);
      assert.ok(selected);
      assert.equal(selected.promptSnippet, winner === "native" ? "Native guidance" : "Public guidance");
      const executable = session.agent.state.tools.find((tool) => tool.name === definition.name);
      assert.ok(executable);
      await executable.execute("inventory-call", { value: "public value" });
      assert.deepEqual(calls, [winner]);
      const renderer = session.toolRendererBinding();
      assert.equal(renderer?.has(definition.name) ?? false, winner === "public");
      if (winner === "public") {
        assert.deepEqual(selected.promptGuidelines, definition.promptGuidelines);
        assert.equal(selected.executionMode, "sequential");
        assert.deepEqual(selected.recovery, { mode: "repeatable" });
        assert.equal(renderer?.renderShell?.(definition.name), "self");
        assert.equal(renderer?.renderCall(definition.name, {
          callId: "inventory-call", name: definition.name, input: { value: "public value" },
          argsComplete: true, executionStarted: true, status: "running", expanded: true,
        }, {
          width: 80, height: 24, focused: false, expanded: true,
          theme: { name: "mono", color: false, unicode: true },
        })?.lines[0]?.spans[0]?.text, "public renderer");
      }
    });
  }

  test(`${entrypoint} rejects malformed native custom-tool definitions before session creation`, async (context) => {
    const malformed: HarnessTool = {
      get definition(): never { throw new Error("invalid native definition"); },
      validate() {}, resources: () => [],
      async execute() { throw new Error("must not execute"); },
    };
    await assert.rejects(createSession(context, entrypoint, [malformed]), /invalid native definition/u);
  });
}
