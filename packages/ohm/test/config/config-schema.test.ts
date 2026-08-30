import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { IsSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { InMemorySettingsStorage, SETTINGS_KEYS, SettingsManager } from "../../src/core/settings-manager.js";
import { CONFIG_SCHEMA_URI, hasNullValue, PORTABLE_CONFIG_SCAFFOLD } from "../helpers/config-scaffold.js";

const CONFIG_SCHEMA_METADATA_VALUE = Type.Object({
  $id: Type.String(),
  $schema: Type.String(),
  properties: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: true });
const EFFECTIVE_SETTINGS_VALUE = Type.Object({
  extensionOwned: Type.Object({ enabled: Type.Boolean() }),
  __proto__: Type.Object({ global: Type.Boolean(), project: Type.Boolean() }),
  theme: Type.String(),
}, { additionalProperties: true });

test("the versioned config schema accepts the portable installed scaffold and describes every core setting", async () => {
  const schema: unknown = JSON.parse(
    await readFile(new URL("../../resources/schemas/config-v1.json", import.meta.url), "utf8"),
  );
  const template: unknown = JSON.parse(
    await readFile(new URL("../../resources/config.example.json", import.meta.url), "utf8"),
  );
  if (!IsSchema(schema) || !Value.Check(CONFIG_SCHEMA_METADATA_VALUE, schema)) {
    assert.fail("The bundled config schema must be a JSON schema with the expected metadata");
  }

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONFIG_SCHEMA_URI);
  assert.deepEqual(template, PORTABLE_CONFIG_SCAFFOLD);
  assert.equal(hasNullValue(template), false);
  assert.deepEqual(
    Object.keys(schema.properties).filter((key) => key !== "$schema"),
    SETTINGS_KEYS,
  );
  assert.equal(Value.Check(schema, template), true);
  assert.equal(Value.Check(schema, {
    $schema: CONFIG_SCHEMA_URI,
    defaultModel: null,
    compaction: { enabled: null, recentTokens: null },
    retry: { provider: { timeoutMs: null } },
    tools: null,
    keybindings: { "app.exit": null },
  }), true);
  assert.equal(Value.Check(schema, { ...PORTABLE_CONFIG_SCAFFOLD, misspelledCoreSetting: true }), false);
  assert.equal(Value.Check(schema, { ...PORTABLE_CONFIG_SCAFFOLD, compaction: { triggerPercent: 49 } }), false);
  assert.equal(Value.Check(schema, { ...PORTABLE_CONFIG_SCAFFOLD, compaction: { recentTokens: 0 } }), false);
  assert.equal(Value.Check(schema, { ...PORTABLE_CONFIG_SCAFFOLD, keybindings: { "app.exit": "" } }), false);
  assert.equal(Value.Check(schema, { ...PORTABLE_CONFIG_SCAFFOLD, enabledModels: ["alpha/\0one"] }), false);
  assert.equal(Value.Check(schema, {
    ...PORTABLE_CONFIG_SCAFFOLD,
    enabledModels: Array.from({ length: 1_025 }, (_, index) => `alpha/${index}`),
  }), false);
  assert.equal(Value.Check(schema, {
    ...PORTABLE_CONFIG_SCAFFOLD,
    modelThinkingLevels: { "alpha/\u007fone": "high" },
  }), false);
});

test("schema metadata stays out of effective settings while unknown extension fields remain compatible", () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({
    $schema: CONFIG_SCHEMA_URI,
    extensionOwned: { enabled: true },
    ["__proto__"]: { global: true },
    theme: "signal",
  }));
  storage.withLock("project", () => JSON.stringify({
    ["__proto__"]: { project: true },
  }));
  const manager = SettingsManager.fromStorage(storage);
  const effective = manager.getSettings();
  if (!Value.Check(EFFECTIVE_SETTINGS_VALUE, effective)) {
    assert.fail("Effective settings must retain validated extension-owned fields");
  }

  assert.equal("$schema" in effective, false);
  assert.deepEqual(effective.extensionOwned, { enabled: true });
  assert.equal(Object.hasOwn(effective, "__proto__"), true);
  assert.deepEqual(effective.__proto__, { global: true, project: true });
  assert.equal(Object.getPrototypeOf(effective), Object.prototype);
  assert.equal(effective.theme, "signal");
});
