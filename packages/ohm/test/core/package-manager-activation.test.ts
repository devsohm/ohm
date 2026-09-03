import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import {
  DefaultPackageManager,
  type PackageActivationCandidate,
} from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { defaultNpmCommand } from "../../src/process/npm-command.js";
import { withFileLock } from "../../src/storage/file-lock.js";
import {
  loadDirectExtensions,
  type RuntimeDirectPathMetadata,
  type RuntimeExtensionHost,
  type RuntimeExtensionLoadOptions,
} from "../../src/extensions/runtime.js";

interface CandidateState {
  api?: ExtensionAPI;
  committedDuringActivation?: boolean;
}

declare global {
  var __ohmCandidateState: CandidateState | undefined;
  var __ohmCancelCandidate: (() => void) | undefined;
  var __ohmDependencyResource: string | undefined;
  var __ohmDependencyValue: string | undefined;
  var __ohmExpectedPackagePath: string | undefined;
}

function candidateState(): CandidateState {
  const state = globalThis.__ohmCandidateState;
  if (state === undefined) throw new Error("Candidate extension did not publish test state");
  return state;
}

function candidateApi(): ExtensionAPI {
  const api = candidateState().api;
  if (api === undefined) throw new Error("Candidate extension did not publish its API");
  return api;
}

interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  settingsPath: string;
  npm: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ohm-package-candidate-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const settingsPath = join(agentDir, "config.json");
  const npm = join(root, "npm.mjs");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(npm, [
    'import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";',
    'import { dirname, join, relative } from "node:path";',
    'const args = process.argv.slice(2);',
    'const manager = args[0] === "--" ? args[1] : "npm";',
    'if (args.includes("view")) { process.stdout.write(JSON.stringify(process.env.OHM_TEST_LATEST_VERSION)); process.exit(0); }',
    'if (args.includes("root") && args.includes("-g")) { process.stdout.write(process.env.OHM_TEST_GLOBAL_NPM_ROOT || ""); process.exit(0); }',
    'const install = args.indexOf("install");',
    'const uninstall = args.indexOf("uninstall");',
    'if (install < 0 && uninstall < 0) process.exit(0);',
    'const prefix = args.indexOf("--prefix");',
    'const cwd = args.indexOf("--cwd");',
    'const root = prefix >= 0 ? args[prefix + 1] : args[cwd + 1];',
    'if (uninstall >= 0) { rmSync(join(root, "node_modules", args[uninstall + 1]), { recursive: true, force: true }); process.exit(0); }',
    'const spec = args[install + 1];',
    'const names = JSON.parse(process.env.OHM_TEST_PACKAGE_NAMES || "{}");',
    'const name = names[spec] || process.env.OHM_TEST_PACKAGE_NAME || "candidate-package";',
    'const hostRange = process.env.OHM_TEST_REJECT_SPEC === spec ? ">=999.0.0" : process.env.OHM_TEST_HOST_RANGE;',
    'const dependencyValue = process.env.OHM_TEST_DEPENDENCY_VALUE;',
    'const dependencyName = process.env.OHM_TEST_DEPENDENCY_NAME || "ohm-test-direct-dependency";',
    'const dependencyResource = process.env.OHM_TEST_DEPENDENCY_RESOURCE === "1";',
    'const missingDependency = process.env.OHM_TEST_MISSING_DEPENDENCY;',
    'const missingDependencyKind = process.env.OHM_TEST_MISSING_DEPENDENCY_KIND;',
    'const target = join(root, "node_modules", name);',
    'mkdirSync(join(target, "extensions"), { recursive: true });',
    'writeFileSync(join(target, "package.json"), JSON.stringify({',
    '  name,',
    '  version: process.env.OHM_TEST_PACKAGE_VERSION,',
    '  dependencies: dependencyValue ? { [dependencyName]: "1.0.0" } : missingDependencyKind === "dependency" ? { [missingDependency]: "1.0.0" } : undefined,',
    '  bundledDependencies: missingDependencyKind === "bundled" ? [missingDependency] : undefined,',
    '  peerDependencies: hostRange ? { ohm: hostRange } : undefined,',
    '  ohm: { extensions: ["extensions/index.mjs", ...(dependencyResource ? [`node_modules/${dependencyName}/extensions/dependent.mjs`] : [])] },',
    '}));',
    'writeFileSync(join(target, "extensions", "index.mjs"), process.env.OHM_TEST_EXTENSION_SOURCE);',
    'if (dependencyValue) {',
    '  const direct = join(root, "node_modules", dependencyName);',
    '  const transitive = join(root, "node_modules", "ohm-test-transitive-dependency");',
    '  mkdirSync(direct, { recursive: true });',
    '  mkdirSync(transitive, { recursive: true });',
    '  writeFileSync(join(direct, "package.json"), JSON.stringify({ name: dependencyName, version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { "ohm-test-transitive-dependency": "1.0.0" } }));',
    '  writeFileSync(join(direct, "index.mjs"), `export { dependencyValue } from "ohm-test-transitive-dependency";\\n`);',
    '  if (dependencyResource) {',
    '    mkdirSync(join(direct, "extensions"), { recursive: true });',
    '    writeFileSync(join(direct, "extensions", "dependent.mjs"), `export default () => { globalThis.__ohmDependencyResource = ${JSON.stringify(dependencyName)}; };\\n`);',
    '  }',
    '  writeFileSync(join(transitive, "package.json"), JSON.stringify({ name: "ohm-test-transitive-dependency", version: "1.0.0", type: "module", exports: "./index.mjs" }));',
    '  writeFileSync(join(transitive, "index.mjs"), `export const dependencyValue = ${JSON.stringify(dependencyValue)};\\n`);',
    '  if (!dependencyResource) {',
    '    let nested = transitive;',
    '    for (let index = 0; index < 70; index += 1) nested = join(nested, `nested-${index}`);',
    '    mkdirSync(nested, { recursive: true });',
    '  }',
    '}',
    'if (process.env.OHM_TEST_PNPM_SYMLINK_LAYOUT === "1") {',
    '  const store = join(root, "node_modules", ".pnpm");',
    '  const moveToStore = (packageName) => {',
    '    const source = join(root, "node_modules", packageName);',
    '    const destination = join(store, `${packageName.replaceAll("/", "+")}@1.0.0`, "node_modules", packageName);',
    '    mkdirSync(dirname(destination), { recursive: true });',
    '    renameSync(source, destination);',
    '    symlinkSync(process.platform === "win32" ? destination : relative(dirname(source), destination), source, process.platform === "win32" ? "junction" : "dir");',
    '    return destination;',
    '  };',
    '  moveToStore(name);',
    '  if (dependencyValue) {',
    '    moveToStore(dependencyName);',
    '    moveToStore("ohm-test-transitive-dependency");',
    '  }',
    '}',
    'const extra = process.env.OHM_TEST_EXTRA_PACKAGE;',
    'if (extra) {',
    '  const extraTarget = join(root, "node_modules", extra);',
    '  mkdirSync(extraTarget, { recursive: true });',
    '  writeFileSync(join(extraTarget, "package.json"), JSON.stringify({ name: extra, version: "1.0.0" }));',
    '}',
    'if (spec?.startsWith("file:")) writeFileSync(join(root, "package.json"), JSON.stringify({',
    '  name: "ohm-package-stage",',
    '  private: true,',
    '  dependencies: { [name]: spec },',
    '}));',
    'if (manager === "npm" && spec?.startsWith("file:")) writeFileSync(join(root, "package-lock.json"), JSON.stringify({',
    '  packages: {',
    '    "": { dependencies: { [name]: spec } },',
    '    ["node_modules/" + name]: { resolved: spec },',
    '    ...(extra ? { ["node_modules/" + extra]: { resolved: "https://registry.invalid/" + extra } } : {}),',
    '  },',
    '}));',
  ].join("\n"));
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setNpmCommand([process.execPath, npm, "--", "npm"]);
  await settings.flush();
  context.after(async () => {
    delete process.env.OHM_TEST_LATEST_VERSION;
    delete process.env.OHM_TEST_MISSING_DEPENDENCY;
    delete process.env.OHM_TEST_MISSING_DEPENDENCY_KIND;
    delete process.env.OHM_TEST_EXTRA_PACKAGE;
    delete process.env.OHM_TEST_DEPENDENCY_NAME;
    delete process.env.OHM_TEST_DEPENDENCY_RESOURCE;
    delete process.env.OHM_TEST_DEPENDENCY_VALUE;
    delete process.env.OHM_TEST_PACKAGE_NAME;
    delete process.env.OHM_TEST_PACKAGE_NAMES;
    delete process.env.OHM_TEST_PACKAGE_VERSION;
    delete process.env.OHM_TEST_PNPM_SYMLINK_LAYOUT;
    delete process.env.OHM_TEST_REJECT_SPEC;
    delete process.env.OHM_TEST_HOST_RANGE;
    delete process.env.OHM_TEST_GLOBAL_NPM_ROOT;
    delete process.env.OHM_TEST_EXTENSION_SOURCE;
    Reflect.deleteProperty(globalThis, "__ohmCandidateState");
    Reflect.deleteProperty(globalThis, "__ohmCancelCandidate");
    Reflect.deleteProperty(globalThis, "__ohmDependencyResource");
    Reflect.deleteProperty(globalThis, "__ohmDependencyValue");
    Reflect.deleteProperty(globalThis, "__ohmExpectedPackagePath");
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, agentDir, settings, settingsPath, npm };
}

function candidateActivator(activationTimeoutMs = 30_000, loadTimeoutMs = 30_000) {
  return async (candidate: PackageActivationCandidate): Promise<void> => {
    const selected = candidate.resources.extensions.filter((entry) => entry.enabled);
    const metadata = new Map(selected.map((entry) => {
      const value: RuntimeDirectPathMetadata = {
        scope: entry.metadata.scope,
        trusted: entry.metadata.scope !== "project" || candidate.projectTrusted,
      };
      if (entry.metadata.baseDir !== undefined) value.resourceRoot = entry.metadata.baseDir;
      return [entry.path, value] as const;
    }));
    let host: RuntimeExtensionHost | undefined;
    try {
      const loadOptions: RuntimeExtensionLoadOptions = {
        workspace: candidate.workspace,
        dataRoot: candidate.dataRoot,
        projectTrusted: candidate.projectTrusted,
        directPathMetadata: metadata,
        activationFailure: "throw",
        activationTimeoutMs,
        loadTimeoutMs,
      };
      if (candidate.signal !== undefined) loadOptions.signal = candidate.signal;
      host = await loadDirectExtensions(selected.map((entry) => entry.path), loadOptions);
    } finally {
      await host?.close();
    }
  };
}

function packageManager(value: Fixture, activationTimeoutMs = 30_000): DefaultPackageManager {
  return new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    activateCandidate: candidateActivator(activationTimeoutMs),
  });
}

async function writeLocalPackage(root: string, factory: string): Promise<string> {
  const packageRoot = join(root, "local-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "local-package",
    ohm: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), factory);
  return packageRoot;
}

async function tree(root: string): Promise<Array<[string, Buffer]>> {
  const entries: Array<[string, Buffer]> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else entries.push([relative(root, path), await readFile(path)]);
    }
  };
  await visit(root);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

async function assertNoResidue(value: Fixture): Promise<void> {
  const roots = [value.agentDir, join(value.cwd, ".ohm")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const residue: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (
          entry.name.startsWith(".ohm-package-stage-")
          || entry.name.startsWith(".ohm-package-commit-")
          || entry.name.startsWith("package-activation-")
          || entry.name.endsWith(".ohm-previous")
          || entry.name.endsWith(".ohm-swap.lock")
        ) residue.push(relative(root, path));
        if (entry.isDirectory()) await visit(path);
      }
    };
    await visit(root);
    assert.deepEqual(residue, []);
  }
}

async function onlySourceReceipt(value: Fixture): Promise<string> {
  const root = join(value.agentDir, "npm", ".ohm-sources");
  const receipts = (await readdir(root)).filter((entry) => entry.endsWith(".json"));
  assert.equal(receipts.length, 1);
  return join(root, receipts[0]!);
}

async function activateInstalledPackage(value: Fixture, manager: DefaultPackageManager, source: string): Promise<void> {
  await candidateActivator()({
    source,
    scope: "user",
    workspace: value.cwd,
    projectTrusted: false,
    resources: await manager.resolve(),
    dataRoot: join(value.agentDir, "tmp", "extensions"),
  });
}

test("install activates a staged package.json direct factory before committing package code or settings", async (context) => {
  const value = await fixture(context);
  const finalPath = join(value.agentDir, "npm", "node_modules", "candidate-package");
  globalThis.__ohmExpectedPackagePath = finalPath;
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    import { existsSync } from "node:fs";
    export default (api) => {
      globalThis.__ohmCandidateState = { api, committedDuringActivation: existsSync(globalThis.__ohmExpectedPackagePath) };
      api.registerCommand("candidate", { handler() {} });
    };
  `;
  const manager = packageManager(value);

  await manager.installAndPersist("npm:candidate-package");
  await value.settings.flush();

  const state = candidateState();
  assert.equal(state.committedDuringActivation, false);
  assert.throws(() => candidateApi().getCommands(), /no longer active|stale|closed/iu);
  assert.equal(JSON.parse(await readFile(join(finalPath, "package.json"), "utf8")).version, "1.0.0");
  assert.deepEqual(value.settings.getGlobalSettings().packages, ["npm:candidate-package"]);
  await assertNoResidue(value);
});

test("npm install and update retain hoisted direct and transitive runtime dependencies through rollback", async (context) => {
  const value = await fixture(context);
  const source = "npm:candidate-package";
  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const directDependency = join(installed, "node_modules", "ohm-test-direct-dependency");
  const transitiveDependency = join(installed, "node_modules", "ohm-test-transitive-dependency");
  const manager = packageManager(value);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_DEPENDENCY_VALUE = "installed-v1";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    import { dependencyValue } from "ohm-test-direct-dependency";
    export default () => {
      globalThis.__ohmDependencyValue = dependencyValue;
      if (dependencyValue === "rejected-v3") throw new Error("dependency update rejected");
    };
  `;

  await manager.installAndPersist(source);
  await value.settings.flush();

  assert.equal(existsSync(directDependency), true);
  assert.equal(existsSync(transitiveDependency), true);
  Reflect.deleteProperty(globalThis, "__ohmDependencyValue");
  await activateInstalledPackage(value, manager, source);
  assert.equal(globalThis.__ohmDependencyValue, "installed-v1");

  process.env.OHM_TEST_LATEST_VERSION = "2.0.0";
  process.env.OHM_TEST_PACKAGE_VERSION = "2.0.0";
  process.env.OHM_TEST_DEPENDENCY_VALUE = "updated-v2";
  await manager.update(source);

  assert.equal(globalThis.__ohmDependencyValue, "updated-v2");
  assert.match(await readFile(join(transitiveDependency, "index.mjs"), "utf8"), /updated-v2/u);
  const installedBeforeRejectedUpdate = await tree(installed);

  process.env.OHM_TEST_LATEST_VERSION = "3.0.0";
  process.env.OHM_TEST_PACKAGE_VERSION = "3.0.0";
  process.env.OHM_TEST_DEPENDENCY_VALUE = "rejected-v3";
  await assert.rejects(manager.update(source), /dependency update rejected/u);

  assert.deepEqual(await tree(installed), installedBeforeRejectedUpdate);
  assert.match(await readFile(join(transitiveDependency, "index.mjs"), "utf8"), /updated-v2/u);
  await assertNoResidue(value);
});

test("real npm file installs materialize an immutable package with its dependency closure", async (context) => {
  const value = await fixture(context);
  const packages = join(value.root, "real-npm-packages");
  const sourceRoot = join(packages, "source");
  const directRoot = join(packages, "direct");
  const transitiveRoot = join(packages, "transitive");
  await mkdir(join(sourceRoot, "extensions"), { recursive: true });
  await mkdir(directRoot, { recursive: true });
  await mkdir(transitiveRoot, { recursive: true });
  await writeFile(join(transitiveRoot, "package.json"), JSON.stringify({
    name: "ohm-real-transitive-dependency",
    version: "1.0.0",
    type: "module",
    exports: "./index.mjs",
  }));
  await writeFile(join(transitiveRoot, "index.mjs"), 'export const value = "real-npm-value";\n');
  await writeFile(join(directRoot, "package.json"), JSON.stringify({
    name: "ohm-real-direct-dependency",
    version: "1.0.0",
    type: "module",
    exports: "./index.mjs",
    dependencies: { "ohm-real-transitive-dependency": pathToFileURL(transitiveRoot).href },
  }));
  await writeFile(join(directRoot, "index.mjs"), 'export { value } from "ohm-real-transitive-dependency";\n');
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({
    name: "ohm-real-file-package",
    version: "1.0.0",
    type: "module",
    dependencies: { "ohm-real-direct-dependency": pathToFileURL(directRoot).href },
    ohm: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(sourceRoot, "extensions", "index.mjs"), `
    import { value } from "ohm-real-direct-dependency";
    export default () => { globalThis.__ohmDependencyValue = value; };
  `);
  value.settings.setNpmCommand(defaultNpmCommand());
  const source = `npm:${pathToFileURL(sourceRoot).href}`;
  const manager = packageManager(value);

  await manager.installAndPersist(source);
  await value.settings.flush();

  const installed = join(value.agentDir, "npm", "node_modules", "ohm-real-file-package");
  assert.equal((await lstat(installed)).isDirectory(), true);
  assert.equal(existsSync(join(sourceRoot, "node_modules")), false);
  assert.equal(existsSync(join(installed, "node_modules", "ohm-real-direct-dependency")), true);
  assert.equal(existsSync(join(installed, "node_modules", "ohm-real-transitive-dependency")), true);
  Reflect.deleteProperty(globalThis, "__ohmDependencyValue");
  await activateInstalledPackage(value, manager, source);
  assert.equal(globalThis.__ohmDependencyValue, "real-npm-value");
  await assertNoResidue(value);
});

test("pnpm-style staged symlinks materialize as relocatable dependency directories", async (context) => {
  const value = await fixture(context);
  value.settings.setNpmCommand([process.execPath, value.npm, "--", "pnpm"]);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_DEPENDENCY_VALUE = "pnpm-symlink-value";
  process.env.OHM_TEST_PNPM_SYMLINK_LAYOUT = "1";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    import { dependencyValue } from "ohm-test-direct-dependency";
    export default () => { globalThis.__ohmDependencyValue = dependencyValue; };
  `;
  const source = "npm:candidate-package";
  const manager = packageManager(value);

  await manager.installAndPersist(source);
  await value.settings.flush();

  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const direct = join(installed, "node_modules", "ohm-test-direct-dependency");
  const transitive = join(installed, "node_modules", "ohm-test-transitive-dependency");
  assert.equal((await lstat(installed)).isDirectory(), true);
  assert.equal((await lstat(direct)).isDirectory(), true);
  assert.equal((await lstat(transitive)).isDirectory(), true);
  Reflect.deleteProperty(globalThis, "__ohmDependencyValue");
  await activateInstalledPackage(value, manager, source);
  assert.equal(globalThis.__ohmDependencyValue, "pnpm-symlink-value");
  await assertNoResidue(value);
});

test("pnpm-style scoped aliases expose explicitly declared dependency resources", async (context) => {
  const value = await fixture(context);
  const dependencyName = "@ohm-test/direct-dependency";
  value.settings.setNpmCommand([process.execPath, value.npm, "--", "pnpm"]);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_DEPENDENCY_NAME = dependencyName;
  process.env.OHM_TEST_DEPENDENCY_RESOURCE = "1";
  process.env.OHM_TEST_DEPENDENCY_VALUE = "pnpm-scoped-value";
  process.env.OHM_TEST_PNPM_SYMLINK_LAYOUT = "1";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    import { dependencyValue } from "${dependencyName}";
    export default () => { globalThis.__ohmDependencyValue = dependencyValue; };
  `;
  const source = "npm:candidate-package";
  const manager = packageManager(value);

  await manager.installAndPersist(source);
  await value.settings.flush();

  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const direct = join(installed, "node_modules", "@ohm-test", "direct-dependency");
  const dependentResource = join(direct, "extensions", "dependent.mjs");
  assert.equal((await lstat(direct)).isDirectory(), true);
  assert.equal(globalThis.__ohmDependencyResource, dependencyName);
  const resources = await manager.resolve();
  assert.equal(resources.extensions.some((entry) => entry.enabled && entry.path === dependentResource), true);
  Reflect.deleteProperty(globalThis, "__ohmDependencyResource");
  Reflect.deleteProperty(globalThis, "__ohmDependencyValue");
  await activateInstalledPackage(value, manager, source);
  assert.equal(globalThis.__ohmDependencyResource, dependencyName);
  assert.equal(globalThis.__ohmDependencyValue, "pnpm-scoped-value");
  await assertNoResidue(value);
});

test("batched npm updates materialize only each package dependency closure", async (context) => {
  const value = await fixture(context);
  const executable = join(value.root, "batch-package-manager.mjs");
  await writeFile(executable, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const args = process.argv.slice(2);',
    'if (args.includes("view")) { process.stdout.write(JSON.stringify("2.0.0")); process.exit(0); }',
    'const install = args.indexOf("install");',
    'if (install < 0) process.exit(0);',
    'const prefix = args.indexOf("--prefix");',
    'const root = args[prefix + 1];',
    'const writePackage = (name, dependencies = {}) => {',
    '  const target = join(root, "node_modules", name);',
    '  mkdirSync(target, { recursive: true });',
    '  writeFileSync(join(target, "package.json"), JSON.stringify({ name, version: "2.0.0", dependencies, ohm: name === "alpha" || name === "beta" ? { extensions: [] } : undefined }));',
    '};',
    'writePackage("alpha", { "alpha-direct": "2.0.0" });',
    'writePackage("alpha-direct", { "alpha-transitive": "2.0.0" });',
    'writePackage("alpha-transitive");',
    'writePackage("beta", { "beta-direct": "2.0.0" });',
    'writePackage("beta-direct", { "beta-transitive": "2.0.0" });',
    'writePackage("beta-transitive");',
    'writePackage("unrelated-sibling");',
  ].join("\n"));
  for (const name of ["alpha", "beta"]) {
    const target = join(value.agentDir, "npm", "node_modules", name);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "package.json"), JSON.stringify({ name, version: "1.0.0", ohm: { extensions: [] } }));
  }
  value.settings.setNpmCommand([process.execPath, executable]);
  value.settings.setPackages(["npm:alpha", "npm:beta"]);
  const manager = packageManager(value);

  await manager.update();

  const installedRoot = join(value.agentDir, "npm", "node_modules");
  assert.deepEqual((await readdir(join(installedRoot, "alpha", "node_modules"))).sort(), [
    "alpha-direct",
    "alpha-transitive",
  ]);
  assert.deepEqual((await readdir(join(installedRoot, "beta", "node_modules"))).sort(), [
    "beta-direct",
    "beta-transitive",
  ]);
  assert.equal(existsSync(join(installedRoot, "alpha", "node_modules", "beta")), false);
  assert.equal(existsSync(join(installedRoot, "beta", "node_modules", "alpha")), false);
  assert.equal(existsSync(join(installedRoot, "alpha", "node_modules", "unrelated-sibling")), false);
  assert.equal(existsSync(join(installedRoot, "beta", "node_modules", "unrelated-sibling")), false);
  await assertNoResidue(value);
});

test("a package manager restart reclaims a crashed lock and restores an interrupted npm directory swap", async (context) => {
  const value = await fixture(context);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const source = "npm:candidate-package";
  await packageManager(value).installAndPersist(source);
  await value.settings.flush();
  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const previous = join(dirname(installed), ".candidate-package.ohm-previous");
  await rename(installed, previous);
  const lock = join(dirname(installed), ".candidate-package.ohm-swap.lock");
  const token = "00000000-0000-4000-8000-000000000001";
  await mkdir(lock);
  await Promise.all([
    writeFile(join(lock, `claim-${token}`), token),
    writeFile(join(lock, `owner-${token}`), token),
    writeFile(join(lock, `pid-${token}`), "999999999"),
  ]);

  const restarted = packageManager(value);

  assert.equal(restarted.getInstalledPath(source, "user"), installed);
  assert.equal(existsSync(join(installed, "package.json")), true);
  assert.equal(existsSync(previous), false);
  assert.equal(existsSync(lock), false);
  await assertNoResidue(value);
});

test("an npm retry reclaims a fresh dead transaction lock without a rollback directory", async (context) => {
  const value = await fixture(context);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const source = "npm:candidate-package";
  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const lock = join(dirname(installed), ".candidate-package.ohm-swap.lock");
  const token = "00000000-0000-4000-8000-000000000001";
  await mkdir(lock, { recursive: true });
  await Promise.all([
    writeFile(join(lock, `claim-${token}`), token),
    writeFile(join(lock, `owner-${token}`), token),
    writeFile(join(lock, `pid-${token}`), "999999999"),
  ]);
  const manager = packageManager(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("dead lock was not reclaimed")), 500);
  timer.unref();
  try {
    await manager.installAndPersist(source, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(existsSync(lock), false);
  await assertNoResidue(value);
});

test("eager recovery does not delete a live npm transaction rollback", async (context) => {
  const value = await fixture(context);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const source = "npm:candidate-package";
  await packageManager(value).installAndPersist(source);
  await value.settings.flush();
  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const previous = join(dirname(installed), ".candidate-package.ohm-previous");
  await rename(installed, previous);
  await mkdir(installed);
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "candidate-package", version: "2.0.0" }));
  const firstInstallSource = "npm:first-install-package";
  const firstInstall = join(dirname(installed), "first-install-package");
  await mkdir(firstInstall);
  await writeFile(join(firstInstall, "package.json"), JSON.stringify({ name: "first-install-package", version: "1.0.0" }));
  const legacyRoot = join(value.root, "global-node-modules");
  const legacyInstall = join(legacyRoot, "first-install-package");
  await mkdir(legacyInstall, { recursive: true });
  await writeFile(join(legacyInstall, "package.json"), JSON.stringify({ name: "first-install-package", version: "0.9.0" }));
  process.env.OHM_TEST_GLOBAL_NPM_ROOT = legacyRoot;

  let releaseTransaction!: () => void;
  const transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
  let transactionEntered!: () => void;
  const entered = new Promise<void>((resolve) => { transactionEntered = resolve; });
  const transaction = withFileLock(join(dirname(installed), ".candidate-package.ohm-swap"), async () => {
    transactionEntered();
    await transactionGate;
  });
  await entered;
  let releaseFirstInstall!: () => void;
  const firstInstallGate = new Promise<void>((resolve) => { releaseFirstInstall = resolve; });
  let firstInstallEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { firstInstallEntered = resolve; });
  const firstTransaction = withFileLock(join(dirname(firstInstall), ".first-install-package.ohm-swap"), async () => {
    firstInstallEntered();
    await firstInstallGate;
  });
  await firstEntered;

  const restarted = packageManager(value);
  try {
    assert.equal(restarted.getInstalledPath(source, "user"), previous);
    assert.equal(restarted.getInstalledPath(firstInstallSource, "user"), undefined);
    assert.equal(JSON.parse(await readFile(join(previous, "package.json"), "utf8")).version, "1.0.0");
    assert.equal(existsSync(previous), true);
  } finally {
    releaseTransaction();
    releaseFirstInstall();
    await Promise.all([transaction, firstTransaction]);
  }

  assert.equal(restarted.getInstalledPath(source, "user"), installed);
  assert.equal(restarted.getInstalledPath(firstInstallSource, "user"), firstInstall);
  assert.equal(existsSync(previous), false);
  await assertNoResidue(value);
});

test("install replaces a dangling legacy package symlink without touching its missing target", async (context) => {
  const value = await fixture(context);
  const source = "npm:candidate-package";
  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const legacyRoot = join(value.root, "legacy-stage");
  const missingTarget = join(legacyRoot, "node_modules", "candidate-package");
  const marker = join(legacyRoot, "marker.txt");
  await mkdir(dirname(installed), { recursive: true });
  await mkdir(missingTarget, { recursive: true });
  await writeFile(marker, "legacy source remains untouched");
  await symlink(missingTarget, installed, process.platform === "win32" ? "junction" : "dir");
  await rm(missingTarget, { recursive: true });
  assert.equal(existsSync(installed), false);
  assert.equal((await lstat(installed)).isSymbolicLink(), true);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";

  await packageManager(value).installAndPersist(source);
  await value.settings.flush();

  assert.equal((await lstat(installed)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(existsSync(missingTarget), false);
  assert.equal(await readFile(marker, "utf8"), "legacy source remains untouched");
  await assertNoResidue(value);
});

test("lazy required and bundled runtime dependencies must exist before package commit", async (context) => {
  for (const kind of ["dependency", "bundled"] as const) {
    const value = await fixture(context);
    const missingName = `ohm-test-missing-${kind}`;
    process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.OHM_TEST_MISSING_DEPENDENCY = missingName;
    process.env.OHM_TEST_MISSING_DEPENDENCY_KIND = kind;
    process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";

    await assert.rejects(
      packageManager(value).installAndPersist("npm:candidate-package"),
      new RegExp(`missing required runtime dependency ${missingName}`, "u"),
    );

    assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", "candidate-package")), false);
    assert.equal(value.settings.getGlobalSettings().packages, undefined);
    await assertNoResidue(value);
  }
});

test("concurrent recovery cannot consume rollback before a failed bare receipt commit", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "receipt-rollback.tgz");
  await writeFile(archive, "receipt rollback fixture contents");
  const source = `npm:${pathToFileURL(archive).href}`;
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(source);
  await value.settings.flush();
  const installed = join(value.agentDir, "npm", "node_modules", "candidate-package");
  const before = await tree(installed);
  const receipt = await onlySourceReceipt(value);
  const receiptBefore = await readFile(receipt);

  process.env.OHM_TEST_PACKAGE_VERSION = "2.0.0";
  const originalRename = fs.promises.rename;
  let releaseReceipt!: () => void;
  const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
  let receiptEntered!: () => void;
  const entered = new Promise<void>((resolve) => { receiptEntered = resolve; });
  let injected = false;
  const injectedRename: typeof fs.promises.rename = async (sourcePath, destinationPath) => {
    if (!injected && String(destinationPath) === receipt) {
      injected = true;
      receiptEntered();
      await receiptGate;
      throw Object.assign(new Error("injected receipt commit failure"), { code: "EIO" });
    }
    await originalRename(sourcePath, destinationPath);
  };
  fs.promises.rename = injectedRename;
  syncBuiltinESMExports();
  const update = manager.install(source);
  try {
    await entered;
    const previous = join(dirname(installed), ".candidate-package.ohm-previous");
    const observer = packageManager(value);
    assert.equal(observer.getInstalledPath(source, "user"), previous);
    assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version, "2.0.0");
    assert.equal(JSON.parse(await readFile(join(previous, "package.json"), "utf8")).version, "1.0.0");
    releaseReceipt();
    await assert.rejects(update, /injected receipt commit failure/u);
  } finally {
    releaseReceipt();
    await update.catch(() => undefined);
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(injected, true);
  assert.deepEqual(await tree(installed), before);
  assert.deepEqual(await readFile(receipt), receiptBefore);
  await assertNoResidue(value);
});

test("project archive installs activate and resolve by the package name inside the archive", async (context) => {
  const value = await fixture(context);
  value.settings.setProjectTrusted(true);
  const archive = join(value.root, "renamed-archive.tgz");
  await writeFile(archive, "fixture archive contents");
  const source = `npm:${pathToFileURL(archive).href}`;
  const finalPath = join(value.cwd, ".ohm", "npm", "node_modules", "candidate-package");
  globalThis.__ohmExpectedPackagePath = finalPath;
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    import { existsSync } from "node:fs";
    export default () => {
      globalThis.__ohmCandidateState = { committedDuringActivation: existsSync(globalThis.__ohmExpectedPackagePath) };
    };
  `;

  await packageManager(value).installAndPersist(source, { local: true });
  await value.settings.flush();

  assert.equal(candidateState().committedDuringActivation, false);
  assert.equal(packageManager(value).getInstalledPath(source, "project"), finalPath);
  assert.deepEqual(value.settings.getProjectSettings().packages, [source]);
  await rm(join(value.cwd, ".ohm", "npm", ".ohm-sources"), { recursive: true, force: true });
  assert.equal(packageManager(value).getInstalledPath(source, "project"), finalPath);
  await assertNoResidue(value);
});

test("multiple bare archive sources retain their installed package identities", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "first-archive.tgz");
  const secondArchive = join(value.root, "second-archive.tgz");
  await writeFile(firstArchive, "first fixture archive contents");
  await writeFile(secondArchive, "second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.OHM_TEST_EXTRA_PACKAGE = "transitive-package";
  const manager = packageManager(value);

  process.env.OHM_TEST_PACKAGE_NAME = "first-package";
  await manager.installAndPersist(firstSource);
  process.env.OHM_TEST_PACKAGE_NAME = "second-package";
  await manager.installAndPersist(secondSource);
  await value.settings.flush();

  const restarted = packageManager(value);
  const firstPath = join(value.agentDir, "npm", "node_modules", "first-package");
  const secondPath = join(value.agentDir, "npm", "node_modules", "second-package");
  assert.equal(restarted.getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(restarted.getInstalledPath(secondSource, "user"), secondPath);
  assert.deepEqual(
    restarted.listConfiguredPackages().map((entry) => entry.installedPath),
    [firstPath, secondPath],
  );
  const resolved = await restarted.resolve(async () => "skip");
  assert.deepEqual(resolved.extensions.map((entry) => entry.path).sort(), [
    join(firstPath, "extensions", "index.mjs"),
    join(secondPath, "extensions", "index.mjs"),
  ]);
  await rm(firstPath, { recursive: true, force: true });
  assert.equal(restarted.getInstalledPath(firstSource, "user"), undefined);
  assert.equal(restarted.getInstalledPath(secondSource, "user"), secondPath);
  await restarted.removeAndPersist(firstSource);
  await value.settings.flush();
  assert.deepEqual(value.settings.getGlobalSettings().packages, [secondSource]);
  assert.equal((await readdir(join(value.agentDir, "npm", ".ohm-sources"))).length, 1);
  await assertNoResidue(value);
});

test("legacy multiple bare archive installs recover their receipts deterministically after restart", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "legacy-first-archive.tgz");
  const secondArchive = join(value.root, "legacy-second-archive.tgz");
  await writeFile(firstArchive, "legacy first fixture archive contents");
  await writeFile(secondArchive, "legacy second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  const firstName = "legacy-first-package";
  const secondName = "legacy-second-package";
  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSource.slice(4)]: firstName,
    [secondSource.slice(4)]: secondName,
  });
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.OHM_TEST_EXTRA_PACKAGE = "legacy-transitive-package";
  const manager = packageManager(value);
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await value.settings.flush();
  const receiptRoot = join(value.agentDir, "npm", ".ohm-sources");
  await rm(receiptRoot, { recursive: true, force: true });

  const restarted = packageManager(value);
  assert.equal(restarted.getInstalledPath(firstSource, "user"), undefined);
  assert.equal(restarted.getInstalledPath(secondSource, "user"), undefined);
  const resolved = await restarted.resolve();

  const firstPath = join(value.agentDir, "npm", "node_modules", firstName);
  const secondPath = join(value.agentDir, "npm", "node_modules", secondName);
  assert.deepEqual(resolved.extensions.map((entry) => entry.path).sort(), [
    join(firstPath, "extensions", "index.mjs"),
    join(secondPath, "extensions", "index.mjs"),
  ]);
  assert.deepEqual(
    (await Promise.all((await readdir(receiptRoot)).map(async (entry) => JSON.parse(await readFile(join(receiptRoot, entry), "utf8")).name))).sort(),
    [firstName, secondName],
  );
  assert.equal(packageManager(value).getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(packageManager(value).getInstalledPath(secondSource, "user"), secondPath);
  await rm(receiptRoot, { recursive: true, force: true });
  const removalRestart = packageManager(value);
  await removalRestart.removeAndPersist(firstSource);
  await value.settings.flush();
  assert.equal(existsSync(firstPath), false);
  assert.equal(removalRestart.getInstalledPath(secondSource, "user"), secondPath);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [secondSource]);
  assert.deepEqual(
    await Promise.all((await readdir(receiptRoot)).map(async (entry) => JSON.parse(await readFile(join(receiptRoot, entry), "utf8")).name)),
    [secondName],
  );
  await assertNoResidue(value);
});

test("offline legacy receipt reconciliation does not run the package manager or mutate state", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "offline-first-archive.tgz");
  const secondArchive = join(value.root, "offline-second-archive.tgz");
  await writeFile(firstArchive, "offline first fixture archive contents");
  await writeFile(secondArchive, "offline second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSource.slice(4)]: "offline-first-package",
    [secondSource.slice(4)]: "offline-second-package",
  });
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await rm(join(value.agentDir, "npm", ".ohm-sources"), { recursive: true, force: true });
  value.settings.setNpmCommand(["/ohm-test-package-command-must-not-run"]);
  await value.settings.flush();
  const npmBefore = await tree(join(value.agentDir, "npm"));
  const settingsBefore = await readFile(value.settingsPath);
  const skipping = packageManager(value);
  assert.equal(skipping.listConfiguredPackages().every((entry) => entry.installedPath === undefined), true);
  assert.deepEqual((await skipping.resolve(async () => "skip")).extensions, []);
  const offline = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    activateCandidate: candidateActivator(),
    offline: true,
  });

  assert.deepEqual((await offline.resolve()).extensions, []);
  await assert.rejects(offline.removeAndPersist(firstSource), /while offline/iu);

  assert.deepEqual(await tree(join(value.agentDir, "npm")), npmBefore);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [firstSource, secondSource]);
  await assertNoResidue(value);
});

test("a bare archive cannot overwrite a destination owned by another source", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "collision-first.tgz");
  const secondArchive = join(value.root, "collision-second.tgz");
  await writeFile(firstArchive, "first collision fixture archive contents");
  await writeFile(secondArchive, "second collision fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.OHM_TEST_PACKAGE_NAME = "shared-archive-package";
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await manager.installAndPersist(firstSource);
  await assert.rejects(manager.installAndPersist(secondSource), /already owned by another package source/u);
  await value.settings.flush();

  assert.equal(
    manager.getInstalledPath(firstSource, "user"),
    join(value.agentDir, "npm", "node_modules", "shared-archive-package"),
  );
  assert.equal(manager.getInstalledPath(secondSource, "user"), undefined);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [firstSource]);
  assert.equal((await readdir(join(value.agentDir, "npm", ".ohm-sources"))).length, 1);
  await assertNoResidue(value);
});

test("a bare archive cannot overwrite a configured named npm package", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "named-first-collision.tgz");
  await writeFile(archive, "named-first collision fixture archive contents");
  const archiveSource = `npm:${pathToFileURL(archive).href}`;
  const namedSource = "npm:cross-kind-package";
  process.env.OHM_TEST_PACKAGE_NAME = "cross-kind-package";
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await manager.installAndPersist(namedSource);
  await assert.rejects(manager.installAndPersist(archiveSource), /already owned by another package source/u);
  await value.settings.flush();

  assert.equal(
    manager.getInstalledPath(namedSource, "user"),
    join(value.agentDir, "npm", "node_modules", "cross-kind-package"),
  );
  assert.equal(manager.getInstalledPath(archiveSource, "user"), undefined);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [namedSource]);
  await assertNoResidue(value);
});

test("a named npm package cannot overwrite a destination owned by a bare archive", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "archive-first-collision.tgz");
  await writeFile(archive, "archive-first collision fixture archive contents");
  const archiveSource = `npm:${pathToFileURL(archive).href}`;
  const namedSource = "npm:cross-kind-package";
  process.env.OHM_TEST_PACKAGE_NAME = "cross-kind-package";
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await manager.installAndPersist(archiveSource);
  await assert.rejects(manager.installAndPersist(namedSource), /already owned by another package source/u);
  await value.settings.flush();

  assert.equal(
    manager.getInstalledPath(archiveSource, "user"),
    join(value.agentDir, "npm", "node_modules", "cross-kind-package"),
  );
  assert.deepEqual(value.settings.getGlobalSettings().packages, [archiveSource]);
  await assertNoResidue(value);
});

test("a missing bare receipt never falls back to a configured named package destination", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "missing-receipt-cross-kind.tgz");
  await writeFile(archive, "missing receipt cross-kind fixture archive contents");
  const archiveSource = `npm:${pathToFileURL(archive).href}`;
  const namedSource = "npm:fallback-named-package";
  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [archiveSource.slice(4)]: "fallback-bare-package",
    "fallback-named-package": "fallback-named-package",
  });
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(archiveSource);
  await manager.installAndPersist(namedSource);
  await value.settings.flush();
  await rm(join(value.agentDir, "npm", ".ohm-sources"), { recursive: true, force: true });
  await rm(join(value.agentDir, "npm", "node_modules", "fallback-bare-package"), { recursive: true, force: true });

  const restarted = packageManager(value);
  assert.equal(restarted.getInstalledPath(archiveSource, "user"), undefined);
  assert.equal(
    restarted.getInstalledPath(namedSource, "user"),
    join(value.agentDir, "npm", "node_modules", "fallback-named-package"),
  );
  await assertNoResidue(value);
});

test("removeAndPersist validates the exact configured npm source before uninstall", async (context) => {
  {
    const value = await fixture(context);
    const archive = join(value.root, "remove-bare-source.tgz");
    await writeFile(archive, "remove bare source fixture archive contents");
    const archiveSource = `npm:${pathToFileURL(archive).href}`;
    process.env.OHM_TEST_PACKAGE_NAME = "remove-exact-package";
    process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(archiveSource);
    await value.settings.flush();
    const installed = join(value.agentDir, "npm", "node_modules", "remove-exact-package");

    await assert.rejects(manager.removeAndPersist("npm:remove-exact-package"), /package source is not configured/iu);

    assert.equal(existsSync(installed), true);
    assert.equal(manager.getInstalledPath(archiveSource, "user"), installed);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [archiveSource]);
    await assertNoResidue(value);
  }

  {
    const value = await fixture(context);
    const configuredSource = "npm:remove-versioned-package@1.0.0";
    process.env.OHM_TEST_PACKAGE_NAME = "remove-versioned-package";
    process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(configuredSource);
    await value.settings.flush();
    const installed = join(value.agentDir, "npm", "node_modules", "remove-versioned-package");

    await assert.rejects(manager.removeAndPersist("npm:remove-versioned-package@2.0.0"), /package source is not configured/iu);

    assert.equal(existsSync(installed), true);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [configuredSource]);
    await assertNoResidue(value);
  }
});

test("configured bare archives reject ambiguous receipt-loss renames and recover unchanged identity", async (context) => {
  for (const receiptState of ["missing", "corrupt"] as const) {
    const value = await fixture(context);
    const archive = join(value.root, `${receiptState}-rename-source.tgz`);
    await writeFile(archive, `${receiptState} rename fixture archive contents`);
    const source = `npm:${pathToFileURL(archive).href}`;
    const originalName = `${receiptState}-original-package`;
    const renamedName = `${receiptState}-renamed-package`;
    process.env.OHM_TEST_PACKAGE_NAME = originalName;
    process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(source);
    await value.settings.flush();
    const receipt = await onlySourceReceipt(value);
    if (receiptState === "missing") await rm(receipt, { force: true });
    else await writeFile(receipt, "{");

    process.env.OHM_TEST_PACKAGE_NAME = renamedName;
    await assert.rejects(manager.update(source), /cannot recover installed npm package identity/iu);

    const originalPath = join(value.agentDir, "npm", "node_modules", originalName);
    assert.equal(existsSync(originalPath), true);
    assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", renamedName)), false);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [source]);

    process.env.OHM_TEST_PACKAGE_NAME = originalName;
    await manager.update(source);
    const repaired = await onlySourceReceipt(value);
    assert.deepEqual(JSON.parse(await readFile(repaired, "utf8")), { name: originalName });
    assert.deepEqual(await readdir(dirname(repaired)), [basename(repaired)]);
    assert.equal(manager.getInstalledPath(source, "user"), originalPath);
    await assertNoResidue(value);
  }
});

test("a bare source cannot claim a configured bare package whose receipt is missing or corrupt", async (context) => {
  for (const receiptState of ["missing", "corrupt"] as const) {
    const value = await fixture(context);
    const firstArchive = join(value.root, `${receiptState}-owner-first.tgz`);
    const secondArchive = join(value.root, `${receiptState}-owner-second.tgz`);
    await writeFile(firstArchive, `${receiptState} owner first fixture archive contents`);
    await writeFile(secondArchive, `${receiptState} owner second fixture archive contents`);
    const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
    const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
    const name = `${receiptState}-unreceipted-package`;
    process.env.OHM_TEST_PACKAGE_NAME = name;
    process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(firstSource);
    await value.settings.flush();
    const receipt = await onlySourceReceipt(value);
    if (receiptState === "missing") await rm(receipt, { force: true });
    else await writeFile(receipt, "{");

    await assert.rejects(manager.installAndPersist(secondSource), /already owned by another package source|package ownership is ambiguous/iu);

    assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", name)), true);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [firstSource]);
    if (receiptState === "missing") assert.equal(existsSync(receipt), false);
    else assert.equal(await readFile(receipt, "utf8"), "{");
    await assertNoResidue(value);
  }
});

test("configured pnpm identifies bare archives from staged root metadata", async (context) => {
  const value = await fixture(context);
  value.settings.setNpmCommand([process.execPath, value.npm, "--", "pnpm"]);
  const archive = join(value.root, "pnpm-archive.tgz");
  await writeFile(archive, "pnpm fixture archive contents");
  const source = `npm:${pathToFileURL(archive).href}`;
  const name = "pnpm-package";
  process.env.OHM_TEST_PACKAGE_NAME = name;
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.OHM_TEST_EXTRA_PACKAGE = "pnpm-transitive-package";

  await packageManager(value).installAndPersist(source);
  await value.settings.flush();

  assert.equal(
    packageManager(value).getInstalledPath(source, "user"),
    join(value.agentDir, "npm", "node_modules", name),
  );
  await assertNoResidue(value);
});

test("bare archive receipts roll back with updates and are removed on uninstall", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "rollback-first.tgz");
  const secondArchive = join(value.root, "rollback-second.tgz");
  await writeFile(firstArchive, "first rollback fixture archive contents");
  await writeFile(secondArchive, "second rollback fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  const firstSpec = firstSource.slice(4);
  const secondSpec = secondSource.slice(4);
  const manager = packageManager(value);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSpec]: "rollback-first-package",
    [secondSpec]: "rollback-second-package",
  });
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await value.settings.flush();
  const firstPath = join(value.agentDir, "npm", "node_modules", "rollback-first-package");
  const secondPath = join(value.agentDir, "npm", "node_modules", "rollback-second-package");

  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSpec]: "rollback-renamed-package",
    [secondSpec]: "rollback-second-package",
  });
  await assert.rejects(manager.update(firstSource), /package identity changed/u);
  assert.equal(manager.getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", "rollback-renamed-package")), false);

  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSpec]: "rollback-first-package",
    [secondSpec]: "rollback-second-package",
  });
  process.env.OHM_TEST_REJECT_SPEC = secondSpec;
  await assert.rejects(manager.update(), /requires ohm >=999\.0\.0/u);

  assert.equal(manager.getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(manager.getInstalledPath(secondSource, "user"), secondPath);
  assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", "rollback-renamed-package")), false);
  delete process.env.OHM_TEST_REJECT_SPEC;
  await manager.removeAndPersist(firstSource);
  await value.settings.flush();
  assert.equal(manager.getInstalledPath(firstSource, "user"), undefined);
  assert.equal(manager.getInstalledPath(secondSource, "user"), secondPath);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [secondSource]);
  assert.equal((await readdir(join(value.agentDir, "npm", ".ohm-sources"))).length, 1);
  await assertNoResidue(value);
});

test("failed bare archive update preserves legacy packages and missing receipts byte-for-byte", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "legacy-rollback-first.tgz");
  const secondArchive = join(value.root, "legacy-rollback-second.tgz");
  await writeFile(firstArchive, "legacy rollback first fixture archive contents");
  await writeFile(secondArchive, "legacy rollback second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.OHM_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSource.slice(4)]: "legacy-rollback-first-package",
    [secondSource.slice(4)]: "legacy-rollback-second-package",
  });
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await value.settings.flush();
  const npmRoot = join(value.agentDir, "npm");
  await rm(join(npmRoot, ".ohm-sources"), { recursive: true, force: true });
  const installedBefore = await tree(npmRoot);
  const settingsBefore = await readFile(value.settingsPath);
  process.env.OHM_TEST_EXTENSION_SOURCE = 'export default () => { throw new Error("legacy update rejected"); };\n';

  await assert.rejects(manager.update(firstSource), /legacy update rejected/u);

  assert.deepEqual(await tree(npmRoot), installedBefore);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  await assertNoResidue(value);
});

test("an incompatible ohm peer is rejected before package code or settings commit", async (context) => {
  const value = await fixture(context);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_HOST_RANGE = ">=999.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await assert.rejects(manager.installAndPersist("npm:candidate-package"), /requires ohm >=999\.0\.0/u);

  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.deepEqual(value.settings.getGlobalSettings().packages, undefined);
  await assertNoResidue(value);
});

test("failed update activation preserves installed code and settings byte-for-byte", async (context) => {
  const value = await fixture(context);
  const manager = packageManager(value);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  await manager.installAndPersist("npm:candidate-package");
  await value.settings.flush();
  const finalPath = join(value.agentDir, "npm");
  const installedBefore = await tree(finalPath);
  const settingsBefore = await readFile(value.settingsPath);

  process.env.OHM_TEST_LATEST_VERSION = "2.0.0";
  process.env.OHM_TEST_PACKAGE_VERSION = "2.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    export default (api) => {
      globalThis.__ohmCandidateState = { api };
      throw new Error("candidate update rejected");
    };
  `;

  await assert.rejects(manager.update("npm:candidate-package"), /candidate update rejected/u);

  assert.deepEqual(await tree(finalPath), installedBefore);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.throws(
    () => candidateApi().getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);
});

test("missing configured packages activate from staging before reconciliation commits code", async (context) => {
  const value = await fixture(context);
  value.settings.setPackages(["npm:candidate-package"]);
  await value.settings.flush();
  const settingsBefore = await readFile(value.settingsPath);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    export default (api) => {
      globalThis.__ohmCandidateState = { api };
      throw new Error("configured candidate rejected");
    };
  `;

  await assert.rejects(packageManager(value).resolve(), /configured candidate rejected/u);

  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.throws(
    () => candidateApi().getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);
});

test("activation timeout and cancellation clean staged code without persisting package settings", async (context) => {
  const value = await fixture(context);
  process.env.OHM_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.OHM_TEST_EXTENSION_SOURCE = `
    export default async (api) => {
      globalThis.__ohmCandidateState = { api };
      globalThis.__ohmCancelCandidate?.();
      await new Promise(() => {});
    };
  `;
  const settingsBefore = await readFile(value.settingsPath);

  await assert.rejects(
    packageManager(value, 25).installAndPersist("npm:candidate-package"),
    /timed out after 25ms/u,
  );
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.throws(
    () => candidateApi().getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);

  const controller = new AbortController();
  globalThis.__ohmCancelCandidate = () => {
    controller.abort(new Error("candidate cancelled"));
  };
  const cancellation = packageManager(value).installAndPersist("npm:candidate-package", { signal: controller.signal });
  await assert.rejects(cancellation, /candidate cancelled/u);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.throws(
    () => candidateApi().getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);
});

test("candidate activation cannot use live session authority", async (context) => {
  const value = await fixture(context);
  const packageRoot = await writeLocalPackage(value.root, `
    export default (api) => {
      api.sendUserMessage("must not reach a session", { deliverAs: "followUp" });
    };
  `);
  const settingsBefore = await readFile(value.settingsPath);

  await assert.rejects(
    packageManager(value).installAndPersist(packageRoot),
    /actions are unavailable before the session host is bound/u,
  );

  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.deepEqual(value.settings.getGlobalSettings().packages, undefined);
  await assertNoResidue(value);
});
