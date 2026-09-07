import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

async function fixture(): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  packages: DefaultPackageManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "ohm-package-manager-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const settings = SettingsManager.inMemory();
  return { root, cwd, agentDir, settings, packages: new DefaultPackageManager({ cwd, agentDir, settingsManager: settings }) };
}

test("package manifests and conventional directories resolve all resource classes", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "package");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await mkdir(join(packageRoot, "themes"), { recursive: true });
  await writeFile(join(packageRoot, "src", "extension.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review");
  await writeFile(join(packageRoot, "prompts", "review.md"), "Review this");
  await writeFile(join(packageRoot, "themes", "dark.json"), "{}");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture",
    ohm: {
      entrypoints: ["src/extension.ts"],
      skills: ["skills"],
      prompts: ["prompts"],
      themes: ["themes"],
    },
  }));
  value.settings.setPackages([packageRoot]);
  await value.settings.flush();

  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [join(packageRoot, "src", "extension.ts")]);
  assert.equal(result.skills.some((entry) => entry.path === join(packageRoot, "skills", "review", "SKILL.md")), true);
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(packageRoot, "prompts", "review.md")]);
  assert.deepEqual(result.themes.map((entry) => entry.path), [join(packageRoot, "themes", "dark.json")]);
  value.settings.setPackages([{ source: packageRoot, entrypoints: [], prompts: [] }]);
  const disabled = await value.packages.resolve();
  assert.deepEqual(disabled.extensions.map((entry) => entry.enabled), [false]);
  assert.deepEqual(disabled.prompts.map((entry) => entry.enabled), [false]);
  assert.equal(disabled.skills.every((entry) => entry.enabled), true);
  assert.equal(disabled.themes.every((entry) => entry.enabled), true);
});

test("project resources win canonical duplicates and filters retain disabled entries", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "filtered");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "enabled.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "disabled.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "filtered" }));
  value.settings.setPackages([{ source: packageRoot, extensions: ["+extensions/enabled.ts", "-extensions/disabled.ts"] }]);
  await value.settings.flush();
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "disabled.ts"), false],
    [join(packageRoot, "extensions", "enabled.ts"), true],
  ]);
  value.settings.setPackages([{ source: packageRoot, entrypoints: ["extensions/enabled.ts"] }]);
  assert.deepEqual((await value.packages.resolve()).extensions.map((entry) => [entry.path, entry.enabled]), [
    [join(packageRoot, "extensions", "disabled.ts"), false],
    [join(packageRoot, "extensions", "enabled.ts"), true],
  ]);
});

test("auto-discovery loads direct files, extension folders, skills, prompts, and themes", async () => {
  const value = await fixture();
  await mkdir(join(value.agentDir, "extensions", "folder"), { recursive: true });
  await mkdir(join(value.agentDir, "skills", "portable"), { recursive: true });
  await mkdir(join(value.agentDir, "prompts"), { recursive: true });
  await mkdir(join(value.agentDir, "themes"), { recursive: true });
  await writeFile(join(value.agentDir, "extensions", "direct.ts"), "export default () => {};");
  await writeFile(join(value.agentDir, "extensions", "folder", "index.js"), "export default () => {};");
  await writeFile(join(value.agentDir, "extensions", "folder", "package.json"), JSON.stringify({ name: "folder", type: "module" }));
  await writeFile(join(value.agentDir, "skills", "portable", "SKILL.md"), "# Portable");
  await writeFile(join(value.agentDir, "prompts", "ask.md"), "Ask");
  await writeFile(join(value.agentDir, "themes", "plain.json"), "{}");
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(value.agentDir, "extensions", "direct.ts"),
    join(value.agentDir, "extensions", "folder", "index.js"),
  ]);
  assert.equal(result.skills.some((entry) => entry.path === join(value.agentDir, "skills", "portable", "SKILL.md")), true);
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(value.agentDir, "prompts", "ask.md")]);
  assert.deepEqual(result.themes.map((entry) => entry.path), [join(value.agentDir, "themes", "plain.json")]);
});

for (const directory of ["plugins", "extensions"]) test(`auto-discovered ${directory} honor authoritative legacy manifests`, async (context) => {
  const value = await fixture();
  context.after(async () => await rm(value.root, { recursive: true, force: true }));
  const packageRoot = join(value.agentDir, directory, "legacy");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "index.mjs"), "export default () => {};\n");
  await writeFile(join(packageRoot, "declared.mjs"), "export default () => {};\n");
  await writeFile(join(packageRoot, "review.md"), "Review");
  const manifest = {
    schemaVersion: 1,
    id: "legacy",
    name: "Legacy",
    contributions: { runtime: [{ path: "declared.mjs" }] },
  };
  const cases = [
    { manifest: { ...manifest, enabled: false }, runtime: [[join(packageRoot, "declared.mjs"), false]], prompts: [] },
    { manifest, runtime: [[join(packageRoot, "declared.mjs"), true]], prompts: [] },
    { manifest: { ...manifest, compatibility: { hostVersion: "<0.0.1" } }, runtime: [[join(packageRoot, "declared.mjs"), false]], prompts: [] },
    { manifest: { ...manifest, contributions: { prompts: [{ id: "review", path: "review.md" }] } }, runtime: [], prompts: [join(packageRoot, "review.md")] },
    { manifest: { ...manifest, integrity: { "declared.mjs": "0".repeat(64) } }, runtime: [], prompts: [] },
    { manifest: { ...manifest, schemaVersion: 99 }, runtime: [], prompts: [] },
  ];
  for (const example of cases) {
    await writeFile(join(packageRoot, "extension.json"), JSON.stringify(example.manifest));
    const result = await value.packages.resolve();
    assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled]), example.runtime);
    assert.deepEqual(result.prompts.map((entry) => entry.path), example.prompts);
  }
  await writeFile(join(packageRoot, "extension.json"), "{");
  assert.deepEqual((await value.packages.resolve()).extensions, []);
});

for (const directory of ["plugins", "extensions"]) test(`auto-discovered ${directory} preserve filters and companion resources`, async () => {
  const value = await fixture();
  const packageRoot = join(value.agentDir, directory, "companion");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await writeFile(join(packageRoot, "index.ts"), "export default () => {};\n");
  await writeFile(join(packageRoot, "prompts", "inspect.md"), "Inspect");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "companion",
    ohm: { [directory === "plugins" ? "entrypoints" : "extensions"]: ["index.ts"], prompts: ["prompts"] },
  }));

  const result = await value.packages.resolve();

  assert.deepEqual(result.extensions.map((entry) => entry.path), [join(packageRoot, "index.ts")]);
  assert.deepEqual(result.prompts.map((entry) => entry.path), [join(packageRoot, "prompts", "inspect.md")]);
  assert.equal(result.prompts[0]?.metadata.baseDir, packageRoot);
  const entrypoint = `${directory}/companion/index.ts`;
  for (const [rules, enabled] of [
    [[`!${entrypoint}`], false],
    [[`!${entrypoint}`, `+${entrypoint}`], true],
    [[`+${entrypoint}`, `-${entrypoint}`], false],
  ] satisfies Array<[string[], boolean]>) {
    value.settings.setLegacyPluginEntrypoints(rules);
    const filtered = await value.packages.resolve();
    assert.deepEqual(filtered.extensions, [{ ...result.extensions[0], enabled }]);
    assert.deepEqual(filtered.prompts, result.prompts);
  }
  value.settings.setLegacyPluginEntrypoints([]);
  value.settings.setPackages([packageRoot]);
  assert.deepEqual(await value.packages.resolve(), result);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "companion",
    ohm: { entrypoints: ["index.ts"], extensions: ["index.ts"] },
  }));
  await assert.rejects(value.packages.resolve(), /entrypoints.*ambiguous/iu);
  for (const entrypoints of [null, "index.ts", [null]]) {
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "companion", ohm: { entrypoints },
    }));
    await assert.rejects(value.packages.resolve(), /entrypoints.*array of strings/iu);
  }
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "companion", ohm: { prompts: ["prompts"] },
  }));
  assert.equal((await value.packages.resolve()).extensions.length, 0);
  await writeFile(join(packageRoot, "package.json"), '{"ohm":');
  await assert.rejects(value.packages.resolve(), SyntaxError);
});

test("an explicit extension root resolves each direct child factory", async () => {
  const value = await fixture();
  const root = join(value.root, "extension-root");
  await mkdir(join(root, "folder"), { recursive: true });
  await writeFile(join(root, "direct.ts"), "export default () => {};\n");
  await writeFile(join(root, "folder", "index.js"), "export default () => {};\n");

  const result = await value.packages.resolvePluginSources([root], { temporary: true });

  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(root, "direct.ts"),
    join(root, "folder", "index.js"),
  ]);
  assert.equal(result.extensions.every((entry) => entry.metadata.baseDir === root), true);
  for (const source of [root, join(root, "direct.ts")]) {
    assert.deepEqual((await value.packages.resolvePluginSources([{ source, autoload: false }])).extensions, []);
    assert.equal((await value.packages.resolvePluginSources([{ source, entrypoints: [] }])).extensions.every((entry) => !entry.enabled), true);
    assert.deepEqual((await value.packages.resolvePluginSources([{ source, entrypoints: ["direct.ts"] }])).extensions
      .filter((entry) => entry.enabled).map((entry) => entry.path), [join(root, "direct.ts")]);
  }
});

test("local lifecycle persists scope-relative sources without deleting user code", async () => {
  const value = await fixture();
  const extension = join(value.cwd, "extension.ts");
  await writeFile(extension, "export default () => {};");
  await value.packages.installAndPersist(extension, { local: true });
  await value.settings.flush();
  assert.deepEqual(value.settings.getProjectSettings().plugins, ["../extension.ts"]);
  assert.equal(value.packages.getInstalledPath("../extension.ts", "project"), extension);
  await value.packages.installAndPersist("./extension.ts", { local: true });
  assert.deepEqual(value.settings.getProjectSettings().plugins, ["../extension.ts"]);
  assert.equal(value.packages.getInstalledPath("../extension.ts", "project"), extension);
  const projectSource = value.packages.listConfiguredPackages().find((entry) => entry.scope === "project")!.source;
  assert.equal(await value.packages.removeAndPersist(projectSource, { local: true }), true);
  await value.packages.installAndPersist(extension, { local: true });
  assert.equal(await value.packages.removeAndPersist(extension, { local: true }), true);
  await value.packages.installAndPersist(extension);
  const userSource = value.packages.listConfiguredPackages().find((entry) => entry.scope === "user")!.source;
  assert.equal(await value.packages.removeAndPersist(userSource), true);
  await value.settings.flush();
  assert.deepEqual(value.settings.getProjectSettings().plugins, []);
  assert.deepEqual(value.settings.getGlobalSettings().plugins, []);
});

test("untrusted project packages cannot access project-managed storage", async () => {
  const value = await fixture();
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const packages = new DefaultPackageManager({ cwd: value.cwd, agentDir: value.agentDir, settingsManager: settings });
  assert.throws(() => packages.addSourceToSettings("npm:example", { local: true }), /not trusted/iu);
  await assert.rejects(packages.install("npm:example", { local: true }), /not trusted/iu);
});

test("Windows drive roots are classified as local package sources", async () => {
  const value = await fixture();
  for (const source of [String.raw`Q:\ohm-missing-package`, "Q:/ohm-missing-package"]) {
    await assert.rejects(
      value.packages.resolvePluginSources([source], { temporary: true }),
      (error) => {
        assert.match(String(error), /Path does not exist/iu);
        assert.doesNotMatch(String(error), /Unsupported package source/iu);
        return true;
      },
    );
  }
  await assert.rejects(
    value.packages.resolvePluginSources(["https://example.invalid/package"], { temporary: true }),
    /Unsupported package source/iu,
  );
});

test("untrusted resolution omits project resources while retaining user resources", async () => {
  const value = await fixture();
  const userExtension = join(value.agentDir, "plugins", "user.ts");
  const projectPlugin = join(value.cwd, ".ohm", "plugins", "project.ts");
  await mkdir(join(value.agentDir, "plugins"), { recursive: true });
  await mkdir(join(value.cwd, ".ohm", "plugins"), { recursive: true });
  await writeFile(userExtension, "export default () => {};");
  await writeFile(projectPlugin, "export default () => {};");
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  const packages = new DefaultPackageManager({ cwd: value.cwd, agentDir: value.agentDir, settingsManager: settings });
  const resolved = await packages.resolve();
  assert.deepEqual(resolved.extensions.map((entry) => entry.path), [userExtension]);
});

test("manifest globs and override order select explicit resources", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "globbed");
  await mkdir(join(packageRoot, "extensions", "nested"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "two.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "nested", "three.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "globbed",
    ohm: { extensions: ["extensions/**/*.ts", "!**/two.ts", "+extensions/two.ts", "-extensions/nested/three.ts"] },
  }));
  value.settings.setPackages([packageRoot]);
  await value.settings.flush();
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => entry.path), [
    join(packageRoot, "extensions", "one.ts"),
    join(packageRoot, "extensions", "two.ts"),
  ]);
});

test("autoload-disabled project filters reuse a configured user package as a delta", async () => {
  const value = await fixture();
  const packageRoot = join(value.root, "shared");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "extensions", "one.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "extensions", "two.ts"), "export default () => {};");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "shared" }));
  value.settings.setPackages([packageRoot]);
  value.settings.setProjectPackages([{ source: packageRoot, autoload: false, extensions: ["+extensions/two.ts"] }]);
  await value.settings.flush();
  const result = await value.packages.resolve();
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.enabled, entry.metadata.scope]), [
    [join(packageRoot, "extensions", "two.ts"), true, "project"],
    [join(packageRoot, "extensions", "one.ts"), true, "user"],
  ]);
});

test("project skills from other harnesses are not discovered automatically", async () => {
  const value = await fixture();
  const repository = join(value.root, "repository");
  const cwd = join(repository, "packages", "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(repository, ".agents", "skills", "root"), { recursive: true });
  await mkdir(join(repository, "packages", ".agents", "skills", "middle"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(repository, ".agents", "skills", "root", "SKILL.md"), "# Root");
  await writeFile(join(repository, "packages", ".agents", "skills", "middle", "SKILL.md"), "# Middle");
  const packages = new DefaultPackageManager({ cwd, agentDir: value.agentDir, settingsManager: value.settings });
  const result = await packages.resolve();
  assert.equal(result.skills.some((entry) => entry.path.endsWith(join("root", "SKILL.md"))), false);
  assert.equal(result.skills.some((entry) => entry.path.endsWith(join("middle", "SKILL.md"))), false);
});
