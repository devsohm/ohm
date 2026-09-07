import type {
  AuthContext, AuthResult, ImageGenerationOptions, ImageModel, ImageModelsRefreshContext,
  ImageProvider, ImageRequest, ImageResult, ModelsRefreshOptions, ProviderHeaders,
} from "./contracts.js";
import { MemoryCredentialStore, type CreateModelsOptions } from "./model-runtime.js";
import { resolveProviderAuth, type ProviderAuthRequest } from "./provider-auth.js";

export interface CreateImageModelsOptions extends Omit<CreateModelsOptions, "providers"> {
  providers?: readonly ImageProvider[];
}

export interface ImageModelsRefreshResult {
  models: readonly ImageModel[];
  errors: ReadonlyMap<string, Error>;
  aborted: boolean;
}

export interface ImageModels {
  getProviders(): readonly ImageProvider[];
  getModels(provider?: string): readonly ImageModel[];
  getModel(provider: string, id: string): ImageModel | undefined;
  getAuth(provider: string, request?: { apiKey?: string; signal?: AbortSignal }): Promise<AuthResult | undefined>;
  generateImage(model: ImageModel, request: ImageRequest, options?: ImageGenerationOptions): Promise<ImageResult>;
  refresh(options?: ModelsRefreshOptions): Promise<ImageModelsRefreshResult>;
}

export interface MutableImageModels extends ImageModels {
  setProvider(provider: ImageProvider): void;
  deleteProvider(id: string): boolean;
}

function catalog(provider: ImageProvider, models: readonly ImageModel[]): readonly ImageModel[] {
  const ids = new Set<string>();
  for (const model of models) {
    if (!model.id.trim() || !model.name.trim() || !model.baseUrl.trim()
      || model.provider !== provider.id || ids.has(model.id)) {
      throw new TypeError(`Invalid or duplicate image model for ${provider.id}`);
    }
    ids.add(model.id);
  }
  return structuredClone(models);
}

function headers(base: ProviderHeaders | undefined, request: ProviderHeaders | undefined): ProviderHeaders | undefined {
  const values = new Map<string, { name: string; value: string | null }>();
  for (const source of [base, request]) {
    for (const [name, value] of Object.entries(source ?? {})) values.set(name.toLowerCase(), { name, value });
  }
  return values.size === 0 ? undefined : Object.fromEntries([...values.values()].map(({ name, value }) => [name, value]));
}

/** An isolated image catalog and credential boundary; registration never changes other collections. */
export function createImageModels(options: CreateImageModelsOptions = {}): MutableImageModels {
  const providers = new Map<string, ImageProvider>();
  const catalogs = new Map<string, readonly ImageModel[]>();
  const refreshes = new Map<string, { options: ModelsRefreshOptions; promise: Promise<void> }>();
  const credentials = options.credentials ?? new MemoryCredentialStore();
  const env = options.env ?? globalThis.process?.env ?? {};
  const context: AuthContext = {
    env: options.authContext?.env ?? (async (name) => env[name]),
    fileExists: options.authContext?.fileExists ?? (async () => false),
    credentials,
    ...options.authContext,
  };
  if (options.fetch !== undefined) context.fetch = options.fetch;
  const collection: MutableImageModels = {
    getProviders: () => [...providers.values()],
    getModels: (provider) => structuredClone(provider === undefined
      ? [...catalogs.values()].flat() : catalogs.get(provider) ?? []),
    getModel: (provider, id) => collection.getModels(provider).find((model) => model.id === id),
    async getAuth(id, request = {}) {
      const provider = providers.get(id);
      return provider === undefined ? undefined : resolveProviderAuth(provider, context, credentials, request);
    },
    async generateImage(model, request, invocation = {}) {
      request.signal?.throwIfAborted();
      const provider = providers.get(model.provider);
      if (provider === undefined) throw new Error(`Unknown image provider: ${model.provider}`);
      const authorization: ProviderAuthRequest = {};
      if (invocation.apiKey !== undefined) authorization.apiKey = invocation.apiKey;
      if (request.signal !== undefined) authorization.signal = request.signal;
      const auth = await resolveProviderAuth(provider, context, credentials, authorization);
      request.signal?.throwIfAborted();
      const selected = { ...model, baseUrl: invocation.baseUrl ?? auth?.auth.baseUrl ?? model.baseUrl };
      const resolved: ImageGenerationOptions = { ...invocation };
      const key = invocation.apiKey ?? auth?.auth.apiKey;
      const merged = headers(auth?.auth.headers, invocation.headers);
      const fetch = invocation.fetch ?? options.fetch;
      if (key !== undefined) resolved.apiKey = key;
      if (merged !== undefined) resolved.headers = merged;
      if (fetch !== undefined) resolved.fetch = fetch;
      return provider.generate(selected, request, resolved);
    },
    async refresh(request = {}) {
      const errors = new Map<string, Error>();
      const selected = request.provider === undefined ? [...providers.values()]
        : [providers.get(request.provider)].filter((provider): provider is ImageProvider => provider !== undefined);
      await Promise.all(selected.map(async (provider) => {
        if (provider.refreshModels === undefined) return;
        try {
          request.signal?.throwIfAborted();
          const current = refreshes.get(provider.id);
          let pending = current?.options.allowNetwork === request.allowNetwork
            && current?.options.force === request.force && current?.options.signal === request.signal
            ? current?.promise : undefined;
          if (pending === undefined) {
            const refresh = provider.refreshModels;
            const task = Promise.resolve().then(async () => {
              const auth = await resolveProviderAuth(provider, context, credentials, {
                ...request, allowRefresh: request.allowNetwork !== false,
              });
              request.signal?.throwIfAborted();
              const refreshContext: ImageModelsRefreshContext = {
                ctx: { ...context, provider: provider.id }, allowNetwork: request.allowNetwork ?? true,
              };
              if (auth !== undefined) refreshContext.auth = auth;
              if (request.force !== undefined) refreshContext.force = request.force;
              if (request.signal !== undefined) refreshContext.signal = request.signal;
              const refreshed = catalog(provider, await refresh.call(provider, refreshContext));
              request.signal?.throwIfAborted();
              if (providers.get(provider.id) === provider && refreshes.get(provider.id)?.promise === task) {
                catalogs.set(provider.id, refreshed);
              }
            }).finally(() => { if (refreshes.get(provider.id)?.promise === task) refreshes.delete(provider.id); });
            refreshes.set(provider.id, { options: { ...request }, promise: task });
            pending = task;
          }
          await pending;
        } catch {
          errors.set(provider.id, new Error(`Image model refresh failed for ${provider.id}`));
        }
      }));
      return { models: collection.getModels(), errors, aborted: request.signal?.aborted === true };
    },
    setProvider(provider) {
      if (!provider.id.trim()) throw new TypeError("Image provider id must not be empty");
      const models = catalog(provider, provider.models);
      providers.set(provider.id, provider);
      catalogs.set(provider.id, models);
      refreshes.delete(provider.id);
    },
    deleteProvider(id) {
      catalogs.delete(id);
      refreshes.delete(id);
      return providers.delete(id);
    },
  };
  for (const provider of options.providers ?? []) collection.setProvider(provider);
  return collection;
}
