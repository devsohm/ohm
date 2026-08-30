import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject, type JsonObject } from "../../src/core/json.js";
import { optionalProperties } from "../../src/core/optional-properties.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import {
  bindDirectProviderWireLifecycle,
  loadDirectExtensions,
  type RuntimeAssistantStreamSnapshot,
} from "../../src/extensions/runtime.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";
import type { ToolInvocation } from "../../src/tools/types.js";

const SESSION_INFO_EVENT_VALUE = Type.Object({ name: Type.String() });
const SESSION_COMPACT_EVENT_VALUE = Type.Object({
  compactionEntry: Type.Object({ summary: Type.String() }),
});
const TOOL_UPDATE_EVENT_VALUE = Type.Object({
  partialResult: Type.Object({ content: Type.String() }),
});
const STATUS_EVENT_VALUE = Type.Object({ status: Type.Number() });

interface MutableProviderHeaders {
  [name: string]: string | null;
}

function requireJsonObject<ValueType>(value: ValueType): JsonObject {
  if (!isJsonObject(value)) throw new Error("Provider request fixture must be a JSON object");
  return value;
}

const DIRECT_EVENTS = [
  "resources_discover",
  "project_trust",
  "session_start",
  "session_info_changed",
  "session_shutdown",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "context",
  "input",
  "model_select",
  "thinking_level_select",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "user_bash",
] as const;

function message(id: string, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("direct factories receive every public event and reducer results alter host behavior", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-direct-events-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const payloads = new Map<string, unknown>();
  const toolUpdates: unknown[] = [];
  const observe = (name: string) => (event: { type: string }): void => {
    seen.push(event.type);
    payloads.set(name, event);
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "event-conformance",
      factory(ohm) {
        ohm.on("resources_discover", (event) => {
          observe("resources_discover")(event);
          return { skillPaths: ["skills"], promptPaths: ["prompts"], themePaths: ["themes"] };
        });
        ohm.on("project_trust", (event) => {
          observe("project_trust")(event);
          return { trusted: "yes", remember: true };
        });
        ohm.on("session_start", observe("session_start"));
        ohm.on("session_info_changed", observe("session_info_changed"));
        ohm.on("session_shutdown", observe("session_shutdown"));
        ohm.on("session_before_switch", (event) => {
          observe("session_before_switch")(event);
          return { cancel: true };
        });
        ohm.on("session_before_fork", (event) => {
          observe("session_before_fork")(event);
          return { cancel: true };
        });
        ohm.on("session_before_tree", (event) => {
          observe("session_before_tree")(event);
          return {
            summary: { summary: "extension tree summary", details: { source: "extension" } },
            customInstructions: "focus on the selected branch",
            replaceInstructions: true,
            label: "selected",
          };
        });
        ohm.on("session_tree", observe("session_tree"));
        ohm.on("session_before_compact", (event) => {
          observe("session_before_compact")(event);
          return {
            compaction: {
              summary: "extension compact summary",
              firstKeptEntryId: "entry-keep",
              tokensBefore: 42,
              details: { source: "extension" },
            },
          };
        });
        ohm.on("session_compact", observe("session_compact"));
        ohm.on("session_compact_failed", observe("session_compact_failed"));
        ohm.on("before_agent_start", (event) => {
          observe("before_agent_start")(event);
          return {
            systemPrompt: `${event.systemPrompt}\nextension prompt`,
            message: { customType: "injected", content: "extension context", display: false },
          };
        });
        ohm.on("agent_start", observe("agent_start"));
        ohm.on("agent_end", observe("agent_end"));
        ohm.on("agent_settled", observe("agent_settled"));
        ohm.on("turn_start", observe("turn_start"));
        ohm.on("turn_end", observe("turn_end"));
        ohm.on("message_start", observe("message_start"));
        ohm.on("message_update", observe("message_update"));
        ohm.on("message_end", (event) => {
          observe("message_end")(event);
          return event.message.role === "assistant"
            ? { message: { ...event.message, content: [...event.message.content, { type: "text", text: "extension display" }] } }
            : undefined;
        });
        ohm.on("tool_execution_start", observe("tool_execution_start"));
        ohm.on("tool_execution_update", (event) => {
          toolUpdates.push(event);
          observe("tool_execution_update")(event);
        });
        ohm.on("tool_execution_end", observe("tool_execution_end"));
        ohm.on("tool_call", (event) => {
          observe("tool_call")(event);
          event.input.checked = true;
          if (event.input.block === true) return { block: true, reason: "extension policy" };
        });
        ohm.on("tool_result", (event) => {
          observe("tool_result")(event);
          return {
            content: [...event.content, { type: "text", text: ":extension" }],
            details: { source: "extension" },
            isError: true,
          };
        });
        ohm.on("context", (event) => {
          observe("context")(event);
          return { messages: event.messages.filter((entry) => entry.role !== "toolResult") };
        });
        ohm.on("input", (event) => {
          observe("input")(event);
          return {
            action: "transform",
            text: `${event.text}:extension`,
            ...optionalProperties(event.images === undefined ? undefined : { images: event.images }),
          };
        });
        ohm.on("model_select", observe("model_select"));
        ohm.on("thinking_level_select", observe("thinking_level_select"));
        ohm.on("before_provider_request", (event) => {
          observe("before_provider_request")(event);
          return { ...requireJsonObject(event.payload), extension: true };
        });
        ohm.on("before_provider_headers", (event) => {
          observe("before_provider_headers")(event);
          event.headers["x-added"] = "yes";
          event.headers["x-remove"] = null;
        });
        ohm.on("after_provider_response", observe("after_provider_response"));
        ohm.on("user_bash", (event) => {
          observe("user_bash")(event);
          return event.command === "handled"
            ? { result: { output: "extension output", exitCode: 7, cancelled: false, truncated: false } }
            : undefined;
        });
      },
    }],
  });
  context.after(async () => await host.close());

  const user = message("msg-user", "user", "hello");
  const assistant = message("msg-assistant", "assistant", "answer");
  const tool = message("msg-tool", "tool", "tool output");
  const runScope = { threadId: "thread-1", runId: "run-1", branch: "main", step: 1 };
  const streamAssistant: RuntimeAssistantStreamSnapshot = {
    role: "assistant",
    provider: "fixture",
    model: "fixture-model",
    text: [{ part: 0, text: "answer" }],
    reasoning: [],
    toolCalls: [],
  };
  const invocation: ToolInvocation = {
    callId: "call-1",
    name: "demo",
    input: { value: 1 },
    index: 0,
  };

  assert.deepEqual(await host.resolveProjectTrust({ workspace: root, cwd: root }), {
    decision: "yes",
    remember: true,
  });
  const resources = await host.discoverResources("startup");
  assert.deepEqual(resources.skillPaths.map((entry) => entry.path), ["skills"]);
  assert.deepEqual(resources.promptPaths.map((entry) => entry.path), ["prompts"]);
  assert.deepEqual(resources.themePaths.map((entry) => entry.path), ["themes"]);

  await host.dispatch("session_start", { reason: "startup", threadId: "thread-1", branch: "main" });
  await host.dispatch("session_info_changed", {
    threadId: "thread-1",
    branch: "main",
    name: "named session",
  });
  await host.dispatch("session_shutdown", { reason: "quit" });
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "resume", targetThreadId: "thread-2" }), {
    cancel: true,
  });
  assert.deepEqual(await host.reduceSessionBeforeFork({
    sourceThreadId: "thread-1",
    targetThreadId: "thread-2",
    sourceEventId: "entry-keep",
    position: "at",
  }), {
    cancel: true,
  });
  const treeSignal = new AbortController().signal;
  assert.deepEqual(await host.reduceSessionBeforeTree({
    preparation: {
      targetId: "entry-keep",
      oldLeafId: "entry-old",
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: treeSignal,
  }), {
    summary: { summary: "extension tree summary", details: { source: "extension" } },
    customInstructions: "focus on the selected branch",
    replaceInstructions: true,
    label: "selected",
  });
  await host.dispatch("session_tree", {
    threadId: "thread-1",
    previousEventId: "entry-old",
    currentEventId: "entry-keep",
  });
  const compactSignal = new AbortController().signal;
  assert.deepEqual(await host.reduceSessionBeforeCompact({
    preparation: {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: [user],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 42,
      fileOps: {
        read: new Set(),
        written: new Set(),
        edited: new Set(),
      },
      settings: { enabled: true, reserveTokens: 8, recentTokens: 16, maxInputTokens: 34 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: compactSignal,
  }), {
    compaction: {
      summary: "extension compact summary",
      firstKeptEntryId: "entry-keep",
      tokensBefore: 42,
      details: { source: "extension" },
    },
  });
  await host.dispatch("session_compact", {
    ...runScope,
    reason: "manual",
    summary: {
      id: "compaction-1",
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      purpose: "compaction",
    },
    sourceMessageIds: ["entry-keep"],
    metadata: { firstKeptEntryId: "entry-keep", tokensBefore: 42 },
    fromExtension: true,
    willRetry: false,
  });
  await host.dispatch("session_compact_failed", {
    reason: "threshold",
    aborted: false,
    willRetry: false,
    fromExtension: true,
    category: "protocol",
    errorMessage: "Compaction response was incomplete",
  });

  const beforeAgent = await host.reduceBeforeAgentStart({
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    step: 1,
    prompt: "build",
    systemPrompt: "base prompt",
    systemPromptOptions: { cwd: root, selectedTools: [] },
  });
  assert.equal(beforeAgent.systemPrompt, "base prompt\nextension prompt");
  assert.deepEqual(beforeAgent.messages.map((entry) => entry.customType), ["injected"]);

  await host.dispatch("agent_start", {
    ...runScope,
    provider: "fixture",
    model: "fixture-model",
  });
  await host.dispatch("agent_end", {
    ...runScope,
    outcome: { status: "completed", finishReason: "stop" },
    messages: [assistant],
    messagesTruncated: false,
  });
  await host.dispatch("agent_settled", {
    ...runScope,
    outcome: { status: "completed", finishReason: "stop" },
    messages: [assistant],
    messagesTruncated: false,
  });
  await host.dispatch("turn_start", {
    ...runScope,
    provider: "fixture",
    model: "fixture-model",
    messageCount: 1,
    toolCount: 1,
  });
  await host.dispatch("turn_end", {
    ...runScope,
    provider: "fixture",
    model: "fixture-model",
    outcome: { status: "completed", finishReason: "stop" },
    message: assistant,
    toolResults: [],
  });
  await host.dispatch("message_start", {
    ...runScope,
    role: "assistant",
    provider: "fixture",
    model: "fixture-model",
    message: streamAssistant,
  });
  await host.dispatch("message_update", {
    ...runScope,
    message: streamAssistant,
    kind: "text",
    part: 0,
    delta: "answer",
  });
  const ended = await host.reduceMessageEnd({
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    step: 1,
    message: assistant,
  });
  const finalBlock = ended.content.at(-1);
  assert.equal(finalBlock?.type, "text");
  assert.equal(finalBlock?.type === "text" ? finalBlock.text : undefined, "extension display");
  await host.dispatch("tool_execution_start", { ...runScope, invocation });
  await host.dispatch("tool_execution_update", {
    ...runScope,
    invocation,
    phase: "running",
  });
  await host.dispatch("tool_execution_update", {
    ...runScope,
    invocation,
    phase: "progress",
    sequence: 1,
    progress: { type: "result", content: "working", isError: false },
  });
  await host.dispatch("tool_execution_end", {
    ...runScope,
    invocation,
    outcome: {
      status: "completed",
      isError: false,
      preview: "done",
      result: {
        type: "tool_result",
        callId: "call-1",
        name: "demo",
        content: "done",
        isError: false,
      },
    },
  });

  const allowed = await host.reduceToolCall({
    ...runScope,
    callId: "call-1",
    name: "demo",
    input: { value: 1 },
    index: 0,
  });
  assert.deepEqual(allowed.invocation.input, { value: 1, checked: true });
  assert.equal(allowed.blocked, false);
  const blocked = await host.reduceToolCall({
    ...runScope,
    callId: "call-2",
    name: "demo",
    input: { block: true },
    index: 1,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "extension policy");
  assert.deepEqual(await host.reduceToolResult({
    ...runScope,
    invocation: allowed.invocation,
    result: { content: "base", isError: false },
  }), {
    content: "base:extension",
    contentBlocks: [
      { type: "text", text: "base" },
      { type: "text", text: ":extension" },
    ],
    isError: true,
    metadata: { source: "extension" },
  });
  assert.deepEqual((await host.reduceContext({ ...runScope, messages: [user, tool] })).map((entry) => entry.id), ["msg-user"]);
  assert.deepEqual(await host.reduceInput({
    threadId: "thread-1",
    branch: "main",
    text: "hello",
    source: "interactive",
  }), { action: "transform", text: "hello:extension" });

  await host.dispatch("model_select", {
    threadId: "thread-1",
    branch: "main",
    provider: "fixture",
    model: "fixture-model",
    source: "set",
  });
  await host.dispatch("thinking_level_select", {
    threadId: "thread-1",
    branch: "main",
    level: "high",
    previousLevel: "medium",
    source: "set",
  });
  assert.deepEqual(await host.reduceBeforeUserShell({ command: "handled", cwd: root, hidden: true }), {
    action: "handled",
    command: "handled",
    cwd: root,
    result: { text: "extension output", exitCode: 7, isError: true, cancelled: false },
  });

  const request = await host.applyBeforeProviderRequestPayload({ model: "fixture-model" });
  assert.deepEqual(request, { model: "fixture-model", extension: true });
  const headers: MutableProviderHeaders = { "x-remove": "yes" };
  await host.applyBeforeProviderHeaders(headers);
  assert.deepEqual(headers, { "x-remove": null, "x-added": "yes" });
  await host.observeAfterProviderResponse(201, { "x-request-id": "request-1" });

  assert.deepEqual([...new Set(seen)].sort(), [...DIRECT_EVENTS].sort());
  const sessionInfoEvent = payloads.get("session_info_changed");
  if (!Value.Check(SESSION_INFO_EVENT_VALUE, sessionInfoEvent)) throw new Error("Session info event is invalid");
  assert.equal(sessionInfoEvent.name, "named session");
  const sessionCompactEvent = payloads.get("session_compact");
  if (!Value.Check(SESSION_COMPACT_EVENT_VALUE, sessionCompactEvent)) throw new Error("Session compact event is invalid");
  assert.equal(sessionCompactEvent.compactionEntry.summary, "summary");
  assert.deepEqual(payloads.get("session_compact_failed"), {
    type: "session_compact_failed",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    fromExtension: true,
    category: "protocol",
    errorMessage: "Compaction response was incomplete",
  });
  const toolUpdateEvent = payloads.get("tool_execution_update");
  if (!Value.Check(TOOL_UPDATE_EVENT_VALUE, toolUpdateEvent)) throw new Error("Tool update event is invalid");
  assert.equal(toolUpdates.length, 1);
  assert.equal(toolUpdateEvent.partialResult.content, "working");
  assert.equal("args" in toolUpdateEvent, false);
  const toolEndEvent = payloads.get("tool_execution_end");
  if (!isJsonObject(toolEndEvent)) throw new Error("Tool end event is invalid");
  assert.equal("args" in toolEndEvent, false);
  const responseEvent = payloads.get("after_provider_response");
  if (!Value.Check(STATUS_EVENT_VALUE, responseEvent)) throw new Error("Provider response event is invalid");
  assert.equal(responseEvent.status, 201);
});

test("provider transport gives trusted direct hooks assembled request and complete response headers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-direct-wire-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const observed: Array<{ status: number; headers: Record<string, string> }> = [];
  let headerCalls = 0;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(ohm) => {
      ohm.on("before_provider_request", (event) => {
        return { ...requireJsonObject(event.payload), extension: true };
      });
      ohm.on("before_provider_headers", (event) => {
        headerCalls += 1;
        assert.equal(event.headers.authorization, "Bearer secret");
        event.headers.authorization = "Bearer extension-replacement";
        event.headers["x-added"] = "yes";
        event.headers["x-remove"] = null;
      });
      ohm.on("after_provider_response", (event) => {
        observed.push({
          status: event.status,
          headers: { ...event.headers },
        });
      });
    }],
  });
  const wire = new ProviderWireInterceptorRegistry();
  const unbind = bindDirectProviderWireLifecycle(host, wire);
  context.after(async () => {
    unbind();
    await host.close();
  });

  let outgoingBody: unknown;
  let outgoingHeaders: Headers | undefined;
  const wrapped = wire.wrapFetch("fixture", async (input, init) => {
    const request = new Request(input, init);
    outgoingBody = await request.clone().json();
    outgoingHeaders = new Headers(request.headers);
    return new Response("{}", {
      status: 201,
      headers: {
        "content-type": "application/json",
        "set-cookie": "secret-cookie",
        "x-request-id": "request-1",
      },
    });
  });
  await wire.withScope({ threadId: "thread-1", runId: "run-1", branch: "main", step: 1 }, async () => {
    await wrapped("https://example.test/v1/responses?api_key=secret", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-remove": "yes",
      },
      body: JSON.stringify({ model: "fixture-model" }),
    });
  });

  assert.deepEqual(outgoingBody, { model: "fixture-model", extension: true });
  assert.equal(outgoingHeaders?.get("authorization"), "Bearer extension-replacement");
  assert.equal(outgoingHeaders?.get("x-added"), "yes");
  assert.equal(outgoingHeaders?.has("x-remove"), false);
  assert.deepEqual(observed, [{
    status: 201,
    headers: {
      "content-type": "application/json",
      "set-cookie": "secret-cookie",
      "x-request-id": "request-1",
    },
  }]);

  const socket = wire.withScope(
    { threadId: "thread-1", runId: "socket-1", branch: "main", step: 2 },
    () => wire.begin("fixture"),
  );
  const handshake = await socket.intercept({
    url: "wss://example.test/v1/responses",
    method: "GET",
    headers: new Headers({ authorization: "Bearer secret" }),
    transport: "websocket",
    phase: "handshake",
  }, new AbortController().signal);
  assert.equal(handshake.headers.get("authorization"), "Bearer extension-replacement");
  assert.equal(handshake.headers.get("x-added"), "yes");
  await socket.observe({
    url: "wss://example.test/v1/responses",
    status: 101,
    statusText: "Switching Protocols",
    headers: {},
    transport: "websocket",
    phase: "open",
  }, new AbortController().signal);

  const frame = await socket.intercept({
    url: "wss://example.test/v1/responses",
    method: "SEND",
    headers: new Headers({ authorization: "Bearer secret" }),
    body: { type: "response.create" },
    transport: "websocket",
    phase: "frame",
  }, new AbortController().signal);
  assert.equal(frame.headersChanged, false);
  assert.deepEqual(frame.body, { type: "response.create", extension: true });
  await socket.observe({
    url: "wss://example.test/v1/responses",
    status: 101,
    statusText: "WebSocket Message",
    headers: {},
    transport: "websocket",
    phase: "frame",
    frame: { direction: "receive", bytes: 42, type: "response.done" },
  }, new AbortController().signal);

  assert.equal(headerCalls, 2);
  assert.deepEqual(observed.map((entry) => entry.status), [201, 101]);
});
