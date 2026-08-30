import { optionalProperties } from "../core/optional-properties.js";
import { Value } from "typebox/value";
import type { CredentialBroker } from "../auth/broker.js";
import type { AmbientCredentialDescriptor, AuthCredential } from "../auth/types.js";
import { resolveAwsDefaultCredentials } from "../auth/aws-credentials.js";
import { resolveAzureDefaultCredential } from "../auth/azure-identity.js";
import { resolveGoogleApplicationDefaultCredentials } from "../auth/google-adc.js";
import {
  configuredGitHubCopilotHost,
  exchangeGitHubCopilotToken,
  normalizeGitHubHost,
} from "../auth/github-copilot.js";
import type {
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderId,
} from "../core/types.js";
import { FUNCTION_VALUE, isObjectValue, OBJECT_VALUE } from "../core/value-schemas.js";
import type { NetworkWebSocketFactory } from "../net/index.js";
import {
  OPENAI_CODEX_TRANSPORT_OBSERVER,
  type OpenAICodexTransportObserver,
} from "../providers/openai-codex-observability.js";
import type { ProviderWireTransportHost } from "../providers/wire.js";
import {
  AnthropicAdapter,
  AzureOpenAIResponsesAdapter,
  BedrockAdapter,
  GeminiAdapter,
  GeminiInteractionsAdapter,
  GitHubCopilotAdapter,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  OpenAICodexResponsesAdapter,
  OpenAIResponsesAdapter,
  OpenRouterAdapter,
  VertexAdapter,
  defineRoutedProviderAdapter,
  type AwsCredentials,
  type AnthropicThinkingConfig,
  type FetchLike,
  type OpenAIPromptCacheOptions,
  type OpenAICodexTransport,
  type OpenAICompatibleProfile,
} from "../providers/index.js";

interface RuntimeProviderCredentialBinding {
  /** Credential broker identity. Defaults to the adapter's public identity. */
  credentialProvider?: string;
}

export type RuntimeLeafProviderConfig = RuntimeProviderCredentialBinding & (
  | { kind: "openai"; baseUrl?: string; organization?: string; project?: string; store?: boolean; promptCacheOptions?: OpenAIPromptCacheOptions; promptCacheRetention?: "in-memory" | "24h"; serviceTier?: "auto" | "default" | "flex" | "priority"; deferredToolLoading?: boolean; reasoningSummaries?: boolean; reasoningTextDisplay?: boolean }
  | {
      kind: "openai-codex";
      baseUrl?: string;
      transport?: OpenAICodexTransport;
      webSocketConnectTimeoutMs?: number;
      webSocketIdleTimeoutMs?: number;
    }
  | { kind: "azure-openai"; endpoint: string; store?: boolean }
  | {
      kind: "anthropic";
      id?: ProviderId;
      credentialProvider?: string;
      baseUrl?: string;
      beta?: string[];
      promptCache?: "off" | "5m" | "1h";
      defaultMaxOutputTokens?: number;
      maxTemperature?: number;
      thinking?: AnthropicThinkingConfig;
      thinkingDisplay?: "summarized" | "omitted";
      deferredToolLoading?: boolean;
      eagerToolInputStreaming?: boolean;
    }
  | { kind: "github-copilot"; host?: string }
  | {
      kind: "gemini";
      protocol?: "interactions" | "generate-content";
      baseUrl?: string;
      store?: boolean;
      userProject?: string;
    }
  | { kind: "vertex"; project: string; location?: string; baseUrl?: string; userProject?: string }
  | {
      kind: "bedrock";
      region?: string;
      profile?: string;
      runtimeEndpoint?: string;
      controlEndpoint?: string;
      promptCache?: "off" | "5m" | "1h";
      thinkingDisplay?: "summarized" | "omitted";
      interleavedThinking?: boolean;
    }
  | { kind: "openrouter"; baseUrl?: string; appName?: string; siteUrl?: string; promptCache?: "off" | "5m" | "1h" }
  | { kind: "ollama"; host?: string }
  | {
      kind: "openai-compatible";
      id?: ProviderId;
      baseUrl: string;
      profile?: OpenAICompatibleProfile;
    }
);

export interface RuntimeRoutedProviderRouteConfig {
  model: string;
  adapter: string;
  protocolFamily: ModelProtocolFamily;
  upstreamModel?: string;
  modelInfo?: ModelInfo;
}

export interface RuntimeRoutedProviderConfig extends RuntimeProviderCredentialBinding {
  kind: "routed";
  id: ProviderId;
  adapters: Readonly<Record<string, RuntimeLeafProviderConfig>>;
  routes: readonly RuntimeRoutedProviderRouteConfig[];
  /** Delegate whose authenticated model listing filters maintained routes. */
  catalogAdapter?: string;
}

export type RuntimeProviderConfig = RuntimeLeafProviderConfig | RuntimeRoutedProviderConfig;

interface ProviderAdapterOptions {
  fetch?: FetchLike;
  webSocket?: NetworkWebSocketFactory;
  wire?: ProviderWireTransportHost;
  environment?: NodeJS.ProcessEnv;
}

interface GoogleTokenSources {
  accessToken: (signal?: AbortSignal) => Promise<string | undefined>;
  userProject: (signal?: AbortSignal) => Promise<string | undefined>;
}

function isCodexTransportObserver<Input>(value: Input): value is Input & OpenAICodexTransportObserver {
  return Value.Check(FUNCTION_VALUE, value);
}

function codexTransportObserver(options: ProviderAdapterOptions): OpenAICodexTransportObserver | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(options, OPENAI_CODEX_TRANSPORT_OBSERVER);
  if (descriptor === undefined || !("value" in descriptor) || !isCodexTransportObserver(descriptor.value)) {
    return undefined;
  }
  return descriptor.value;
}

async function credential(
  broker: CredentialBroker,
  provider: string,
  signal?: AbortSignal,
): Promise<Exclude<AuthCredential, AmbientCredentialDescriptor>> {
  const resolved = await broker.resolve({ provider, ...optionalProperties(signal === undefined ? undefined : { signal }) });
  if (resolved === undefined) throw new Error(`No credential is configured for ${provider}`);
  if (resolved.credential.kind === "ambient") {
    throw new Error(`Ambient ${resolved.credential.provider} identity requires a configured token/credential resolver`);
  }
  return resolved.credential;
}

async function optionalCredential(
  broker: CredentialBroker,
  provider: string,
  signal?: AbortSignal,
): Promise<Exclude<AuthCredential, AmbientCredentialDescriptor> | undefined> {
  const resolved = await broker.resolve({ provider, ...optionalProperties(signal === undefined ? undefined : { signal }) });
  if (resolved === undefined || resolved.credential.kind === "ambient") return undefined;
  return resolved.credential;
}

function apiKeyIfPresent(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const found = await credential(broker, provider, signal);
    return found.kind === "api_key" ? found.apiKey : undefined;
  };
}

function anthropicAccessTokenIfPresent(
  broker: CredentialBroker,
  provider: string,
): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const found = await credential(broker, provider, signal);
    if (found.kind === "api_key") return undefined;
    return found.accessToken;
  };
}

function optionalApiKeySource(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const found = await optionalCredential(broker, provider, signal);
    return found?.kind === "api_key" ? found.apiKey : undefined;
  };
}

function googleTokenSources(
  broker: CredentialBroker,
  provider: string,
  configuredUserProject?: string,
  fetchImplementation?: FetchLike,
): GoogleTokenSources {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveGoogleApplicationDefaultCredentials>>> | undefined;
  let activeUserProject: string | undefined;
  const ambient = async (signal?: AbortSignal) => {
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached;
    const resolved = await resolveGoogleApplicationDefaultCredentials({
      ...optionalProperties(fetchImplementation === undefined ? undefined : { fetch: fetchImplementation }),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    if (resolved === undefined) throw new Error("Google application default credentials are unavailable");
    cached = resolved;
    return cached;
  };
  return {
    accessToken: async (signal) => {
      const explicit = await optionalCredential(broker, provider, signal);
      if (explicit?.kind === "api_key" && explicit.apiKey !== undefined) {
        activeUserProject = undefined;
        return undefined;
      }
      if (explicit !== undefined && explicit.kind !== "api_key") {
        if (explicit.expiresAt !== undefined && explicit.expiresAt <= Date.now()) throw new Error(`${provider} bearer credential is expired`);
        activeUserProject = configuredUserProject;
        return explicit.accessToken;
      }
      const token = await ambient(signal);
      activeUserProject = configuredUserProject ?? token.quotaProjectId;
      return token.accessToken;
    },
    userProject: async () => activeUserProject ?? configuredUserProject,
  };
}

function azureTokenSource(
  broker: CredentialBroker,
  fetchImplementation?: FetchLike,
): (signal?: AbortSignal) => Promise<string | undefined> {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveAzureDefaultCredential>>> | undefined;
  return async (signal) => {
    const explicit = await optionalCredential(broker, "azure-openai", signal);
    if (explicit?.kind === "api_key") return undefined;
    if (explicit !== undefined) {
      if (explicit.expiresAt !== undefined && explicit.expiresAt <= Date.now()) throw new Error("azure-openai bearer credential is expired");
      return explicit.accessToken;
    }
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const resolved = await resolveAzureDefaultCredential({
      ...optionalProperties(fetchImplementation === undefined ? undefined : { fetch: fetchImplementation }),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    if (resolved === undefined) throw new Error("Azure default credentials are unavailable");
    cached = resolved;
    return cached.accessToken;
  };
}

function awsCredentialSource(
  fetchImplementation?: FetchLike,
  environment?: NodeJS.ProcessEnv,
  profile?: string,
): (signal?: AbortSignal) => Promise<AwsCredentials> {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveAwsDefaultCredentials>>> | undefined;
  return async (signal) => {
    if (cached !== undefined && (cached.expiresAt === undefined || cached.expiresAt > Date.now() + 60_000)) return cached;
    const resolved = await resolveAwsDefaultCredentials({
      ...optionalProperties(fetchImplementation === undefined ? undefined : { fetch: fetchImplementation }),
      ...optionalProperties(environment === undefined ? undefined : { environment }),
      ...optionalProperties(profile === undefined ? undefined : { profile }),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    if (resolved === undefined) throw new Error("AWS default credentials are unavailable");
    cached = resolved;
    return cached;
  };
}

function bearerSource(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string> {
  return async (signal) => {
    const found = await credential(broker, provider, signal);
    if (found.kind !== "api_key") return found.accessToken;
    if (found.apiKey === undefined) throw new Error(`Credential for ${provider} has no API key`);
    return found.apiKey;
  };
}

function optionalBearerSource(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const resolved = await broker.resolve({ provider, ...optionalProperties(signal === undefined ? undefined : { signal }) });
    if (resolved === undefined) return undefined;
    const found = resolved.credential;
    if (found.kind === "ambient") throw new Error(`Ambient ${found.provider} identity requires a configured token resolver`);
    return found.kind === "api_key" ? found.apiKey : found.accessToken;
  };
}

function githubCopilotCredentialSource(
  broker: CredentialBroker,
  fetchImplementation?: FetchLike,
  configuredHost?: string,
  credentialProvider = "github-copilot",
  environment: NodeJS.ProcessEnv = process.env,
): (signal?: AbortSignal) => Promise<{ accessToken: string; enterpriseHost?: string }> {
  let cached: { sourceToken: string; accessToken: string; expiresAt: number; enterpriseHost?: string } | undefined;
  return async (signal) => {
    const found = await credential(broker, credentialProvider, signal);
    const enterpriseHost = configuredHost === undefined
      ? configuredGitHubCopilotHost(environment)
      : normalizeGitHubHost(configuredHost);
    if (found.kind === "oauth") {
      return {
        accessToken: found.accessToken,
        ...optionalProperties(enterpriseHost === "github.com" ? undefined : { enterpriseHost }),
      };
    }
    const sourceToken = found.kind === "api_key" ? found.apiKey : found.accessToken;
    if (sourceToken === undefined) throw new Error(`Credential for ${credentialProvider} has no API key`);
    if (
      cached !== undefined && cached.sourceToken === sourceToken &&
      cached.enterpriseHost === (enterpriseHost === "github.com" ? undefined : enterpriseHost) &&
      cached.expiresAt > Date.now() + 5 * 60_000
    ) return { accessToken: cached.accessToken, ...optionalProperties(cached.enterpriseHost === undefined ? undefined : { enterpriseHost: cached.enterpriseHost }) };
    const token = await exchangeGitHubCopilotToken(sourceToken, enterpriseHost, {
      ...optionalProperties(fetchImplementation === undefined ? undefined : { fetch: fetchImplementation }),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    cached = {
      sourceToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      ...optionalProperties(enterpriseHost === "github.com" ? undefined : { enterpriseHost }),
    };
    return { accessToken: cached.accessToken, ...optionalProperties(cached.enterpriseHost === undefined ? undefined : { enterpriseHost: cached.enterpriseHost }) };
  };
}

function routedWireHost(
  wire: ProviderWireTransportHost | undefined,
  provider: ProviderId,
): ProviderWireTransportHost | undefined {
  if (wire === undefined) return undefined;
  return {
    wrapFetch(_delegate, fetchImplementation) {
      return wire.wrapFetch(provider, fetchImplementation);
    },
    begin(_delegate) {
      return wire.begin(provider);
    },
  };
}

export function runtimeProviderProtocolFamily(config: RuntimeLeafProviderConfig): ModelProtocolFamily | undefined {
  switch (config.kind) {
    case "openai":
    case "openai-codex":
    case "azure-openai":
      return "openai-responses";
    case "anthropic":
      return "anthropic-messages";
    case "gemini":
      return config.protocol === "generate-content" ? "gemini-generate-content" : "gemini-interactions";
    case "vertex":
      return "gemini-generate-content";
    case "bedrock":
      return "bedrock-converse";
    case "ollama":
      return "ollama-chat";
    case "openrouter":
    case "openai-compatible":
      return "openai-chat-completions";
    case "github-copilot":
      return undefined;
  }
}

function createRoutedProviderAdapter(
  config: RuntimeRoutedProviderConfig,
  broker: CredentialBroker,
  options: ProviderAdapterOptions,
): ProviderAdapter {
  const transportObserver = codexTransportObserver(options);
  if (!Value.Check(OBJECT_VALUE, config.adapters) || Array.isArray(config.adapters)) {
    throw new TypeError(`Routed provider ${config.id} adapters must be an object`);
  }
  const definitions = Object.entries(config.adapters);
  if (definitions.length === 0 || definitions.length > 128) {
    throw new TypeError(`Routed provider ${config.id} must define 1 through 128 adapters`);
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0 || config.routes.length > 20_000) {
    throw new TypeError(`Routed provider ${config.id} must define 1 through 20000 routes`);
  }
  const normalizedDefinitions = new Map<string, RuntimeLeafProviderConfig>();
  for (const [name, definition] of definitions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
      throw new TypeError(`Routed provider ${config.id} adapter name is invalid: ${name}`);
    }
    if (!Value.Check(OBJECT_VALUE, definition) || Array.isArray(definition)) {
      throw new TypeError(`Routed provider ${config.id} adapter ${name} must be an object`);
    }
    const credentialProvider = definition.credentialProvider ?? config.credentialProvider ?? config.id;
    const normalized: RuntimeLeafProviderConfig = { ...definition };
    normalized.credentialProvider = credentialProvider;
    normalizedDefinitions.set(name, normalized);
  }
  for (const [index, route] of config.routes.entries()) {
    if (!isObjectValue(route) || Array.isArray(route)) {
      throw new TypeError(`Routed provider ${config.id} route ${index} must be an object`);
    }
    const definition = normalizedDefinitions.get(route.adapter);
    if (definition === undefined) {
      throw new TypeError(`Routed provider ${config.id} route ${index} references unknown adapter ${route.adapter}`);
    }
    const protocolFamily = runtimeProviderProtocolFamily(definition);
    if (protocolFamily === undefined) {
      throw new TypeError(
        `Routed provider ${config.id} adapter ${route.adapter} selects its protocol dynamically and cannot be used in an exact route`,
      );
    }
    if (protocolFamily !== route.protocolFamily) {
      throw new TypeError(
        `Routed provider ${config.id} route ${index} declares ${route.protocolFamily} but adapter ${route.adapter} uses ${protocolFamily}`,
      );
    }
  }
  if (config.catalogAdapter !== undefined && !normalizedDefinitions.has(config.catalogAdapter)) {
    throw new TypeError(`Routed provider ${config.id} catalog adapter is unknown: ${config.catalogAdapter}`);
  }
  const delegates = new Map<string, ProviderAdapter>();
  const publicWire = routedWireHost(options.wire, config.id);
  for (const [name, normalized] of normalizedDefinitions) {
    delegates.set(name, createProviderAdapter(normalized, broker, {
        ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
        ...optionalProperties(options.webSocket === undefined ? undefined : { webSocket: options.webSocket }),
        ...optionalProperties(publicWire === undefined ? undefined : { wire: publicWire }),
        ...optionalProperties(options.environment === undefined ? undefined : { environment: options.environment }),
        ...optionalProperties(transportObserver === undefined ? undefined : { [OPENAI_CODEX_TRANSPORT_OBSERVER]: transportObserver }),
      }));
  }
  const routed = defineRoutedProviderAdapter({
    id: config.id,
    delegateOwnership: "owned",
    routes: config.routes.map((route, index) => {
      const delegate = delegates.get(route.adapter);
      if (delegate === undefined) {
        throw new TypeError(`Routed provider ${config.id} route ${index} references unknown adapter ${route.adapter}`);
      }
      return {
        model: route.model,
        adapter: delegate,
        protocolFamily: route.protocolFamily,
        ...optionalProperties(route.upstreamModel === undefined ? undefined : { upstreamModel: route.upstreamModel }),
        ...optionalProperties(route.modelInfo === undefined ? undefined : { modelInfo: route.modelInfo }),
      };
    }),
  });
  if (config.catalogAdapter === undefined) return routed;
  const catalogAdapter = delegates.get(config.catalogAdapter)!;
  const routes = new Map(config.routes.map((route) => [route.model, route]));
  return {
    ...routed,
    async listModels(signal) {
      const advertised = new Set((await catalogAdapter.listModels(signal)).map((model) => model.id));
      signal.throwIfAborted();
      return (await routed.listModels(signal)).filter((model) => {
        const route = routes.get(model.id);
        return route !== undefined && advertised.has(route.upstreamModel ?? route.model);
      });
    },
  };
}

export function createProviderAdapter(
  config: RuntimeProviderConfig,
  broker: CredentialBroker,
  options: ProviderAdapterOptions = {},
): ProviderAdapter {
  const transportObserver = codexTransportObserver(options);
  if (config.kind === "routed") return createRoutedProviderAdapter(config, broker, options);
  const credentialProvider = config.credentialProvider ?? runtimeProviderId(config);
  const providerFetch = options.wire?.wrapFetch(
    runtimeProviderId(config),
    options.fetch ?? globalThis.fetch,
  );
  const transport = providerFetch === undefined
    ? options.fetch === undefined ? {} : { fetch: options.fetch }
    : { fetch: providerFetch };
  switch (config.kind) {
    case "openai-codex":
      return new OpenAICodexResponsesAdapter({
        credential: async (signal) => {
          const found = await credential(broker, credentialProvider, signal);
          if (found.kind !== "oauth") throw new Error("OpenAI Codex requires ChatGPT subscription OAuth");
          if (found.accountId === undefined) throw new Error("OpenAI Codex credential has no ChatGPT account ID; run /login openai-codex again");
          return { accessToken: found.accessToken, accountId: found.accountId };
        },
        ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
        ...optionalProperties(config.transport === undefined ? undefined : { transport: config.transport }),
        ...optionalProperties(config.webSocketConnectTimeoutMs === undefined ? undefined : { webSocketConnectTimeoutMs: config.webSocketConnectTimeoutMs }),
        ...optionalProperties(config.webSocketIdleTimeoutMs === undefined ? undefined : { webSocketIdleTimeoutMs: config.webSocketIdleTimeoutMs }),
        ...optionalProperties(options.webSocket === undefined ? undefined : { webSocket: options.webSocket }),
        ...optionalProperties(options.wire === undefined ? undefined : { wire: options.wire }),
        ...optionalProperties(transportObserver === undefined ? undefined : { [OPENAI_CODEX_TRANSPORT_OBSERVER]: transportObserver }),
        ...transport,
      });
    case "openai":
      return new OpenAIResponsesAdapter({
        accessToken: bearerSource(broker, credentialProvider),
        ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
        ...optionalProperties(config.organization === undefined ? undefined : { organization: config.organization }),
        ...optionalProperties(config.project === undefined ? undefined : { project: config.project }),
        ...optionalProperties(config.store === undefined ? undefined : { store: config.store }),
        ...optionalProperties(config.promptCacheOptions === undefined ? undefined : { promptCacheOptions: config.promptCacheOptions }),
        ...optionalProperties(config.promptCacheRetention === undefined ? undefined : { promptCacheRetention: config.promptCacheRetention }),
        ...optionalProperties(config.serviceTier === undefined ? undefined : { serviceTier: config.serviceTier }),
        ...optionalProperties(config.deferredToolLoading === undefined ? undefined : { deferredToolLoading: config.deferredToolLoading }),
        ...optionalProperties(config.reasoningSummaries === undefined ? undefined : { reasoningSummaries: config.reasoningSummaries }),
        ...optionalProperties(config.reasoningTextDisplay === undefined ? undefined : { reasoningTextDisplay: config.reasoningTextDisplay }),
        ...transport,
      });
    case "azure-openai":
      return new AzureOpenAIResponsesAdapter({
        endpoint: config.endpoint,
        apiKey: optionalApiKeySource(broker, credentialProvider),
        accessToken: azureTokenSource(broker, options.fetch),
        ...optionalProperties(config.store === undefined ? undefined : { store: config.store }),
        ...transport,
      });
    case "anthropic":
      return new AnthropicAdapter({
        ...optionalProperties(config.id === undefined ? undefined : { id: config.id }),
        apiKey: apiKeyIfPresent(broker, credentialProvider),
        accessToken: anthropicAccessTokenIfPresent(broker, credentialProvider),
        oauth: async (signal) =>
          runtimeProviderId(config) === "anthropic" &&
          (await credential(broker, credentialProvider, signal)).kind === "oauth",
        ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
        ...optionalProperties(config.beta === undefined ? undefined : { beta: config.beta }),
        ...optionalProperties(config.promptCache === undefined ? undefined : { promptCache: config.promptCache }),
        ...optionalProperties(config.defaultMaxOutputTokens === undefined ? undefined : { defaultMaxOutputTokens: config.defaultMaxOutputTokens }),
        ...optionalProperties(config.maxTemperature === undefined ? undefined : { maxTemperature: config.maxTemperature }),
        ...optionalProperties(config.thinking === undefined ? undefined : { thinking: config.thinking }),
        ...optionalProperties(config.thinkingDisplay === undefined ? undefined : { thinkingDisplay: config.thinkingDisplay }),
        ...optionalProperties(config.deferredToolLoading === undefined ? undefined : { deferredToolLoading: config.deferredToolLoading }),
        ...optionalProperties(config.eagerToolInputStreaming === undefined ? undefined : { eagerToolInputStreaming: config.eagerToolInputStreaming }),
        ...transport,
      });
    case "github-copilot":
      return new GitHubCopilotAdapter({
        credential: githubCopilotCredentialSource(
          broker,
          options.fetch,
          config.host,
          credentialProvider,
          options.environment,
        ),
        ...transport,
      });
    case "gemini": {
      const google = googleTokenSources(broker, credentialProvider, config.userProject, options.fetch);
      const common = {
        apiKey: optionalApiKeySource(broker, credentialProvider),
        accessToken: google.accessToken,
        userProject: google.userProject,
        ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
        ...transport,
      };
      return config.protocol === "generate-content"
        ? new GeminiAdapter(common)
        : new GeminiInteractionsAdapter({ ...common, ...optionalProperties(config.store === undefined ? undefined : { store: config.store }) });
    }
    case "vertex": {
      const google = googleTokenSources(broker, credentialProvider, config.userProject, options.fetch);
      return new VertexAdapter({
        project: config.project,
        apiKey: optionalApiKeySource(broker, credentialProvider),
        accessToken: google.accessToken,
        userProject: google.userProject,
        ...optionalProperties(config.location === undefined ? undefined : { location: config.location }),
        ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
        ...transport,
      });
    }
    case "bedrock": {
      const bearerToken = optionalBearerSource(broker, credentialProvider);
      return new BedrockAdapter({
        ...optionalProperties(config.region === undefined ? undefined : { region: config.region }),
        ...optionalProperties(config.profile === undefined ? undefined : { profile: config.profile }),
        ...optionalProperties(options.environment === undefined ? undefined : { environment: options.environment }),
        bearerToken,
        credentials: awsCredentialSource(options.fetch, options.environment, config.profile),
        ...optionalProperties(config.runtimeEndpoint === undefined ? undefined : { runtimeEndpoint: config.runtimeEndpoint }),
        ...optionalProperties(config.controlEndpoint === undefined ? undefined : { controlEndpoint: config.controlEndpoint }),
        ...optionalProperties(config.promptCache === undefined ? undefined : { promptCache: config.promptCache }),
        ...optionalProperties(config.thinkingDisplay === undefined ? undefined : { thinkingDisplay: config.thinkingDisplay }),
        ...optionalProperties(config.interleavedThinking === undefined ? undefined : { interleavedThinking: config.interleavedThinking }),
        fetch: options.fetch ?? globalThis.fetch,
        ...optionalProperties(options.wire === undefined ? undefined : { wire: options.wire }),
      });
    }
    case "openrouter":
      return new OpenRouterAdapter({
        apiKey: bearerSource(broker, credentialProvider),
        ...optionalProperties(config.baseUrl === undefined ? undefined : { baseUrl: config.baseUrl }),
        ...optionalProperties(config.appName === undefined ? undefined : { appName: config.appName }),
        ...optionalProperties(config.siteUrl === undefined ? undefined : { siteUrl: config.siteUrl }),
        ...optionalProperties(config.promptCache === undefined ? undefined : { promptCache: config.promptCache }),
        ...transport,
      });
    case "ollama":
      {
        const host = config.host ?? "http://127.0.0.1:11434";
        const hostname = new URL(host).hostname;
        const local = ["127.0.0.1", "localhost", "::1"].includes(hostname);
        return new OllamaAdapter({
          ...optionalProperties(local ? undefined : { apiKey: optionalBearerSource(broker, credentialProvider) }),
          host,
          ...transport,
        });
      }
    default: {
      const id = config.id ?? "openai-compatible";
      const provider = config.credentialProvider ?? id;
      return new OpenAICompatibleAdapter({
        id,
        baseUrl: config.baseUrl,
        accessToken: bearerSource(broker, provider),
        ...optionalProperties(config.profile === undefined ? undefined : { profile: config.profile }),
        ...transport,
      });
    }
  }
}

export function runtimeProviderId(config: RuntimeProviderConfig): ProviderId {
  if (config.kind === "routed") return config.id;
  if (config.kind === "openai-compatible") return config.id ?? "openai-compatible";
  if (config.kind === "anthropic") return config.id ?? "anthropic";
  return config.kind;
}
