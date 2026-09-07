import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { appendGrammarInputDelta, type GrammarInputBuffer } from "../src/api/constrained-sampling.ts";
import {
  generateImage,
  getImageModels,
  openrouterImagesProvider,
  registerImageProvider,
  unregisterImageProvider,
} from "../src/image-runtime.ts";
import type { Context, ImageModel, JsonObject, JsonValue } from "../src/index.ts";
import { captureFetch, collect, model, sse, userContext } from "./black-box-helpers.ts";

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && value.constructor === Object;
}

function jsonObject(value: JsonValue | undefined): JsonObject {
  assert.ok(isJsonObject(value));
  return value;
}

function jsonArray(value: JsonValue | undefined): JsonValue[] {
  assert.ok(Array.isArray(value));
  return value;
}

test("Kimi tool schemas gain required structural types without mutating the caller schema", async () => {
  const parameters = Type.Unsafe({
    properties: {
      mode: { enum: ["fast", "safe"] },
      nested: { properties: { value: { type: "string" } }, required: ["value"] },
      rows: { items: { properties: { id: { type: "number" } } } },
    },
    required: ["mode"],
  });
  const original = structuredClone(parameters);
  const context: Context = {
    ...userContext(),
    tools: [{ name: "search", description: "Search", parameters }],
  };
  const mock = captureFetch(() => sse(["[DONE]"]));
  await collect(streamOpenAICompletions(model("openai-completions", {
    id: "kimi-k3",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
  }), context, { apiKey: "key", fetch: mock.fetch, maxRetries: 0 }));

  const tools = jsonArray(mock.requests[0]?.body.tools);
  const normalized = jsonObject(jsonObject(tools[0]).function).parameters;
  const normalizedObject = jsonObject(normalized);
  const properties = jsonObject(normalizedObject.properties);
  assert.equal(normalizedObject.type, "object");
  assert.equal(jsonObject(properties.mode).type, "string");
  assert.equal(jsonObject(properties.nested).type, "object");
  assert.equal(jsonObject(properties.rows).type, "array");
  assert.deepEqual(parameters, original);
});

test("Responses grammar tools use an explicitly advertised reviewed variant", async () => {
  const context: Context = {
    ...userContext(),
    tools: [{
      name: "expression",
      description: "Return one expression",
      parameters: Type.Object({ input: Type.String() }),
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: "start: /[0-9]+/" },
      },
    }],
  };
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  await collect(streamOpenAIResponses(model("openai-responses", {
    compat: { supportsOpenAIGrammarTools: true },
  }), context, { apiKey: "key", fetch: mock.fetch, maxRetries: 0 }));
  const tool = jsonArray(mock.requests[0]?.body.tools)[0];
  assert.deepEqual(tool, {
    type: "custom",
    name: "expression",
    description: "Return one expression",
    format: { type: "grammar", syntax: "lark", definition: "start: /[0-9]+/" },
  });
});

test("grammar fragments escape property names and preserve their JSON value", () => {
  const property = 'co"de\\line';
  const buffer: GrammarInputBuffer = { value: "" };
  const json = appendGrammarInputDelta(buffer, property, "first", false)
    + appendGrammarInputDelta(buffer, property, "first\nsecond", false)
    + appendGrammarInputDelta(buffer, property, "first\nsecond", true);
  assert.deepEqual(JSON.parse(json), { [property]: "first\nsecond" });
});

for (const responses of [false, true]) {
  test(`${responses ? "Responses" : "Chat"} forced tools use their own wire shape`, async () => {
    const context: Context = { ...userContext(), tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({}) }] };
    const mock = captureFetch(() => sse<JsonValue>(responses ? [{ type: "response.completed", response: {} }] : ["[DONE]"]));
    const options = { apiKey: "dummy", fetch: mock.fetch, maxRetries: 0, toolChoice: { type: "function" as const, function: { name: "lookup" } } };
    if (responses) await collect(streamOpenAIResponses(model("openai-responses"), context, options));
    else await collect(streamOpenAICompletions(model("openai-completions"), context, options));
    assert.deepEqual(mock.requests[0]?.body.tool_choice, responses
      ? { type: "function", name: "lookup" }
      : { type: "function", function: { name: "lookup" } });
  });
}

for (const deltas of [["12", "3"], ["\ud83d", "\ude00"]]) {
test(`Responses grammar arguments preserve ${JSON.stringify(deltas)} in fragments and final input`, async () => {
  const input = deltas.join("");
  const context: Context = { ...userContext(), tools: [{
    name: "expression", description: "Expression", parameters: Type.Object({ code: Type.String() }),
    constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[0-9]+/" } },
  }] };
  const mock = captureFetch(() => sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "item", call_id: "call", name: "expression" } },
    ...deltas.map((delta) => ({ type: "response.custom_tool_call_input.delta", item_id: "item", delta })),
    { type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "item", call_id: "call", name: "expression", input } },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses", { compat: { supportsOpenAIGrammarTools: true } }), context, { apiKey: "dummy", fetch: mock.fetch, maxRetries: 0 }));
  assert.equal(result.terminal.stopReason, "toolUse");
  const tool = result.terminal.content.find((part) => part.type === "toolCall");
  assert.deepEqual(tool?.arguments, { code: input });
  const fragments = result.events.flatMap((event) => event.type === "toolcall_delta" ? [event.delta] : []).join("");
  assert.deepEqual(JSON.parse(fragments), { code: input });
});
}

test("Responses grammar history and forced choice retain custom tool semantics", async () => {
  const selected = model("openai-responses", { compat: { supportsOpenAIGrammarTools: true } });
  const context: Context = { ...userContext(), tools: [{
    name: "expression", description: "Expression", parameters: Type.Object({ code: Type.String() }),
    constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[0-9]+/" } },
  }] };
  context.messages.push({
    role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, usage: {}, stopReason: "toolUse", timestamp: 1,
    content: [{ type: "toolCall", id: "call", name: "expression", arguments: { code: "123" } }],
  });
  context.messages.push({
    role: "toolResult", toolCallId: "call", toolName: "expression", isError: false, timestamp: 2,
    content: [{ type: "text", text: "ok" }],
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  await collect(streamOpenAIResponses(selected, context, {
    apiKey: "dummy", fetch: mock.fetch, maxRetries: 0, toolChoice: { type: "function", function: { name: "expression" } },
  }));
  assert.deepEqual(mock.requests[0]?.body.tool_choice, { type: "custom", name: "expression" });
  assert.deepEqual(jsonArray(mock.requests[0]?.body.input).slice(-2), [
    { type: "custom_tool_call", call_id: "call", name: "expression", input: "123" },
    { type: "custom_tool_call_output", call_id: "call", output: "ok" },
  ]);
});

test("image registration is provider-scoped and generation returns canonical blocks", async () => {
  const entry: ImageModel = {
    id: "image-model",
    name: "Image model",
    provider: "black-box-images",
    baseUrl: "https://images.example/v1",
  };
  registerImageProvider({
    id: "black-box-images",
    name: "Black box images",
    models: [entry],
    async generate(model, request) {
      return {
        model: model.id,
        provider: model.provider,
        images: [{ data: btoa(request.prompt), mimeType: "image/png" }],
      };
    },
  });
  try {
    assert.deepEqual(getImageModels("black-box-images"), [entry]);
    const result = await generateImage(entry, { prompt: "pixel" });
    assert.deepEqual(result.images, [{ data: "cGl4ZWw=", mimeType: "image/png" }]);
  } finally {
    unregisterImageProvider("black-box-images");
  }
});

test("OpenRouter image payloads normalize aspect ratio and data URLs", async () => {
  let payload: JsonObject | undefined;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const parsed: JsonValue = JSON.parse(String(init?.body));
    assert.ok(isJsonObject(parsed));
    payload = parsed;
    return Response.json({
      choices: [{ message: { images: [{ image_url: { url: "data:image/webp;base64,YWJj" } }] } }],
    });
  };
  const provider = openrouterImagesProvider({ apiKey: "key", fetch });
  const result = await provider.generate(provider.models[0]!, { prompt: "draw", size: "1024x768" });
  assert.deepEqual(payload?.image_config, { aspect_ratio: "4:3" });
  assert.deepEqual(result.images, [{ data: "YWJj", mimeType: "image/webp" }]);
});
