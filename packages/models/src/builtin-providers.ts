import type {
  Api,
  JsonObject,
  JsonValue,
  Model,
  OAuthAuth,
  OAuthCredentials,
  Provider,
  ProviderAuth,
  ProviderHeaders,
  RefreshModelsContext,
} from "./contracts.js";
import {
  apiKeyMethod,
  browserOAuthMethod,
  deviceOAuthMethod,
  type BrowserOAuthConfig,
  type DeviceOAuthConfig,
} from "./auth-flows.js";
import {
  anthropicModels,
  deepseekModels,
  githubCopilotModels,
  googleModels,
  kimiCodeModels,
  ollamaModels,
  openaiCodexModels,
  openaiModels,
  opencodeGoModels,
  opencodeModels,
  openrouterModels,
  xaiModels,
} from "./catalogs.js";
import { createProvider, type CreateProviderOptions } from "./model-runtime.js";
import { streamByApi } from "./protocol-transports.js";

export interface ProviderFactoryOptions {
  baseUrl?: string;
  models?: readonly Model[];
  headers?: ProviderHeaders;
  oauth?: OAuthAuth;
}

export interface XaiOAuthOptions {
  clientId: string;
  mode?: "browser" | "device";
  authorizationUrl?: string;
  deviceUrl?: string;
  tokenUrl?: string;
  scopes?: readonly string[];
  redirectUri?: string;
  fetch?: typeof globalThis.fetch;
}

function configuredModels(
  provider: string,
  defaults: readonly Model[],
  baseUrl: string,
  options: ProviderFactoryOptions,
): readonly Model[] {
  return (options.models ?? defaults).map((model) => ({
    ...structuredClone(model),
    provider,
    baseUrl: options.baseUrl ?? model.baseUrl ?? baseUrl,
  }));
}

function builtIn(
  id: string,
  name: string,
  defaults: readonly Model[],
  baseUrl: string,
  environment: readonly string[],
  options: ProviderFactoryOptions = {},
  auth: ProviderAuth = { apiKey: apiKeyMethod("API key", environment) },
): Provider {
  const providerOptions: CreateProviderOptions = {
    id,
    name,
    baseUrl: options.baseUrl ?? baseUrl,
    models: configuredModels(id, defaults, baseUrl, options),
    auth: options.oauth ? { ...auth, oauth: options.oauth } : auth,
    transport: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
  };
  if (options.headers !== undefined) providerOptions.headers = options.headers;
  return createProvider(providerOptions);
}

export function openaiProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("openai", "OpenAI", openaiModels, "https://api.openai.com/v1", ["OPENAI_API_KEY"], options);
}

export function anthropicProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("anthropic", "Anthropic", anthropicModels, "https://api.anthropic.com", ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"], options);
}

export function googleProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("google", "Google", googleModels, "https://generativelanguage.googleapis.com", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], options);
}

export function openrouterProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("openrouter", "OpenRouter", openrouterModels, "https://openrouter.ai/api/v1", ["OPENROUTER_API_KEY"], options);
}

export function deepseekProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("deepseek", "DeepSeek", deepseekModels, "https://api.deepseek.com/v1", ["DEEPSEEK_API_KEY"], options);
}

export function kimiCodeProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("kimi-code", "Kimi Code", kimiCodeModels, "https://api.kimi.com/coding/v1", ["KIMI_CODE_API_KEY"], options);
}

export function opencodeProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("opencode", "OpenCode Zen", opencodeModels, "https://opencode.ai/zen/v1", ["OPENCODE_API_KEY"], options);
}

export function opencodeGoProvider(options: ProviderFactoryOptions = {}): Provider {
  let catalog = configuredModels("opencode-go", opencodeGoModels, "https://opencode.ai/zen/go/v1", options);
  const baseUrl = options.baseUrl ?? "https://opencode.ai/zen/go/v1";
  const auth: ProviderAuth = {
    apiKey: apiKeyMethod("OpenCode Go API key", ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]),
  };
  if (options.oauth !== undefined) auth.oauth = options.oauth;
  const provider: Provider = {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl,
    auth,
    getModels: () => catalog,
    async refreshModels(context) {
      catalog = await refreshOpenCodeGo(catalog, baseUrl, context);
    },
    stream: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
    streamSimple: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
  };
  if (options.headers !== undefined) provider.headers = options.headers;
  return provider;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && value.constructor === Object;
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return value !== null && value !== undefined && value.constructor === String ? String(value) : undefined;
}

async function refreshOpenCodeGo(
  reviewed: readonly Model[],
  baseUrl: string,
  context: RefreshModelsContext,
): Promise<readonly Model[]> {
  if (!context.allowNetwork) return (await context.store.read())?.models ?? reviewed;
  const credential = context.credential;
  const key = credential?.type === "api_key" ? credential.key : credential?.access;
  if (!key) return reviewed;
  const request: RequestInit = {
    headers: { authorization: "Bearer " + key, accept: "application/json" },
  };
  if (context.signal !== undefined) request.signal = context.signal;
  const response = await (context.fetch ?? globalThis.fetch)(baseUrl.replace(/\/+$/u, "") + "/models", request);
  if (!response.ok) throw new Error("OpenCode Go model discovery failed with HTTP " + response.status);
  const value: JsonValue = await response.json();
  const entries = isJsonObject(value) && Array.isArray(value.data) ? value.data : [];
  const live = new Set(entries.flatMap((item) => {
    const id = isJsonObject(item) ? jsonString(item.id) : undefined;
    return id === undefined ? [] : [id];
  }));
  const next = reviewed.filter((model) => live.has(model.id));
  await context.store.write({ models: next, checkedAt: Date.now() });
  return next;
}

export function openaiCodexProvider(options: ProviderFactoryOptions = {}): Provider {
  const auth: ProviderAuth = {};
  if (options.oauth !== undefined) auth.oauth = options.oauth;
  return builtIn(
    "openai-codex",
    "OpenAI Codex",
    openaiCodexModels,
    "https://chatgpt.com/backend-api/codex",
    [],
    options,
    auth,
  );
}

export function githubCopilotProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("github-copilot", "GitHub Copilot", githubCopilotModels, "https://api.githubcopilot.com", ["COPILOT_GITHUB_TOKEN"], options);
}

export function xaiProvider(options: ProviderFactoryOptions & { xaiOAuth?: XaiOAuthOptions } = {}): Provider {
  const oauth = options.xaiOAuth ? createXaiOAuth(options.xaiOAuth) : options.oauth;
  const auth: ProviderAuth = {
    apiKey: apiKeyMethod("xAI API key", ["XAI_API_KEY"]),
  };
  if (oauth !== undefined) auth.oauth = oauth;
  return builtIn(
    "xai",
    "xAI",
    xaiModels,
    "https://api.x.ai/v1",
    ["XAI_API_KEY"],
    options,
    auth,
  );
}

export function createXaiOAuth(options: XaiOAuthOptions): OAuthAuth {
  const scopes = options.scopes ?? ["openid", "offline_access"];
  const tokenUrl = options.tokenUrl ?? "https://auth.x.ai/oauth2/token";
  if (options.mode === "device") {
    const config: DeviceOAuthConfig = {
      name: "Sign in with SuperGrok or X Premium",
      clientId: options.clientId,
      deviceUrl: options.deviceUrl ?? "https://auth.x.ai/oauth2/device_authorization",
      tokenUrl,
      scopes,
    };
    if (options.fetch !== undefined) config.fetch = options.fetch;
    return deviceOAuthMethod(config);
  }
  const config: BrowserOAuthConfig = {
    name: "Sign in with SuperGrok or X Premium",
    authorizationUrl: options.authorizationUrl ?? "https://auth.x.ai/oauth2/authorize",
    tokenUrl,
    clientId: options.clientId,
    scopes,
    redirectUri: options.redirectUri ?? "http://127.0.0.1:56121/callback",
  };
  if (options.fetch !== undefined) config.fetch = options.fetch;
  return browserOAuthMethod(config);
}

export function ollamaProvider(options: ProviderFactoryOptions = {}): Provider {
  let catalog = configuredModels("ollama", ollamaModels, "http://127.0.0.1:11434/v1", options);
  const base = options.baseUrl ?? "http://127.0.0.1:11434";
  return {
    id: "ollama",
    name: "Ollama",
    baseUrl: base,
    auth: { apiKey: apiKeyMethod("Optional API key", ["OLLAMA_API_KEY"]) },
    getModels: () => catalog,
    async refreshModels(context) {
      if (!context.allowNetwork) {
        catalog = (await context.store.read())?.models ?? catalog;
        return;
      }
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : credential?.access;
      const request: RequestInit = {};
      if (key !== undefined && key !== "") request.headers = { authorization: "Bearer " + key };
      if (context.signal !== undefined) request.signal = context.signal;
      const response = await (context.fetch ?? globalThis.fetch)(base.replace(/\/+$/u, "") + "/api/tags", request);
      if (!response.ok) throw new Error("Ollama discovery failed with HTTP " + response.status);
      const value: JsonValue = await response.json();
      const entries = isJsonObject(value) && Array.isArray(value.models) ? value.models : [];
      catalog = entries.flatMap((entry) => {
        const name = isJsonObject(entry) ? jsonString(entry.name) : undefined;
        if (name === undefined) return [];
        const model: Model<"openai-completions"> = {
        id: name,
        name,
        api: "openai-completions",
        provider: "ollama",
        baseUrl: base.replace(/\/+$/u, "") + "/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
        };
        return [model];
      });
      await context.store.write({ models: catalog, checkedAt: Date.now() });
    },
    stream: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
    streamSimple: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
  };
}

export const builtinProviderFactories = Object.freeze({
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
  "github-copilot": githubCopilotProvider,
  google: googleProvider,
  "kimi-code": kimiCodeProvider,
  ollama: ollamaProvider,
  "openai-codex": openaiCodexProvider,
  openai: openaiProvider,
  opencode: opencodeProvider,
  "opencode-go": opencodeGoProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
});

const builtinProviderFactoryMap = new Map<string, () => Provider>(Object.entries(builtinProviderFactories));

export function getBuiltinProviders(): readonly Provider[] {
  return Object.values(builtinProviderFactories).map((factory) => factory());
}

export function getBuiltinProvider(id: string): Provider | undefined {
  const factory = builtinProviderFactoryMap.get(id);
  return factory?.();
}

export function apiProvider<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  return provider;
}

export function oauthAccessToken(credentials: OAuthCredentials): string {
  return credentials.access;
}
