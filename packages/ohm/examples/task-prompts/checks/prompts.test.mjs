import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadPromptTemplates, renderPluginPrompt } from "ohm/plugins";
import { loadPromptTemplates as loadSdkPromptTemplates } from "ohm/sdk";

const directory = fileURLToPath(new URL("../prompts", import.meta.url));
const templates = await loadPromptTemplates([directory]);

function render(name, args = "") {
  const prompt = templates.find((entry) => entry.id === name);
  assert.ok(prompt, `missing prompt: ${name}`);
  return renderPluginPrompt(prompt, args);
}

test("public loaders discover the same three templates and metadata", () => {
  assert.deepEqual(templates.map((entry) => entry.id), ["diagnose-issue", "implement-change", "review-change"]);
  const sdkTemplates = loadSdkPromptTemplates({
    cwd: dirname(directory), agentDir: dirname(directory),
    promptPaths: [directory], includeDefaults: false,
  });
  assert.deepEqual(sdkTemplates.map((entry) => entry.name).sort(), templates.map((entry) => entry.id));
  for (const prompt of templates) {
    const sdk = sdkTemplates.find((entry) => entry.name === prompt.id);
    assert.ok(sdk);
    assert.equal(sdk.content.trim(), prompt.template.trim());
    assert.equal(sdk.description, prompt.description);
    assert.equal(sdk.argumentHint, prompt.argumentHint);
    assert.ok(prompt.description);
    assert.ok(prompt.argumentHint);
  }
});

test("missing arguments use bounded defaults instead of inventing a task", () => {
  const review = render("review-change");
  assert.match(review, /^Review scope: tracked staged and unstaged changes against HEAD$/mu);
  assert.match(review, /^Focus: correctness, regressions, and data safety$/mu);
  assert.match(render("diagnose-issue"), /^Issue: not specified$/mu);
  assert.match(render("diagnose-issue"), /^Investigation scope: current workspace$/mu);
  assert.match(render("implement-change"), /^Requested outcome: not specified$/mu);
  assert.match(render("implement-change"), /^Implementation scope: current workspace$/mu);
  for (const prompt of templates) assert.doesNotMatch(render(prompt.id), /\$\{|\$ARGUMENTS|\$@|\$\d/u);
});

test("quoted positional arguments preserve spaces and retain additional context", () => {
  const review = render("review-change", `'src/a b.ts' "cancellation safety" preserve existing behavior`);
  assert.match(review, /^Review scope: src\/a b\.ts$/mu);
  assert.match(review, /^Focus: cancellation safety$/mu);
  assert.match(review, /^Additional context: preserve existing behavior$/mu);
  assert.match(render("diagnose-issue", '"resume loses history"'), /^Issue: resume loses history$/mu);
  assert.match(render("implement-change", '"bound history output"'), /^Requested outcome: bound history output$/mu);
});

test("argument values are substituted once, never reinterpreted as placeholders", () => {
  const literal = "$2 ${1:-fallback} $ARGUMENTS";
  const review = render("review-change", `'${literal}' "actual focus"`);
  assert.ok(review.includes(`Review scope: ${literal}\n`));
  assert.match(review, /^Focus: actual focus$/mu);
});

test("review and diagnosis remain read-only while implementation stays scoped", () => {
  for (const name of ["review-change", "diagnose-issue"]) {
    assert.match(render(name), /Do not edit files, change Git state, install dependencies, or make external\s+writes/u);
  }
  assert.match(render("diagnose-issue"), /Recommend a bounded fix, but do not implement it/u);
  assert.match(render("implement-change"), /Do not\s+commit, push, publish, or alter external systems without explicit authorization/u);
});
