import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject, JsonValue } from "../../src/core/json.js";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import {
  byteChunks,
  collect,
  fakeFetch,
  parseJsonObject,
  readJsonObject,
  request,
  streamResponse,
  terminalCount,
} from "./helpers.js";

function sse(value: JsonValue): string {
  return `data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`;
}

test("Moonshot chat uses max_tokens, binary thinking, and durable reasoning content", async () => {
  let body: JsonObject | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "moonshotai",
    baseUrl: "https://api.moonshot.ai/v1",
    profile: "moonshot",
    fetch: fakeFetch(async (incoming) => {
      body = await readJsonObject(incoming);
      return streamResponse(byteChunks(sse({
        id: "moonshot-response",
        model: "kimi-k2.6",
        choices: [{
          index: 0,
          delta: { reasoning_content: "checked", content: "done" },
          finish_reason: "stop",
        }],
      })));
    }),
  });
  const input = request("moonshotai");
  input.model = "kimi-k2.6";
  input.maxOutputTokens = 123;
  input.reasoningEffort = "high";

  const events = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(body?.max_tokens, 123);
  assert.equal(body?.max_completion_tokens, undefined);
  assert.deepEqual(body?.thinking, { type: "enabled" });
  const end = events.at(-1);
  assert.equal(end?.type, "response_end");
  const assistantMessage = end?.type === "response_end" && end.state.kind === "chat_completions"
    ? parseJsonObject(JSON.stringify(end.state.assistantMessage))
    : undefined;
  assert.equal(assistantMessage?.reasoning_content, "checked");
});

test("Moonshot always-thinking models omit the rejected disabled thinking value", async () => {
  let body: JsonObject | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "moonshotai-cn",
    baseUrl: "https://api.moonshot.cn/v1",
    profile: "moonshot",
    fetch: fakeFetch(async (incoming) => {
      body = await readJsonObject(incoming);
      return streamResponse(byteChunks(sse({
        id: "moonshot-response",
        model: "kimi-k2.7-code",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      })));
    }),
  });
  const input = request("moonshotai-cn");
  input.model = "kimi-k2.7-code";
  input.reasoningEffort = "off";
  input.modelSettings = { reasoningEffortMap: { off: null } };

  assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);
  assert.equal(body?.thinking, undefined);
  assert.equal(body?.reasoning_effort, undefined);
});

test("Moonshot K3 sends its explicit reasoning effort instead of binary thinking", async () => {
  let body: JsonObject | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "moonshotai",
    baseUrl: "https://api.moonshot.ai/v1",
    profile: "moonshot",
    fetch: fakeFetch(async (incoming) => {
      body = await readJsonObject(incoming);
      return streamResponse(byteChunks(sse({
        id: "moonshot-response",
        model: "kimi-k3",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      })));
    }),
  });
  const input = request("moonshotai");
  input.model = "kimi-k3";
  input.reasoningEffort = "max";
  input.modelSettings = {
    compatibility: {
      reasoningFormat: "openai",
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
  };

  assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);
  assert.equal(body?.reasoning_effort, "max");
  assert.equal(body?.thinking, undefined);
});
