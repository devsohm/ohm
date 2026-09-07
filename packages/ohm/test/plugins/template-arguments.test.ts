import assert from "node:assert/strict";
import test from "node:test";

import {
  renderPluginCommand,
  renderPluginPrompt,
  type PluginPromptTemplate,
  type PluginSlashCommand,
} from "../../src/plugins/index.js";

function prompt(template: string): PluginPromptTemplate {
  return {
    id: "arguments",
    extensionId: "fixture",
    sourcePath: "/fixture/arguments.md",
    sha256: "0".repeat(64),
    template,
  };
}

function command(template: string): PluginSlashCommand {
  return {
    name: "arguments",
    extensionId: "fixture",
    sourcePath: "/fixture/arguments.md",
    sha256: "0".repeat(64),
    template,
  };
}

test("prompt templates support zero-index compatibility and aggregate defaults", () => {
  assert.equal(renderPluginPrompt(prompt("$0"), "one two"), "");
  assert.equal(renderPluginPrompt(prompt("${0:-fallback}"), "one two"), "fallback");
  assert.equal(renderPluginPrompt(prompt("${@:0}"), "one two three"), "one two three");
  assert.equal(renderPluginPrompt(prompt("${@:0:2}"), "one two three"), "one two");
  assert.equal(renderPluginPrompt(prompt("${@:-fallback}"), "one two"), "one two");
  assert.equal(renderPluginPrompt(prompt("${ARGUMENTS:-fallback}"), ""), "fallback");
  assert.equal(renderPluginCommand(command("${ARGUMENTS:-fallback}"), "one two"), "one two");
});

test("prompt template replacements remain single-pass", () => {
  assert.equal(renderPluginPrompt(prompt("${@:0}"), "'$1' '${@:-fallback}'"), "$1 ${@:-fallback}");
});
