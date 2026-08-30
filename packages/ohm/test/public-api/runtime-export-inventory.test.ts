import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core/json.js";

const INVENTORY_SCHEMA = Type.Object({
  schemaVersion: Type.Number(),
  evidenceLimits: Type.Array(Type.Object({
    scope: Type.String(),
    apis: Type.Array(Type.String()),
    reason: Type.String(),
  })),
  packages: Type.Array(Type.Object({
    name: Type.String(),
    manifest: Type.String(),
    entries: Type.Array(Type.Object({
      subpath: Type.String(),
      kind: Type.Union([
        Type.Literal("library"),
        Type.Literal("wildcard-library"),
        Type.Literal("executable"),
        Type.Literal("metadata"),
      ]),
      tests: Type.Array(Type.String()),
    })),
  })),
});

const NAMED_EXPORT_INVENTORY_SCHEMA = Type.Object({
  schemaVersion: Type.Number(),
  entries: Type.Record(Type.String(), Type.Object({
    runtime: Type.Array(Type.String()),
    typeOnly: Type.Array(Type.String()),
  })),
});

type Inventory = Static<typeof INVENTORY_SCHEMA>;
type NamedExportInventory = Static<typeof NAMED_EXPORT_INVENTORY_SCHEMA>;

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const inventoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../release/public-runtime-export-inventory.json");
const namedInventoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../release/public-named-export-inventory.json");

async function json(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isJsonObject(parsed)) throw new TypeError(`${path} must contain a JSON object`);
  return parsed;
}

function inventory(value: JsonObject): Inventory {
  if (!Check(INVENTORY_SCHEMA, value)) throw new TypeError("Runtime export inventory is invalid");
  return value;
}

function namedExportInventory(value: JsonObject): NamedExportInventory {
  if (!Check(NAMED_EXPORT_INVENTORY_SCHEMA, value)) throw new TypeError("Named export inventory is invalid");
  return value;
}

function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

async function sourceModules(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await sourceModules(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) output.push(path);
  }
  return output.sort();
}

function regularExpressionLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function assertTestBehavior(path: string, behavior: string): Promise<void> {
  const source = await readFile(path, "utf8");
  const title = regularExpressionLiteral(behavior);
  assert.match(
    source,
    new RegExp(`(?:^|\\n)\\s*(?:test|it|describe)(?:\\.(?:only|skip|todo))?\\s*\\(\\s*["'\\x60]${title}["'\\x60]`, "u"),
    `${path} does not declare the mapped test behavior ${JSON.stringify(behavior)}`,
  );
}

test("runtime export inventory exactly maps every declared package entry to an evidence file", async () => {
  const runtimeInventory = inventory(await json(inventoryPath));
  assert.equal(runtimeInventory.schemaVersion, 1);
  assert.equal(runtimeInventory.evidenceLimits.length > 0, true);
  for (const limit of runtimeInventory.evidenceLimits) {
    assert.match(limit.scope, /[A-Za-z]/u);
    assert.equal(limit.apis.length > 0, true);
    assert.match(limit.reason, /[A-Za-z]/u);
  }
  assert.deepEqual(runtimeInventory.packages.map((entry) => entry.name).sort(), [
    "@ohm/kernel",
    "@ohm/models",
    "@ohm/terminal",
    "ohm",
  ]);

  for (const packageEntry of runtimeInventory.packages) {
    const manifest = await json(join(repository, packageEntry.manifest));
    assert.equal(manifest.name, packageEntry.name);
    const declared = manifest.exports === undefined
      ? ["."]
      : Object.entries(jsonObject(manifest.exports, `${packageEntry.name} exports`))
          .filter(([, target]) => target !== null)
          .map(([subpath]) => subpath);
    const inventoried = packageEntry.entries.map((entry) => entry.subpath);
    assert.deepEqual(inventoried, declared, `${packageEntry.name} export inventory drifted from package.json`);
    assert.equal(new Set(inventoried).size, inventoried.length, `${packageEntry.name} has duplicate inventory entries`);

    for (const entry of packageEntry.entries) {
      assert.equal(entry.tests.length > 0, true, `${packageEntry.name}${entry.subpath} has no semantic test`);
      for (const mapping of entry.tests) {
        const separator = mapping.indexOf("#");
        assert.notEqual(separator, -1, `${mapping} must identify a test behavior after #`);
        const path = join(repository, mapping.slice(0, separator));
        await access(path);
        const behavior = mapping.slice(separator + 1);
        assert.match(behavior, /[A-Za-z]/u);
        await assertTestBehavior(path, behavior);
      }
    }
  }
});

test("wildcard AI entry points execute as source modules and expose initialized values", async () => {
  for (const directory of [
    join(repository, "packages/models/src/providers"),
    join(repository, "packages/models/src/api"),
  ]) {
    const modules = await sourceModules(directory);
    assert.equal(modules.length > 0, true);
    let codeBearing = 0;
    for (const path of modules) {
      const module = await import(pathToFileURL(path).href);
      const values = Object.values(module);
      if (values.length === 0) continue;
      codeBearing += 1;
      assert.equal(values.every((value) => value !== undefined), true, path);
    }
    assert.equal(codeBearing > 0, true, `${directory} has no executable wildcard entry points`);
  }
});

test("named export baseline structurally covers every code-bearing ohm entry point", async () => {
  const exportInventory = namedExportInventory(await json(namedInventoryPath));
  const manifest = await json(join(repository, "packages/ohm/package.json"));
  const codeEntries = Object.entries(jsonObject(manifest.exports, "ohm exports"))
    .filter(([, value]) => isJsonObject(value) && Object.hasOwn(value, "types"))
    .map(([subpath]) => subpath === "." ? "." : subpath.slice(2));
  assert.equal(exportInventory.schemaVersion, 1);
  assert.deepEqual(Object.keys(exportInventory.entries), codeEntries);
  for (const [entry, exports] of Object.entries(exportInventory.entries)) {
    assert.equal(exports.runtime.length > 0, true, `${entry} has no runtime bindings`);
    assert.deepEqual(exports.runtime, [...new Set(exports.runtime)].sort(), `${entry} runtime bindings are not canonical`);
    assert.deepEqual(exports.typeOnly, [...new Set(exports.typeOnly)].sort(), `${entry} type-only bindings are not canonical`);
    assert.equal(exports.runtime.some((name) => exports.typeOnly.includes(name)), false, `${entry} classifies a binding twice`);
  }
});

test("SDK documentation names every public SDK binding", async () => {
  const exportInventory = namedExportInventory(await json(namedInventoryPath));
  const sdk = exportInventory.entries.sdk;
  assert.notEqual(sdk, undefined);
  if (sdk === undefined) throw new Error("SDK named export inventory is missing");
  const documentation = await readFile(join(repository, "packages/ohm/docs/sdk.md"), "utf8");
  for (const name of [...sdk.runtime, ...sdk.typeOnly]) {
    assert.equal(documentation.includes(name), true, `docs/sdk.md does not name ${name}`);
  }
});
