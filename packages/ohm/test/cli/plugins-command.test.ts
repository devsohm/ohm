import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { parseArgs } from "../../src/cli/args.js";
import { preparePluginPreview } from "../../src/cli/plugin-author.js";
import { pluginResourceOptions } from "../../src/cli/plugin-flags.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { isJsonObject, type JsonValue } from "../../src/core/json.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

async function plugin(directory: string, name: string): Promise<void> {
  await Promise.all(["skills", "prompts", "themes"].map(async (kind) => await mkdir(join(directory, kind), { recursive: true })));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name, type: "module", ohm: { extensions: ["index.mjs"], skills: ["skills"], prompts: ["prompts"], themes: ["themes"] },
  }));
  await writeFile(join(directory, "index.mjs"), `
    import { PluginConfigConflictError } from "ohm/plugins";
    export default function activate(ohm) {
      if (!PluginConfigConflictError) throw new Error("Missing public plugin contract");
      ohm.registerCommand(${JSON.stringify(name)}, { async handler() {} });
    }
  `);
  await writeFile(join(directory, "skills", "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nSelected skill.`);
  await writeFile(join(directory, "prompts", `${name}.md`), `---\ndescription: ${name} prompt\n---\nSelected prompt.`);
  await writeFile(join(directory, "themes", `${name}.json`), JSON.stringify({ schemaVersion: 1, name, styles: { accent: { foreground: 81 } } }));
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ohm-plugins-command-"));
  const agentDirectory = join(root, "agent");
  const workspace = join(root, "workspace");
  const selected = join(root, "selected");
  await mkdir(workspace);
  await mkdir(agentDirectory);
  await plugin(selected, "selected-plugin");
  await plugin(join(root, "unrelated"), "unrelated-plugin");
  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({ packages: [join(root, "unrelated")] }));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, workspace, agentDirectory, selected };
}

test("plugin resource selection stays aligned through preview, refresh, and RPC", async (t) => {
  const value = await fixture(t);
  const preview = await preparePluginPreview(value.selected, value.workspace);
  const args = parseArgs(preview.argv);
  const runtime = await loadRuntime({
    workspace: value.workspace,
    agentDirectory: value.agentDirectory,
    credentialStore: new InMemoryCredentialStore(),
    ephemeral: true,
    offline: true,
    projectTrusted: false,
    pluginRuntime: true,
    pluginPaths: args.pluginPaths,
    ...pluginResourceOptions(args),
  });
  try {
    const verify = () => {
      assert.deepEqual(runtime.runtimePlugins.commands().map((command) => command.name), ["selected-plugin"]);
      assert.deepEqual(runtime.resourceLoader.getSkills().skills.map((skill) => skill.name), ["selected-plugin"]);
      assert.deepEqual(runtime.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name), ["selected-plugin"]);
      assert.deepEqual(runtime.resourceLoader.getThemes().themes.map((theme) => theme.name), ["selected-plugin"]);
    };
    verify();
    await runtime.refresh();
    verify();
  } finally {
    await runtime.close();
  }
  for (const { flags, expected } of [
    { flags: ["--no-plugins"], expected: [] },
    { flags: ["--no-plugins", "--plugin", value.selected], expected: [
      { name: "selected-plugin", source: "extension" },
      { name: "selected-plugin", source: "prompt" },
      { name: "skill:selected-plugin", source: "skill" },
    ] },
    { flags: ["--no-plugin-code"], expected: [
      { name: "unrelated-plugin", source: "prompt" },
      { name: "skill:unrelated-plugin", source: "skill" },
    ] },
    { flags: ["--no-plugins", "--plugin", value.selected, "--no-skills", "--no-prompt-templates", "--no-themes"],
      expected: [{ name: "selected-plugin", source: "extension" }] },
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/bin/ohm.ts"),
      "--mode", "rpc", "--offline", "--workspace", value.workspace, "--no-approve", "--no-session", ...flags], {
      cwd: resolve("."), env: { ...process.env, OHM_HOME: value.agentDirectory }, encoding: "utf8", timeout: 15_000,
      input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const response: JsonValue = JSON.parse(result.stdout);
    assert.ok(isJsonObject(response) && response.success === true && isJsonObject(response.data));
    assert.ok(Array.isArray(response.data.commands));
    const commands = response.data.commands.map((command) => {
      assert.ok(isJsonObject(command));
      return { name: command.name, source: command.source };
    });
    assert.deepEqual(flags[0] === "--no-plugin-code"
      ? commands.filter((command) => command.name === "unrelated-plugin" || command.name === "skill:unrelated-plugin")
      : commands, expected, flags.join(" "));
  }
});

test("individual suppression wins over no-plugins independent of flag order", () => {
  const codeOnly = pluginResourceOptions(parseArgs(["--no-plugin-code"]));
  assert.equal(codeOnly.pluginCode, false);
  assert.equal(codeOnly.skills, true);
  assert.equal(codeOnly.promptTemplates, true);
  assert.equal(codeOnly.themes, true);
  for (const argv of [
    ["--no-plugins", "--no-skills", "--no-prompt-templates", "--no-themes"],
    ["--no-themes", "--no-prompt-templates", "--no-skills", "--no-plugins"],
  ]) {
    assert.deepEqual(pluginResourceOptions(parseArgs(argv)), {
      pluginCode: false, skills: false, promptTemplates: false, themes: false,
      explicitPluginResources: { skills: false, prompts: false, themes: false },
    });
  }
});

test("plugins CLI selects the same package state and suppresses unrelated discovery", async (t) => {
  const value = await fixture(t);
  const cli = (argv: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/bin/ohm.ts"), ...argv,
      "--json", "--offline", "--workspace", value.workspace, "--no-approve", "--no-plugins"], {
      cwd: resolve("."), env: { ...process.env, OHM_HOME: value.agentDirectory }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  assert.doesNotMatch(cli(["plugins", "commands"]), /unrelated-plugin/u);
  assert.match(cli(["plugins", "commands", "--plugin", value.selected]), /selected-plugin/u);
  const prompts = cli(["plugins", "prompts", "--plugin", value.selected]);
  assert.match(prompts, /selected-plugin/u);
  assert.doesNotMatch(prompts, /unrelated-plugin/u);
  cli(["plugins", "install", value.selected]);
  assert.match(cli(["plugins", "list"]), /selected/u);
  cli(["plugins", "remove", value.selected]);
  assert.doesNotMatch(cli(["plugins", "list"]), /selected/u);
  assert.match(await readFile(join(value.selected, "package.json"), "utf8"), /selected-plugin/u);
});
