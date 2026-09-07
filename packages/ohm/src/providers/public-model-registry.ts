import { optionalProperties } from "../core/optional-properties.js";
import { isProxy } from "node:util/types";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthCheck,
  AuthInteraction,
  AuthResult,
  AuthType,
  Context,
  Credential,
  CredentialInfo,
  Model,
  ModelsApiStreamOptions,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsSimpleStreamOptions,
  Provider,
  ProviderHeaders,
} from "@ohm/models";

import { boundedRedactedMessage } from "../core/bounded-diagnostic.js";
import { errorMessage } from "../core/errors.js";
import { isObjectValue, STRING_VALUE } from "../core/value-schemas.js";
import type { PluginProviderConfig } from "../plugins/model-boundary.js";
import type { ModelRuntime, ModelRuntimeAuthOverrides } from "./model-compat.js";
import { Value } from "typebox/value";

export type ProviderConfigInput = PluginProviderConfig;

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

function cleanHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const selected = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return Object.keys(selected).length === 0 ? undefined : selected;
}

function authenticationError<Input>(error: Input): string {
  let source = errorMessage(error);
  if (isObjectValue(error) && !isProxy(error)) {
    const cause = Reflect.getOwnPropertyDescriptor(error, "cause");
    if (cause !== undefined && "value" in cause && cause.value !== undefined) source = errorMessage(cause.value);
  }
  return boundedRedactedMessage(source);
}

/**
 * Synchronous catalog view over the public model runtime.
 *
 * Catalog reads intentionally return the latest completed runtime snapshot;
 * call `refresh()` when a caller needs a newer provider or authentication view.
 */
export class ModelRegistry {
  readonly #runtime: ModelRuntime;

  constructor(runtime: ModelRuntime) {
    this.#runtime = runtime;
  }

  getAll(): Model<Api>[] { return [...this.#runtime.getModels()]; }
  getModels(providerId?: string): readonly Model<Api>[] { return [...this.#runtime.getModels(providerId)]; }
  getAvailable(): Model<Api>[] { return [...this.#runtime.getAvailableSnapshot()]; }
  getAvailableSnapshot(): readonly Model<Api>[] { return [...this.#runtime.getAvailableSnapshot()]; }
  find(providerId: string, modelId: string): Model<Api> | undefined {
    return this.#runtime.getModel(providerId, modelId);
  }
  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.#runtime.getModel(providerId, modelId);
  }
  getProviders(): readonly Provider[] { return [...this.#runtime.getProviders()]; }
  getProvider(providerId: string): Provider | undefined { return this.#runtime.getProvider(providerId); }
  getProviderDisplayName(providerId: string): string {
    return this.#runtime.getProvider(providerId)?.name ?? providerId;
  }
  getError(): string | undefined { return this.#runtime.getError(); }
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
    return this.#runtime.refresh(options);
  }
  refreshConfig(): Promise<void> { return this.#runtime.refreshConfig(); }

  checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return this.#runtime.checkAuth(providerId);
  }
  hasConfiguredAuth(providerOrModel: string | Model<Api>): boolean {
    return this.#runtime.hasConfiguredAuth(providerOrModel);
  }
  isUsingOAuth(providerOrModel: string | Model<Api>): boolean {
    return this.#runtime.isUsingOAuth(providerOrModel);
  }
  isSubscription(providerOrModel: string | Model<Api>): boolean {
    return this.#runtime.isSubscription(providerOrModel);
  }
  getProviderAuthStatus(providerId: string): ReturnType<ModelRuntime["getProviderAuthStatus"]> {
    return this.#runtime.getProviderAuthStatus(providerId);
  }
  getCompatibilityRequestConfig(model: Model<Api>): { headers?: ProviderHeaders; authHeader: boolean } {
    return this.#runtime.getCompatibilityRequestConfig(model);
  }
  getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(
    providerOrModel: string | Model<Api>,
    overrides?: ModelRuntimeAuthOverrides,
  ): Promise<AuthResult | undefined> {
    return Value.Check(STRING_VALUE, providerOrModel)
      ? this.#runtime.getAuth(providerOrModel, overrides)
      : this.#runtime.getAuth(providerOrModel, overrides);
  }
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const result = await this.#runtime.getAuth(model);
      if (result !== undefined) {
        const headers = cleanHeaders(result.auth.headers);
        return {
          ok: true,
          ...optionalProperties(result.auth.apiKey === undefined ? undefined : { apiKey: result.auth.apiKey }),
          ...optionalProperties(headers === undefined ? undefined : { headers }),
          ...optionalProperties(result.env === undefined ? undefined : { env: result.env }),
        };
      }
      const fallback = this.#runtime.getCompatibilityRequestConfig(model);
      if (fallback.authHeader) return { ok: false, error: `No API key found for ${model.provider}` };
      const headers = cleanHeaders(fallback.headers);
      return { ok: true, ...optionalProperties(headers === undefined ? undefined : { headers }) };
    } catch (error) {
      return { ok: false, error: authenticationError(error) };
    }
  }
  setRuntimeApiKey(providerId: string, apiKey: string, options?: ModelsRefreshOptions): Promise<void> {
    return this.#runtime.setRuntimeApiKey(providerId, apiKey, options);
  }
  removeRuntimeApiKey(providerId: string): Promise<void> {
    return this.#runtime.removeRuntimeApiKey(providerId);
  }
  listCredentials(): Promise<readonly CredentialInfo[]> { return this.#runtime.listCredentials(); }
  login(providerId: string, type: AuthType | "provider_account", interaction: AuthInteraction): Promise<Credential> {
    return this.#runtime.login(providerId, type, interaction);
  }
  logout(providerId: string): Promise<void> { return this.#runtime.logout(providerId); }

  getRegisteredProviderConfig(providerId: string): PluginProviderConfig | undefined {
    return this.#runtime.getRegisteredProviderConfig(providerId);
  }
  getRegisteredProviderIds(): readonly string[] { return [...this.#runtime.getRegisteredProviderIds()]; }
  getRegisteredNativeProvider(providerId: string): Provider | undefined {
    return this.#runtime.getRegisteredNativeProvider(providerId);
  }
  registerProvider(provider: Provider): void;
  registerProvider(providerId: string, config: PluginProviderConfig): void;
  registerProvider(providerOrId: Provider | string, config?: PluginProviderConfig): void {
    if (!Value.Check(STRING_VALUE, providerOrId)) {
      this.#runtime.registerNativeProvider(providerOrId);
      return;
    }
    if (config === undefined) throw new Error("Provider configuration is required");
    this.#runtime.registerProvider(providerOrId, config);
  }
  registerNativeProvider(provider: Provider): void { this.#runtime.registerNativeProvider(provider); }
  unregisterProvider(providerId: string): void { this.#runtime.unregisterProvider(providerId); }

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    return this.#runtime.stream(model, context, options);
  }
  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return this.#runtime.complete(model, context, options);
  }
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    return this.#runtime.streamSimple(model, context, options);
  }
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return this.#runtime.completeSimple(model, context, options);
  }

  close(): Promise<void> { return this.#runtime.close(); }
  internalRegistry(): ReturnType<ModelRuntime["internalRegistry"]> { return this.#runtime.internalRegistry(); }
  models(): ReturnType<ModelRuntime["models"]> { return this.#runtime.models(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}
