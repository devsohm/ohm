import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MODEL_SCOPE_SELECTORS,
  isExactModelSelector,
  modelIsInScope,
  normalizeModelScopeSelectors,
  resolveScopedModels,
} from "../../src/core/model-scope.js";

const MODELS = [
  { provider: "alpha", id: "one" },
  { provider: "alpha", id: "two" },
  { provider: "beta", id: "one" },
] as const;

test("model scope selectors use exact provider/model references", () => {
  assert.equal(isExactModelSelector("alpha/one"), true);
  assert.equal(isExactModelSelector("alpha/family/one"), true);
  for (const invalid of [
    "one",
    "/one",
    "alpha/",
    "alpha/*",
    " alpha/one",
    "alpha/one ",
    "alpha/\0one",
    "alpha/\u007fone",
    "alpha/\u009fone",
    `${"p".repeat(129)}/one`,
    `alpha/${"m".repeat(513)}`,
  ]) {
    assert.equal(isExactModelSelector(invalid), false, invalid);
  }
  assert.deepEqual(normalizeModelScopeSelectors(["alpha/one", "alpha/one", "beta/one"]), [
    "alpha/one",
    "beta/one",
  ]);
  assert.throws(() => normalizeModelScopeSelectors(["alpha/*"]), /exact provider\/model/u);
  assert.throws(
    () => normalizeModelScopeSelectors(Array.from({ length: MAX_MODEL_SCOPE_SELECTORS + 1 }, (_, index) => `alpha/${index}`)),
    /more than 1024 selectors/u,
  );
});

test("empty scope preserves catalog order while a non-empty scope preserves selector order", () => {
  assert.deepEqual(resolveScopedModels([], MODELS, {}), MODELS.map((model) => ({ model })));
  assert.deepEqual(resolveScopedModels(["beta/one", "missing/model", "alpha/two"], MODELS, {
    "alpha/two": "high",
  }), [
    { model: MODELS[2] },
    { model: MODELS[1], thinkingLevel: "high" },
  ]);
  assert.equal(modelIsInScope([], "missing", "model"), true);
  assert.equal(modelIsInScope(["alpha/one"], "alpha", "one"), true);
  assert.equal(modelIsInScope(["alpha/one"], "beta", "one"), false);
});
