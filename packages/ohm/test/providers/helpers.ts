import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";
import {
  isJsonObject,
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../src/core/json.js";
import { Type } from "typebox";
import { Check } from "typebox/value";

const JSON_NUMBER = Type.Number();
const JSON_STRING = Type.String();

export function byteChunks(value: string | Uint8Array, sizes: number[] = []): Uint8Array[] {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  if (sizes.length === 0) return [...bytes].map((byte) => Uint8Array.of(byte));
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + size)));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
}

export function readable(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function streamResponse(
  chunks: Uint8Array[],
  headers: HeadersInit = { "content-type": "text/event-stream" },
  status = 200,
): Response {
  return new Response(readable(chunks), { status, headers });
}

export function fakeFetch(factory: (request: Request) => Response | Promise<Response>): typeof fetch {
  const fetchFixture: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    return await factory(request);
  };
  return fetchFixture;
}

export function parseJsonValue(value: string): JsonValue {
  return toJsonValue(JSON.parse(value));
}

export function parseJsonObject(value: string): JsonObject {
  return jsonObject(parseJsonValue(value));
}

export async function readJsonObject(message: Request | Response): Promise<JsonObject> {
  return jsonObject(toJsonValue(await message.json()));
}

export function jsonObject(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) throw new TypeError("Expected a JSON object fixture");
  return value;
}

export function jsonArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError("Expected a JSON array fixture");
  return value;
}

export function jsonObjects(value: JsonValue | undefined): JsonObject[] {
  const selected = jsonArray(value);
  if (!selected.every((entry) => isJsonObject(entry))) {
    throw new TypeError("Expected a JSON object array fixture");
  }
  return selected;
}

export function jsonString(value: JsonValue | undefined): string {
  if (!Check(JSON_STRING, value)) throw new TypeError("Expected a JSON string fixture");
  return value;
}

export function jsonNumber(value: JsonValue | undefined): number {
  if (!Check(JSON_NUMBER, value)) throw new TypeError("Expected a JSON number fixture");
  return value;
}

export async function collect(iterable: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export function request(provider: ProviderRequest["provider"]): ProviderRequest {
  return {
    provider,
    model: "test-model",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ],
    tools: [],
  };
}

export function terminalCount(events: AdapterEvent[]): number {
  return events.filter((event) => event.type === "response_end" || event.type === "error").length;
}
