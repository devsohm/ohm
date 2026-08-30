import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { JsonValue } from "../core/json.js";
import {
  BOOLEAN_VALUE,
  FUNCTION_VALUE,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";
import { MIN_REDACTABLE_SECRET_CHARACTERS } from "./redaction.js";
import { hasAsciiControl } from "./validation.js";

const CREDENTIAL_INPUT_RECORD = Type.Record(Type.String(), Type.Unknown());

type CredentialInputRecord = Static<typeof CREDENTIAL_INPUT_RECORD>;

export type AuthProviderId = string;

export interface ApiKeyCredential {
  kind: "api_key";
  provider: AuthProviderId;
  apiKey?: string;
  env?: Record<string, string>;
  accountId?: string;
}

export interface BearerCredential {
  kind: "bearer";
  provider: AuthProviderId;
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
  subject?: string;
}

export interface OAuthCredential {
  kind: "oauth";
  provider: AuthProviderId;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  scopes: string[];
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  clientId?: string;
  accountId?: string;
  subject?: string;
  providerData?: Record<string, string>;
}

export type AmbientProvider = "aws" | "google" | "azure";

export interface AmbientCredentialDescriptor {
  kind: "ambient";
  provider: AmbientProvider;
  mechanism: "aws_default_chain" | "google_adc" | "azure_default_credential";
  hints: Readonly<Record<string, string | boolean>>;
}

export type AuthCredential =
  | ApiKeyCredential
  | BearerCredential
  | OAuthCredential
  | AmbientCredentialDescriptor;

export interface ResolvedCredential {
  credential: AuthCredential;
  source: string;
}

export interface CredentialRequest {
  provider: AuthProviderId;
  signal?: AbortSignal;
}

export interface CredentialSource {
  readonly name: string;
  resolve(request: CredentialRequest): Promise<AuthCredential | undefined>;
}

export interface CredentialStore {
  read(id: string): Promise<AuthCredential | undefined>;
  write(id: string, credential: AuthCredential): Promise<void>;
  delete(id: string): Promise<void>;
  withLock<T>(id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface CredentialSummary {
  providerId: string;
  type: AuthCredential["kind"];
}

/** Credential storage with atomic read-modify-write and secret-free enumeration. */
export interface MutableCredentialStore extends CredentialStore {
  list(): Promise<readonly CredentialSummary[]>;
  modify(
    id: string,
    operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<AuthCredential | undefined>;
}

export function isMutableCredentialStore(store: CredentialStore): store is MutableCredentialStore {
  return (
    "list" in store &&
    Value.Check(FUNCTION_VALUE, store.list) &&
    "modify" in store &&
    Value.Check(FUNCTION_VALUE, store.modify)
  );
}

export type CredentialProfileIndexValue = JsonValue;

export interface CredentialProfileMetadataStore extends CredentialStore {
  readCredentialProfileIndex(id: string): Promise<CredentialProfileIndexValue | undefined>;
  writeCredentialProfileIndex(id: string, value: CredentialProfileIndexValue): Promise<void>;
  deleteCredentialProfileIndex(id: string): Promise<void>;
  /** Enumerates profile registrations without reading or exposing credential values. */
  listCredentialProfileIds?(): Promise<readonly string[]>;
}

export function isCredentialProfileMetadataStore(
  store: CredentialStore,
): store is CredentialProfileMetadataStore {
  return (
    "readCredentialProfileIndex" in store &&
    Value.Check(FUNCTION_VALUE, store.readCredentialProfileIndex) &&
    "writeCredentialProfileIndex" in store &&
    Value.Check(FUNCTION_VALUE, store.writeCredentialProfileIndex) &&
    "deleteCredentialProfileIndex" in store &&
    Value.Check(FUNCTION_VALUE, store.deleteCredentialProfileIndex)
  );
}

function hasForbiddenTextControl(value: string): boolean {
  return hasAsciiControl(value) || /[\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export function assertCredentialId(id: string): void {
  if (
    id.length === 0 ||
    id.includes("\0") ||
    hasForbiddenTextControl(id) ||
    Buffer.byteLength(id, "utf8") > 512 ||
    id === "__proto__" ||
    id === "prototype" ||
    id === "constructor"
  ) {
    throw new TypeError("Credential id is invalid");
  }
}

export function credentialSecrets(credential: AuthCredential): string[] {
  switch (credential.kind) {
    case "api_key":
      return [
        ...(credential.apiKey === undefined ? [] : [credential.apiKey]),
        ...Object.values(credential.env ?? {}),
      ];
    case "bearer":
      return [credential.accessToken];
    case "oauth":
      return credential.refreshToken === undefined
        ? [credential.accessToken]
        : [credential.accessToken, credential.refreshToken];
    case "ambient":
      return [];
  }
}

function isRecord<T>(value: T): value is T & CredentialInputRecord {
  return Value.Check(CREDENTIAL_INPUT_RECORD, value);
}

function boundedText<T>(value: T, maximum: number, optional = true): boolean {
  return (
    (optional && value === undefined) ||
    (Value.Check(STRING_VALUE, value) &&
      value !== "" &&
      Buffer.byteLength(value, "utf8") <= maximum &&
      !hasForbiddenTextControl(value))
  );
}

function boundedSecretText<T>(value: T, maximum: number, optional = true): boolean {
  if (value === undefined) return optional;
  return Value.Check(STRING_VALUE, value) &&
    boundedText(value, maximum, false) &&
    value.length >= MIN_REDACTABLE_SECRET_CHARACTERS;
}

function knownKeys(value: CredentialInputRecord, names: readonly string[]): boolean {
  return Object.keys(value).every((name) => names.includes(name));
}

function credentialProvider<T>(value: T): boolean {
  return boundedText(value, 512, false) &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor";
}

function credentialEnvironment<T>(value: T): value is T & Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 64) return false;
  let aggregate = 0;
  for (const [name, entry] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      Buffer.byteLength(name, "utf8") > 256 ||
      !Value.Check(STRING_VALUE, entry) ||
      entry === "" ||
      entry.length < MIN_REDACTABLE_SECRET_CHARACTERS ||
      entry.includes("\0") ||
      Buffer.byteLength(entry, "utf8") > 64 * 1024
    ) return false;
    aggregate += Buffer.byteLength(name, "utf8") + Buffer.byteLength(entry, "utf8");
  }
  return aggregate <= 256 * 1024;
}

function oauthEndpoint<T>(value: T): boolean {
  if (value === undefined) return true;
  if (!Value.Check(STRING_VALUE, value) || value === "" || Buffer.byteLength(value, "utf8") > 16 * 1024) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  return (
    (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback)) &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    endpoint.hash === ""
  );
}

export function isAuthCredential<T>(value: T): value is T & AuthCredential {
  if (!isRecord(value) || !Value.Check(STRING_VALUE, value.kind) || !credentialProvider(value.provider)) {
    return false;
  }
  if (!boundedText(value.accountId, 4096) || !boundedText(value.subject, 4096)) return false;
  switch (value.kind) {
    case "api_key":
      return knownKeys(value, ["kind", "provider", "apiKey", "env", "accountId"]) &&
        boundedSecretText(value.apiKey, 64 * 1024) &&
        (value.env === undefined || credentialEnvironment(value.env)) &&
        (value.apiKey !== undefined || value.env !== undefined);
    case "bearer":
      return (
        knownKeys(value, ["kind", "provider", "accessToken", "expiresAt", "accountId", "subject"]) &&
        boundedSecretText(value.accessToken, 48 * 1024, false) &&
        Value.Check(STRING_VALUE, value.accessToken) &&
        !/\s/u.test(value.accessToken) &&
        (value.expiresAt === undefined ||
          (Value.Check(NUMBER_VALUE, value.expiresAt) && Number.isSafeInteger(value.expiresAt)))
      );
    case "oauth":
      return (
        knownKeys(value, [
          "kind", "provider", "accessToken", "refreshToken", "expiresAt", "tokenType", "scopes",
          "tokenEndpoint", "revocationEndpoint", "clientId", "accountId", "subject", "providerData",
        ]) &&
        boundedSecretText(value.accessToken, 48 * 1024, false) &&
        Value.Check(STRING_VALUE, value.accessToken) &&
        !/\s/u.test(value.accessToken) &&
        boundedSecretText(value.refreshToken, 48 * 1024) &&
        Value.Check(NUMBER_VALUE, value.expiresAt) &&
        Number.isSafeInteger(value.expiresAt) &&
        Value.Check(STRING_VALUE, value.tokenType) &&
        value.tokenType.toLowerCase() === "bearer" &&
        Array.isArray(value.scopes) &&
        value.scopes.length <= 256 &&
        value.scopes.every((scope) =>
          Value.Check(STRING_VALUE, scope) &&
          boundedText(scope, 1024, false) &&
          !/\s/u.test(scope)) &&
        oauthEndpoint(value.tokenEndpoint) &&
        oauthEndpoint(value.revocationEndpoint) &&
        boundedText(value.clientId, 4096) &&
        (value.providerData === undefined || (
          isRecord(value.providerData) &&
          Object.keys(value.providerData).length <= 16 &&
          Object.entries(value.providerData).every(([name, entry]) =>
            /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) &&
            !/secret|password|token/iu.test(name) &&
            boundedText(entry, 4096, false))
        ))
      );
    case "ambient": {
      if (!knownKeys(value, ["kind", "provider", "mechanism", "hints"]) || !isRecord(value.hints)) return false;
      if (
        Object.keys(value.hints).length > 64 ||
        !Object.entries(value.hints).every(([name, hint]) =>
          boundedText(name, 256, false) &&
          (Value.Check(BOOLEAN_VALUE, hint) || boundedText(hint, 2048, false)))
      ) {
        return false;
      }
      return (
        (value.provider === "aws" && value.mechanism === "aws_default_chain") ||
        (value.provider === "google" && value.mechanism === "google_adc") ||
        (value.provider === "azure" && value.mechanism === "azure_default_credential")
      );
    }
    default:
      return false;
  }
}

export function assertAuthCredential<T>(value: T): asserts value is T & AuthCredential {
  if (!isAuthCredential(value)) throw new TypeError("Credential has an invalid or unsupported shape");
}
