import { optionalProperties } from "../core/optional-properties.js";
import { open } from "node:fs/promises";

import type { Api, Model } from "@ohm/models";

import { errorCode, errorMessage } from "../core/errors.js";
import { isJsonObject, type JsonObject } from "../core/json.js";
import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";
import { parseConfiguredModels } from "./registry.js";
import { Value } from "typebox/value";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS = 256;
const MAX_MODELS = 4_096;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function readConfigurationFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("model configuration is not a regular file");
    if (before.size > MAX_CONFIG_BYTES) throw new Error("model configuration exceeds 8 MiB");

    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (bytes > MAX_CONFIG_BYTES) throw new Error("model configuration exceeds 8 MiB");

    const after = await handle.stat();
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("model configuration changed while being read");
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface RuntimeModelDefinition {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: Array<"text" | "image">;
  cost?: Model<Api>["cost"];
  contextWindow?: number;
  maxInputTokens?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface RuntimeProviderDefinition {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Model<Api>["compat"];
  models?: RuntimeModelDefinition[];
}

export interface RuntimeModelConfiguration {
  providers: ReadonlyMap<string, RuntimeProviderDefinition>;
  error?: string;
}

function object<Input>(value: Input, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function text<Input>(value: Input, label: string, optional = true): string | undefined {
  if (value === undefined && optional) return undefined;
  if (
    !Value.Check(STRING_VALUE, value) || value.trim() === "" || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 64 * 1024
  ) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function positive<Input>(value: Input, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return value;
}

function positiveInteger<Input>(value: Input, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function headers<Input>(value: Input, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  if (Object.keys(selected).length > 256) throw new TypeError(`${label} has too many entries`);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(selected)) {
    const header = text(entry, `${label}.${name}`, false);
    if (header !== undefined) result[name] = header;
  }
  return result;
}

function thinkingLevelMap<Input>(value: Input, label: string): Model<Api>["thinkingLevelMap"] {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  const result: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
  for (const [level, mapping] of Object.entries(selected)) {
    const normalizedLevel = THINKING_LEVELS.find((candidate) => candidate === level);
    if (normalizedLevel === undefined || (mapping !== null && !Value.Check(STRING_VALUE, mapping))) {
      throw new TypeError(`${label}.${level} is invalid`);
    }
    if (mapping?.toLocaleLowerCase("en-US") === "ultra") {
      throw new TypeError(`${label}.${level} maps to an unsupported reasoning effort`);
    }
    result[normalizedLevel] = mapping;
  }
  return result;
}

function cost<Input>(value: Input, label: string): Model<Api>["cost"] | undefined {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  const rate = (name: string): number => {
    const entry = selected[name];
    if (!Value.Check(NUMBER_VALUE, entry) || !Number.isFinite(entry) || entry < 0) {
      throw new TypeError(`${label}.${name} must be a non-negative number`);
    }
    return entry;
  };
  return {
    input: rate("input"),
    output: rate("output"),
    cacheRead: rate("cacheRead"),
    cacheWrite: rate("cacheWrite"),
  };
}

function compatibility<Input>(value: Input, label: string): Model<Api>["compat"] {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  const [parsed] = parseConfiguredModels([{
    provider: "openai-compatible",
    id: "runtime-configuration-validation",
    requestCompatibility: selected,
  }]);
  const requestCompatibility = parsed?.requestCompatibility;
  if (requestCompatibility === undefined) return undefined;
  const {
    chatTemplateParameters,
    openRouterRouting,
    vercelGatewayRouting,
    ...compatibleFields
  } = requestCompatibility;
  const chatTemplateKwargs = chatTemplateParameters === undefined
    ? undefined
    : structuredClone(chatTemplateParameters);
  const publicOpenRouterRouting = openRouterRouting === undefined
    ? undefined
    : structuredClone(openRouterRouting);
  const publicVercelGatewayRouting = vercelGatewayRouting === undefined
    ? undefined
    : structuredClone(vercelGatewayRouting);
  if (chatTemplateKwargs !== undefined && !isJsonObject(chatTemplateKwargs)) {
    throw new TypeError(`${label}.chatTemplateParameters must contain JSON data`);
  }
  if (publicOpenRouterRouting !== undefined && !isJsonObject(publicOpenRouterRouting)) {
    throw new TypeError(`${label}.openRouterRouting must contain JSON data`);
  }
  if (publicVercelGatewayRouting !== undefined && !isJsonObject(publicVercelGatewayRouting)) {
    throw new TypeError(`${label}.vercelGatewayRouting must contain JSON data`);
  }
  return {
    ...compatibleFields,
    ...optionalProperties(chatTemplateKwargs === undefined ? undefined : { chatTemplateKwargs }),
    ...optionalProperties(publicOpenRouterRouting === undefined ? undefined : {
      openRouterRouting: publicOpenRouterRouting,
    }),
    ...optionalProperties(publicVercelGatewayRouting === undefined ? undefined : {
      vercelGatewayRouting: publicVercelGatewayRouting,
    }),
  };
}

function model<Input>(value: Input, label: string): RuntimeModelDefinition {
  const selected = object(value, label);
  const id = text(selected.id, `${label}.id`, false);
  if (id === undefined) throw new TypeError(`${label}.id must be a non-empty string`);
  const input = selected.input === undefined
    ? undefined
    : parseInputModes(selected.input, `${label}.input`);
  if (selected.reasoning !== undefined && !Value.Check(BOOLEAN_VALUE, selected.reasoning)) {
    throw new TypeError(`${label}.reasoning must be a boolean`);
  }
  const name = text(selected.name, `${label}.name`);
  const api = text(selected.api, `${label}.api`);
  const baseUrl = text(selected.baseUrl, `${label}.baseUrl`);
  const normalizedThinkingLevelMap = thinkingLevelMap(selected.thinkingLevelMap, `${label}.thinkingLevelMap`);
  const normalizedCost = cost(selected.cost, `${label}.cost`);
  const contextWindow = positive(selected.contextWindow, `${label}.contextWindow`);
  const maxInputTokens = positiveInteger(selected.maxInputTokens, `${label}.maxInputTokens`);
  const maxTokens = positive(selected.maxTokens, `${label}.maxTokens`);
  const normalizedHeaders = headers(selected.headers, `${label}.headers`);
  const compat = compatibility(selected.compat, `${label}.compat`);
  return {
    id,
    ...optionalProperties(name === undefined ? undefined : { name }),
    ...optionalProperties(api === undefined ? undefined : { api }),
    ...optionalProperties(baseUrl === undefined ? undefined : { baseUrl }),
    ...optionalProperties(selected.reasoning === undefined ? undefined : { reasoning: selected.reasoning }),
    ...optionalProperties(normalizedThinkingLevelMap === undefined ? undefined : {
      thinkingLevelMap: normalizedThinkingLevelMap,
    }),
    ...optionalProperties(input === undefined ? undefined : { input }),
    ...optionalProperties(normalizedCost === undefined ? undefined : { cost: normalizedCost }),
    ...optionalProperties(contextWindow === undefined ? undefined : { contextWindow }),
    ...optionalProperties(maxInputTokens === undefined ? undefined : { maxInputTokens }),
    ...optionalProperties(maxTokens === undefined ? undefined : { maxTokens }),
    ...optionalProperties(normalizedHeaders === undefined ? undefined : { headers: normalizedHeaders }),
    ...optionalProperties(compat === undefined ? undefined : { compat }),
  };
}

function parseInputModes<Input>(value: Input, label: string): Array<"text" | "image"> {
  if (!Array.isArray(value)) throw new TypeError(`${label} must contain only text or image`);
  return value.map((entry) => {
    if (entry !== "text" && entry !== "image") {
      throw new TypeError(`${label} must contain only text or image`);
    }
    return entry;
  });
}

function provider<Input>(value: Input, label: string): RuntimeProviderDefinition {
  const selected = object(value, label);
  if (selected.authHeader !== undefined && !Value.Check(BOOLEAN_VALUE, selected.authHeader)) {
    throw new TypeError(`${label}.authHeader must be a boolean`);
  }
  let models: RuntimeModelDefinition[] | undefined;
  if (selected.models !== undefined) {
    if (!Array.isArray(selected.models) || selected.models.length > MAX_MODELS) {
      throw new TypeError(`${label}.models must be a bounded array`);
    }
    models = selected.models.map((entry, index) => model(entry, `${label}.models[${index}]`));
  }
  const name = text(selected.name, `${label}.name`);
  const baseUrl = text(selected.baseUrl, `${label}.baseUrl`);
  const apiKey = text(selected.apiKey, `${label}.apiKey`);
  const api = text(selected.api, `${label}.api`);
  const normalizedHeaders = headers(selected.headers, `${label}.headers`);
  const compat = compatibility(selected.compat, `${label}.compat`);
  return {
    ...optionalProperties(name === undefined ? undefined : { name }),
    ...optionalProperties(baseUrl === undefined ? undefined : { baseUrl }),
    ...optionalProperties(apiKey === undefined ? undefined : { apiKey }),
    ...optionalProperties(api === undefined ? undefined : { api }),
    ...optionalProperties(normalizedHeaders === undefined ? undefined : { headers: normalizedHeaders }),
    ...optionalProperties(selected.authHeader === undefined ? undefined : { authHeader: selected.authHeader }),
    ...optionalProperties(compat === undefined ? undefined : { compat }),
    ...optionalProperties(models === undefined ? undefined : { models }),
  };
}

function stripComments(input: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    const next = input[index + 1];
    if (quoted) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quoted = false;
      continue;
    }
    if (current === '"') {
      quoted = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

export async function loadRuntimeModelConfiguration(path: string | undefined): Promise<RuntimeModelConfiguration> {
  if (path === undefined) return { providers: new Map() };
  try {
    const content = await readConfigurationFile(path);
    const root = object(JSON.parse(stripComments(content)), "Model configuration");
    const entries = Object.entries(object(root.providers, "Model configuration.providers"));
    if (entries.length > MAX_PROVIDERS) throw new Error("model configuration has too many providers");
    const providers = new Map<string, RuntimeProviderDefinition>();
    for (const [id, value] of entries) {
      text(id, "Provider id", false);
      if (id === "__proto__" || id === "prototype" || id === "constructor") throw new TypeError("Provider id is invalid");
      providers.set(id, provider(value, `Provider ${id}`));
    }
    return { providers };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { providers: new Map() };
    return {
      providers: new Map(),
      error: `Failed to load model configuration: ${errorMessage(error)}\n\nFile: ${path}`,
    };
  }
}
