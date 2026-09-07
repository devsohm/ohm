import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { discoverSkills, loadSkill } from "../../src/context/skills.js";
import type { JsonValue } from "../../src/core/json.js";
import { bundledAuthoringResources } from "../../src/prompts/resources.js";

const STARTER_MANIFEST_VALUE = Type.Object({
  private: Type.Boolean(),
  peerDependencies: Type.Object({ ohm: Type.String() }, { additionalProperties: true }),
  scripts: Type.Object({ test: Type.String() }, { additionalProperties: true }),
}, { additionalProperties: true });

test("bundled authoring skill loads its references and preserves authority boundaries", async () => {
  const resources = bundledAuthoringResources();
  for (const path of Object.values(resources)) await access(path);
  assert.equal("promptRoot" in resources, false);
  assert.equal("authoringPrompt" in resources, false);

  const skills = await discoverSkills([{ path: resources.skillRoot, scope: "user", trusted: true }]);
  assert.deepEqual(skills.map((entry) => entry.name), ["ohm-dev"]);
  const skill = skills[0];
  assert.ok(skill);
  const loaded = await loadSkill(skill);
  assert.equal(loaded.truncated, false);

  const references = [...loaded.instructions.matchAll(/\]\((references\/[^)]+)\)/gu)].map((match) => match[1]!);
  assert.deepEqual(references, [
    "references/configuration.md",
    "references/plugins.md",
    "references/core-tui-providers.md",
    "references/project-development.md",
    "references/testing-release.md",
  ]);
  const contents = new Map<string, string>();
  for (const reference of references) {
    const path = resolve(dirname(resources.authoringSkill), reference);
    const content = await readFile(path, "utf8");
    contents.set(reference, content);
    // Check the links authors actually follow instead of snapshotting each sentence.
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const target = match[1]!;
      if (/^[a-z][a-z\d+.-]*:/iu.test(target)) continue;
      await access(resolve(dirname(path), target));
    }
  }

  for (const rule of [
    /ask the user to run `\/refresh`/iu,
    /Do not invoke or simulate the slash command yourself/iu,
    /Use a plugin for optional, project-specific, or integration behavior/iu,
    /Change ohm source only for a product-wide invariant/iu,
    /`\/refresh` does not load changed ohm source or rebuilt JavaScript modules/iu,
    /Never restart the process automatically/iu,
  ]) assert.match(loaded.instructions, rule);
  const plugins = contents.get("references/plugins.md")!;
  assert.match(plugins, /failed activation commits nothing/iu);
  assert.match(plugins, /API becomes stale/iu);
  assert.match(plugins, /never reopen the active session file or parse it as text/iu);
  assert.doesNotMatch(plugins, /extension\.json|ohm --package/u);
  const core = contents.get("references/core-tui-providers.md")!;
  assert.match(core, /Route every tool execution through the coordinator/iu);
  assert.match(core, /one owner for the complete mutable terminal surface/iu);
  assert.match(core, /provider-authorized public reasoning/iu);
  assert.match(contents.get("references/project-development.md")!, /explicitly places them in scope/iu);
  const testing = contents.get("references/testing-release.md")!;
  assert.match(testing, /Offline mode does not sandbox plugin or tool code/iu);
  assert.match(testing, /explicit user authorization/iu);
});

test("plugin event documentation retains valid table columns", async () => {
  const events = await readFile(resolve(bundledAuthoringResources().documentationRoot, "plugin-events.md"), "utf8");
  for (const [index, row] of events.split("\n").entries()) {
    if (!row.startsWith("|")) continue;
    assert.equal(
      row.match(/(?<!\\)\|/gu)?.length,
      4,
      `plugin-events.md:${index + 1} must retain three Markdown table columns`,
    );
  }
});

test("the starter has a runnable public-API-only author check", async () => {
  const starterRoot = resolve(bundledAuthoringResources().examplesRoot, "starter");
  const manifest: JsonValue = JSON.parse(await readFile(resolve(starterRoot, "package.json"), "utf8"));
  if (!Value.Check(STARTER_MANIFEST_VALUE, manifest)) assert.fail("starter package manifest is invalid");
  assert.equal(manifest.private, true);
  assert.equal(manifest.peerDependencies.ohm, ">=0.2.0 <0.3.0");
  assert.equal(manifest.scripts.test, "tsc --noEmit -p tsconfig.json && node --test checks/runtime.test.mjs");
  await access(resolve(starterRoot, "src/index.ts"));
  await access(resolve(starterRoot, "tsconfig.json"));
  const checks = await readFile(resolve(starterRoot, "checks/runtime.test.mjs"), "utf8");
  assert.doesNotMatch(checks, /(?:^|["'])\.\.\/\.\.\/(?:src|dist)\//mu);
});
