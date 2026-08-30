import { optionalProperties } from "../core/optional-properties.js";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  CredentialProfileManager,
} from "../auth/profiles.js";
import {
  isMutableCredentialStore,
  isCredentialProfileMetadataStore,
  type AuthCredential,
  type CredentialStore,
  type MutableCredentialStore,
  type OAuthCredential,
} from "../auth/types.js";
import { isJsonObject } from "../core/json.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import type {
  ProviderCredential,
  ProviderCredentialInfo,
  ProviderCredentialStore,
  ProviderOAuthCredential,
} from "./models.js";
import {
  markProviderCredentialScope,
  providerCredentialScope,
} from "./provider-credential-scope.js";
import { Value } from "typebox/value";

function toProviderCredential(credential: AuthCredential | undefined): ProviderCredential | undefined {
  if (credential === undefined || credential.kind === "ambient") return undefined;
  if (credential.kind === "api_key") {
    return {
      type: "api_key",
      ...optionalProperties(credential.apiKey === undefined ? undefined : { key: credential.apiKey }),
      ...optionalProperties(credential.env === undefined ? undefined : { env: { ...credential.env } }),
    };
  }
  if (credential.kind === "bearer") return { type: "api_key", key: credential.accessToken };
  return {
    type: "oauth",
    access: credential.accessToken,
    refresh: credential.refreshToken ?? "",
    expires: credential.expiresAt,
    tokenType: credential.tokenType,
    scopes: credential.scopes,
    ...optionalProperties(credential.tokenEndpoint === undefined ? undefined : { tokenEndpoint: credential.tokenEndpoint }),
    ...optionalProperties(credential.revocationEndpoint === undefined ? undefined : { revocationEndpoint: credential.revocationEndpoint }),
    ...optionalProperties(credential.clientId === undefined ? undefined : { clientId: credential.clientId }),
    ...optionalProperties(credential.accountId === undefined ? undefined : { accountId: credential.accountId }),
    ...optionalProperties(credential.subject === undefined ? undefined : { subject: credential.subject }),
    ...optionalProperties(credential.providerData === undefined ? undefined : { providerData: credential.providerData }),
  };
}

function cloneProviderCredential(
  credential: ProviderCredential | undefined,
): ProviderCredential | undefined {
  if (credential === undefined) return undefined;
  return markProviderCredentialScope(structuredClone(credential), providerCredentialScope(credential));
}

function stringRecord<Input>(value: Input): Record<string, string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every((entry): entry is [string, string] => Value.Check(STRING_VALUE, entry[1]))
    ? Object.fromEntries(entries)
    : undefined;
}

function toHostCredential(provider: string, credential: ProviderCredential): AuthCredential {
  if (credential.type === "api_key") {
    const env = stringRecord(credential.env);
    if (credential.key === undefined && (env === undefined || Object.keys(env).length === 0)) {
      throw new TypeError(`Credential for ${provider} has neither a key nor provider environment`);
    }
    return {
      kind: "api_key",
      provider,
      ...optionalProperties(credential.key === undefined ? undefined : { apiKey: credential.key }),
      ...optionalProperties(env === undefined ? undefined : { env }),
    };
  }
  const tokenType = Value.Check(STRING_VALUE, credential.tokenType) ? credential.tokenType : "Bearer";
  const scopes = Array.isArray(credential.scopes)
    ? credential.scopes.filter((scope): scope is string => Value.Check(STRING_VALUE, scope))
    : [];
  const providerData = stringRecord(credential.providerData);
  return {
    kind: "oauth",
    provider,
    accessToken: credential.access,
    ...optionalProperties(credential.refresh === "" ? undefined : { refreshToken: credential.refresh }),
    expiresAt: credential.expires,
    tokenType,
    scopes,
    ...optionalProperties(Value.Check(STRING_VALUE, credential.tokenEndpoint) ? { tokenEndpoint: credential.tokenEndpoint } : undefined),
    ...optionalProperties(Value.Check(STRING_VALUE, credential.revocationEndpoint) ? { revocationEndpoint: credential.revocationEndpoint } : undefined),
    ...optionalProperties(Value.Check(STRING_VALUE, credential.clientId) ? { clientId: credential.clientId } : undefined),
    ...optionalProperties(Value.Check(STRING_VALUE, credential.accountId) ? { accountId: credential.accountId } : undefined),
    ...optionalProperties(Value.Check(STRING_VALUE, credential.subject) ? { subject: credential.subject } : undefined),
    ...optionalProperties(providerData === undefined ? undefined : { providerData }),
  };
}

/** Bridges ohm's durable auth store to the direct provider collection without exposing secrets. */
export class ProviderCredentialStoreAdapter implements ProviderCredentialStore {
  readonly #store: MutableCredentialStore;
  readonly #knownProviders = new Set<string>();
  readonly #observedStoredProviders = new Set<string>();
  readonly #readSnapshot = new AsyncLocalStorage<{
    reads: Map<string, Promise<ProviderCredential | undefined>>;
    profileProviders?: Promise<{ providers: Set<string>; profileIds: Set<string> }>;
  }>();
  #storedProfileProvidersLoading: Promise<{
    providers: Set<string>;
    profileIds: Set<string>;
  }> | undefined;

  constructor(store: CredentialStore) {
    if (!isMutableCredentialStore(store)) {
      throw new TypeError("Provider credential storage requires atomic modify and list operations");
    }
    this.#store = store;
  }

  async read(providerId: string): Promise<ProviderCredential | undefined> {
    const snapshot = this.#readSnapshot.getStore();
    const existing = snapshot?.reads.get(providerId);
    if (existing !== undefined) return cloneProviderCredential(await existing);
    const pending = this.#read(providerId);
    snapshot?.reads.set(providerId, pending);
    const credential = await pending;
    return snapshot === undefined ? credential : cloneProviderCredential(credential);
  }

  /** @internal Keeps repeated model-refresh reads consistent without caching across operations. */
  async withReadSnapshot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#readSnapshot.getStore() !== undefined) return await operation();
    return await this.#readSnapshot.run({ reads: new Map() }, operation);
  }

  async #read(providerId: string): Promise<ProviderCredential | undefined> {
    this.#knownProviders.add(providerId);
    const store = this.#store;
    if (!isCredentialProfileMetadataStore(store)) {
      return toProviderCredential(await this.#store.read(providerId));
    }
    const storedProviders = await this.#profileProviders();
    let registered = storedProviders.profileIds.has(providerId);
    if (!storedProviders.providers.has(providerId) && !this.#observedStoredProviders.has(providerId)) {
      if (store.listCredentialProfileIds !== undefined) return undefined;
      registered = await store.withLock(providerId, async () =>
        await store.readCredentialProfileIndex(providerId) !== undefined);
      if (!registered) return undefined;
      this.#observedStoredProviders.add(providerId);
    }
    const active = await new CredentialProfileManager(store, providerId).active();
    if (!active.configured) {
      if (registered || storedProviders.providers.has(providerId)) {
        throw new Error(`Credential profile registration is missing for ${providerId}`);
      }
      return undefined;
    }
    if (active.fallbackSelected === true) return undefined;
    if (active.name === undefined) {
      throw new Error(`No active credential profile is selected for ${providerId}`);
    }
    if (active.credential === undefined) {
      throw new Error(`Active credential profile is missing for ${providerId}`);
    }
    return markProviderCredentialScope(toProviderCredential(active.credential), active.storageId);
  }

  async list(): Promise<readonly ProviderCredentialInfo[]> {
    if (isCredentialProfileMetadataStore(this.#store) && isMutableCredentialStore(this.#store)) {
      const providers = new Set(this.#knownProviders);
      for (const providerId of (await this.#profileProviders()).providers) providers.add(providerId);
      const entries = await Promise.all([...providers].sort().map(async (providerId) => {
        try {
          const credential = await this.read(providerId);
          return credential === undefined ? undefined : { providerId, type: credential.type };
        } catch {
          return undefined;
        }
      }));
      return entries.filter((entry): entry is ProviderCredentialInfo => entry !== undefined);
    }
    if (!isMutableCredentialStore(this.#store)) return [];
    return (await this.#store.list()).map((entry) => ({
      providerId: entry.providerId,
      type: entry.type === "oauth" ? "oauth" : "api_key",
    }));
  }

  async modify(
    providerId: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<ProviderCredential | undefined> {
    if (!isMutableCredentialStore(this.#store)) return undefined;
    signal?.throwIfAborted();
    this.#knownProviders.add(providerId);
    if (isCredentialProfileMetadataStore(this.#store)) {
      const manager = new CredentialProfileManager(this.#store, providerId);
      const active = await manager.active();
      if (active.configured && active.fallbackSelected !== true && active.name === undefined) {
        throw new Error(`No active credential profile is selected for ${providerId}`);
      }
      if (active.name !== undefined && active.credential === undefined) {
        throw new Error(`Active credential profile is missing for ${providerId}`);
      }
      if (active.storageId !== undefined) {
        const result = await this.#store.modify(active.storageId, async (current) => {
          if (current !== undefined && current.provider !== providerId) {
            throw new Error(`Active credential profile belongs to a different provider registration`);
          }
          const replacement = await operation(toProviderCredential(current));
          return replacement === undefined ? undefined : toHostCredential(providerId, replacement);
        }, signal);
        return this.#rememberModified(
          providerId,
          markProviderCredentialScope(toProviderCredential(result), active.storageId),
        );
      }
      const replacement = await operation(undefined);
      if (replacement === undefined) return undefined;
      const credential = toHostCredential(providerId, replacement);
      await manager.putSelected(credential, {
        select: true,
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      });
      return this.#rememberModified(providerId, toProviderCredential(credential));
    }
    const result = await this.#store.modify(providerId, async (current) => {
      const replacement = await operation(toProviderCredential(current));
      return replacement === undefined ? undefined : toHostCredential(providerId, replacement);
    }, signal);
    return this.#rememberModified(providerId, toProviderCredential(result));
  }

  async delete(providerId: string): Promise<void> {
    this.#knownProviders.add(providerId);
    if (isCredentialProfileMetadataStore(this.#store)) {
      const manager = new CredentialProfileManager(this.#store, providerId);
      const active = await manager.active();
      if (active.name !== undefined) await manager.delete(active.name);
      this.#rememberDeleted(providerId);
      return;
    }
    await this.#store.delete(providerId);
    this.#rememberDeleted(providerId);
  }

  async #profileProviders(): Promise<{ providers: Set<string>; profileIds: Set<string> }> {
    const snapshot = this.#readSnapshot.getStore();
    const pending = snapshot?.profileProviders ?? this.#storedProfileProvidersLoading ?? (async () => {
      const entries = await this.#store.list();
      const profileIdsValue = isCredentialProfileMetadataStore(this.#store)
        ? await this.#store.listCredentialProfileIds?.() ?? []
        : [];
      const profileIds = new Set(profileIdsValue);
      const providers = new Set([...entries.map((entry) => entry.providerId), ...profileIds]);
      for (const provider of providers) this.#observedStoredProviders.add(provider);
      return { providers, profileIds };
    })();
    if (snapshot !== undefined) snapshot.profileProviders = pending;
    else this.#storedProfileProvidersLoading = pending;
    try {
      return await pending;
    } finally {
      if (snapshot === undefined && this.#storedProfileProvidersLoading === pending) {
        this.#storedProfileProvidersLoading = undefined;
      }
    }
  }

  #rememberModified(
    providerId: string,
    credential: ProviderCredential | undefined,
  ): ProviderCredential | undefined {
    const snapshot = this.#readSnapshot.getStore();
    if (snapshot !== undefined) {
      snapshot.reads.set(providerId, Promise.resolve(cloneProviderCredential(credential)));
      delete snapshot.profileProviders;
    }
    return credential;
  }

  #rememberDeleted(providerId: string): void {
    const snapshot = this.#readSnapshot.getStore();
    if (snapshot !== undefined) {
      snapshot.reads.set(providerId, Promise.resolve(undefined));
      delete snapshot.profileProviders;
    }
  }
}

export function providerOAuthCredential(credential: AuthCredential): ProviderOAuthCredential | undefined {
  const converted = toProviderCredential(credential);
  return converted?.type === "oauth" ? converted : undefined;
}

/** Convert a direct-provider OAuth value back to ohm's canonical credential shape. */
export function hostOAuthCredential(provider: string, credential: ProviderOAuthCredential): OAuthCredential {
  const converted = toHostCredential(provider, credential);
  if (converted.kind !== "oauth") throw new TypeError(`Credential for ${provider} is not OAuth`);
  return converted;
}
