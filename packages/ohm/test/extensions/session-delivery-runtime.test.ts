import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  ExtensionSessionDelivery,
  ImageContent,
  TextContent,
} from "../../src/extensions/direct.js";
import {
  loadDirectExtensions,
  type RuntimeDirectActionsHandler,
  type RuntimeExtensionHost,
} from "../../src/extensions/runtime.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";

interface DeliveryCall {
  kind: "message" | "user";
  value: unknown;
  options: unknown;
}

async function workspace(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-delivery-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

function bindSession(
  host: RuntimeExtensionHost,
  root: string,
  sessionId: string,
  calls: DeliveryCall[],
): void {
  const manager = SessionManager.inMemory(root, { id: sessionId });
  host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(manager),
    modelRegistry: new ModelRegistry(createModels()),
    thinkingLevel: "off",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => `${sessionId} system prompt`,
  }));
  const actions: RuntimeDirectActionsHandler & { readonly marker: string } = {
    marker: sessionId,
    sendMessage() { throw new Error("Unacknowledged custom delivery was used"); },
    sendUserMessage() { throw new Error("Unacknowledged user delivery was used"); },
    async sendMessageAcknowledged(message, options) {
      assert.equal(this.marker, sessionId);
      calls.push({ kind: "message", value: message, options });
      if (message.customType === "reject") throw new Error(`${sessionId} rejected delivery`);
    },
    async sendUserMessageAcknowledged(content, options) {
      assert.equal(this.marker, sessionId);
      calls.push({ kind: "user", value: content, options });
    },
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    async setModel() { return true; },
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    getSystemPromptOptions: () => ({ cwd: root }),
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async refresh() {},
  };
  host.setDirectActionsHandler(actions);
}

test("callback session delivery remains bound to its exact acknowledged session action", async (context) => {
  const root = await workspace(context);
  const deliveries: ExtensionSessionDelivery[] = [];
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "capture-session-delivery",
      factory(ohm) {
        ohm.on("session_start", (_event, extensionContext) => {
          deliveries.push(extensionContext.sessionDelivery);
        });
      },
    }],
  });
  context.after(async () => await host.close());

  const sessionACalls: DeliveryCall[] = [];
  bindSession(host, root, "session-a", sessionACalls);
  await host.dispatch("session_start", { reason: "startup", threadId: "thread-a" });

  const sessionBCalls: DeliveryCall[] = [];
  bindSession(host, root, "session-b", sessionBCalls);
  await host.dispatch("session_start", { reason: "resume", threadId: "thread-b" });

  assert.equal(deliveries.length, 2);
  const sessionA = deliveries[0]!;
  const sessionB = deliveries[1]!;
  assert.equal(sessionA.sessionId, "session-a");
  assert.equal(sessionB.sessionId, "session-b");

  const publicContent: Array<TextContent | ImageContent> = [
    { type: "text", text: "public text" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ];
  const acceptedA = sessionA.sendMessage({
    customType: "session-a-result",
    content: publicContent,
    display: true,
    details: { taskId: "task-a" },
  }, { triggerTurn: true, deliverAs: "nextTurn" });
  assert.equal(acceptedA instanceof Promise, true);
  await acceptedA;
  await sessionB.sendMessage({
    customType: "session-b-result",
    content: "session b result",
    display: false,
  }, { deliverAs: "followUp" });
  await sessionA.sendUserMessage("session a follow-up", { deliverAs: "followUp" });
  await sessionB.sendUserMessage(publicContent, {
    deliverAs: "steer",
    expandPromptTemplates: false,
  });
  await assert.rejects(
    sessionA.sendMessage({ customType: "reject", content: "failure", display: false }),
    /session-a rejected delivery/u,
  );

  const canonicalContent = [
    { type: "text", text: "public text" },
    { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
  ];
  assert.deepEqual(sessionACalls, [
    {
      kind: "message",
      value: {
        customType: "session-a-result",
        content: canonicalContent,
        display: true,
        details: { taskId: "task-a" },
      },
      options: { triggerTurn: true, deliverAs: "nextTurn" },
    },
    {
      kind: "user",
      value: "session a follow-up",
      options: { deliverAs: "followUp" },
    },
    {
      kind: "message",
      value: { customType: "reject", content: "failure", display: false },
      options: undefined,
    },
  ]);
  assert.deepEqual(sessionBCalls, [
    {
      kind: "message",
      value: { customType: "session-b-result", content: "session b result", display: false },
      options: { deliverAs: "followUp" },
    },
    {
      kind: "user",
      value: canonicalContent,
      options: { deliverAs: "steer", expandPromptTemplates: false },
    },
  ]);

  await host.close();
  const callCounts = [sessionACalls.length, sessionBCalls.length];
  await assert.rejects(
    sessionA.sendUserMessage("late a"),
    /no longer active|host is closed/u,
  );
  await assert.rejects(
    sessionB.sendMessage({ customType: "late", content: "late b", display: false }),
    /no longer active|host is closed/u,
  );
  assert.deepEqual([sessionACalls.length, sessionBCalls.length], callCounts);
});
