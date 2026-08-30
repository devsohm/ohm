import { optionalProperties } from "../core/optional-properties.js";
import type {
  AdapterEvent,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
} from "../core/types.js";
import {
  getSupportedThinkingLevels,
  type Models,
  type Provider,
  type ProviderAuth,
  type ProviderModel,
  type ProviderModelThinkingLevel,
} from "./models.js";

const THINKING_LEVELS: readonly ProviderModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const TOKEN_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type TokenPriceField = typeof TOKEN_PRICE_FIELDS[number];

const sourceModelInfo = new WeakMap<ProviderModel, ModelInfo>();

function projectTokenPrices(
  source: Partial<Record<TokenPriceField, number>> | undefined,
) {
  return {
    input: source?.input ?? 0,
    output: source?.output ?? 0,
    cacheRead: source?.cacheRead ?? 0,
    cacheWrite: source?.cacheWrite ?? 0,
  };
}

/**
 * Maps the product adapter boundary into the direct model runtime without
 * allowing request credentials to enter the canonical ProviderRequest.
 */
export function providerFromAdapter(
  adapter: ProviderAdapter,
  options: {
    name?: string;
    auth: ProviderAuth;
    baseUrl?: string;
    initialModels?: readonly ModelInfo[];
    model?: (info: ModelInfo) => ProviderModel;
    allowUnauthenticatedRefresh?: boolean;
    listModels?(signal: AbortSignal): Promise<readonly ModelInfo[]>;
    streamRequest?(
      request: ProviderRequest,
      streamOptions: import("./models.js").ProviderStreamOptions,
      signal: AbortSignal,
      model: ProviderModel,
    ): AsyncIterable<AdapterEvent>;
  },
): Provider {
  const convert: (info: ModelInfo) => ProviderModel = options.model ?? ((info) => providerModelFromInfo(info));
  const baseline = (options.initialModels ?? []).map(convert);
  let models: ProviderModel[] = [...baseline];
  const request = (
    model: ProviderModel,
    context: import("./models.js").ProviderStreamContext,
    streamOptions: import("./models.js").ProviderStreamOptions,
  ): ProviderRequest => ({
    provider: adapter.id,
    model: model.id,
    api: model.api,
    messages: context.messages,
    tools: context.tools ?? [],
    ...optionalProperties(streamOptions.toolChoice === undefined ? undefined : { toolChoice: streamOptions.toolChoice }),
    ...optionalProperties(streamOptions.temperature === undefined ? undefined : { temperature: streamOptions.temperature }),
    ...optionalProperties(streamOptions.cacheRetention === undefined ? undefined : { cacheRetention: streamOptions.cacheRetention }),
    ...optionalProperties(context.providerState === undefined ? undefined : { providerState: context.providerState }),
    ...optionalProperties(streamOptions.maxOutputTokens === undefined ? undefined : { maxOutputTokens: streamOptions.maxOutputTokens }),
    ...optionalProperties(streamOptions.reasoningEffort === undefined ? undefined : { reasoningEffort: streamOptions.reasoningEffort }),
    ...optionalProperties(streamOptions.thinkingBudgets === undefined ? undefined : { thinkingBudgets: streamOptions.thinkingBudgets }),
    ...optionalProperties(streamOptions.sessionId === undefined ? undefined : { sessionId: streamOptions.sessionId }),
    ...optionalProperties(streamOptions.metadata === undefined ? undefined : { metadata: streamOptions.metadata }),
    ...optionalProperties(streamOptions.transport === undefined ? undefined : { transport: streamOptions.transport }),
    ...optionalProperties(streamOptions.timeoutMs === undefined ? undefined : { timeoutMs: streamOptions.timeoutMs }),
    ...optionalProperties(streamOptions.maxRetries === undefined ? undefined : { maxRetries: streamOptions.maxRetries }),
    ...optionalProperties(streamOptions.maxRetryDelayMs === undefined ? undefined : { maxRetryDelayMs: streamOptions.maxRetryDelayMs }),
    ...optionalProperties(streamOptions.onPayload === undefined ? undefined : { onPayload: streamOptions.onPayload }),
    ...optionalProperties(streamOptions.onResponse === undefined ? undefined : { onResponse: streamOptions.onResponse }),
    ...optionalProperties(model.name === model.id && model.compat === undefined && model.headers === undefined &&
      model.thinkingLevelMap === undefined ? undefined : {
          modelSettings: {
            ...optionalProperties(model.name === model.id ? undefined : { displayName: model.name }),
            ...optionalProperties(model.headers === undefined ? undefined : { headers: structuredClone(model.headers) }),
            ...optionalProperties(model.thinkingLevelMap === undefined ? undefined : { reasoningEffortMap: structuredClone(model.thinkingLevelMap) }),
            ...optionalProperties(model.compat === undefined ? undefined : { compatibility: structuredClone(model.compat) }),
          },
        }),
  });
  const stream = (
    model: ProviderModel,
    context: import("./models.js").ProviderStreamContext,
    streamOptions: import("./models.js").ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent> => {
    const signal = streamOptions.signal ?? new AbortController().signal;
    const selected = request(model, context, streamOptions);
    return options.streamRequest === undefined
      ? adapter.stream(selected, signal)
      : options.streamRequest(selected, streamOptions, signal, model);
  };
  return {
    id: adapter.id,
    name: options.name ?? adapter.id,
    ...optionalProperties(options.baseUrl === undefined ? undefined : { baseUrl: options.baseUrl }),
    auth: options.auth,
    getModels: () => models,
    async refreshModels(context) {
      models = [...baseline];
      const stored = await context.store.read();
      if (stored !== undefined) models = [...stored.models];
      if (!context.allowNetwork || context.signal?.aborted) return;
      if (context.credential === undefined && options.allowUnauthenticatedRefresh !== true) return;
      const signal = context.signal ?? new AbortController().signal;
      const refreshed = (await (options.listModels ?? adapter.listModels.bind(adapter))(signal)).map(convert);
      if (context.signal?.aborted) return;
      models = refreshed;
      if (models.every((model) =>
        Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 &&
        Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0)) {
        await context.store.write({ models, checkedAt: Date.now() });
      }
    },
    stream(model, context, streamOptions = {}) {
      return stream(model, context, streamOptions);
    },
    streamSimple(model, context, streamOptions = {}) {
      return stream(model, context, streamOptions);
    },
  };
}

export function providerModelToInfo(model: ProviderModel): ModelInfo {
  const preserved = sourceModelInfo.get(model);
  if (preserved !== undefined) return structuredClone(preserved);
  const observedAt = new Date().toISOString();
  const capability = (supported: boolean) => ({
    value: supported ? "supported" as const : "unsupported" as const,
    source: "configuration" as const,
    observedAt,
  });
  const reasoningEfforts = model.reasoning ? getSupportedThinkingLevels(model) : [];
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.name,
    contextTokens: model.contextWindow,
    ...optionalProperties(model.maxInputTokens === undefined ? undefined : { maxInputTokens: model.maxInputTokens }),
    maxOutputTokens: model.maxTokens,
    capabilities: {
      tools: capability(true),
      reasoning: capability(model.reasoning),
      images: capability(model.input.includes("image")),
    },
    compatibility: {
      protocolFamily: { value: model.api, source: "configuration", observedAt },
      inputModalities: { value: model.input, source: "configuration", observedAt },
      outputModalities: { value: ["text"], source: "configuration", observedAt },
      ...optionalProperties(reasoningEfforts.length === 0 ? undefined : { reasoningEfforts: { value: reasoningEfforts, source: "configuration", observedAt } }),
    },
    pricing: {
      currency: "USD",
      unit: "per_million_tokens",
      source: "configuration",
      observedAt,
      ...projectTokenPrices(model.cost),
    },
  };
}

export function providerAdapterFromModels(models: Models, providerId: ProviderId): ProviderAdapter {
  return {
    id: providerId,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
      const model = models.getModel(providerId, request.model);
      if (model === undefined) {
        yield* errorStream(`Unknown model: ${providerId}/${request.model}`);
        return;
      }
      if (request.api !== undefined && request.api !== model.api) {
        yield* errorStream(`Model ${providerId}/${request.model} declares API ${model.api}, not ${request.api}`);
        return;
      }
      const requestedEffort = THINKING_LEVELS.find((level) => level === request.reasoningEffort);
      const reasoningEffortMap = request.modelSettings?.reasoningEffortMap ?? model.thinkingLevelMap;
      const mappedEffort = requestedEffort === undefined
        ? undefined
        : Object.hasOwn(reasoningEffortMap ?? {}, requestedEffort)
          ? reasoningEffortMap?.[requestedEffort]
          : requestedEffort;
      const wireEffort = model.api === "openai-responses" && mappedEffort === "off"
        ? "none"
        : mappedEffort;
      const requestModel = request.modelSettings === undefined
        ? model
        : {
            ...model,
            ...optionalProperties(request.modelSettings.displayName === undefined ? undefined : { name: request.modelSettings.displayName }),
            ...optionalProperties(request.modelSettings.reasoningEffortMap === undefined ? undefined : { thinkingLevelMap: structuredClone(request.modelSettings.reasoningEffortMap) }),
            ...optionalProperties(request.modelSettings.compatibility === undefined ? undefined : { compat: structuredClone(request.modelSettings.compatibility) }),
          };
      yield* models.stream(requestModel, {
        messages: request.messages,
        tools: request.tools,
        ...optionalProperties(request.providerState === undefined ? undefined : { providerState: request.providerState }),
      }, {
        signal,
        ...optionalProperties(request.maxOutputTokens === undefined ? undefined : { maxOutputTokens: request.maxOutputTokens }),
        ...optionalProperties(wireEffort === undefined || wireEffort === null ? undefined : { reasoningEffort: wireEffort }),
        ...optionalProperties(request.toolChoice === undefined ? undefined : { toolChoice: request.toolChoice }),
        ...optionalProperties(request.temperature === undefined ? undefined : { temperature: request.temperature }),
        ...optionalProperties(request.cacheRetention === undefined ? undefined : { cacheRetention: request.cacheRetention }),
        ...optionalProperties(request.thinkingBudgets === undefined ? undefined : { thinkingBudgets: request.thinkingBudgets }),
        ...optionalProperties(request.sessionId === undefined ? undefined : { sessionId: request.sessionId }),
        ...optionalProperties(request.metadata === undefined ? undefined : { metadata: request.metadata }),
        ...optionalProperties(request.transport === undefined ? undefined : { transport: request.transport }),
        ...optionalProperties(request.timeoutMs === undefined ? undefined : { timeoutMs: request.timeoutMs }),
        ...optionalProperties(request.maxRetries === undefined ? undefined : { maxRetries: request.maxRetries }),
        ...optionalProperties(request.maxRetryDelayMs === undefined ? undefined : { maxRetryDelayMs: request.maxRetryDelayMs }),
        ...optionalProperties(request.onPayload === undefined ? undefined : { onPayload: request.onPayload }),
        ...optionalProperties(request.onResponse === undefined ? undefined : { onResponse: request.onResponse }),
        ...optionalProperties(request.modelSettings?.headers === undefined ? undefined : { headers: request.modelSettings.headers }),
      });
    },
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      signal.throwIfAborted();
      await models.refreshProvider(providerId, { signal });
      signal.throwIfAborted();
      return [...await models.getAvailable(providerId)].map(providerModelToInfo);
    },
  };
}

export function providerModelFromInfo(
  info: ModelInfo,
  providerProtocol?: ProviderModel["api"],
): ProviderModel {
  const api = info.compatibility?.protocolFamily?.value ?? providerProtocol;
  if (api === undefined) throw new TypeError(`Model ${info.provider}/${info.id} does not declare an API protocol`);
  const reportedReasoningEfforts = info.capabilities.reasoning.value === "unsupported"
    ? undefined
    : info.compatibility?.reasoningEfforts?.value;
  const reasoning = info.capabilities.reasoning.value === "supported" ||
    reportedReasoningEfforts?.some((effort) => !["off", "none"].includes(effort.trim().toLocaleLowerCase("en-US"))) === true;
  const thinkingLevelMap = reportedReasoningEfforts === undefined
    ? undefined
    : (() => {
        const normalized = new Set(reportedReasoningEfforts.map((effort) => effort.trim().toLocaleLowerCase("en-US")));
        if (normalized.has("none")) normalized.add("off");
        const selected: NonNullable<ProviderModel["thinkingLevelMap"]> = {};
        for (const level of THINKING_LEVELS) selected[level] = normalized.has(level) ? level : null;
        return selected;
      })();
  const model: ProviderModel = {
    id: info.id,
    name: info.displayName ?? info.id,
    api,
    provider: info.provider,
    baseUrl: "",
    reasoning,
    ...optionalProperties(thinkingLevelMap === undefined ? undefined : { thinkingLevelMap }),
    input: info.capabilities.images.value === "supported" ? ["text", "image"] : ["text"],
    cost: projectTokenPrices(info.pricing),
    contextWindow: info.contextTokens ?? 0,
    ...optionalProperties(info.maxInputTokens === undefined ? undefined : { maxInputTokens: info.maxInputTokens }),
    maxTokens: info.maxOutputTokens ?? 0,
  };
  sourceModelInfo.set(model, structuredClone(info));
  return model;
}

async function* errorStream(message: string): AsyncIterable<AdapterEvent> {
  yield {
    type: "error",
    error: {
      category: "provider",
      message,
      retryable: false,
      partial: false,
    },
  };
}
