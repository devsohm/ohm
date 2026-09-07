import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import { isJsonObject, type JsonValue } from "../../src/core/json.js";
import { defineTool } from "../../src/plugins/direct.js";
import { loadDirectPlugins } from "../../src/plugins/runtime.js";
import { DirectProcessRunner } from "../../src/process/runner.js";
import { MAX_TOOL_INPUT_BYTES, ToolCoordinator } from "../../src/tools/coordinator.js";
import { createHarnessToolFromDefinition } from "../../src/tools/direct-tool.js";
import { getDirectToolOrigin } from "../../src/tools/direct-tool-origin.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";

test("direct argument preparation repairs raw JSON before coordinated schema validation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-argument-preparation-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const observed: JsonValue[] = [];
  let executions = 0;
  const definition = defineTool({
    name: "normalize_number",
    description: "Normalize numeric argument envelopes",
    parameters: Type.Object({ count: Type.Number({ minimum: 1 }) }, { additionalProperties: false }),
    prepareArguments(input) {
      observed.push(input);
      return { count: Number(isJsonObject(input) ? input["rawCount"] : input) };
    },
    async execute(_id, input) {
      executions += 1;
      return { content: [{ type: "text" as const, text: String(input.count) }], details: {} };
    },
  });
  const host = await loadDirectPlugins([], {
    workspace,
    inlinePlugins: [(ohm) => { ohm.registerTool(definition); }],
  });
  t.after(async () => await host.close());
  const context: ToolContext = {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "prepare-run",
    threadId: "prepare-thread",
  };
  const native = host.tools()[0]!;
  const direct = createHarnessToolFromDefinition(definition, () => { throw new Error("No direct execution"); });
  assert.equal(getDirectToolOrigin(direct), definition);
  assert.equal(getDirectToolOrigin(native), undefined);
  for (const tool of [native, direct]) {
    const raw = { rawCount: "2" };
    const objectInput = await tool.prepareInput?.(raw, context);
    assert.ok(isJsonObject(objectInput));
    assert.equal(objectInput["count"], 2);
    assert.notEqual(observed.at(-1), raw, "preparation receives an isolated JSON snapshot");
    const stringInput = await tool.prepareInput?.("3", context);
    assert.ok(isJsonObject(stringInput));
    assert.equal(stringInput["count"], 3);
  }
  const coordinator = new ToolCoordinator(new ToolRegistry([native]));
  const [valid] = await coordinator.execute([{ callId: "valid", name: definition.name, input: { rawCount: "4" }, index: 0 }], context);
  assert.equal(valid?.result.isError, false);
  assert.equal(valid?.result.content, "4");
  const [invalid] = await coordinator.execute([{ callId: "invalid", name: definition.name, input: { rawCount: "0" }, index: 0 }], context);
  assert.equal(invalid?.result.isError, true);
  assert.equal(executions, 1, "prepared arguments still require the complete parameter schema");

  let accessorCalls = 0;
  const accessorInput = Object.defineProperty({}, "rawCount", { enumerable: true, get() { accessorCalls += 1; return "2"; } });
  const before = observed.length;
  for (const tool of [native, direct]) {
    await assert.rejects(async () => await tool.prepareInput?.(accessorInput, context), /data propert|accessor/u);
    await assert.rejects(async () => await tool.prepareInput?.({ rawCount: "2".repeat(MAX_TOOL_INPUT_BYTES + 1) }, context), /exceeds/u);
  }
  assert.equal(observed.length, before);
  assert.equal(accessorCalls, 0);
});

test("custom tool renderers receive partial nested arguments before execution", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-partial-tool-renderer-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const seen: Array<{ label: string; complete: boolean }> = [];
  const host = await loadDirectPlugins([], {
    workspace,
    inlinePlugins: [(ohm) => {
      ohm.registerTool(defineTool({
        name: "partial_render",
        description: "Render streamed argument progress",
        parameters: Type.Object({ items: Type.Array(Type.Object({ label: Type.String() })) }),
        async execute() { return { content: [], details: {} }; },
        renderCall(input, _theme, context) {
          const label = input.items?.[0]?.label ?? "waiting";
          seen.push({ label, complete: context.argsComplete });
          return { render() { return [label]; }, invalidate() {} };
        },
      }));
    }],
  });
  t.after(async () => await host.close());
  const binding = host.toolRendererBinding();
  const context = { width: 80, height: 24, focused: false, expanded: false, theme: { name: "mono" as const, color: false, unicode: false } };
  const view = { callId: "partial", name: "partial_render", executionStarted: false, status: "pending" as const, expanded: false };
  for (const input of [{}, { items: [{}] }]) {
    assert.equal(binding.renderCall(view.name, { ...view, input, argsComplete: false }, context)?.lines[0]?.spans[0]?.text, "waiting");
  }
  assert.equal(binding.renderCall(view.name, { ...view, input: { items: [{ label: "ready" }] }, argsComplete: true }, context)?.lines[0]?.spans[0]?.text, "ready");
  assert.deepEqual(seen, [{ label: "waiting", complete: false }, { label: "waiting", complete: false }, { label: "ready", complete: true }]);
  assert.deepEqual(host.diagnostics(), []);
});
