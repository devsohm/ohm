import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeModelConfiguration } from "../../src/providers/model-runtime-config.js";

test("model configuration comments preserve strings and JSON token boundaries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohm-model-comments-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  await writeFile(path, `{
    // Local provider
    "providers": { "local": {
      "baseUrl": "https://example.test/v1/*literal*/",
      "models": [{ "id": "quoted\\"//literal", /* tokens */ "maxTokens": 12 }]
    }}
  } // End`);
  const valid = await loadRuntimeModelConfiguration(path);
  assert.equal(valid.error, undefined);
  assert.equal(valid.providers.get("local")?.baseUrl, "https://example.test/v1/*literal*/");
  assert.equal(valid.providers.get("local")?.models?.[0]?.id, 'quoted"//literal');
  assert.equal(valid.providers.get("local")?.models?.[0]?.maxTokens, 12);

  for (const content of [
    '{"providers": {}} /* unclosed',
    '{"providers": {"local": {"authHeader": tr/* split keyword */ue}}}',
    '{"providers": {"local": {"models": [{"id": "model", "maxTokens": 1/* split number */2}]}}}',
  ]) {
    await writeFile(path, content);
    const invalid = await loadRuntimeModelConfiguration(path);
    assert.ok(invalid.error, `invalid JSON must not be repaired by comment removal: ${content}`);
    assert.equal(invalid.providers.size, 0);
  }
});
