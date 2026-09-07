import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage } from "@ohm/kernel";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject } from "../../src/core/json.js";
import type { CanonicalMessage, NormalizedUsage, ProviderState, ToolResultBlock } from "../../src/core/types.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectPlugins } from "../../src/plugins/runtime.js";
import {
  canonicalAgentMessages,
  canonicalMessage,
  canonicalSessionEntryId,
  canonicalUsage,
  extensionAssistantEventFromMessage,
  extensionAssistantKernelStreamMessage,
  extensionContextMessages,
  extensionMessage,
  extensionSessionEntries,
  extensionSessionEntriesForCanonicalEntry,
  pluginSessionManager,
  extensionToolResult,
  extensionUsage,
  type PluginSessionProvenance,
  type SessionEntry,
} from "../../src/plugins/session-contract.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, type AgentSessionEvent } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import type { SessionEntry as CanonicalSessionEntry } from "../../src/storage/types.js";

const SESSION_PAGE_VALUE = Type.Object({
  entries: Type.Array(Type.Object({
    id: Type.String(),
    parentId: Type.Union([Type.String(), Type.Null()]),
    type: Type.String(),
    message: Type.Optional(Type.Unknown()),
  }, { additionalProperties: true })),
  totalEntries: Type.Number(),
}, { additionalProperties: true });
const PAGED_SESSION_VALUE = Type.Object({
  getEntriesPage: Type.Function([Type.Number(), Type.Number()], SESSION_PAGE_VALUE),
}, { additionalProperties: true });
const USER_MESSAGE_VALUE = Type.Object({
  role: Type.Literal("user"),
  content: Type.Array(Type.Unknown()),
}, { additionalProperties: true });
const BASH_MESSAGE_VALUE = Type.Object({
  role: Type.Literal("bashExecution"),
  output: Type.String(),
}, { additionalProperties: true });
type SessionPage = Static<typeof SESSION_PAGE_VALUE>;

function sessionMessage(entry: SessionEntry | undefined): AgentMessage | undefined {
  return entry?.type === "message" ? entry.message : undefined;
}

const normalizedUsage: NormalizedUsage = {
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  cacheWrite1hTokens: 1,
  reasoningTokens: 2,
  totalTokens: 13,
  cost: { input: 0.07, output: 0.06, cacheRead: 0.002, cacheWrite: 0.004, total: 0.136 },
};

test("extension usage conversion preserves cache, reasoning, and cost semantics", () => {
  const exposed = extensionUsage(normalizedUsage);
  assert.deepEqual(exposed, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    cacheWrite1h: 1,
    reasoning: 2,
    totalTokens: 13,
    cost: { input: 0.07, output: 0.06, cacheRead: 0.002, cacheWrite: 0.004, total: 0.136 },
  });
  assert.deepEqual(canonicalUsage(exposed), normalizedUsage);
  assert.throws(
    () => canonicalUsage({ ...exposed, totalTokens: 12 }),
    /totalTokens must equal/u,
  );
});

function ownedContextMessages(): CanonicalMessage[] {
  return [0, 1].flatMap((turn) => [{
    id: `user-${turn}`,
    role: "user" as const,
    content: [{ type: "text" as const, text: `request-${turn}` }],
    createdAt: "2026-09-06T00:00:00.000Z",
    displayText: `display-${turn}`,
  }, {
    id: `assistant-${turn}`,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `answer-${turn}` }],
    createdAt: "2026-09-06T00:00:00.001Z",
    api: "extension-stream" as const,
    provider: "fixture",
    model: "fixture-model",
    responseId: `response-${turn}`,
    responseModel: `revision-${turn}`,
    diagnostics: [{ type: "provider_response", message: `response-${turn}`, timestamp: turn }],
    providerState: { kind: "extension_stream" as const, assistantContent: [{ continuation: `opaque-${turn}` }] },
    usage: normalizedUsage,
    stopReason: "stop" as const,
  }]);
}

test("context prefix filtering and reordering preserve the selected message owners", () => {
  const previous = ownedContextMessages();
  const before = structuredClone(previous);
  const projection = extensionContextMessages(previous);
  for (const indices of [[2, 3], [3, 0, 2, 1], [0, 1, 2, 3]]) {
    const selected = structuredClone(indices.map((index) => projection.messages[index]!));
    assert.deepEqual(canonicalAgentMessages(selected, projection.owners), indices.map((index) => previous[index]));
  }
  assert.deepEqual(previous, before);
});

test("owned context edits survive JSON cloning without accepting identity or provider-state forgery", () => {
  const previous = ownedContextMessages();
  const projection = extensionContextMessages(previous);
  const assistant = projection.messages[3]!;
  assert.equal(assistant.role, "assistant");
  if (assistant.role !== "assistant") assert.fail("Expected an assistant message");
  const edited = { ...assistant, content: [{ type: "text" as const, text: "edited answer" }] };
  const restored = canonicalAgentMessages(structuredClone([edited]), projection.owners)[0]!;
  assert.deepEqual(restored, { ...previous[3], content: [{ type: "text", text: "edited answer" }] });
  assert.equal("contextId" in restored, false);
  const { providerState: _state, ...withoutState } = edited;
  assert.deepEqual(canonicalAgentMessages([withoutState], projection.owners)[0], restored);
  for (const change of [
    { contextId: "forged" },
    { role: "user" as const, content: [] },
    { responseId: "forged" },
    { responseModel: "forged" },
    { api: "forged" },
    { provider: "forged" },
    { model: "forged" },
    { diagnostics: [{ type: "forged", timestamp: 0 }] },
    { providerState: { ...assistant.providerState!, value: { continuation: "forged" } } },
  ]) {
    assert.throws(() => canonicalAgentMessages([{ ...assistant, ...change }], projection.owners),
      /identity|owned message role|host-owned/u);
  }
  assert.throws(() => canonicalAgentMessages([assistant, assistant], projection.owners), /more than once/u);
  assert.throws(() => canonicalAgentMessages([assistant], extensionContextMessages(previous).owners), /no longer active/u);
  const { contextId: _contextId, ...withoutIdentity } = assistant;
  assert.throws(() => canonicalAgentMessages([withoutIdentity]), /cannot be introduced/u);
  const { providerState: _providerState, responseId: _responseId, responseModel: _responseModel, diagnostics: _diagnostics, ...replacement } = withoutIdentity;
  const [newMessage] = canonicalAgentMessages([replacement]);
  assert.ok(newMessage);
  assert.notEqual(newMessage.id, previous[3]?.id);
  assert.equal("providerState" in newMessage, false);
});

test("context tokens distinguish identical projections and flattened tool results", () => {
  const user = ownedContextMessages()[0]!;
  const duplicate = { ...user, id: "second-user", displayText: "second display" };
  const tool: CanonicalMessage = {
    id: "tool-batch",
    role: "tool",
    content: ["one", "two"].map((callId) => ({ type: "tool_result", callId, name: "read", content: callId, isError: false })),
    createdAt: user.createdAt,
  };
  const projection = extensionContextMessages([user, duplicate, tool]);
  const selected = [projection.messages[1]!, projection.messages[3]!, projection.messages[2]!];
  const restored = canonicalAgentMessages(structuredClone(selected), projection.owners);
  assert.deepEqual(restored[0], duplicate);
  assert.equal(restored[1]?.id, tool.id);
  assert.notEqual(restored[2]?.id, tool.id);
  assert.equal(new Set(restored.map((message) => message.id)).size, restored.length);
  assert.deepEqual(restored.slice(1).map((message) => message.content[0]?.type === "tool_result" ? message.content[0].callId : undefined), ["two", "one"]);
  assert.equal(new Set(projection.messages.map((message) => "contextId" in message ? message.contextId : undefined)).size, 4);
});

test("runtime context hooks can trim history then reorder and edit the retained assistant", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-context-owners-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const host = await loadDirectPlugins([], {
    workspace: root,
    inlinePlugins: [{ name: "context-owners", factory(ohm) {
      ohm.on("context", (event) => ({ messages: event.messages.slice(2) }));
      ohm.on("context", (event) => ({ messages: event.messages.toReversed().map((message) => message.role === "assistant"
        ? { ...message, content: [{ type: "text" as const, text: "edited answer" }] }
        : message) }));
    } }],
  });
  context.after(async () => await host.close());
  const previous = ownedContextMessages();
  const restored = await host.reduceContext({ threadId: "thread", runId: "run", branch: "main", messages: previous });
  assert.deepEqual(restored, [
    { ...previous[3], content: [{ type: "text", text: "edited answer" }] },
    previous[2],
  ]);
  assert.deepEqual(host.diagnostics(), []);
});

test("new context messages do not inherit a previous message identity or private metadata by position", () => {
  const previous: CanonicalMessage = {
    id: "owned-user",
    role: "user",
    content: [{ type: "text", text: "original" }],
    createdAt: "2026-09-06T00:00:00.000Z",
    displayText: "host-only display",
    purpose: "instructions",
  };
  const projection = extensionContextMessages([previous]);
  const [inserted, retained] = canonicalAgentMessages([
    { role: "user", content: "injected", timestamp: Date.parse(previous.createdAt) },
    projection.messages[0]!,
  ], projection.owners);
  assert.notEqual(inserted?.id, previous.id);
  assert.equal(inserted?.displayText, undefined);
  assert.equal(inserted?.purpose, undefined);
  assert.deepEqual(retained, previous);
});

test("extension usage conversion preserves missing cache telemetry", () => {
  const canonical: NormalizedUsage = {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    cost: { input: 0.07, output: 0.06, cacheRead: 0, cacheWrite: 0, total: 0.13 },
  };
  const exposed = extensionUsage(canonical);
  assert.equal(Object.hasOwn(exposed, "cacheRead"), false);
  assert.equal(Object.hasOwn(exposed, "cacheWrite"), false);
  assert.deepEqual(canonicalUsage(exposed), canonical);
});

test("extension usage conversion preserves unavailable counters and explicit zero", () => {
  const partial: NormalizedUsage = { inputTokens: 7, totalTokens: 10 };
  assert.deepEqual(extensionUsage(partial), { input: 7, totalTokens: 10 });
  assert.deepEqual(canonicalUsage({ input: 7, totalTokens: 10 }), partial);
  assert.deepEqual(extensionUsage(undefined), {});
  assert.deepEqual(canonicalUsage({}), {});

  const explicitZero: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  assert.deepEqual(canonicalUsage(extensionUsage(explicitZero)), explicitZero);
});

test("message conversion uses public image and assistant message contracts without losing host state", () => {
  const user: CanonicalMessage = {
    id: "message-user",
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
  };
  const publicUser = extensionMessage(user);
  assert.equal(publicUser.role, "user");
  assert.deepEqual(publicUser.content, [
    { type: "text", text: "inspect" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ]);
  assert.deepEqual(canonicalMessage(publicUser, user), user);

  const assistant: CanonicalMessage & { providerState: ProviderState } = {
    id: "message-assistant",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "done", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "call-signed",
        name: "inspect",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
    provider: "custom-provider",
    model: "custom-model",
    api: "extension-stream",
    publicApi: "custom-stream",
    responseModel: "custom-model-revision",
    responseId: "custom-response",
    diagnostics: [{
      type: "provider_response",
      message: "Provider response received",
      details: { response: { status: 200, headers: { "x-request-id": "custom-request" } } },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
    providerState: { kind: "extension_stream", assistantContent: [{ continuation: "opaque" }] },
    usage: normalizedUsage,
    stopReason: "stop",
  };
  const publicAssistant = extensionMessage(assistant);
  if (publicAssistant.role !== "assistant") assert.fail("Expected an assistant message");
  assert.equal(publicAssistant.api, "custom-stream");
  assert.equal(publicAssistant.responseModel, "custom-model-revision");
  assert.equal(publicAssistant.responseId, "custom-response");
  assert.deepEqual(publicAssistant.diagnostics, assistant.diagnostics);
  assert.deepEqual(publicAssistant.content, [
    { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: true },
    { type: "text", text: "done", textSignature: "text-signature" },
    {
      type: "toolCall",
      id: "call-signed",
      name: "inspect",
      arguments: { path: "README.md" },
      thoughtSignature: "tool-signature",
    },
  ]);
  assert.deepEqual(publicAssistant.providerState?.value, {
    kind: "extension_stream",
    assistantContent: [{ continuation: "opaque" }],
  });
  assert.deepEqual(canonicalMessage(publicAssistant, assistant), assistant);
  assert.throws(
    () => canonicalMessage({ ...publicAssistant, responseId: "forged-response" }, assistant),
    /response metadata is host-owned/u,
  );
  assert.throws(
    () => canonicalMessage({
      ...publicAssistant,
      diagnostics: [{
        type: "forged",
        message: "api_key=sk-proj-forged-secret-value",
        timestamp: Date.now(),
      }],
    }, assistant),
    /response metadata is host-owned/u,
  );
  const { providerState: _providerState, ...withoutProviderState } = publicAssistant;
  assert.throws(
    () => canonicalMessage(withoutProviderState, undefined),
    /response metadata cannot be introduced/u,
  );
});

test("trusted assistant stream projection maps one bounded snapshot and reuses its public partial", () => {
  const toolArguments = { path: "README.md" };
  const message: CanonicalMessage = {
    id: "stream-projection",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private trace", visibility: "provider_trace" },
      { type: "thinking", thinking: "visible thought", visibility: "summary" },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "call-stream",
        name: "read",
        arguments: toolArguments,
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-08-30T00:00:00.000Z",
    provider: "stream-provider",
    model: "stream-model",
  };

  const projected = extensionAssistantKernelStreamMessage(message);
  const event = extensionAssistantEventFromMessage(
    { type: "text_delta", part: 2, text: "answer" },
    projected,
  );

  assert.deepEqual(projected.content, [
    { type: "thinking", thinking: "visible thought" },
    { type: "text", text: "answer", textSignature: "text-signature" },
    {
      type: "toolCall",
      id: "call-stream",
      name: "read",
      arguments: { path: "README.md" },
      thoughtSignature: "tool-signature",
    },
  ]);
  assert.equal(projected.stopReason, "pending");
  assert.equal(event.type, "text_delta");
  assert.equal("partial" in event ? event.partial : undefined, projected);
  const text = message.content.find((block) => block.type === "text");
  if (text?.type === "text") text.text = "mutated";
  toolArguments.path = "mutated";
  assert.deepEqual(projected.content[1], { type: "text", text: "answer", textSignature: "text-signature" });
  assert.deepEqual(projected.content.at(-1), {
    type: "toolCall",
    id: "call-stream",
    name: "read",
    arguments: { path: "README.md" },
    thoughtSignature: "tool-signature",
  });
  assert.throws(
    () => extensionAssistantKernelStreamMessage({
      ...message,
      content: [{ type: "provider_opaque", provider: "fixture", mediaType: "application/json", value: {} }],
    }),
    /unsupported blocks/u,
  );
  assert.throws(
    () => extensionAssistantKernelStreamMessage({
      ...message,
      content: [{ type: "tool_call", callId: "array-call", name: "read", arguments: [] }],
    }),
    /arguments must be a JSON object/u,
  );
});

test("runtime message conversion accepts only nullish omissions beyond the public content contract", () => {
  const assistant = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } satisfies AgentMessage;
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-empty",
    toolName: "empty-result",
    content: [],
    details: undefined,
    isError: false,
    timestamp: 2,
  } satisfies AgentMessage;

  for (const value of [null, undefined]) {
    const convertedAssistant = canonicalMessage(Object.assign({}, assistant, {
      ...assistant,
      content: value,
    }));
    assert.deepEqual(convertedAssistant.role === "assistant" ? convertedAssistant.content : undefined, []);

    const convertedTool = canonicalMessage(Object.assign({}, toolResult, {
      ...toolResult,
      content: value,
    }));
    assert.equal(convertedTool.role, "tool");
    if (convertedTool.role !== "tool") assert.fail("Expected a tool message");
    assert.deepEqual(convertedTool.content[0]?.type === "tool_result"
      ? convertedTool.content[0].contentBlocks
      : undefined, []);
  }

  const invalid = ["text", 1, { type: "text", text: "not-an-array" }, [{ type: "text" }]];
  for (const content of invalid) {
    const invalidAssistant = structuredClone(assistant);
    Object.defineProperty(invalidAssistant, "content", { value: content });
    assert.throws(() => canonicalMessage(invalidAssistant));
    const invalidToolResult = structuredClone(toolResult);
    Object.defineProperty(invalidToolResult, "content", { value: content });
    assert.throws(() => canonicalMessage(invalidToolResult));
  }
});

test("assistant diagnostics are redacted before public extension projection", () => {
  const exposed = extensionMessage({
    id: "message-secret-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    provider: "provider",
    model: "model",
    diagnostics: [{
      type: "provider_failure",
      message: "api_key=sk-proj-abcdefghijklmnop",
      details: {
        authorization: "Bearer sk-proj-abcdefghijklmnop",
        nested: { access_token: "sk-proj-abcdefghijklmnop" },
      },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  });
  if (exposed.role !== "assistant") assert.fail("Expected an assistant message");
  assert.deepEqual(exposed.diagnostics, [{
    type: "provider_failure",
    message: "api_key=[REDACTED]",
    details: {
      authorization: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
    },
    timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
  }]);
  assert.throws(() => extensionMessage({
    id: "message-oversized-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    diagnostics: [{
      type: "provider_failure",
      message: "x".repeat(4 * 1024 + 1),
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  }), /byte limit/u);
  assert.throws(() => extensionMessage({
    id: "message-non-json-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    diagnostics: [{
      type: "provider_failure",
      message: "failed",
      details: { invalid: undefined },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  }), /only JSON values/u);
});

test("signed assistant content survives JSONL persistence and public session projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-signed-session-"));
  let manager: SessionManager | undefined;
  let reopened: SessionManager | undefined;
  context.after(async () => {
    reopened?.closeV4Store();
    manager?.closeV4Store();
    await rm(root, { recursive: true, force: true });
  });
  manager = SessionManager.create(root, join(root, "sessions"), { id: "signed" });
  manager.appendMessage({
    id: "signed-assistant",
    role: "assistant",
    provider: "signed-provider",
    model: "signed-model",
    api: "extension-stream",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "signed-call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
    stopReason: "tool_calls",
  });

  manager.closeV4Store();
  reopened = SessionManager.open(manager.getSessionFile()!);
  const entry = pluginSessionManager(reopened).getEntries()[0];
  assert.equal(entry?.type, "message");
  assert.deepEqual(entry?.type === "message" ? entry.message : undefined, {
    role: "assistant",
    provider: "signed-provider",
    model: "signed-model",
    api: "extension-stream",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "toolCall",
        id: "signed-call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    usage: {},
    stopReason: "toolUse",
    timestamp: Date.parse("2026-07-21T00:00:00.000Z"),
  });
});

test("extension provenance survives durable custom entry and message replay", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-extension-provenance-"));
  let manager: SessionManager | undefined;
  let reopened: SessionManager | undefined;
  context.after(async () => {
    reopened?.closeV4Store();
    manager?.closeV4Store();
    await rm(root, { recursive: true, force: true });
  });
  manager = SessionManager.create(root, join(root, "sessions"), { id: "extension-provenance" });
  const provenance: PluginSessionProvenance = {
    schemaVersion: 1,
    extensionId: "review-notes",
    sourceSha256: "1".repeat(64),
    packageVersion: "3.1.0",
    packageContentSha256: "2".repeat(64),
    manifestSha256: "3".repeat(64),
  };
  manager.appendCustomEntry("review-state", { count: 2 }, undefined, provenance);
  manager.appendCustomMessageEntry("review-message", "ready", true, { count: 2 }, { provenance });
  manager.appendCustomEntry("legacy-state", { unchanged: true });
  manager.appendCustomMessageEntry("legacy-message", "unchanged", false);
  assert.deepEqual([...manager.getV4State().nodes.values()].map((node) => node.nodeType), [
    "extension_state",
    "extension_context",
    "extension_state",
    "extension_context",
  ]);

  manager.closeV4Store();
  reopened = SessionManager.open(manager.getSessionFile()!);
  const entries = pluginSessionManager(reopened).getEntries();
  assert.deepEqual(entries.slice(0, 2).map((entry) =>
    entry.type === "custom" || entry.type === "custom_message" ? entry.provenance : undefined), [
    provenance,
    provenance,
  ]);
  assert.equal(entries[2]?.type === "custom" && Object.hasOwn(entries[2], "provenance"), false);
  assert.equal(
    entries[3]?.type === "custom_message" && Object.hasOwn(entries[3], "provenance"),
    false,
  );
});

test("tool results retain ordered content, details, usage, and dynamically added tools", () => {
  const block: ToolResultBlock = {
    type: "tool_result",
    callId: "call-1",
    name: "inspect",
    content: "firstlast",
    contentBlocks: [
      { type: "text", text: "first" },
      { type: "image", mediaType: "image/jpeg", data: "aW1hZ2U=" },
      { type: "text", text: "last" },
    ],
    metadata: { path: "result.txt" },
    addedToolNames: ["follow_up"],
    isError: false,
  };
  const canonical: CanonicalMessage = {
    id: "message-tool",
    role: "tool",
    content: [block],
    createdAt: "2026-07-21T00:00:02.000Z",
    usage: normalizedUsage,
  };
  const exposed = extensionToolResult(canonical, block);
  assert.deepEqual(exposed.content, [
    { type: "text", text: "first" },
    { type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" },
    { type: "text", text: "last" },
  ]);
  assert.deepEqual(exposed.details, { path: "result.txt" });
  assert.deepEqual(exposed.addedToolNames, ["follow_up"]);
  assert.deepEqual(exposed.usage, extensionUsage(normalizedUsage));

  const roundTrip = canonicalMessage(exposed, canonical);
  assert.equal(roundTrip.role, "tool");
  assert.deepEqual(roundTrip.content[0], { ...block, images: [block.contentBlocks![1]] });
  assert.deepEqual(roundTrip.usage, normalizedUsage);
});

test("extension session facade projects a canonical tool batch as individual public messages", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract" });
  const userId = manager.appendMessage({
    id: "message-user",
    role: "user",
    content: [{ type: "text", text: "run both" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const toolId = manager.appendMessage({
    id: "message-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "call-2", name: "two", content: "second", isError: true },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const session = pluginSessionManager(manager);
  const entries = session.getEntries();
  assert.deepEqual(entries.map((entry) => entry.type === "message" ? entry.message.role : entry.type), [
    "user",
    "toolResult",
    "toolResult",
  ]);
  assert.equal(entries[1]?.id, toolId);
  assert.equal(entries[1]?.parentId, userId);
  assert.equal(entries[2]?.id, `${toolId}~1`);
  assert.equal(entries[2]?.parentId, toolId);
  assert.equal(session.getLeafId(), `${toolId}~1`);
  assert.deepEqual(
    entries.slice(1).map((entry) => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") {
        return assert.fail("Expected a tool-result message entry");
      }
      return entry.message.toolName;
    }),
    ["one", "two"],
  );

  const publicMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "continue" }],
    timestamp: Date.parse("2026-07-21T00:00:02.000Z"),
  };
  session.appendMessage(publicMessage);
  assert.equal(manager.getLeafEntry()?.type, "message");
  const leaf = session.getLeafEntry();
  assert.deepEqual(leaf?.type === "message" ? leaf.message : undefined, publicMessage);
});

for (const storage of ["memory", "saved", "compatibility"] as const) {
  for (const omitted of ["branch", "compaction"] as const) {
    test(`context projection preserves global entry identities after ${omitted} in ${storage} sessions`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "ohm-context-identities-"));
      let manager: SessionManager | undefined;
      t.after(async () => {
        manager?.closeV4Store();
        await rm(directory, { recursive: true, force: true });
      });
      manager = storage === "saved"
        ? SessionManager.create(directory, directory, { id: "context-identities" })
        : SessionManager.inMemory(directory, { id: "context-identities" });
      const createdAt = "2026-07-29T12:00:00.000Z";
      const root = manager.appendMessage({
        id: "root-message", role: "user", content: [{ type: "text", text: "root" }], createdAt,
      }, { nodeId: "root" });
      manager.appendMessage({ id: "tool-message", role: "tool", content: [
        { type: "tool_result", callId: "one", name: "one", content: "one", isError: false },
        { type: "tool_result", callId: "two", name: "two", content: "two", isError: false },
      ], createdAt }, { nodeId: "tool" });
      if (omitted === "branch") manager.branch(root);
      const retained = manager.appendMessage({
        id: "retained-message", role: "user", content: [{ type: "text", text: "retained" }], createdAt,
      }, { nodeId: "tool~1" });
      const compaction = omitted === "compaction" ? manager.appendCompaction("summary", retained, 100) : undefined;
      if (storage === "saved") {
        const file = manager.getSessionFile()!;
        manager.closeV4Store();
        manager = SessionManager.open(file);
      }
      if (storage === "compatibility") {
        // Older managers expose full entries but neither metadata paging nor revisions.
        Object.defineProperty(manager, "getEntryProjectionMetadataPage", { value: undefined });
        Object.defineProperty(manager, "getTreeRevision", { value: undefined });
      }
      const facade = pluginSessionManager(manager);
      const fullReads = t.mock.method(manager, "getEntries");
      const ordinalReads = t.mock.method(manager, "getEntrySequence");
      const context = facade.buildContextEntries();
      assert.equal(fullReads.mock.callCount(), storage === "compatibility" ? 1 : 0,
        "context identity mapping must build the compatibility projection at most once");
      assert.equal(ordinalReads.mock.callCount(), 0, "context identity mapping must not build the cold history index");
      fullReads.mock.restore();
      ordinalReads.mock.restore();
      assert.deepEqual(context.map((entry) => entry.id), compaction === undefined
        ? ["root", "tool~1~0"]
        : [compaction, "tool~1~0"]);
      assert.equal(facade.getLeafId(), compaction ?? "tool~1~0");
      const branch = new Map(facade.getBranch().map((entry) => [entry.id, entry]));
      for (const entry of context) {
        assert.deepEqual(facade.getEntry(entry.id), entry);
        assert.deepEqual(branch.get(entry.id), entry);
      }
      const expected = structuredClone(context);
      context[0]!.parentId = "mutated caller result";
      assert.deepEqual(facade.buildContextEntries(), expected);
    });
  }
}

test("extension session pages bound payload materialization across projection spans and live appends", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract-pages" });
  const root = manager.appendMessage({
    id: "paged-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const tools = manager.appendMessage({
    id: "paged-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "paged-call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "paged-call-2", name: "two", content: "second", isError: false },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const child = manager.appendMessage({
    id: "paged-child",
    role: "assistant",
    provider: "paged-provider",
    model: "paged-model",
    content: [{ type: "text", text: "child" }],
    createdAt: "2026-07-21T00:00:02.000Z",
  });
  for (let index = 0; index < 128; index += 1) {
    manager.appendCustomEntry("paged-filler", { index });
  }

  const nativeGetEntries = manager.getEntries.bind(manager);
  const nativeGetEntry = manager.getEntry.bind(manager);
  let fullMaterializations = 0;
  let pageMaterializations = 0;
  manager.getEntries = () => {
    const entries = nativeGetEntries();
    fullMaterializations += entries.length;
    return entries;
  };
  manager.getEntry = (id) => {
    const entry = nativeGetEntry(id);
    if (entry !== undefined) pageMaterializations += 1;
    return entry;
  };

  const session = pluginSessionManager(manager);
  if (!Value.Check(PAGED_SESSION_VALUE, session)) assert.fail("Expected the bounded session-page interface");
  assert.equal(canonicalSessionEntryId(manager, `${tools}~1`), tools);
  assert.equal(canonicalSessionEntryId(manager, "missing"), undefined);
  assert.equal(fullMaterializations, 0, "public mutation IDs must resolve without full payload projection");
  const coldTail = session.getEntriesPage(131, 1);
  assert.equal(coldTail.entries.length, 1);
  assert.equal(coldTail.totalEntries, 132);
  assert.equal(pageMaterializations, 1);
  assert.equal(fullMaterializations, 0);

  const first = session.getEntriesPage(0, 1);
  assert.deepEqual(first.entries.map((entry) => entry.id), [root]);
  assert.equal(first.totalEntries, 132);
  assert.equal(pageMaterializations, 2);
  assert.equal(fullMaterializations, 0);

  const spanning = session.getEntriesPage(2, 2);
  assert.deepEqual(spanning.entries.map((entry) => [entry.id, entry.parentId]), [
    [`${tools}~1`, tools],
    [child, `${tools}~1`],
  ]);
  assert.equal(pageMaterializations, 4);
  assert.equal(fullMaterializations, 0);

  const firstMessage = sessionMessage(first.entries[0]);
  if (!Value.Check(USER_MESSAGE_VALUE, firstMessage)) assert.fail("Expected paged user message");
  firstMessage.content[0] = { type: "text", text: "mutated page" };
  const replayed = session.getEntriesPage(0, 1);
  const replayedMessage = sessionMessage(replayed.entries[0]);
  assert.deepEqual(
    Value.Check(USER_MESSAGE_VALUE, replayedMessage) ? replayedMessage.content : undefined,
    [{ type: "text", text: "root" }],
  );

  manager.appendLabelChange(root, "root label");
  const afterRevision = session.getEntriesPage(0, 1);
  assert.deepEqual(afterRevision.entries.map((entry) => entry.id), [root]);
  assert.equal(fullMaterializations, 0);

  const previousTotal = afterRevision.totalEntries;
  session.appendMessage({
    role: "bashExecution",
    command: "printf live",
    output: "live output",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.parse("2026-07-21T00:00:03.000Z"),
  });
  const appended = session.getEntriesPage(previousTotal, 1);
  assert.equal(appended.totalEntries, previousTotal + 1);
  const appendedMessage = sessionMessage(appended.entries[0]);
  assert.equal(Value.Check(BASH_MESSAGE_VALUE, appendedMessage) ? appendedMessage.role : undefined, "bashExecution");
  assert.equal(
    Value.Check(BASH_MESSAGE_VALUE, appendedMessage) ? appendedMessage.output : undefined,
    "live output",
  );
  assert.equal(fullMaterializations, 0);
  assert.ok(pageMaterializations <= 7, `paged projection materialized ${pageMaterializations} canonical rows`);
});

test("extension session pages preserve projected ID collisions and cursor order", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract-page-collisions" });
  manager.appendMessage({
    id: "row",
    role: "tool",
    content: [
      { type: "tool_result", callId: "collision-1", name: "one", content: "one", isError: false },
      { type: "tool_result", callId: "collision-2", name: "two", content: "two", isError: false },
      { type: "tool_result", callId: "collision-3", name: "three", content: "three", isError: false },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
  }, { nodeId: "row" });
  manager.appendMessage({
    id: "row~1",
    role: "user",
    content: [{ type: "text", text: "collision" }],
    createdAt: "2026-07-21T00:00:01.000Z",
  }, { nodeId: "row~1" });
  manager.appendMessage({
    id: "row~2",
    role: "user",
    content: [{ type: "text", text: "second collision" }],
    createdAt: "2026-07-21T00:00:02.000Z",
  }, { nodeId: "row~2" });

  const session = pluginSessionManager(manager);
  if (!Value.Check(PAGED_SESSION_VALUE, session)) assert.fail("Expected the bounded session-page interface");
  const expected = session.getEntries();
  assert.deepEqual(expected.map((entry) => [entry.id, entry.parentId]), [
    ["row", null],
    ["row~1", "row"],
    ["row~2", "row~1"],
    ["row~1~0", "row~2"],
    ["row~2~0", "row~1~0"],
  ]);
  const replayed = [];
  for (let offset = 0; offset < expected.length; offset += 1) {
    const page: SessionPage = session.getEntriesPage(offset, 1);
    assert.equal(page.totalEntries, expected.length);
    replayed.push(...page.entries);
  }
  assert.deepEqual(replayed, expected);
});

for (const [kind, field] of [
  ["compaction", "firstKeptEntryId"],
  ["branch_summary", "fromId"],
  ["label", "targetId"],
] as const) {
  test(`plugin session ${kind}.${field} references preserve projected ID collisions`, (t) => {
    const manager = SessionManager.inMemory("/tmp", { id: `session-reference-${kind}` });
    t.after(() => manager.closeV4Store());
    const createdAt = "2026-07-21T00:00:00.000Z";
    manager.appendMessage({
      id: "tool-message", role: "tool", createdAt,
      content: [
        { type: "tool_result", callId: "one", name: "one", content: "one", isError: false },
        { type: "tool_result", callId: "two", name: "two", content: "two", isError: false },
      ],
    }, { nodeId: "tool" });
    manager.appendMessage({
      id: "user-message", role: "user", createdAt,
      content: [{ type: "text", text: "referenced user" }],
    }, { nodeId: "tool~1" });
    const reference: CanonicalSessionEntry = kind === "compaction"
      ? manager.getEntry(manager.appendCompaction("summary", "tool~1", 100))!
      : kind === "branch_summary"
        ? manager.getEntry(manager.branchWithSummary("tool~1", "summary"))!
        : { type: "label", id: "label", parentId: "tool~1", timestamp: createdAt, targetId: "tool~1", label: "selected" };
    const readStoredEntries = manager.getEntries.bind(manager);
    const storedBefore = readStoredEntries();
    const nativeEntries = structuredClone(storedBefore);
    if (kind === "label") {
      // V4 labels are state; older managers can expose legacy label entries.
      nativeEntries.push(reference);
      t.mock.method(manager, "getEntries", () => structuredClone(nativeEntries));
      t.mock.method(manager, "getEntry", (id: string) => structuredClone(nativeEntries.find((entry) => entry.id === id)));
      t.mock.method(manager, "buildContextEntries", () => structuredClone(nativeEntries));
      Object.defineProperty(manager, "getEntryProjectionMetadataPage", { value: undefined });
      Object.defineProperty(manager, "getTreeRevision", { value: undefined });
    }
    const nativeBefore = structuredClone(nativeEntries);
    const facade = pluginSessionManager(manager);
    const expected = { ...reference, parentId: "tool~1~0", [field]: "tool~1~0" };
    const pages = Array.from({ length: 4 }, (_, offset) => facade.getEntriesPage(offset, 1).entries).flat();
    for (const [projection, entries] of [
      ["pure", extensionSessionEntries(nativeEntries)],
      ["full", facade.getEntries()],
      ["pages", pages],
      ["single", [facade.getEntry(reference.id)]],
      ["context", facade.buildContextEntries()],
      ["committed", extensionSessionEntriesForCanonicalEntry(manager, reference)],
    ] as const) {
      assert.deepEqual(entries.find((entry) => entry?.id === reference.id), expected, projection);
    }
    assert.equal(canonicalSessionEntryId(manager, "tool~1~0"), "tool~1");
    assert.equal(sessionMessage(facade.getEntry("tool~1~0"))?.role, "user");
    assert.equal(sessionMessage(facade.getEntry("tool~1"))?.role, "toolResult");
    assert.deepEqual(nativeEntries, nativeBefore, "public projection must not rewrite canonical references");
    assert.deepEqual(readStoredEntries(), storedBefore, "public reads must not change native storage");
  });
}

test("extension branch queries apply bounds and limits to projected entries", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "extension-branch-queries" });
  const root = manager.appendMessage({
    id: "branch-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const custom = manager.appendCustomEntry("note", { value: 1 });
  const tools = manager.appendMessage({
    id: "branch-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "branch-call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "branch-call-2", name: "two", content: "second", isError: false },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const session = pluginSessionManager(manager);
  const projectedTail = `${tools}~1`;

  assert.deepEqual(session.findEntriesOnBranch().map((entry) => entry.id), [
    projectedTail,
    tools,
    custom,
    root,
  ]);
  assert.deepEqual(
    session.findEntriesOnBranch({ start: projectedTail, stopAtId: tools }).map((entry) => entry.id),
    [projectedTail, tools],
  );
  assert.deepEqual(
    session.findEntriesOnBranch({ start: projectedTail, order: "oldestFirst", limit: 2 }).map((entry) => entry.id),
    [root, custom],
  );
  assert.deepEqual(
    session.findEntriesOnBranch({ start: projectedTail, customType: "note" }).map((entry) => entry.id),
    [custom],
  );
  assert.equal(session.findEntryOnBranch({ start: projectedTail, type: "message" })?.id, projectedTail);
  assert.deepEqual(session.findEntriesOnBranch({ start: null }), []);
  assert.throws(() => session.findEntriesOnBranch({ start: "missing" }), /Entry missing not found/u);
  assert.throws(() => session.findEntriesOnBranch({ limit: -1 }), /positive integer/u);

  const result = session.findEntriesOnBranch({ start: projectedTail, customType: "note" });
  const projected = result[0];
  if (projected?.type !== "custom" || !isJsonObject(projected.data)) {
    assert.fail("Expected projected custom-entry data");
  }
  projected.data.value = 99;
  const stored = session.getEntry(custom);
  assert.deepEqual(stored?.type === "custom" ? stored.data : undefined, { value: 1 });
});

test("AgentSession publishes queue and committed-session lifecycle events", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-session-events-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "public-events" }),
    providers: new ProviderRegistry(),
    workspace: cwd,
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(async () => await session.close());
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  session.appendCustomEntry("marker", { ready: true });
  session.setSessionName("Contract test");
  const thinkingLevel = session.thinkingLevel === "low" ? "high" : "low";
  session.setThinkingLevel(thinkingLevel);
  session.steer("queued message");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.type === "custom"));
  assert.ok(events.some((event) => event.type === "session_info_changed" && event.name === "Contract test"));
  assert.ok(events.some((event) => event.type === "thinking_level_changed" && event.level === thinkingLevel));
  assert.ok(events.some((event) => (
    event.type === "queue_update" && event.steering.includes("queued message")
  )));
});
