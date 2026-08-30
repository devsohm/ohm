import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const PACKAGE_MANIFEST_VALUE = Type.Object({
  ohm: Type.Optional(Type.Object({ extensions: Type.Optional(Type.Array(Type.String())) })),
});
const CAPABILITY_MATRIX_VALUE = Type.Object({
  capabilities: Type.Array(Type.Object({ examples: Type.Array(Type.String()) })),
});
const ERROR_CODE_VALUE = Type.Object({ code: Type.Optional(Type.String()) });

function parseJson<Schema extends TSchema>(schema: Schema, source: string): Static<Schema> {
  const value: unknown = JSON.parse(source);
  if (!Value.Check(schema, value)) throw new Error("Catalog JSON does not match its test contract");
  return value;
}

function errorCode<ValueType>(value: ValueType): string | undefined {
  return Value.Check(ERROR_CODE_VALUE, value) ? value.code : undefined;
}

const TIERS = new Set(["starter", "recipe", "example", "contract"]);
const HOSTS = new Set(["tui", "print", "json", "rpc", "serve", "sdk"]);
const EXTERNAL_ACCESS = new Set([
  "filesystem-read",
  "filesystem-write",
  "process",
  "network",
  "credentials",
  "terminal-control",
]);
const VERIFY = new Set(["package test", "central conformance"]);

function codeValue(value: string): string {
  assert.match(value, /^`[^`]+`$/u);
  return value.slice(1, -1);
}

test("the examples catalog owns every installable package exactly once", async () => {
  const examplesRoot = resolve("examples");
  const source = await readFile(resolve(examplesRoot, "README.md"), "utf8");
  const rows = source.split("\n").filter((line) => line.startsWith("| ["));
  const catalog = new Map<string, { hosts: string[]; access: string[] }>();

  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 6, `invalid catalog row: ${row}`);
    const link = /^\[([a-z0-9-]+)\]\(\.\/([a-z0-9-]+)\/\)$/u.exec(cells[0]!);
    assert.ok(link, `invalid example link: ${cells[0]}`);
    assert.equal(link[1], link[2]);
    const name = link[1]!;
    assert.equal(catalog.has(name), false, `${name} appears more than once`);
    assert.ok(cells[1]!.length > 0, `${name} has no outcome`);
    assert.equal(TIERS.has(codeValue(cells[2]!)), true, `${name} has an invalid tier`);
    const hosts = codeValue(cells[3]!) === "all" ? [...HOSTS] : codeValue(cells[3]!).split(", ");
    assert.equal(hosts.length > 0 && hosts.every((host) => HOSTS.has(host)), true, `${name} has invalid hosts`);
    const accessValue = codeValue(cells[4]!);
    const externalAccess = accessValue === "none" ? [] : accessValue.split(", ");
    assert.equal(
      externalAccess.every((entry) => EXTERNAL_ACCESS.has(entry)),
      true,
      `${name} has invalid external access`,
    );
    assert.equal(VERIFY.has(codeValue(cells[5]!)), true, `${name} has an invalid verification mode`);
    catalog.set(name, { hosts, access: externalAccess });
  }

  const packages: string[] = [];
  for (const entry of await readdir(examplesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifestSource: string;
    try {
      manifestSource = await readFile(resolve(examplesRoot, entry.name, "package.json"), "utf8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") continue;
      throw cause;
    }
    const manifest = parseJson(PACKAGE_MANIFEST_VALUE, manifestSource);
    if ((manifest.ohm?.extensions?.length ?? 0) === 0) continue;
    packages.push(entry.name);
    assert.equal(catalog.has(entry.name), true, `${entry.name} is missing from the examples catalog`);
    await access(resolve(examplesRoot, entry.name, "README.md"));
    for (const extension of manifest.ohm?.extensions ?? []) {
      await access(resolve(examplesRoot, entry.name, extension));
    }
  }
  assert.deepEqual([...catalog.keys()].sort(), packages.sort());

  const matrix = parseJson(
    CAPABILITY_MATRIX_VALUE,
    await readFile(resolve("docs/extension-capabilities.json"), "utf8"),
  );
  const matrixPackages = new Set(matrix.capabilities.flatMap((capability) => capability.examples)
    .map((example) => example.replace(/^examples\//u, "")));
  assert.deepEqual([...matrixPackages].sort(), packages.sort());

  for (const match of source.matchAll(/\]\((\.\/[^)#]+)\)/gu)) {
    await access(resolve(examplesRoot, match[1]!));
  }
});
