import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@ohm/models";

import { projectSessionWireEvent } from "../../src/interfaces/session-wire.js";
import type { AgentSessionEvent } from "../../src/service/agent-session.js";

function message(text = ""): AssistantMessage {
  return {
    role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture",
    content: [{ type: "text", text }], usage: { input: 4, output: text.length },
    stopReason: "pending", timestamp: 1,
  };
}

function update(partial: AssistantMessage, assistantMessageEvent: AssistantMessageEvent): AgentSessionEvent {
  return { type: "message_update", message: partial, assistantMessageEvent };
}

test("wire deltas omit cumulative snapshots without changing SDK events", () => {
  const partial = message("previous plus delta");
  const event = update(partial, { type: "text_delta", contentIndex: 0, delta: "delta", partial });
  const before = structuredClone(event);
  assert.deepEqual(projectSessionWireEvent(event), {
    type: "message_update", streamVersion: 1, usage: partial.usage,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta" },
  });
  assert.deepEqual(event, before);
});

test("wire tool starts retain identity and subsequent argument deltas reconstruct input", () => {
  const partial = message();
  partial.content = [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }];
  const start = projectSessionWireEvent(update(partial, { type: "toolcall_start", contentIndex: 0, partial }));
  assert.equal(start.type, "message_update");
  if (start.type !== "message_update") assert.fail("Expected a message update");
  assert.deepEqual(start.assistantMessageEvent, { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "lookup" });
  let input = "";
  for (const delta of ['{"query":', '"hello"}']) {
    const event = projectSessionWireEvent(update(partial, { type: "toolcall_delta", contentIndex: 0, delta, partial }));
    assert.equal(event.type, "message_update");
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
      input += event.assistantMessageEvent.delta;
    }
  }
  assert.deepEqual(JSON.parse(input), { query: "hello" });
});

test("wire keeps authoritative boundaries and all progress kinds", () => {
  const partial = message("complete");
  for (const event of [
    { type: "message_start", message: partial },
    { type: "message_end", message: partial },
    { type: "agent_settled" },
  ] satisfies AgentSessionEvent[]) assert.equal(projectSessionWireEvent(event), event);
  for (const event of [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_end", contentIndex: 0, content: "complete", partial },
    { type: "thinking_start", contentIndex: 0, partial },
    { type: "thinking_delta", contentIndex: 0, delta: "visible reasoning", partial },
    { type: "thinking_end", contentIndex: 0, content: "visible reasoning", partial },
    { type: "done", reason: "stop", message: partial },
    { type: "error", reason: "aborted", error: partial },
  ] satisfies AssistantMessageEvent[]) {
    const projected = projectSessionWireEvent(update(partial, event));
    assert.equal(projected.type, "message_update");
    if (projected.type === "message_update") {
      assert.equal(projected.assistantMessageEvent.type, event.type);
      assert.equal("partial" in projected.assistantMessageEvent, false);
      assert.deepEqual(projected.usage, partial.usage);
    }
  }
});

test("wire output grows linearly with fixed-sized text deltas", (context) => {
  function bytes(count: number, compact: boolean): number {
    let total = 0;
    const delta = "x".repeat(128);
    for (let index = 1; index <= count; index += 1) {
      const partial = message(delta.repeat(index));
      const event = update(partial, { type: "text_delta", contentIndex: 0, delta, partial });
      total += Buffer.byteLength(JSON.stringify(compact ? projectSessionWireEvent(event) : event));
    }
    return total;
  }
  const before = bytes(512, false);
  const after = bytes(512, true);
  const doubled = bytes(1_024, true);
  assert.ok(doubled < after * 2.1);
  assert.ok(after < before / 50);
  context.diagnostic(JSON.stringify({ chunks: 512, snapshotBytes: before, deltaBytes: after, doubledDeltaBytes: doubled }));
});
