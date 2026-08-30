import { optionalProperties } from "../core/optional-properties.js";
import type { Api } from "@ohm/models";

import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import type { ModelProtocolFamily } from "../core/types.js";
import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";
import { protocolFromPublicApi } from "../extensions/model-boundary.js";
import { OHM_VERSION } from "../version.js";
import type { Provider, ProviderModel, ProviderRefreshContext } from "./models.js";
import { parseStoredProviderModels } from "./registry.js";
import { Value } from "typebox/value";

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const REMOTE_CATALOG_TIMEOUT_MS = 15_000;
const REMOTE_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const REMOTE_CATALOG_MAX_MODELS = 4_096;
const REMOTE_CATALOG_MAX_DEPTH = 32;
const REMOTE_CATALOG_MAX_NODES = 100_000;
const INTERNAL_PROTOCOLS = new Set<ModelProtocolFamily>([
  "anthropic-messages",
  "bedrock-converse",
  "extension-stream",
  "gemini-generate-content",
  "gemini-interactions",
  "ollama-chat",
  "openai-chat-completions",
  "openai-responses",
]);

function finite<Input>(value: Input, name: string): number {
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Remote model ${name} must be a finite non-negative number`);
  }
  return value;
}

function positive<Input>(value: Input, name: string): number {
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Remote model ${name} must be a positive safe integer`);
  }
  return value;
}

function protocol<Input>(value: Input): ModelProtocolFamily {
  if (!Value.Check(STRING_VALUE, value) || value.trim() === "") {
    throw new TypeError("Remote model API must be a non-empty string");
  }
  const internal = [...INTERNAL_PROTOCOLS].find((candidate) => candidate === value);
  return internal ?? protocolFromPublicApi(value satisfies Api);
}

function modelFromCatalog(provider: Provider, value: JsonValue): ProviderModel {
  if (!isJsonObject(value) || !Value.Check(STRING_VALUE, value.id) || value.id.trim() === "") {
    throw new TypeError(`Remote model catalog for ${provider.id} contains an invalid model`);
  }
  const existing = provider.getModels().find((model) => model.id === value.id);
  const baseUrl = Value.Check(STRING_VALUE, value.baseUrl) && value.baseUrl.trim() !== ""
    ? value.baseUrl
    : existing?.baseUrl ?? provider.baseUrl;
  if (baseUrl === undefined) throw new TypeError(`Remote model ${provider.id}/${value.id} is missing baseUrl`);
  const input = Array.isArray(value.input)
    ? value.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : existing?.input;
  if (input === undefined || input.length === 0) throw new TypeError(`Remote model ${provider.id}/${value.id} is missing input modes`);
  const cost = isJsonObject(value.cost) ? value.cost : existing?.cost;
  if (cost === undefined) throw new TypeError(`Remote model ${provider.id}/${value.id} is missing cost metadata`);
  let costTiers: JsonValue[] | undefined;
  if (Array.isArray(cost.tiers)) {
    costTiers = [];
    for (const tier of cost.tiers) {
      if (!isJsonObject(tier)) throw new TypeError(`Remote model ${provider.id}/${value.id} has invalid cost tiers`);
      costTiers.push(structuredClone(tier));
    }
  }
  const maxInputTokens = value.maxInputTokens ?? existing?.maxInputTokens;
  const candidate: JsonObject = {
    id: value.id,
    name: Value.Check(STRING_VALUE, value.name) && value.name.trim() !== "" ? value.name : existing?.name ?? value.id,
    api: protocol(value.api ?? existing?.api),
    provider: provider.id,
    baseUrl,
    reasoning: Value.Check(BOOLEAN_VALUE, value.reasoning) ? value.reasoning : existing?.reasoning ?? false,
    input,
    cost: {
      input: finite(cost.input, "input cost"),
      output: finite(cost.output, "output cost"),
      cacheRead: finite(cost.cacheRead, "cache-read cost"),
      cacheWrite: finite(cost.cacheWrite, "cache-write cost"),
      ...optionalProperties(costTiers === undefined ? undefined : { tiers: costTiers }),
    },
    contextWindow: finite(value.contextWindow ?? existing?.contextWindow, "context window"),
    ...optionalProperties(maxInputTokens === undefined
      ? undefined
      : { maxInputTokens: positive(maxInputTokens, "maximum input tokens") }),
    maxTokens: finite(value.maxTokens ?? existing?.maxTokens, "maximum output tokens"),
    ...optionalProperties(isJsonObject(value.thinkingLevelMap)
      ? { thinkingLevelMap: structuredClone(value.thinkingLevelMap) }
      : undefined),
    ...optionalProperties(isJsonObject(value.headers)
      ? {
          headers: Object.fromEntries(
            Object.entries(value.headers).filter((entry): entry is [string, string] =>
              Value.Check(STRING_VALUE, entry[1])),
          ),
        }
      : undefined),
    ...optionalProperties(isJsonObject(value.compat) ? { compat: structuredClone(value.compat) } : undefined),
  };
  const [model] = parseStoredProviderModels(provider.id, [candidate], `Remote model catalog for ${provider.id}`);
  if (model === undefined) throw new TypeError(`Remote model catalog for ${provider.id} contains an invalid model`);
  return model;
}

function catalogEntries(value: JsonValue): JsonValue[] {
  const entries = Array.isArray(value)
    ? value
    : isJsonObject(value) && Array.isArray(value.models)
      ? value.models
      : isJsonObject(value)
        ? Object.values(value)
        : undefined;
  if (entries === undefined) throw new TypeError("Remote model catalog response must contain models");
  if (entries.length > REMOTE_CATALOG_MAX_MODELS) {
    throw new TypeError(`Remote model catalog contains too many models (maximum ${REMOTE_CATALOG_MAX_MODELS})`);
  }
  return entries;
}

function assertCatalogBounds(value: JsonValue): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > REMOTE_CATALOG_MAX_NODES) throw new TypeError("Remote model catalog contains too much metadata");
    if (current.depth > REMOTE_CATALOG_MAX_DEPTH) {
      throw new TypeError("Remote model catalog metadata is nested too deeply");
    }
    if (Value.Check(STRING_VALUE, current.value)) {
      if (Buffer.byteLength(current.value, "utf8") > 256 * 1024) {
        throw new TypeError("Remote model catalog contains an oversized string");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > REMOTE_CATALOG_MAX_MODELS) {
        throw new TypeError("Remote model catalog contains an oversized array");
      }
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isJsonObject(current.value)) continue;
    const entries = Object.entries(current.value);
    if (entries.length > REMOTE_CATALOG_MAX_MODELS) {
      throw new TypeError("Remote model catalog contains an oversized object");
    }
    for (const [key, child] of entries) {
      if (Buffer.byteLength(key, "utf8") > 512) {
        throw new TypeError("Remote model catalog contains an oversized metadata key");
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

async function responseJson(response: Response): Promise<JsonValue> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new TypeError("Remote model catalog response has an invalid content length");
    }
    if (Number(declaredLength) > REMOTE_CATALOG_MAX_BYTES) {
      throw new TypeError(`Remote model catalog response exceeds ${REMOTE_CATALOG_MAX_BYTES} bytes`);
    }
  }
  if (response.body === null) throw new TypeError("Remote model catalog response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > REMOTE_CATALOG_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TypeError(`Remote model catalog response exceeds ${REMOTE_CATALOG_MAX_BYTES} bytes`);
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  if (!isJsonValue(parsed)) throw new TypeError("Remote model catalog response must be JSON");
  catalogEntries(parsed);
  assertCatalogBounds(parsed);
  return parsed;
}

function mergeModels(baseline: readonly ProviderModel[], overlay: readonly ProviderModel[]): ProviderModel[] {
  const merged = [...baseline];
  const indexById = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    const id = merged[index]!.id;
    if (!indexById.has(id)) indexById.set(id, index);
  }
  for (const model of overlay) {
    const index = indexById.get(model.id);
    if (index === undefined) {
      indexById.set(model.id, merged.length);
      merged.push(model);
    } else {
      merged[index] = model;
    }
  }
  return merged;
}

function validEtag<Input>(value: Input): string | undefined {
  if (!Value.Check(STRING_VALUE, value) || value.length > 1_024) return undefined;
  const quoted = value.startsWith("W/\"") ? value.slice(2) : value;
  if (!quoted.startsWith("\"") || !quoted.endsWith("\"") || quoted.length < 2) return undefined;
  for (const character of quoted.slice(1, -1)) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x21 || code === 0x22 || code > 0x7e) return undefined;
  }
  return value;
}

/** Add an explicitly configured, persisted HTTP catalog overlay to a provider. */
export function withRemoteCatalog(provider: Provider, catalogBaseUrl: string): Provider {
  let overlay: readonly ProviderModel[] = [];
  let active: Promise<void> | undefined;
  return {
    ...provider,
    getModels: () => mergeModels(provider.getModels(), overlay),
    refreshModels(context: ProviderRefreshContext) {
      active ??= (async () => {
        try {
          overlay = [];
          const stored = await context.store.read();
          if (stored !== undefined) overlay = stored.models.filter((model) => model.provider === provider.id);
          if (!context.allowNetwork || context.signal?.aborted) return;
          if (!context.force && stored?.checkedAt !== undefined && Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS) return;
          const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
          const etag = validEtag(stored?.etag);
          const signal = context.signal === undefined
            ? AbortSignal.timeout(REMOTE_CATALOG_TIMEOUT_MS)
            : AbortSignal.any([context.signal, AbortSignal.timeout(REMOTE_CATALOG_TIMEOUT_MS)]);
          const response = await fetch(url, {
            headers: {
              accept: "application/json",
              "user-agent": `ohm/${OHM_VERSION}`,
              ...optionalProperties(etag === undefined ? undefined : { "if-none-match": etag }),
            },
            signal,
          });
          if (context.signal?.aborted) return;
          const checkedAt = Date.now();
          if (response.status === 304) {
            await context.store.write({ models: overlay, checkedAt, ...optionalProperties(etag === undefined ? undefined : { etag }) });
            return;
          }
          if (response.status === 404 || response.status === 501) {
            await context.store.write({ models: overlay, checkedAt, ...optionalProperties(etag === undefined ? undefined : { etag }) });
            return;
          }
          if (!response.ok) {
            await context.store.write({ models: overlay, checkedAt, ...optionalProperties(etag === undefined ? undefined : { etag }) });
            throw new Error(`Remote model catalog request failed for ${provider.id}: ${response.status}`);
          }
          const next = catalogEntries(await responseJson(response)).map((entry) => modelFromCatalog(provider, entry));
          if (context.signal?.aborted) return;
          overlay = next;
          const nextEtag = validEtag(response.headers.get("etag"));
          await context.store.write({ models: next, checkedAt, ...optionalProperties(nextEtag === undefined ? undefined : { etag: nextEtag }) });
        } finally {
          active = undefined;
        }
      })();
      return active;
    },
  };
}
