import assert from "node:assert/strict";
import test from "node:test";

import type { ImageBlock } from "../../src/core/types.js";
import {
  dispatchActiveInteractiveResourceSlash,
  resolveInteractiveResourceSlash,
} from "../../src/modes/interactive-resource-commands.js";
import type { AgentSessionPromptOptions } from "../../src/service/agent-session.js";
import type { InteractiveResourceSession } from "../../src/modes/interactive-resource-commands.js";

interface PromptCall {
  text: string;
  options: AgentSessionPromptOptions;
}

function sessionFixture() {
  const prompts: PromptCall[] = [];
  const session: InteractiveResourceSession = {
    extensionRunner: {
      getRuntimeHost() {
        return { hasCommand(name: string) { return name === "extension" || name === "copy:1"; } };
      },
    },
    promptTemplates: [{ name: "review" }],
    settingsManager: { getEnableSkillCommands: () => true },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "triage" }] }) },
    async prompt(text: string, options: AgentSessionPromptOptions) {
      prompts.push({ text, options });
      return { sessionId: "fixture", results: [] };
    },
  };
  return { session, prompts };
}

test("interactive slash resources resolve runtime commands, prompts, skills, and installed static templates", () => {
  const { session } = sessionFixture();
  const catalog = {
    command(name: string) {
      return name === "static-command"
        ? { name, extensionId: "fixture", sourcePath: "/fixture", sha256: "0".repeat(64), template: "command {{args}}" }
        : undefined;
    },
    prompt(name: string) {
      return name === "static-prompt"
        ? { id: name, extensionId: "fixture", sourcePath: "/fixture", sha256: "0".repeat(64), template: "prompt {{input}}" }
        : undefined;
    },
  };

  assert.equal(resolveInteractiveResourceSlash(session, "/extension now", catalog)?.kind, "runtime");
  assert.equal(resolveInteractiveResourceSlash(session, "/copy", catalog), undefined);
  assert.equal(resolveInteractiveResourceSlash(session, "/copy:1", catalog)?.kind, "runtime");
  assert.equal(resolveInteractiveResourceSlash(session, "/review now", catalog)?.kind, "prompt");
  assert.equal(resolveInteractiveResourceSlash(session, "/skill:triage now", catalog)?.kind, "skill");
  assert.deepEqual(resolveInteractiveResourceSlash(session, "/static-command now", catalog), {
    kind: "static-command",
    name: "static-command",
    args: "now",
    input: "/static-command now",
    prompt: "command now",
  });
  assert.equal(resolveInteractiveResourceSlash(session, "/static-prompt now", catalog)?.prompt, "prompt now");
  assert.equal(resolveInteractiveResourceSlash(session, "/unknown", catalog), undefined);
});

test("active slash resources dispatch exactly once through follow-up prompt admission", async () => {
  const { session, prompts } = sessionFixture();
  const route = resolveInteractiveResourceSlash(session, "/extension now");
  assert.ok(route);
  const images: ImageBlock[] = [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }];
  const controller = new AbortController();

  await dispatchActiveInteractiveResourceSlash(session, route, images, controller.signal);

  assert.deepEqual(prompts, [{
    text: "/extension now",
    options: {
      images,
      signal: controller.signal,
      source: "interactive",
      streamingBehavior: "followUp",
    },
  }]);
});
