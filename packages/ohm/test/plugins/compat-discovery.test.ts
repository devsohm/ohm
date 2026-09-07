import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";

import { createEventBus } from "../../src/core/event-bus.js";
import { PORTABLE_PLUGIN_SCHEMA } from "../../src/core/portable-plugin.js";
import { FUNCTION_VALUE } from "../../src/core/value-schemas.js";
import type { PluginAPI } from "../../src/plugins/direct.js";
import {
  discoverAndLoadPlugins,
  getPluginRuntimeHost,
  projectLoadedPluginHost,
} from "../../src/plugins/compat.js";
import { loadDirectPlugins } from "../../src/plugins/runtime.js";

declare global {
  var __compatLoaderCount: number | undefined;
  var __compatLoaderApi: PluginAPI | undefined;
  var __compatLoaderInspections: number | undefined;
}

const roots = new Set<string>();

async function temporaryDirectory(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.add(root);
  return root;
}

async function moduleFile(path: string, body = "export default () => {};\n"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

test.afterEach(async () => {
  globalThis.__compatLoaderCount = undefined;
  globalThis.__compatLoaderApi = undefined;
  globalThis.__compatLoaderInspections = undefined;
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("discovers project, user, and explicit factories with manifest and index precedence", async () => {
  const cwd = await temporaryDirectory("ohm-compat-discovery-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const projectExtensions = join(cwd, ".ohm", "plugins");
  const packageDirectory = join(projectExtensions, "manifest-package");
  const direct = join(projectExtensions, "direct.ts");
  const declared = join(packageDirectory, "declared.js");
  const firstDeclared = join(packageDirectory, "z-first.js");
  const ignoredPackageIndex = join(packageDirectory, "index.ts");
  const ignoredNested = join(projectExtensions, "nested", "deeper", "index.ts");
  const directModule = join(projectExtensions, "module.mjs");
  const legacyProject = join(cwd, ".ohm", "extensions", "legacy.ts");
  const user = join(agentDir, "plugins", "user.js");
  const legacyUser = join(agentDir, "extensions", "legacy-user.js");
  const explicitDirectory = join(cwd, "explicit");
  const explicitIndex = join(explicitDirectory, "index.ts");
  const ignoredExplicitSibling = join(explicitDirectory, "sibling.ts");

  await moduleFile(direct);
  await moduleFile(declared);
  await moduleFile(firstDeclared);
  await moduleFile(ignoredPackageIndex);
  await moduleFile(ignoredNested);
  await moduleFile(directModule);
  await moduleFile(legacyProject);
  await moduleFile(legacyUser);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ ohm: { entrypoints: ["z-first.js", "declared.js"] } }),
    "utf8",
  );
  await moduleFile(user);
  await moduleFile(explicitIndex);
  await moduleFile(ignoredExplicitSibling);
  await writeFile(join(explicitDirectory, "package.json"), JSON.stringify({ type: "module" }));

  const result = await discoverAndLoadPlugins([explicitDirectory], cwd, agentDir);
  try {
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.resolvedPath),
      [direct, firstDeclared, declared, directModule, legacyProject, user, legacyUser, explicitIndex],
    );
    assert.equal(result.plugins.some((extension) => extension.resolvedPath === ignoredPackageIndex), false);
    assert.equal(result.plugins.some((extension) => extension.resolvedPath === ignoredNested), false);
    assert.equal(result.plugins.some((extension) => extension.resolvedPath === ignoredExplicitSibling), false);
    assert.deepEqual(result.plugins.map((extension) => extension.sourceInfo.scope).sort(), [
      "project",
      "project",
      "project",
      "project",
      "project",
      "temporary",
      "user",
      "user",
    ]);
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("public discovery accepts the runtime's source formats as loose files and index packages", async () => {
  const cwd = await temporaryDirectory("ohm-plugin-formats-");
  const agentDir = await temporaryDirectory("ohm-plugin-formats-agent-");
  const expected: string[] = [];
  for (const suffix of ["ts", "tsx", "js", "mjs", "cjs", "mts", "cts"]) {
    const body = suffix === "cjs" || suffix === "cts" ? "module.exports = () => {};\n" : "export default () => {};\n";
    for (const path of [join(agentDir, "plugins", `loose.${suffix}`), join(agentDir, "plugins", suffix, `index.${suffix}`)]) {
      await moduleFile(path, body);
      expected.push(path);
    }
  }
  const result = await discoverAndLoadPlugins([], cwd, agentDir);
  try {
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plugins.map((plugin) => plugin.resolvedPath).sort(), expected.sort());
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("compat package discovery bounds manifests at exactly 1 MiB without activating rejected fallback code", async () => {
  const cwd = await temporaryDirectory("ohm-compat-bounded-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const roots = ["exact", "oversized"].map((name) => join(cwd, name));
  const manifest = JSON.stringify({ ohm: { extensions: ["declared.js"] } });
  for (const [index, root] of roots.entries()) {
    await moduleFile(join(root, "declared.js"));
    await moduleFile(join(root, "index.ts"), "export default () => { globalThis.__compatLoaderCount = 1; };\n");
    const bytes = 1024 * 1024 + index;
    await writeFile(join(root, "package.json"), `${manifest}${" ".repeat(bytes - Buffer.byteLength(manifest))}`);
  }

  const result = await discoverAndLoadPlugins(roots, cwd, agentDir);
  try {
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.path, roots[1]);
    assert.match(result.errors[0]!.error, /exceeds 1048576 bytes/u);
    assert.equal(globalThis.__compatLoaderCount, undefined);
    assert.deepEqual(result.plugins.map((extension) => [
      basename(extension.path),
      basename(join(extension.path, "..")),
    ]), [
      ["declared.js", "exact"],
    ]);
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("compat discovery honors canonical, empty, and resource-only declarations and rejects malformed manifests", async () => {
  const cwd = await temporaryDirectory("ohm-compat-manifests-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const manifests = [
    ["canonical", JSON.stringify({ ohm: { entrypoints: ["declared.js"] } })],
    ["empty", JSON.stringify({ ohm: { entrypoints: [] } })],
    ["empty-umbrella", JSON.stringify({ ohm: {} })],
    ["resource-only", JSON.stringify({ ohm: { skills: ["skills"] } })],
    ["invalid-json", "{"],
    ["invalid-entry", JSON.stringify({ ohm: { entrypoints: [42] } })],
    ["ambiguous", JSON.stringify({ ohm: { entrypoints: [], extensions: ["index.ts"] } })],
    ["portable-empty", JSON.stringify({ $schema: PORTABLE_PLUGIN_SCHEMA, name: "portable-empty" })],
    ["portable-invalid", "{"],
  ] as const;
  for (const automatic of [true, false]) {
    const base = automatic ? join(cwd, ".ohm", "extensions") : join(cwd, "explicit");
    const requested: string[] = [];
    for (const [name, manifest] of manifests) {
      const directory = join(base, name);
      requested.push(directory);
      await moduleFile(join(directory, "declared.js"));
      await moduleFile(join(directory, "index.ts"), "export default () => { globalThis.__compatLoaderCount = 1; };\n");
      await writeFile(join(directory, name.startsWith("portable-") ? "plugin.json" : "package.json"), manifest);
    }
    const result = await discoverAndLoadPlugins(automatic ? [] : requested, cwd, agentDir);
    try {
      assert.equal(globalThis.__compatLoaderCount, undefined);
      assert.deepEqual(result.plugins.map((extension) => extension.path), [join(base, "canonical", "declared.js")]);
      assert.deepEqual(new Set(result.errors.map((error) => error.path)), new Set([
        join(base, "invalid-json"), join(base, "invalid-entry"), join(base, "ambiguous"),
        join(base, "portable-invalid"),
      ]));
    } finally {
      await getPluginRuntimeHost(result.runtime)?.close();
      if (automatic) await rm(base, { recursive: true });
    }
  }
});

test("deduplicates canonically with the first discovery source retaining ownership", async () => {
  const cwd = await temporaryDirectory("ohm-compat-dedup-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const direct = join(cwd, ".ohm", "plugins", "same.ts");
  await moduleFile(direct);
  await symlink(join(cwd, ".ohm", "plugins"), join(cwd, ".ohm", "extensions"), process.platform === "win32" ? "junction" : "dir");

  const result = await discoverAndLoadPlugins([
    direct,
    join(cwd, ".ohm", "extensions", ".", "same.ts"),
  ], cwd, agentDir);
  try {
    assert.deepEqual(result.errors, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.sourceInfo.scope, "project");
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("records one path failure and continues loading later factories", async () => {
  const cwd = await temporaryDirectory("ohm-compat-errors-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const invalid = join(cwd, "invalid.ts");
  const valid = join(cwd, "valid.ts");
  await moduleFile(invalid, `
export default () => {
  const failure = new Error("activation failed");
  Object.defineProperty(failure, "message", {
    get() {
      globalThis.__compatLoaderInspections = (globalThis.__compatLoaderInspections ?? 0) + 1;
      throw new Error("hostile activation failure was inspected");
    },
  });
  throw failure;
};
`);
  await moduleFile(valid, "export default (api) => api.registerFlag('loaded', { type: 'boolean', default: true });\n");

  const result = await discoverAndLoadPlugins([invalid, valid], cwd, agentDir);
  try {
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.path, invalid);
    assert.match(result.errors[0]!.error, /^Failed to load plugin:/u);
    assert.equal(globalThis.__compatLoaderInspections, undefined);
    assert.deepEqual(result.plugins.map((extension) => extension.path), [valid]);
    assert.equal(result.plugins[0]!.flags.has("loaded"), true);
    assert.equal(result.runtime.flagValues.get("loaded"), true);
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("projects exact direct registrations while retaining one native execution authority", async () => {
  const cwd = await temporaryDirectory("ohm-compat-projection-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const source = join(cwd, "complete.ts");
  await moduleFile(source, `
export default (api) => {
  globalThis.__compatLoaderApi = api;
  api.on("session_start", () => {});
  api.registerTool({
    name: "inspect",
    label: "Inspect",
    description: "Inspect a value",
    parameters: { type: "object" },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
  api.registerCommand("review", { description: "Review", async handler() {} });
  api.registerFlag("verbose", { description: "Verbose", type: "boolean", default: false });
  api.registerShortcut("ctrl+g", { description: "Go", handler() {} });
  api.registerMessageRenderer("notice", () => undefined);
  api.registerMarkdownTransformer((markdown) => markdown);
  api.registerEntryRenderer("state", () => undefined);
};
`);

  const result = await discoverAndLoadPlugins([source], cwd, agentDir);
  try {
    const extension = result.plugins[0]!;
    assert.ok(getPluginRuntimeHost(result.runtime));
    assert.deepEqual([...extension.handlers.keys()], ["session_start"]);
    assert.deepEqual([...extension.tools.keys()], ["inspect"]);
    assert.deepEqual([...extension.commands.keys()], ["review"]);
    assert.deepEqual([...extension.flags.keys()], ["verbose"]);
    assert.deepEqual([...extension.shortcuts.keys()], ["ctrl+g"]);
    assert.deepEqual([...extension.messageRenderers.keys()], ["notice"]);
    assert.equal(Value.Check(FUNCTION_VALUE, extension.markdownTransformer), true);
    const entryRenderers = extension.entryRenderers;
    assert.ok(entryRenderers !== undefined);
    assert.deepEqual([...entryRenderers.keys()], ["state"]);

    const api = globalThis.__compatLoaderApi;
    assert.ok(api !== undefined);
    api.registerCommand("late", { async handler() {} });
    assert.equal(extension.commands.has("late"), true);
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("uses a supplied event bus and removes generation listeners on shutdown", async () => {
  const cwd = await temporaryDirectory("ohm-compat-events-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const listener = join(cwd, "listener.ts");
  const emitter = join(cwd, "emitter.ts");
  await moduleFile(listener, `
export default (api) => api.events.on("compat:ping", () => {
  globalThis.__compatLoaderCount = (globalThis.__compatLoaderCount ?? 0) + 1;
});
`);
  await moduleFile(emitter, "export default (api) => api.events.emit('compat:ping', { ok: true });\n");
  const eventBus = createEventBus();

  const result = await discoverAndLoadPlugins([listener, emitter], cwd, agentDir, eventBus);
  assert.equal(globalThis.__compatLoaderCount, 1);
  const host = getPluginRuntimeHost(result.runtime);
  assert.ok(host);
  await host.close();
  eventBus.emit("compat:ping", { ok: true });
  assert.equal(globalThis.__compatLoaderCount, 1);
});

test("rolls back supplied event-bus listeners when activation fails", async () => {
  const cwd = await temporaryDirectory("ohm-compat-event-rollback-");
  const agentDir = await temporaryDirectory("ohm-compat-agent-");
  const source = join(cwd, "failure.ts");
  await moduleFile(source, `
export default (api) => {
  api.events.on("compat:rollback", () => {
    globalThis.__compatLoaderCount = (globalThis.__compatLoaderCount ?? 0) + 1;
  });
  throw new Error("activation failed");
};
`);
  const eventBus = createEventBus();

  const result = await discoverAndLoadPlugins([source], cwd, agentDir, eventBus);
  try {
    assert.equal(result.plugins.length, 0);
    assert.equal(result.errors.length, 1);
    eventBus.emit("compat:rollback", null);
    assert.equal(globalThis.__compatLoaderCount, undefined);
  } finally {
    await getPluginRuntimeHost(result.runtime)?.close();
  }
});

test("projects an existing host without evaluating its factories again", async () => {
  const cwd = await temporaryDirectory("ohm-compat-existing-host-");
  const source = join(cwd, "existing.ts");
  await moduleFile(source, `
export default (api) => {
  globalThis.__compatLoaderCount = (globalThis.__compatLoaderCount ?? 0) + 1;
  api.registerCommand("existing", { async handler() {} });
};
`);
  const host = await loadDirectPlugins([source], {
    workspace: cwd,
    activationFailure: "throw",
    inlinePlugins: [{
      name: "hidden-inline",
      hidden: true,
      factory(api) {
        api.registerFlag("inline", { type: "boolean", default: true });
      },
    }],
  });

  const result = projectLoadedPluginHost(host);
  try {
    assert.equal(globalThis.__compatLoaderCount, 1);
    assert.equal(result.plugins.length, 2);
    assert.equal(result.plugins[0]!.commands.has("existing"), true);
    assert.equal(result.plugins[1]!.hidden, true);
    assert.equal(result.plugins[1]!.flags.has("inline"), true);
    assert.equal(getPluginRuntimeHost(result.runtime), host);
  } finally {
    await host.close();
  }
});
