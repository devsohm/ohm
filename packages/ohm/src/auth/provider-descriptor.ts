import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { optionalProperties } from "../core/optional-properties.js";
import type { ModelInfo } from "../core/types.js";
import {
  FUNCTION_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";
import { normalizeDeviceAuthorizationParameters } from "./device.js";
import type { AmbientProvider } from "./types.js";
import { hasAsciiControl } from "./validation.js";

export interface ProviderManagedOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: "Bearer";
  scopes?: readonly string[];
  accountId?: string;
  subject?: string;
  providerData?: Readonly<Record<string, string>>;
}

export interface ProviderManagedAuthInteraction {
  readonly signal: AbortSignal;
  showAuthorization(input: { url: string | URL }): void | Promise<void>;
  showDeviceCode(input: {
    userCode: string;
    verificationUri: string | URL;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void | Promise<void>;
  showProgress(message: string): void | Promise<void>;
  prompt(input: { message: string }): Promise<string>;
  select(input: {
    message: string;
    options: readonly { id: string; label: string; detail?: string }[];
  }): Promise<string | undefined>;
}

/** Trusted provider-owned authentication for protocols that are not declarative OAuth. */
export interface ProviderManagedOAuthAuthMethod {
  kind: "managed_oauth";
  id: string;
  label?: string;
  detail?: string;
  login(interaction: ProviderManagedAuthInteraction): Promise<ProviderManagedOAuthCredential>;
  refresh(
    credential: ProviderManagedOAuthCredential,
    signal: AbortSignal,
  ): Promise<ProviderManagedOAuthCredential>;
  /** Optional provider-specific bearer/API-key projection. Defaults to accessToken. */
  getApiKey?(credential: ProviderManagedOAuthCredential): string;
  /** Optional credential-conditioned catalog projection. */
  modifyModels?(
    models: readonly ModelInfo[],
    credential: ProviderManagedOAuthCredential,
    signal: AbortSignal,
  ): readonly ModelInfo[] | Promise<readonly ModelInfo[]>;
}

export interface ProviderApiKeyAuthMethod {
  kind: "api_key";
  label?: string;
  detail?: string;
}

interface ProviderOAuthAuthMethodBase {
  id: string;
  label?: string;
  detail?: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scopes?: readonly string[];
}

export interface ProviderPkceAuthMethod extends ProviderOAuthAuthMethodBase {
  kind: "oauth_pkce";
  authorizationEndpoint: string;
  callbackPath?: string;
  authorizationParameters?: Readonly<Record<string, string>>;
}

export interface ProviderDeviceAuthMethod extends ProviderOAuthAuthMethodBase {
  kind: "oauth_device";
  deviceEndpoint: string;
  deviceParameters?: Readonly<Record<string, string>>;
}

export interface ProviderAmbientAuthMethod {
  kind: "ambient";
  provider: AmbientProvider;
  label?: string;
  detail?: string;
}

export type ProviderAuthDescriptorMethod =
  | ProviderApiKeyAuthMethod
  | ProviderPkceAuthMethod
  | ProviderDeviceAuthMethod
  | ProviderManagedOAuthAuthMethod
  | ProviderAmbientAuthMethod;

export interface ProviderRequestHeaderAuth {
  header: string;
  prefix?: string;
}

export interface ProviderRequestAwsSigV4Auth {
  region: string;
  service: string;
}

/** Exact network authority granted to a provider extension without exposing credential bytes. */
export interface ProviderAuthenticatedRequestPolicy {
  origins: readonly string[];
  apiKey?: ProviderRequestHeaderAuth;
  bearer?: ProviderRequestHeaderAuth;
  awsSigV4?: ProviderRequestAwsSigV4Auth;
}

export interface ProviderAuthDescriptor {
  provider: string;
  /** Optional distinct account ID; runtime descriptors cannot reuse another registered provider's credential ID. */
  credentialId?: string;
  displayName?: string;
  methods: readonly ProviderAuthDescriptorMethod[];
  request?: ProviderAuthenticatedRequestPolicy;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  "client_id",
  "client_secret",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "state",
]);

const PROVIDER_INPUT_RECORD = Type.Record(Type.String(), Type.Unknown());
const PROVIDER_INPUT_ARRAY = Type.Array(Type.Unknown());

type MethodAnnotations = Pick<ProviderApiKeyAuthMethod, "label" | "detail">;
type ProviderInputRecord = Static<typeof PROVIDER_INPUT_RECORD>;

function record<T>(value: T, label: string): ProviderInputRecord {
  if (!Value.Check(PROVIDER_INPUT_RECORD, value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function allowed(input: ProviderInputRecord, names: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((name) => !names.includes(name));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function identifier<T>(value: T, label: string): string {
  if (!Value.Check(STRING_VALUE, value) || !ID.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function text<T>(value: T, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    !Value.Check(STRING_VALUE, value) ||
    value === "" ||
    hasAsciiControl(value) ||
    /[\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    Buffer.byteLength(value) > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function endpoint<T>(value: T, label: string): string {
  if (!Value.Check(STRING_VALUE, value) || value === "" || Buffer.byteLength(value) > 16 * 1024) {
    throw new TypeError(`${label} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new TypeError(`${label} must use HTTPS or loopback HTTP`);
  }
  if (parsed.username !== "" || parsed.password !== "") throw new TypeError(`${label} must not contain credentials`);
  if (parsed.hash !== "") throw new TypeError(`${label} must not contain a fragment`);
  return parsed.toString();
}

function scopes<T>(value: T, label: string): string[] {
  if (value === undefined) return [];
  if (!Value.Check(PROVIDER_INPUT_ARRAY, value) || value.length > 256) throw new TypeError(`${label} is invalid`);
  const result = value.map((scope, index) => {
    if (
      !Value.Check(STRING_VALUE, scope) ||
      scope === "" ||
      /[\s\0]/u.test(scope) ||
      Buffer.byteLength(scope) > 1024
    ) {
      throw new TypeError(`${label}[${index}] is invalid`);
    }
    return scope;
  });
  return result;
}

function annotations(
  input: ProviderInputRecord,
  label: string,
): MethodAnnotations {
  const methodLabel = text(input.label, `${label}.label`, 256);
  const detail = text(input.detail, `${label}.detail`, 2048);
  return {
    ...optionalProperties(methodLabel === undefined ? undefined : { label: methodLabel }),
    ...optionalProperties(detail === undefined ? undefined : { detail }),
  };
}

function oauthBase(
  input: ProviderInputRecord,
  label: string,
): Pick<ProviderOAuthAuthMethodBase, "id" | "clientId" | "tokenEndpoint" | "revocationEndpoint" | "scopes" | "label" | "detail"> {
  const clientId = text(input.clientId, `${label}.clientId`, 4096);
  if (clientId === undefined) throw new TypeError(`${label}.clientId is required`);
  return {
    id: identifier(input.id, `${label}.id`),
    clientId,
    tokenEndpoint: endpoint(input.tokenEndpoint, `${label}.tokenEndpoint`),
    ...optionalProperties(input.revocationEndpoint === undefined
      ? undefined
      : { revocationEndpoint: endpoint(input.revocationEndpoint, `${label}.revocationEndpoint`) }),
    scopes: scopes(input.scopes, `${label}.scopes`),
    ...annotations(input, label),
  };
}

function authorizationParameters<T>(value: T, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  if (Object.keys(input).length > 64) throw new TypeError(`${label} contains too many parameters`);
  const result: Record<string, string> = {};
  for (const [name, parameter] of Object.entries(input)) {
    if (
      name === "" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(name) ||
      Buffer.byteLength(name) > 256 ||
      RESERVED_AUTHORIZATION_PARAMETERS.has(name.toLowerCase()) ||
      /secret|password|token/iu.test(name) ||
      !Value.Check(STRING_VALUE, parameter) ||
      /[\0\r\n]/u.test(parameter) ||
      Buffer.byteLength(parameter) > 4096
    ) {
      throw new TypeError(`${label}.${name || "<empty>"} is invalid or reserved`);
    }
    result[name] = parameter;
  }
  return result;
}

/** Provider registrations are trusted for callback signatures; this boundary verifies callability without replacing identity. */
function assertTrustedCallback<T extends Function>(
  value: ProviderInputRecord[string],
  label: string,
): asserts value is T {
  if (!Value.Check(FUNCTION_VALUE, value)) throw new TypeError(`${label} must be a function`);
}

function requestOrigin<T>(value: T, label: string): string {
  const selected = endpoint(value, label);
  const parsed = new URL(selected);
  if (parsed.pathname !== "/" || parsed.search !== "") throw new TypeError(`${label} must contain only an origin`);
  return parsed.origin;
}

function requestHeaderAuth<T>(value: T, label: string): ProviderRequestHeaderAuth | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  allowed(input, ["header", "prefix"], label);
  const header = text(input.header, `${label}.header`, 256);
  if (header === undefined || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header)) {
    throw new TypeError(`${label}.header is invalid`);
  }
  const normalized = header.toLowerCase();
  if (["cookie", "host", "content-length", "proxy-authorization", "transfer-encoding"].includes(normalized)) {
    throw new TypeError(`${label}.header is reserved`);
  }
  const prefix = text(input.prefix, `${label}.prefix`, 256);
  if (prefix !== undefined && /[\r\n\0]/u.test(prefix)) throw new TypeError(`${label}.prefix is invalid`);
  return { header: normalized, ...optionalProperties(prefix === undefined ? undefined : { prefix }) };
}

function requestPolicy<T>(value: T): ProviderAuthenticatedRequestPolicy | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Provider authentication descriptor request");
  allowed(input, ["origins", "apiKey", "bearer", "awsSigV4"], "Provider authentication descriptor request");
  if (!Array.isArray(input.origins) || input.origins.length < 1 || input.origins.length > 16) {
    throw new TypeError("Provider authentication descriptor request.origins must contain between 1 and 16 origins");
  }
  const origins = [...new Set(input.origins.map((origin, index) =>
    requestOrigin(origin, `Provider authentication descriptor request.origins[${index}]`)))];
  const apiKey = requestHeaderAuth(input.apiKey, "Provider authentication descriptor request.apiKey");
  const bearer = requestHeaderAuth(input.bearer, "Provider authentication descriptor request.bearer");
  let awsSigV4: ProviderRequestAwsSigV4Auth | undefined;
  if (input.awsSigV4 !== undefined) {
    const configured = record(input.awsSigV4, "Provider authentication descriptor request.awsSigV4");
    allowed(configured, ["region", "service"], "Provider authentication descriptor request.awsSigV4");
    const region = text(configured.region, "Provider authentication descriptor request.awsSigV4.region", 256);
    const service = text(configured.service, "Provider authentication descriptor request.awsSigV4.service", 256);
    if (
      region === undefined || service === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(region) ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(service)
    ) throw new TypeError("Provider authentication descriptor request.awsSigV4 is invalid");
    awsSigV4 = { region, service };
  }
  if (apiKey === undefined && bearer === undefined && awsSigV4 === undefined) {
    throw new TypeError("Provider authentication descriptor request must configure an authentication strategy");
  }
  return {
    origins,
    ...optionalProperties(apiKey === undefined ? undefined : { apiKey }),
    ...optionalProperties(bearer === undefined ? undefined : { bearer }),
    ...optionalProperties(awsSigV4 === undefined ? undefined : { awsSigV4 }),
  };
}

/** Validate and detach an extension-supplied provider authentication descriptor. */
export function normalizeProviderAuthDescriptor<T>(value: T): ProviderAuthDescriptor {
  const input = record(value, "Provider authentication descriptor");
  allowed(input, ["provider", "credentialId", "displayName", "methods", "request"], "Provider authentication descriptor");
  const provider = identifier(input.provider, "Provider authentication descriptor provider");
  const credentialId = input.credentialId === undefined
    ? undefined
    : identifier(input.credentialId, "Provider authentication descriptor credentialId");
  const displayName = text(input.displayName, "Provider authentication descriptor displayName", 256);
  const request = requestPolicy(input.request);
  if (!Array.isArray(input.methods) || input.methods.length === 0 || input.methods.length > 16) {
    throw new TypeError("Provider authentication descriptor methods must contain between 1 and 16 entries");
  }

  let apiKeys = 0;
  let ambientMethods = 0;
  const oauthIds = new Set<string>();
  const methods = input.methods.map((value, index): ProviderAuthDescriptorMethod => {
    const label = `Provider authentication descriptor methods[${index}]`;
    const method = record(value, label);
    if (method.kind === "api_key") {
      allowed(method, ["kind", "label", "detail"], label);
      apiKeys += 1;
      if (apiKeys > 1) throw new TypeError("Provider authentication descriptor contains duplicate API-key methods");
      return { kind: "api_key", ...annotations(method, label) };
    }
    if (method.kind === "ambient") {
      allowed(method, ["kind", "provider", "label", "detail"], label);
      ambientMethods += 1;
      if (ambientMethods > 1) throw new TypeError("Provider authentication descriptor contains duplicate ambient methods");
      if (method.provider !== "aws" && method.provider !== "google" && method.provider !== "azure") {
        throw new TypeError(`${label}.provider must be aws, google, or azure`);
      }
      return { kind: "ambient", provider: method.provider, ...annotations(method, label) };
    }
    if (method.kind === "oauth_pkce") {
      allowed(method, [
        "kind", "id", "label", "detail", "clientId", "authorizationEndpoint", "tokenEndpoint", "revocationEndpoint", "scopes",
        "callbackPath", "authorizationParameters",
      ], label);
      const base = oauthBase(method, label);
      if (oauthIds.has(base.id)) throw new TypeError(`Duplicate provider OAuth method id: ${base.id}`);
      oauthIds.add(base.id);
      const callbackPath = text(method.callbackPath, `${label}.callbackPath`, 1024);
      if (callbackPath !== undefined && (!callbackPath.startsWith("/") || callbackPath.includes("?") || callbackPath.includes("#"))) {
        throw new TypeError(`${label}.callbackPath must be an absolute URL path`);
      }
      const parameters = authorizationParameters(method.authorizationParameters, `${label}.authorizationParameters`);
      return {
        kind: "oauth_pkce",
        ...base,
        authorizationEndpoint: endpoint(method.authorizationEndpoint, `${label}.authorizationEndpoint`),
        ...optionalProperties(callbackPath === undefined ? undefined : { callbackPath }),
        ...optionalProperties(parameters === undefined ? undefined : { authorizationParameters: parameters }),
      };
    }
    if (method.kind === "oauth_device") {
      allowed(method, ["kind", "id", "label", "detail", "clientId", "deviceEndpoint", "tokenEndpoint", "revocationEndpoint", "scopes", "deviceParameters"], label);
      const base = oauthBase(method, label);
      if (oauthIds.has(base.id)) throw new TypeError(`Duplicate provider OAuth method id: ${base.id}`);
      oauthIds.add(base.id);
      const deviceParameters = normalizeDeviceAuthorizationParameters(method.deviceParameters, `${label}.deviceParameters`);
      return {
        kind: "oauth_device",
        ...base,
        deviceEndpoint: endpoint(method.deviceEndpoint, `${label}.deviceEndpoint`),
        ...optionalProperties(deviceParameters === undefined ? undefined : { deviceParameters }),
      };
    }
    if (method.kind === "managed_oauth") {
      allowed(method, ["kind", "id", "label", "detail", "login", "refresh", "getApiKey", "modifyModels"], label);
      const id = identifier(method.id, `${label}.id`);
      if (oauthIds.has(id)) throw new TypeError(`Duplicate provider OAuth method id: ${id}`);
      oauthIds.add(id);
      assertTrustedCallback<ProviderManagedOAuthAuthMethod["login"]>(method.login, `${label}.login`);
      assertTrustedCallback<ProviderManagedOAuthAuthMethod["refresh"]>(method.refresh, `${label}.refresh`);
      const getApiKey = method.getApiKey;
      if (getApiKey !== undefined) {
        assertTrustedCallback<NonNullable<ProviderManagedOAuthAuthMethod["getApiKey"]>>(
          getApiKey,
          `${label}.getApiKey`,
        );
      }
      const modifyModels = method.modifyModels;
      if (modifyModels !== undefined) {
        assertTrustedCallback<NonNullable<ProviderManagedOAuthAuthMethod["modifyModels"]>>(
          modifyModels,
          `${label}.modifyModels`,
        );
      }
      return {
        kind: "managed_oauth",
        id,
        ...annotations(method, label),
        login: method.login,
        refresh: method.refresh,
        ...optionalProperties(getApiKey === undefined ? undefined : { getApiKey }),
        ...optionalProperties(modifyModels === undefined ? undefined : { modifyModels }),
      };
    }
    throw new TypeError(`${label}.kind is invalid`);
  });

  return {
    provider,
    ...optionalProperties(credentialId === undefined ? undefined : { credentialId }),
    ...optionalProperties(displayName === undefined ? undefined : { displayName }),
    methods,
    ...optionalProperties(request === undefined ? undefined : { request }),
  };
}

/** Detaches public metadata while retaining trusted provider callback identities. */
export function cloneProviderAuthDescriptor(value: ProviderAuthDescriptor): ProviderAuthDescriptor {
  return {
    provider: value.provider,
    ...optionalProperties(value.credentialId === undefined ? undefined : { credentialId: value.credentialId }),
    ...optionalProperties(value.displayName === undefined ? undefined : { displayName: value.displayName }),
    methods: value.methods.map((method) => {
      if (method.kind === "managed_oauth") return { ...method };
      return structuredClone(method);
    }),
    ...optionalProperties(value.request === undefined ? undefined : { request: structuredClone(value.request) }),
  };
}
