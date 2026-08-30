import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamOpenAIResponses } from "../src/api/openai-responses.ts";
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
