import type {
  Api,
  ApiKeyCredential,
  ApiStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthCheck,
  AuthContext,
  AuthInteraction,
  AuthResult,
  AuthType,
  Context,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  ModelsApiStreamOptions,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsSimpleStreamOptions,
  MutableModels,
  Provider,
  ProviderAuth,
  ProviderCatalogCacheEntry,
  ProviderCatalogStore,
  ProviderHeaders,
  RefreshModelsContext,
  SimpleStreamOptions,
  StreamFn,
} from "./contracts.js";
import { createAssistantMessageEventStream, errorAssistantMessage, lazyStream } from "./streaming.js";

function completionOf(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  return stream.result();
}

export interface CreateModelsOptions {
  credentials?: CredentialStore;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  providers?: readonly Provider[];
  authContext?: Partial<Pick<AuthContext, "env" | "fileExists" | "now">>;
}

interface ApiKeyResolutionInput {
  ctx: AuthContext;
  credential?: ApiKeyCredential;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<string, Credential>();
  readonly #tails = new Map<string, Promise<void>>();

  async read(provider: string): Promise<Credential | undefined> {
    return clone(this.#values.get(provider));
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.#values].map(([providerId, credential]) => {
      const info: CredentialInfo = { providerId, type: credential.type };
      if (credential.type === "oauth") info.expires = credential.expires;
      return info;
    });
  }

  async modify(
    provider: string,
    update: (current: Credential | undefined) => Credential | undefined | Promise<Credential | undefined>,
    signal?: AbortSignal,
  ): Promise<Credential | undefined> {
    signal?.throwIfAborted();
    const previous = this.#tails.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#tails.set(provider, tail);
    await previous;
    try {
      signal?.throwIfAborted();
      const next = await update(clone(this.#values.get(provider)));
      signal?.throwIfAborted();
      if (next === undefined) this.#values.delete(provider);
      else this.#values.set(provider, clone(next)!);
      return clone(next);
    } finally {
      release();
      if (this.#tails.get(provider) === tail) this.#tails.delete(provider);
    }
  }

  async delete(provider: string): Promise<void> {
    await this.modify(provider, () => undefined);
  }
}

export { MemoryCredentialStore as InMemoryCredentialStore };

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryCatalogStore implements ProviderCatalogStore {
  #entry: ProviderCatalogCacheEntry | undefined;

  async read(): Promise<ProviderCatalogCacheEntry | undefined> {
    return clone(this.#entry);
  }

  async write(entry: ProviderCatalogCacheEntry): Promise<void> {
    this.#entry = clone(entry);
  }

  async delete(): Promise<void> {
    this.#entry = undefined;
  }
}

class ModelCollection implements MutableModels {
  readonly #providers = new Map<string, Provider>();
  readonly #catalogs = new Map<string, readonly Model[]>();
  readonly #catalogStores = new Map<string, MemoryCatalogStore>();
  readonly #credentials: CredentialStore;
  readonly #authContext: AuthContext;
  #available: readonly Model[] = [];

  constructor(options: CreateModelsOptions) {
    this.#credentials = options.credentials ?? new MemoryCredentialStore();
    const authContext: AuthContext = {
      env: options.authContext?.env ?? (async (name) => options.env?.[name] ?? globalThis.process?.env[name]),
      fileExists: options.authContext?.fileExists ?? (async () => false),
      credentials: this.#credentials,
    };
    if (options.fetch !== undefined) authContext.fetch = options.fetch;
    if (options.authContext?.now !== undefined) authContext.now = options.authContext.now;
    this.#authContext = authContext;
    for (const provider of options.providers ?? []) this.setProvider(provider);
  }

  setProvider(provider: Provider): void {
    if (!provider.id.trim()) throw new TypeError("Provider id must not be empty");
    this.#providers.set(provider.id, provider);
    this.#catalogs.set(provider.id, validateCatalog(provider, provider.getModels()));
    this.#catalogStores.set(provider.id, new MemoryCatalogStore());
    this.#available = [];
  }

  removeProvider(providerId: string): boolean {
    this.#catalogs.delete(providerId);
    this.#catalogStores.delete(providerId);
    this.#available = this.#available.filter((model) => model.provider !== providerId);
    return this.#providers.delete(providerId);
  }

  getProviders(): readonly Provider[] {
    return [...this.#providers.values()];
  }

  getProvider(providerId: string): Provider | undefined {
    return this.#providers.get(providerId);
  }

  getModels(providerId?: string): readonly Model[] {
    if (providerId !== undefined) return cloneModels(this.#catalogs.get(providerId) ?? []);
    return cloneModels([...this.#catalogs.values()].flat());
  }

  getModel(providerId: string, modelId: string): Model | undefined {
    return clone(this.#catalogs.get(providerId)?.find((model) => model.id === modelId));
  }

  async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    const provider = this.#providers.get(providerId);
    if (!provider) return undefined;
    if (!provider.auth.apiKey && !provider.auth.oauth) return { ok: true, type: "api_key" };
    const credential = await this.#credentials.read(provider.id);
    if (provider.auth.apiKey?.check) {
      const input: ApiKeyResolutionInput = { ctx: this.#context(provider.id) };
      if (credential?.type === "api_key") input.credential = credential;
      const result = await provider.auth.apiKey.check(input);
      if (result) {
        const check: AuthCheck = { ok: true, type: result.type };
        if (result.message !== undefined) check.message = result.message;
        return check;
      }
    }
    const resolved = await this.#resolveAuth(provider);
    return resolved === undefined
      ? { ok: false, message: "No credentials configured for " + provider.name }
      : { ok: true, type: credential?.type ?? "api_key" };
  }

  async getAvailable(providerId?: string): Promise<readonly Model[]> {
    const providers = providerId === undefined
      ? this.getProviders()
      : [this.#providers.get(providerId)].filter((entry): entry is Provider => entry !== undefined);
    const current: Model[] = [];
    for (const provider of providers) {
      const credential = await this.#credentials.read(provider.id);
      const needsAuth = provider.auth.apiKey !== undefined || provider.auth.oauth !== undefined;
      const resolved = needsAuth ? await this.#resolveAuth(provider) : undefined;
      if (needsAuth && !resolved && provider.id !== "ollama") continue;
      const full = cloneModels(this.#catalogs.get(provider.id) ?? []);
      current.push(...(provider.filterModels
        ? validateCatalog(provider, provider.filterModels(full, credential))
        : full));
    }
    const outside = providerId === undefined ? [] : this.#available.filter((model) => model.provider !== providerId);
    this.#available = cloneModels([...outside, ...current]);
    return cloneModels(current);
  }

  getAvailableSnapshot(): readonly Model[] {
    return cloneModels(this.#available);
  }

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options: ModelsApiStreamOptions<TApi> = {},
  ): AssistantMessageEventStream {
    return lazyStream(async () => {
      const provider = this.#providers.get(model.provider);
      if (!provider) return failedStream(model, "Unknown provider: " + model.provider);
      const auth = await this.#resolveAuth(provider);
      if ((provider.auth.apiKey || provider.auth.oauth) && !auth && !options.apiKey && provider.id !== "ollama") {
        return failedStream(model, "No credentials configured for " + provider.name);
      }
      const headers = mergeHeaders(provider.headers, auth?.auth.headers, model.headers, options.headers);
      const selected = auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
      const effective: ApiStreamOptions<TApi> = {
        ...options,
      };
      if (headers !== undefined) effective.headers = headers;
      if (options.apiKey === undefined && auth?.auth.apiKey !== undefined) effective.apiKey = auth.auth.apiKey;
      if (options.env === undefined && auth?.env !== undefined) effective.env = auth.env;
      if (options.fetch === undefined && this.#authContext.fetch !== undefined) effective.fetch = this.#authContext.fetch;
      return provider.stream(selected, context, effective);
    });
  }

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return completionOf(this.stream(model, context, options));
  }

  streamSimple(model: Model, context: Context, options: ModelsSimpleStreamOptions = {}): AssistantMessageEventStream {
    return lazyStream(async () => {
      const provider = this.#providers.get(model.provider);
      if (!provider) return failedStream(model, "Unknown provider: " + model.provider);
      const auth = await this.#resolveAuth(provider);
      if ((provider.auth.apiKey || provider.auth.oauth) && !auth && !options.apiKey && provider.id !== "ollama") {
        return failedStream(model, "No credentials configured for " + provider.name);
      }
      const headers = mergeHeaders(provider.headers, auth?.auth.headers, model.headers, options.headers);
      const selected = auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
      const effective: SimpleStreamOptions = {
        ...options,
      };
      if (headers !== undefined) effective.headers = headers;
      if (options.apiKey === undefined && auth?.auth.apiKey !== undefined) effective.apiKey = auth.auth.apiKey;
      if (options.env === undefined && auth?.env !== undefined) effective.env = auth.env;
      if (options.fetch === undefined && this.#authContext.fetch !== undefined) effective.fetch = this.#authContext.fetch;
      return provider.streamSimple(selected, context, effective);
    });
  }

  completeSimple(model: Model, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
    return completionOf(this.streamSimple(model, context, options));
  }

  async login(providerId: string, type: AuthType | "provider_account", interaction: AuthInteraction): Promise<Credential> {
    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error("Unknown provider: " + providerId);
    let normalized: Credential | undefined;
    if (type === "api_key") {
      normalized = await provider.auth.apiKey?.login?.(interaction);
    } else if (type === "oauth") {
      const credential = await provider.auth.oauth?.login(interaction);
      if (credential) normalized = { ...credential, type: "oauth" };
    } else {
      normalized = await provider.auth.providerAccount?.login(interaction);
    }
    if (!normalized) throw new Error(provider.name + " does not support " + type + " authentication");
    interaction.signal?.throwIfAborted();
    await this.#credentials.modify(providerId, () => {
      interaction.signal?.throwIfAborted();
      return normalized;
    }, interaction.signal);
    this.#available = [];
    return normalized;
  }

  async logout(providerId: string): Promise<void> {
    await this.#credentials.delete(providerId);
    this.#available = this.#available.filter((model) => model.provider !== providerId);
  }

  async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
    const errors = new Map<string, Error>();
    const providers = options.provider === undefined
      ? this.getProviders()
      : [this.#providers.get(options.provider)].filter((entry): entry is Provider => entry !== undefined);
    for (const provider of providers) {
      if (!provider.refreshModels) continue;
      try {
        const credential = await this.#credentials.read(provider.id);
        const context: RefreshModelsContext = {
          store: this.#catalogStores.get(provider.id) ?? new MemoryCatalogStore(),
          allowNetwork: options.allowNetwork ?? true,
        };
        if (credential !== undefined) context.credential = credential;
        if (options.force !== undefined) context.force = options.force;
        if (options.signal !== undefined) context.signal = options.signal;
        if (this.#authContext.fetch !== undefined) context.fetch = this.#authContext.fetch;
        await provider.refreshModels(context);
        this.#catalogs.set(provider.id, validateCatalog(provider, provider.getModels()));
      } catch (cause) {
        errors.set(provider.id, cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
    this.#available = [];
    return { models: this.getModels(), errors, aborted: options.signal?.aborted === true };
  }

  async getAuth(providerOrModel: string | Model): Promise<AuthResult | undefined> {
    const providerId = providerOrModel instanceof Object ? providerOrModel.provider : String(providerOrModel);
    const provider = this.#providers.get(providerId);
    return provider ? this.#resolveAuth(provider) : undefined;
  }

  #context(provider: string): AuthContext {
    return { ...this.#authContext, provider };
  }

  async #resolveAuth(provider: Provider): Promise<AuthResult | undefined> {
    let credential = await this.#credentials.read(provider.id);
    if (credential?.type === "oauth" && provider.auth.oauth) {
      const now = this.#authContext.now?.() ?? Date.now();
      if (credential.expires <= now) {
        credential = await this.#credentials.modify(provider.id, async (stored) => {
          if (stored?.type !== "oauth") return stored;
          const currentNow = this.#authContext.now?.() ?? Date.now();
          if (stored.expires > currentNow) return stored;
          return { ...await provider.auth.oauth!.refresh(stored), type: "oauth" };
        });
      }
      if (credential?.type === "oauth") {
        return {
          auth: await provider.auth.oauth.toAuth(credential),
          source: "stored OAuth credential",
        };
      }
    }
    if (provider.auth.apiKey) {
      const input: ApiKeyResolutionInput = { ctx: this.#context(provider.id) };
      if (credential?.type === "api_key") input.credential = credential;
      return provider.auth.apiKey.resolve(input);
    }
    return undefined;
  }
}

function validateCatalog<TApi extends Api>(provider: Provider<TApi>, models: readonly Model<TApi>[]): readonly Model<TApi>[] {
  const unique = new Map<string, Model<TApi>>();
  for (const model of models) {
    if (!model.id.trim()) throw new TypeError("Model id must not be empty");
    if (unique.has(model.id)) throw new TypeError("Duplicate model id for " + provider.id + ": " + model.id);
    if (model.provider !== provider.id) {
      throw new TypeError("Model " + model.id + " belongs to " + model.provider + ", not " + provider.id);
    }
    if (!model.name.trim()) throw new TypeError("Model " + model.id + " must have a name");
    if (!model.api.trim()) throw new TypeError("Model " + model.id + " must have an API");
    if (!model.baseUrl.trim()) throw new TypeError("Model " + model.id + " must have a base URL");
    if (model.input.length === 0 || model.input.some((input) => input !== "text" && input !== "image")) {
      throw new TypeError("Model " + model.id + " must declare supported input");
    }
    positiveModelNumber(model.id, "contextWindow", model.contextWindow);
    positiveModelNumber(model.id, "maxTokens", model.maxTokens);
    if (model.maxInputTokens !== undefined) positiveModelNumber(model.id, "maxInputTokens", model.maxInputTokens);
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = model.cost?.[field];
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`Model ${model.id} cost.${field} must be a non-negative finite number`);
      }
    }
    unique.set(model.id, structuredClone(model));
  }
  return [...unique.values()];
}

function positiveModelNumber(modelId: string, field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Model ${modelId} ${field} must be a positive safe integer`);
  }
}

function cloneModels<TApi extends Api>(models: readonly Model<TApi>[]): readonly Model<TApi>[] {
  return structuredClone(models);
}

function mergeHeaders(...sources: Array<ProviderHeaders | undefined>): ProviderHeaders | undefined {
  const headers = new Map<string, { name: string; value: string | null }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) headers.set(name.toLowerCase(), { name, value });
  }
  if (headers.size === 0) return undefined;
  return Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));
}

function failedStream(model: Model, cause: string): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const error = errorAssistantMessage(cause, { api: model.api, provider: model.provider, model: model.id });
    output.push({ type: "start", partial: { ...error, stopReason: "pending", errorMessage: undefined } });
    output.push({ type: "error", reason: "error", error });
  });
  return output;
}

export function createModels(options: CreateModelsOptions = {}): MutableModels {
  return new ModelCollection(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string;
  name?: string;
  baseUrl?: string;
  models?: readonly Model<TApi>[];
  auth?: ProviderAuth;
  headers?: ProviderHeaders;
  transport?: StreamFn<TApi>;
  transports?: Partial<Record<TApi, StreamFn<TApi>>>;
  refreshModels?: (context: Parameters<NonNullable<Provider<TApi>["refreshModels"]>>[0]) => Promise<void | readonly Model<TApi>[]>;
  filterModels?: Provider<TApi>["filterModels"];
}

export function createProvider<TApi extends Api = Api>(options: CreateProviderOptions<TApi>): Provider<TApi> {
  let catalog = cloneModels(options.models ?? []);
  const dispatch: StreamFn<TApi> = (model, context, streamOptions) => {
    const transport = options.transports?.[model.api] ?? options.transport;
    if (!transport) return failedStream(model, "Provider " + options.id + " does not implement " + model.api);
    return transport(model, context, streamOptions);
  };
  const core: Provider<TApi> = {
    id: options.id,
    name: options.name ?? options.id,
    auth: options.auth ?? {},
    getModels: () => cloneModels(catalog),
    stream: dispatch,
    streamSimple: dispatch,
  };
  const provider: Provider<TApi> = options.baseUrl === undefined
    ? core
    : { ...core, baseUrl: options.baseUrl };
  if (options.headers !== undefined) provider.headers = options.headers;
  if (options.filterModels !== undefined) provider.filterModels = options.filterModels;
  const refreshModels = options.refreshModels;
  if (refreshModels !== undefined) {
    provider.refreshModels = async (context) => {
      const refreshed = await refreshModels(context);
      if (refreshed) catalog = cloneModels(refreshed);
    };
  }
  return provider;
}
