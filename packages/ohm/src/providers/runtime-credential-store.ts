import { assertRedactableSecret, defaultSecretRedactor } from "../auth/redaction.js";
import { assertCredentialId } from "../auth/types.js";
import { optionalProperties } from "../core/optional-properties.js";
import type { ProviderCredential, ProviderCredentialInfo, ProviderCredentialStore } from "./models.js";

/** Non-persistent API-key overlay used only by one runtime instance. */
export class RuntimeCredentialStore implements ProviderCredentialStore {
  readonly #store: ProviderCredentialStore;
  readonly #apiKeys = new Map<string, string>();

  constructor(store: ProviderCredentialStore) {
    this.#store = store;
  }

  setApiKey(provider: string, apiKey: string): void {
    assertCredentialId(provider);
    if (apiKey.trim() === "" || apiKey.includes("\0") || Buffer.byteLength(apiKey, "utf8") > 64 * 1024) {
      throw new TypeError("Runtime API key must be a non-empty value no larger than 64 KiB");
    }
    assertRedactableSecret(apiKey, "Runtime API key");
    defaultSecretRedactor.register(apiKey);
    this.#apiKeys.set(provider, apiKey);
  }

  removeApiKey(provider: string): void {
    assertCredentialId(provider);
    this.#apiKeys.delete(provider);
  }

  hasRuntimeApiKey(provider: string): boolean {
    return this.#apiKeys.has(provider);
  }

  async read(provider: string): Promise<ProviderCredential | undefined> {
    const apiKey = this.#apiKeys.get(provider);
    if (apiKey === undefined) return await this.#store.read(provider);
    const stored = await this.#store.read(provider);
    return {
      type: "api_key",
      key: apiKey,
      ...optionalProperties(stored?.type !== "api_key" || stored.env === undefined ? undefined : { env: stored.env }),
    };
  }

  async list(): Promise<readonly ProviderCredentialInfo[]> {
    const entries = new Map((await this.#store.list()).map((entry) => [entry.providerId, entry]));
    for (const providerId of this.#apiKeys.keys()) entries.set(providerId, { providerId, type: "api_key" });
    return [...entries.values()];
  }

  modify(
    provider: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<ProviderCredential | undefined> {
    return this.#store.modify(provider, operation, signal);
  }

  async delete(provider: string): Promise<void> {
    this.#apiKeys.delete(provider);
    await this.#store.delete(provider);
  }
}
