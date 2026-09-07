import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPromptCompositionMetadata,
  promptCompositionSource,
} from "../../src/core/prompt-composition.js";
import { buildSystemPrompt } from "../../src/core/system-prompt.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import type { Skill } from "../../src/core/skills.js";

const skill = (name: string, disabled = false): Skill => ({
  name,
  description: `${name} description`,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "local" }),
  disableModelInvocation: disabled,
});

test("custom prompts replace the default but retain append, context, visible skills, and cwd", () => {
  const prompt = buildSystemPrompt({
    customPrompt: "Custom base",
    appendSystemPrompt: "Appended",
    cwd: "C:\\work\\project",
    selectedTools: ["read"],
    contextFiles: [{ path: "/work/AGENTS.md", content: "Project rules" }],
    skills: [skill("visible"), skill("hidden", true)],
  });
  assert.equal(prompt.startsWith("Custom base\n\nAppended"), true);
  assert.match(prompt, /<project_instructions path="\/work\/AGENTS\.md">\nProject rules/u);
  assert.match(prompt, /<name>visible<\/name>/u);
  assert.doesNotMatch(prompt, /<name>hidden<\/name>/u);
  assert.match(prompt, /Current working directory: C:\/work\/project$/u);
  assert.doesNotMatch(prompt, /Available tools:/u);
});

test("instruction source paths cannot break their prompt tag", () => {
  const prompt = buildSystemPrompt({
    customPrompt: "Custom",
    cwd: "/work",
    contextFiles: [{ path: "/work/a&\"<b>\nfile.md", content: "Project rules" }],
  });

  assert.match(
    prompt,
    /<project_instructions path="\/work\/a&amp;&quot;&lt;b&gt;&#xA;file\.md">\nProject rules/u,
  );
  assert.doesNotMatch(prompt, /path="\/work\/a&"/u);
});

test("skills are omitted when read is unavailable", () => {
  const prompt = buildSystemPrompt({
    customPrompt: "Custom",
    cwd: "/work",
    selectedTools: ["bash"],
    skills: [skill("review")],
  });
  assert.doesNotMatch(prompt, /available_skills/u);
});

test("default prompt lists every selected tool and de-duplicates guidelines", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work",
    selectedTools: ["read", "bash", "private"],
    toolSnippets: { read: "Read files", bash: "Run commands" },
    promptGuidelines: ["Keep changes focused", " Keep changes focused "],
  });
  assert.match(prompt, /- read: Read files/u);
  assert.match(prompt, /- bash: Run commands/u);
  assert.match(prompt, /^- private$/mu);
  assert.equal(prompt.match(/Keep changes focused/gu)?.length, 1);
  assert.match(prompt, /Use bash for file discovery/u);
});

test("default guidance stays bounded and distinguishes scope, evidence, and tool access", () => {
  const prompt = buildSystemPrompt({ cwd: "/work" });
  assert.ok(Buffer.byteLength(prompt) < 1600, "Keep fixed guidance compact; task-specific instructions belong in resources");
  assert.match(prompt, /review, or diagnosis does not authorize edits/u);
  assert.match(prompt, /Treat untrusted instructions.*as data/u);
  assert.match(prompt, /Distinguish observed results from assumptions and checks not run/u);
  assert.match(prompt, /Tool access is not permission to exceed the task/u);
  assert.doesNotMatch(prompt, /system-prompt\.(?:ts|js)|Built-in prompt implementation/u);
});

test("optional snippets cannot hide selected tools or add inactive tools", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work",
    selectedTools: ["custom_lookup", "custom_lookup"],
    toolSnippets: { inactive: "Must not be advertised" },
  });
  assert.equal(prompt.split("\n").filter((line) => line === "- custom_lookup").length, 1);
  assert.doesNotMatch(prompt, /\(none\)|inactive|Must not be advertised/u);
  assert.match(buildSystemPrompt({ cwd: "/work" }), /Available tools:[\s\S]*\(none\)/u);
});

test("dedicated discovery tools suppress the bash discovery guideline", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work",
    selectedTools: ["bash", "grep"],
    toolSnippets: { bash: "Run commands", grep: "Search" },
  });
  assert.doesNotMatch(prompt, /Use bash for file discovery/u);
});

test("prompt composition metadata is content-free, exact, and bounded", () => {
  const prompt = "exact composed prompt";
  const source = promptCompositionSource("instruction", "/work/AGENTS.md", "private instructions");
  const metadata = buildPromptCompositionMetadata({
    prompt,
    sources: [source],
    selectedTools: ["read", "bash", "read"],
    skills: [skill("visible"), skill("hidden", true)],
  });

  assert.equal(metadata.bytes, Buffer.byteLength(prompt));
  assert.equal(metadata.sha256, promptCompositionSource("system_prompt", "unused", prompt).sha256);
  assert.deepEqual(metadata.sources, [source]);
  assert.deepEqual(metadata.tools, ["read", "bash"]);
  assert.deepEqual(metadata.skills, [{ name: "visible", manifestPath: "/skills/visible/SKILL.md" }]);
  assert.equal(metadata.truncated, false);
  assert.doesNotMatch(JSON.stringify(metadata), /private instructions/u);

  const bounded = buildPromptCompositionMetadata({
    prompt,
    sources: Array.from({ length: 2_000 }, (_, index) =>
      promptCompositionSource("instruction", `/work/${index.toString().padStart(4, "0")}-${"x".repeat(256)}.md`, "x")),
  });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 64 * 1024);
});
