import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "../src/core/json.js";
import { OHM_VERSION } from "../src/version.js";

test("packaged product and runtime use the same version", async () => {
  const packageJson: JsonValue = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!Value.Check(Type.Object({ version: Type.String() }, { additionalProperties: true }), packageJson)) {
    assert.fail("package version metadata is invalid");
  }
  assert.equal(packageJson.version, OHM_VERSION);
});
