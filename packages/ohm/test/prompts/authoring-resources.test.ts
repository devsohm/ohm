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

const examples = [
  "starter",
  "provider-override",
  "raw-editor-ui",
  "session-jsonl",
  "session-control",
  "dynamic-package",
  "provider-hooks",
  "provider-catalog",
  "runtime-catalog",
  "session-lifecycle",
  "project-trust",
] as const;

test("bundled authoring resources describe the direct package contract", async () => {
  const resources = bundledAuthoringResources();
  const skillDirectory = dirname(resources.authoringSkill);
  const referenceDirectory = resolve(skillDirectory, "references");
  const configurationReference = resolve(referenceDirectory, "configuration.md");
  const extensionsReference = resolve(referenceDirectory, "extensions.md");
  const coreReference = resolve(referenceDirectory, "core-tui-providers.md");
  const projectReference = resolve(referenceDirectory, "project-development.md");
  const testingReference = resolve(referenceDirectory, "testing-release.md");
  const starterRoot = resolve(skillDirectory, "../../../examples/starter");
  await Promise.all([
    access(resources.documentationRoot),
    access(resources.examplesRoot),
    access(resources.skillRoot),
    access(resources.authoringSkill),
    access(resolve(skillDirectory, "../../../docs/extensions.md")),
    access(resolve(skillDirectory, "../../../examples/README.md")),
    access(resolve(skillDirectory, "../../../docs/extension-api.md")),
    access(resolve(skillDirectory, "../../../docs/extension-events.md")),
    access(resolve(skillDirectory, "../../../docs/extension-capabilities.md")),
    access(resolve(skillDirectory, "../../../docs/modes.md")),
    access(resolve(skillDirectory, "../../../docs/rpc.md")),
    access(resolve(skillDirectory, "../../../docs/packages.md")),
    access(resolve(skillDirectory, "../../../docs/tui.md")),
    ...examples.map(async (name) => await access(resolve(skillDirectory, `../../../examples/${name}`))),
    access(configurationReference),
    access(extensionsReference),
    access(coreReference),
    access(projectReference),
    access(testingReference),
    access(resolve(starterRoot, "checks/runtime.test.mjs")),
  ]);
  assert.equal("promptRoot" in resources, false);
  assert.equal("authoringPrompt" in resources, false);

  const skills = await discoverSkills([{ path: resources.skillRoot, scope: "user", trusted: true }]);
  assert.deepEqual(skills.map((entry) => entry.name), ["ohm-dev"]);
  const skill = skills.find((entry) => entry.name === "ohm-dev");
  assert.ok(skill);
  const loaded = await loadSkill(skill);
  assert.equal(loaded.truncated, false);
  assert.match(loaded.instructions, /references\/configuration\.md/u);
  assert.match(loaded.instructions, /references\/extensions\.md/u);
  assert.match(loaded.instructions, /references\/core-tui-providers\.md/u);
  assert.match(loaded.instructions, /references\/project-development\.md/u);
  assert.match(loaded.instructions, /references\/testing-release\.md/u);
  assert.match(loaded.instructions, /ask the user to run `\/refresh`/iu);
  assert.match(loaded.instructions, /Do not invoke or simulate the slash command yourself/iu);
  assert.match(loaded.instructions, /Use an extension for optional, project-specific, or integration behavior/iu);
  assert.match(loaded.instructions, /acceptance criteria, target hosts/iu);
  assert.match(loaded.instructions, /Change ohm source only for a product-wide invariant/iu);
  assert.match(loaded.instructions, /`\/refresh` does not load changed ohm source or rebuilt JavaScript modules/iu);
  assert.match(loaded.instructions, /Never restart the process automatically/iu);

  const configuration = await readFile(configurationReference, "utf8");
  assert.match(configuration, /ohm config edit/u);
  assert.match(configuration, /ohm config validate/u);
  assert.match(configuration, /`\/refresh` is the normal path/iu);
  assert.match(configuration, /global `AGENTS\.md` is deliberately empty/iu);

  const extensions = await readFile(extensionsReference, "utf8");
  assert.match(extensions, /docs\/extensions\.md/u);
  assert.match(extensions, /examples\/README\.md/u);
  assert.match(extensions, /docs\/extension-api\.md/u);
  assert.match(extensions, /docs\/extension-events\.md/u);
  assert.match(extensions, /docs\/extension-capabilities\.md/u);
  assert.match(extensions, /docs\/modes\.md/u);
  assert.match(extensions, /docs\/rpc\.md/u);
  assert.match(extensions, /examples\/starter/u);
  assert.match(extensions, /examples\/provider-override/u);
  assert.match(extensions, /examples\/raw-editor-ui/u);
  assert.match(extensions, /examples\/session-jsonl/u);
  assert.match(extensions, /examples\/session-control/u);
  assert.match(extensions, /examples\/dynamic-package/u);
  assert.match(extensions, /examples\/provider-hooks/u);
  assert.match(extensions, /examples\/provider-catalog/u);
  assert.match(extensions, /examples\/runtime-catalog/u);
  assert.match(extensions, /examples\/session-lifecycle/u);
  assert.match(extensions, /examples\/project-trust/u);
  assert.match(extensions, /package\.json/iu);
  assert.doesNotMatch(extensions, /extension\.json/u);
  assert.match(extensions, /onDispose/u);
  assert.match(extensions, /API becomes stale/iu);
  assert.match(extensions, /fixed executable and argv array/iu);
  assert.match(extensions, /failed activation commits nothing/iu);
  assert.match(extensions, /In a source checkout, inspect the nearest central conformance test/iu);
  assert.match(extensions, /Installed artifacts do not ship host source or central tests/iu);
  assert.match(extensions, /shared footer status row/iu);
  assert.match(extensions, /target hosts and exact behavior when `context\.hasUI` is false/iu);
  assert.match(extensions, /`ohm\.exec` for one bounded request/iu);
  assert.match(extensions, /`ohm\.processes\.spawn` only when work must continue/iu);
  assert.match(extensions, /Host registrations and `ohm\.processes` workers are generation-owned/iu);
  assert.match(extensions, /reports accept real local package directories, not `\.tgz` files/iu);
  assert.match(extensions, /valid-candidate repeat-activation smoke/iu);
  assert.match(extensions, /exact installed package/iu);
  assert.match(extensions, /ohm --extension PATH/u);
  assert.doesNotMatch(extensions, /ohm --package/u);
  assert.match(extensions, /There is no dashboard to copy/iu);
  assert.match(extensions, /context\.sessionManager/u);
  assert.match(extensions, /never reopen the active JSONL session file/iu);

  const core = await readFile(coreReference, "utf8");
  assert.match(core, /packages\/ohm\/src\/extensions\/direct\.ts/u);
  assert.match(core, /packages\/ohm\/src\/extensions\/runtime\.ts/u);
  assert.match(core, /packages\/ohm\/src\/extensions\/config-store\.ts/u);
  assert.match(core, /packages\/ohm\/src\/core\/package-manager\.ts/u);
  assert.match(core, /packages\/ohm\/src\/core\/portable-plugin\.ts/u);
  assert.match(core, /packages\/ohm\/src\/extensions\/project-packages\.ts/u);
  assert.match(core, /packages\/ohm\/src\/core\/resource-loader\.ts/u);
  assert.match(core, /packages\/ohm\/src\/tui\/direct-ui\.ts/u);
  assert.match(core, /packages\/ohm\/src\/interfaces\/rpc-extension-ui\.ts/u);
  assert.match(core, /packages\/ohm\/src\/cli\/runtime\.ts/u);
  assert.match(core, /packages\/ohm\/src\/sdk\/index\.ts/u);
  assert.match(core, /packages\/ohm\/src\/service\/agent-session\.ts/u);
  assert.match(core, /packages\/ohm\/test\/extensions\//u);
  assert.match(core, /Route every tool execution through the coordinator/iu);
  assert.match(core, /one owner for the complete mutable terminal surface/iu);
  assert.match(core, /provider-authorized public reasoning/iu);
  assert.match(core, /`\/refresh` reloads resources, not changed source modules/iu);

  const project = await readFile(projectReference, "utf8");
  assert.match(project, /never guess a package manager/iu);
  assert.match(project, /captured process/iu);
  assert.match(project, /guaranteed cleanup/iu);
  assert.match(project, /explicitly places them in scope/iu);

  const testing = await readFile(testingReference, "utf8");
  assert.match(testing, /npm run check/u);
  assert.match(testing, /npm run benchmark:release-offline/u);
  assert.match(testing, /explicit user authorization/iu);

  const packageDocs = await readFile(resolve(resources.documentationRoot, "packages.md"), "utf8");
  assert.match(packageDocs, /ohm install .*npm:file:\/\/\/absolute\/path\/my-extension-1\.2\.3\.tgz/u);
  assert.match(packageDocs, /do not accept a `\.tgz` archive as `PACKAGE`/iu);
  assert.match(packageDocs, /valid-candidate repeat activation/iu);
  assert.match(packageDocs, /checks\/runtime\.test\.mjs/iu);
  assert.match(packageDocs, /schema 1 lock.*migrates `extension\.json` packages/isu);
  const extensionDocs = await readFile(resolve(resources.documentationRoot, "extensions.md"), "utf8");
  assert.match(extensionDocs, /## One package, one runtime API/iu);
  assert.match(extensionDocs, /Every factory receives the same generation-scoped `ExtensionAPI`/iu);
  assert.match(extensionDocs, /same package resolver, trust boundary, refresh transaction, and extension runtime/iu);
  assert.match(extensionDocs, /do not create another activation API, process, or plugin store/iu);
  assert.match(extensionDocs, /content.*array of text or image blocks/isu);
  assert.match(extensionDocs, /reverse (?:registration )?order/iu);
  assert.match(extensionDocs, /shared footer status row/iu);
  const extensionEvents = await readFile(resolve(resources.documentationRoot, "extension-events.md"), "utf8");
  for (const [index, row] of extensionEvents.split("\n").entries()) {
    if (!row.startsWith("|")) continue;
    assert.equal(
      row.match(/(?<!\\)\|/gu)?.length,
      4,
      `extension-events.md:${index + 1} must retain three Markdown table columns`,
    );
  }

  const cookbook = await readFile(resolve(resources.documentationRoot, "cookbook.md"), "utf8");
  assert.match(cookbook, /manual baseline from an ohm source checkout/iu);
  assert.match(cookbook, /do not assume a `packages\/ohm` directory exists/iu);

  const starterManifest: JsonValue = JSON.parse(await readFile(resolve(starterRoot, "package.json"), "utf8"));
  if (!Value.Check(STARTER_MANIFEST_VALUE, starterManifest)) assert.fail("starter package manifest is invalid");
  assert.equal(starterManifest.private, true);
  assert.equal(starterManifest.peerDependencies?.ohm, ">=0.1.0 <0.2.0");
  assert.equal(starterManifest.scripts?.test, "tsc --noEmit -p tsconfig.json && node --test checks/runtime.test.mjs");
  await access(resolve(starterRoot, "extensions/index.ts"));
  await access(resolve(starterRoot, "tsconfig.json"));
  const starterTest = await readFile(resolve(starterRoot, "checks/runtime.test.mjs"), "utf8");
  assert.doesNotMatch(starterTest, /(?:^|["'])\.\.\/\.\.\/src\//mu);
  assert.doesNotMatch(starterTest, /(?:^|["'])\.\.\/\.\.\/dist\//mu);
});
