import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime, preactivateProjectTrustPlugins } from "../../src/cli/runtime.js";
import { ProjectTrustResolver } from "../../src/cli/project-trust.js";
import { TrustStore } from "../../src/config/trust.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getPluginRuntimeHost } from "../../src/plugins/compat.js";
import type { PluginAPI } from "../../src/plugins/direct.js";
import type { PluginConfigSnapshot } from "../../src/plugins/config-store.js";
import { loadDirectPlugins, type RuntimePluginHost } from "../../src/plugins/runtime.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

declare global {
  var __ohmModeDataApi: PluginAPI | undefined;
  var __ohmModeDataActivations: number | undefined;
}

for (const firstMode of ["cli", "sdk"] as const) {
  for (const legacy of [false, true]) {
    test(`${firstMode} plugin state crosses product modes with ${legacy ? "legacy" : "fresh"} data`, async (context) => {
      const root = await mkdtemp(join(tmpdir(), "ohm-plugin-mode-data-"));
      const cwd = join(root, "workspace");
      const agentDir = join(root, "agent");
      const pluginDir = join(agentDir, legacy ? "extensions" : "plugins");
      const extension = join(pluginDir, "mode-data.mjs");
      const dataRoot = legacy ? join(agentDir, "state", "extension-data") : join(agentDir, "extension-data");
      const close: Array<() => Promise<void>> = [];
      context.after(async () => {
        for (const dispose of close.reverse()) await dispose();
        Reflect.deleteProperty(globalThis, "__ohmModeDataApi");
        Reflect.deleteProperty(globalThis, "__ohmModeDataActivations");
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(cwd);
      await mkdir(pluginDir, { recursive: true });
      if (legacy) await mkdir(dataRoot, { recursive: true });
      await writeFile(extension, `export default (api) => {
        globalThis.__ohmModeDataApi = api;
        globalThis.__ohmModeDataActivations = (globalThis.__ohmModeDataActivations ?? 0) + 1;
        api.on("project_trust", () => ({ trusted: "yes" }));
      };\n`);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
      });
      close.push(async () => await modelRuntime.close());
      let snapshots: PluginConfigSnapshot[] | undefined;
      let initialPaths: ReturnType<RuntimePluginHost["pluginDataPaths"]>;
      const modes = [firstMode, firstMode === "cli" ? "sdk" : "cli", firstMode];
      for (const [index, mode] of modes.entries()) {
        let host: RuntimePluginHost;
        let dispose: () => Promise<void>;
        if (mode === "cli") {
          const runtime = await loadRuntime({
            workspace: cwd, agentDirectory: agentDir, credentialStore: new InMemoryCredentialStore(),
            projectTrusted: false, pluginCode: true, pluginRuntime: true, ephemeral: true,
            offline: true, skills: false, promptTemplates: false, themes: false,
          });
          host = runtime.runtimePlugins;
          dispose = async () => await runtime.close();
          close.push(dispose);
        } else {
          const created = await createAgentSession({
            cwd, agentDir, modelRuntime, noTools: "all", sessionManager: SessionManager.inMemory(cwd),
            settingsManager: SettingsManager.inMemory(),
          });
          dispose = async () => await created.session.close();
          close.push(dispose);
          const selected = getPluginRuntimeHost(created.pluginsResult.runtime);
          assert.ok(selected);
          host = selected;
        }
        assert.equal(host.dataRoot, dataRoot);
        const paths = host.pluginDataPaths(extension);
        assert.ok(paths);
        const api = globalThis.__ohmModeDataApi;
        assert.ok(api);
        if (index === 0) initialPaths = paths;
        else {
          assert.deepEqual(paths, initialPaths);
          assert.deepEqual(await Promise.all([api.config.read("user"), api.config.read("workspace")]), snapshots);
          assert.equal(await readFile(join(paths.workspace, "custom.txt"), "utf8"), `mode-${index - 1}`);
        }
        snapshots = await Promise.all((["user", "workspace"] as const).map(async (scope, scopeIndex) =>
          await api.config.replace(scope, { mode, index }, { expectedRevision: snapshots?.[scopeIndex]?.revision ?? null })));
        await writeFile(join(paths.workspace, "custom.txt"), `mode-${index}`);
        await dispose();
      }
    });
  }
}

for (const [name, failure] of [
  ["SDK plugin data conflicts close the model runtime and session manager created during startup", "conflict"],
  ["SDK manager construction failure closes its already-created model runtime", "manager-create"],
  ["SDK plugin data conflicts retain the primary failure and continue cleanup after manager close fails", "manager-close"],
] as const) {
  test(name, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "ohm-sdk-data-conflict-"));
    const agentDir = join(root, "agent");
    let ownedManager: SessionManager | undefined;
    let ownedRuntime: ModelRuntime | undefined;
    context.after(async () => {
      context.mock.restoreAll();
      ownedManager?.closeV4Store();
      await ownedRuntime?.close();
      await rm(root, { recursive: true, force: true });
    });
    const manager = SessionManager.create(root, join(root, "sessions"));
    ownedManager = manager;
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
    });
    ownedRuntime = runtime;
    await mkdir(join(agentDir, "extension-data"), { recursive: true });
    await mkdir(join(agentDir, "state", "extension-data"), { recursive: true });
    const constructionFailure = new Error("manager construction failed");
    const cleanupFailure = new Error("manager cleanup failed");
    context.mock.method(ModelRuntime, "create", async () => runtime);
    context.mock.method(SessionManager, "create", () => {
      if (failure === "manager-create") throw constructionFailure;
      return manager;
    });
    const originalClose = manager.closeV4Store.bind(manager);
    const closeManager = context.mock.method(manager, "closeV4Store", () => {
      if (failure === "manager-close") throw cleanupFailure;
      originalClose();
    });
    const closeRuntime = context.mock.method(runtime, "close");
    await assert.rejects(createAgentSession({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory() }), (error) => {
      if (failure === "manager-create") assert.equal(error, constructionFailure);
      else {
        let primary = error;
        if (failure === "manager-close") {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors.slice(1), [cleanupFailure]);
          primary = error.errors[0];
        }
        assert.ok(primary instanceof Error);
        assert.match(primary.message, /Plugin data exists in both/u);
      }
      return true;
    });
    assert.equal(closeManager.mock.callCount(), failure === "manager-create" ? 0 : 1);
    assert.equal(closeRuntime.mock.callCount(), 1);
  });
}

test("legacy plugin data survives pre-trust handoff, project append, and refresh", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-plugin-trust-data-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const dataRoot = join(agentDir, "state", "extension-data");
  const user = join(agentDir, "extensions", "trust-data.mjs");
  const project = join(cwd, ".ohm", "extensions", "project-data.mjs");
  const close: Array<() => Promise<void>> = [];
  context.after(async () => {
    for (const dispose of close.reverse()) await dispose();
    Reflect.deleteProperty(globalThis, "__ohmModeDataApi");
    Reflect.deleteProperty(globalThis, "__ohmModeDataActivations");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(join(agentDir, "extensions"));
  await mkdir(join(cwd, ".ohm", "extensions"), { recursive: true });
  await writeFile(user, `export default (api) => {
    globalThis.__ohmModeDataApi = api;
    globalThis.__ohmModeDataActivations = (globalThis.__ohmModeDataActivations ?? 0) + 1;
    api.on("project_trust", () => ({ trusted: "yes" }));
  };\n`);
  await writeFile(project, "export default (api) => api.registerCommand('project-data', { handler() {} });\n");
  const resolver = new ProjectTrustResolver(new TrustStore(join(agentDir, "trusted-workspaces.json")), {
    agentDirectory: agentDir,
    preactivate: async (workspace) => await preactivateProjectTrustPlugins({ agentDirectory: agentDir, userPlugins: join(agentDir, "plugins") }, workspace, {
      pluginRuntime: true, pluginCode: true, offline: true,
    }),
  });
  close.push(async () => await resolver.close());
  assert.equal(await resolver.isTrusted(cwd), true);
  const prepared = await resolver.takePreactivatedPlugins(cwd);
  assert.ok(prepared);
  close.push(async () => await prepared.close());
  assert.equal(prepared.dataRoot, dataRoot);
  assert.equal(prepared.pluginDataPaths(project), undefined);
  assert.equal(globalThis.__ohmModeDataActivations, 1);
  const api = globalThis.__ohmModeDataApi;
  assert.ok(api);
  const retained = await api.config.replace("user", { retained: true }, { expectedRevision: null });
  const runtime = await loadRuntime({
    workspace: cwd, agentDirectory: agentDir, credentialStore: new InMemoryCredentialStore(),
    projectTrusted: true, pluginCode: true, pluginRuntime: true, ephemeral: true,
    offline: true, skills: false, promptTemplates: false, themes: false, preactivatedRuntimePlugins: prepared,
  });
  close.push(async () => await runtime.close());
  assert.equal(runtime.runtimePlugins, prepared);
  assert.equal(globalThis.__ohmModeDataActivations, 1);
  const projectPaths = prepared.pluginDataPaths(project);
  assert.ok(projectPaths);
  assert.ok(projectPaths.workspace.startsWith(dataRoot));
  await runtime.refresh();
  assert.equal(runtime.runtimePlugins.dataRoot, dataRoot);
  assert.equal(globalThis.__ohmModeDataActivations, 2);
  assert.deepEqual(runtime.runtimePlugins.pluginDataPaths(project), projectPaths);
  assert.deepEqual(await globalThis.__ohmModeDataApi?.config.read("user"), retained);
});

for (const mode of ["cli", "loader"] as const) {
  test(`${mode} retains a prepared custom data root through refresh even with conflicting product roots`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "ohm-plugin-custom-data-"));
    const agentDir = join(root, "agent");
    const dataRoot = join(root, "custom");
    const close: Array<() => Promise<void>> = [];
    context.after(async () => {
      for (const dispose of close.reverse()) await dispose();
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(agentDir, "extension-data"), { recursive: true });
    await mkdir(join(agentDir, "state", "extension-data"), { recursive: true });
    let api: PluginAPI | undefined;
    const pluginFactories = [{ name: "custom-data", factory(value: PluginAPI) { api = value; } }];
    const prepared = await loadDirectPlugins([], { workspace: root, dataRoot, inlinePlugins: pluginFactories });
    close.push(async () => await prepared.close());
    assert.ok(api);
    const retained = await api.config.replace("workspace", { custom: true }, { expectedRevision: null });
    let refresh: () => Promise<void>;
    let current: () => RuntimePluginHost | undefined;
    if (mode === "cli") {
      const runtime = await loadRuntime({
        workspace: root, agentDirectory: agentDir, credentialStore: new InMemoryCredentialStore(),
        projectTrusted: false, pluginCode: false, pluginRuntime: true, ephemeral: true,
        offline: true, skills: false, promptTemplates: false, themes: false,
        preactivatedRuntimePlugins: prepared, pluginFactories,
      });
      close.push(async () => await runtime.close());
      refresh = async () => { await runtime.refresh(); };
      current = () => runtime.runtimePlugins;
    } else {
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir, settingsManager: SettingsManager.inMemory(), preparedPlugins: prepared, pluginFactories,
      });
      close.push(async () => await getPluginRuntimeHost(loader.getPlugins().runtime)?.close());
      await loader.refresh();
      refresh = async () => await loader.refresh();
      current = () => getPluginRuntimeHost(loader.getPlugins().runtime);
    }
    assert.equal(current(), prepared);
    await refresh();
    assert.notEqual(current(), prepared);
    assert.equal(current()?.dataRoot, dataRoot);
    assert.deepEqual(await api.config.read("workspace"), retained);
  });
}
