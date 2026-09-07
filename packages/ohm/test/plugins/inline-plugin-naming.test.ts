import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PluginAPI } from "../../src/plugins/direct.js";
import { loadDirectPlugins } from "../../src/plugins/runtime.js";

declare global {
  var __ohmDuplicateInlinePreflightActivation: number | undefined;
}

test("inline extension metadata uses stable ordinal and explicit names", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-inline-names-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const noop = (): void => undefined;
  const host = await loadDirectPlugins([], {
    workspace,
    activationFailure: "throw",
    inlinePlugins: [
      noop,
      { name: "named", factory: noop, hidden: true },
      noop,
    ],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.plugins().map((entry) => entry.sourcePath), [
    "<inline:1>",
    "<inline:named>",
    "<inline:3>",
  ]);
  assert.equal(host.compatibilityProjection("<inline:named>")?.hidden, true);
});

test("inline names that normalize alike retain isolated extension data", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-inline-data-names-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  let first: PluginAPI | undefined;
  let second: PluginAPI | undefined;
  const host = await loadDirectPlugins([], {
    workspace,
    activationFailure: "throw",
    inlinePlugins: [
      { name: "Alpha", factory(api) { first = api; } },
      { name: "alpha", factory(api) { second = api; } },
    ],
  });
  context.after(async () => await host.close());

  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  await first.config.replace("user", { owner: "Alpha" }, { expectedRevision: null });
  assert.deepEqual(await second.config.read("user"), { revision: null, value: undefined });
  assert.notDeepEqual(
    host.pluginDataPaths("<inline:Alpha>"),
    host.pluginDataPaths("<inline:alpha>"),
  );
});

test("same declared inline ID retains source-owned initial and advanced UI operations", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-inline-ui-owners-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const advancedOwners: Array<{ extensionId: string; sourcePath: string; ownerKey: string }> = [];
  const host = await loadDirectPlugins([], {
    workspace,
    activationFailure: "throw",
    inlinePlugins: [
      {
        name: "Alpha",
        factory(api) {
          api.on("session_start", (_event, runtime) => {
            runtime.ui.setStatus("phase", "Alpha");
            runtime.ui.setWorkingIndicator({ frames: ["A"] });
          });
        },
      },
      {
        name: "alpha",
        factory(api) {
          api.on("session_start", (_event, runtime) => {
            runtime.ui.setStatus("phase", "alpha");
            runtime.ui.setWorkingIndicator({ frames: ["a"] });
          });
        },
      },
    ],
  });
  context.after(async () => await host.close());
  host.setAdvancedUiHandler({
    apply(operation) {
      advancedOwners.push({
        extensionId: operation.extensionId,
        sourcePath: operation.sourcePath,
        ownerKey: operation.ownerKey,
      });
    },
    getToolOutputExpanded: () => false,
  });

  await host.dispatch("session_start", {});

  const initial = host.initialUi().filter((operation) => operation.type === "status");
  assert.deepEqual(initial.map((operation) => operation.extensionId), ["inline-alpha", "inline-alpha"]);
  assert.deepEqual(initial.map((operation) => operation.sourcePath), ["<inline:Alpha>", "<inline:alpha>"]);
  assert.equal(new Set(initial.map((operation) => operation.ownerKey)).size, 2);
  assert.equal(initial.every((operation) => operation.signal.aborted === false), true);
  assert.deepEqual(advancedOwners.map((operation) => operation.extensionId), ["inline-alpha", "inline-alpha"]);
  assert.deepEqual(advancedOwners.map((operation) => operation.sourcePath), ["<inline:Alpha>", "<inline:alpha>"]);
  assert.equal(new Set(advancedOwners.map((operation) => operation.ownerKey)).size, 2);
});

test("duplicate explicit inline names fail before activation or data creation", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-inline-duplicate-names-"));
  const dataRoot = join(workspace, "extension-data");
  const sourcePath = join(workspace, "direct.mjs");
  globalThis.__ohmDuplicateInlinePreflightActivation = undefined;
  await writeFile(sourcePath, `
globalThis.__ohmDuplicateInlinePreflightActivation = (globalThis.__ohmDuplicateInlinePreflightActivation ?? 0) + 1;
export default function activate() {}
`);
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  context.after(() => { globalThis.__ohmDuplicateInlinePreflightActivation = undefined; });
  let activations = 0;
  let host: Awaited<ReturnType<typeof loadDirectPlugins>> | undefined;

  try {
    await assert.rejects(async () => {
      host = await loadDirectPlugins([sourcePath], {
        workspace,
        dataRoot,
        activationFailure: "throw",
        inlinePlugins: [
          { name: "duplicate", factory() { activations += 1; } },
          { name: "duplicate", factory() { activations += 1; } },
        ],
      });
    }, /duplicate inline plugin name/iu);
  } finally {
    await host?.close();
  }

  assert.equal(activations, 0);
  assert.equal(globalThis.__ohmDuplicateInlinePreflightActivation, undefined);
  await assert.rejects(access(dataRoot), { code: "ENOENT" });
});
