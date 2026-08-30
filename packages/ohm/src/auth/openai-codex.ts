import { optionalProperties } from "../core/optional-properties.js";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject, type JsonObject } from "../core/json.js";
import { authAbortError, authFailureError } from "./cancellation.js";
import {
  createLoopbackAuthorization,
  exchangeAuthorizationCode,
  type AuthorizationCodeCallback,
  type LoopbackAuthorizationSession,
  type OAuthTokenResponse,
} from "./loopback.js";
import { requestOAuthJson } from "./oauth-http.js";
import { oauthErrorCode, oauthTokenExpiresAt, parseOAuthTokenResponse } from "./oauth-token.js";
import { refreshGenericOAuthWithFetch } from "./oauth.js";
import { defaultSecretRedactor } from "./redaction.js";
import { validateOAuthClientId } from "./oauth-client-registration.js";
import { createOAuthState, createPkcePair } from "./pkce.js";
import type { OAuthCredential } from "./types.js";
import { hasAsciiControl, isStringValue } from "./validation.js";

export const OPENAI_CODEX_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/oauth/authorize";
export const OPENAI_CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_DEVICE_ENDPOINT = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const OPENAI_CODEX_DEVICE_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const OPENAI_CODEX_CALLBACK_PORT = 1455;
export const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback";
export const OPENAI_CODEX_SCOPES = Object.freeze(["openid", "profile", "email", "offline_access"]);

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const NUMBER_VALUE = Type.Number();
const ERROR_CODE_VALUE = Type.Object({ code: Type.Optional(Type.Unknown()) }, { additionalProperties: true });
const OPENAI_AUTH_VALUE = Type.Object({
  chatgpt_account_id: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });

export interface OpenAICodexAuthorizationCallbacks {
  showAuthorization(input: { url: URL; userCode?: string }): void | Promise<void>;
  openUrl?(url: URL): void | Promise<void>;
  requestManualAuthorization?(
    input: { authorizationUrl: URL; redirectUri: string; state: string },
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

export interface OpenAICodexAuthorizationOptions extends OpenAICodexAuthorizationCallbacks {
  flow: "browser" | "device";
  clientId: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  callbackPort?: number;
  requestTimeoutMs?: number;
}

interface DeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

interface OpenAICodexIdentity {
  accountId: string;
  subject?: string;
}

function boundedPrintable<T>(value: T, label: string, maximum: number): string {
  if (
    !isStringValue(value) ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > maximum ||
    hasAsciiControl(value)
  ) throw new Error(`OpenAI Codex ${label} is invalid`);
  return value;
}

function jwtClaims(token: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || Buffer.byteLength(parts[1], "utf8") > 64 * 1024) {
    throw new Error("OpenAI Codex access token is not a valid JWT");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("OpenAI Codex access token has invalid JWT claims");
  }
  if (!isJsonObject(value)) {
    throw new Error("OpenAI Codex access token has invalid JWT claims");
  }
  return value;
}

export function openAICodexIdentity(accessToken: string): OpenAICodexIdentity {
  const claims = jwtClaims(accessToken);
  const auth = claims[OPENAI_AUTH_CLAIM];
  const accountId = Value.Check(OPENAI_AUTH_VALUE, auth)
    ? boundedPrintable(auth.chatgpt_account_id, "account ID", 4096)
    : undefined;
  if (accountId === undefined) throw new Error("OpenAI Codex access token omitted the ChatGPT account ID");
  const subject = isStringValue(claims.sub) && claims.sub !== "" && Buffer.byteLength(claims.sub, "utf8") <= 4096
    ? claims.sub
    : undefined;
  return { accountId, ...optionalProperties(subject === undefined ? undefined : { subject }) };
}

function credential(token: OAuthTokenResponse, oauthClientId: string, now: () => number): OAuthCredential {
  if (token.refreshToken === undefined) throw new Error("OpenAI Codex OAuth response omitted a refresh token");
  const identity = openAICodexIdentity(token.accessToken);
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return {
    kind: "oauth",
    provider: "openai-codex",
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: oauthTokenExpiresAt(token, now()),
    tokenType: token.tokenType,
    scopes: token.scope?.split(/\s+/u).filter(Boolean) ?? [...OPENAI_CODEX_SCOPES],
    tokenEndpoint: OPENAI_CODEX_TOKEN_ENDPOINT,
    clientId: oauthClientId,
    ...identity,
  };
}

function manualAuthorization(
  value: string,
  expected: { redirectUri: string; state: string },
): AuthorizationCodeCallback {
  const input = value.trim();
  if (input === "" || Buffer.byteLength(input, "utf8") > 16 * 1024 || hasAsciiControl(input)) {
    throw new Error("Manual OpenAI Codex OAuth response is invalid");
  }
  let callback: URL | undefined;
  try {
    callback = new URL(input);
  } catch {}
  if (callback === undefined) {
    const separator = input.lastIndexOf("#");
    const code = separator < 0 ? input : input.slice(0, separator);
    const state = separator < 0 ? expected.state : input.slice(separator + 1);
    boundedPrintable(code, "authorization code", 4096);
    if (state !== expected.state) throw new Error("Manual OpenAI Codex OAuth state is invalid");
    return { code, state };
  }
  const redirect = new URL(expected.redirectUri);
  if (
    callback.protocol !== redirect.protocol ||
    callback.hostname !== redirect.hostname ||
    callback.port !== redirect.port ||
    callback.pathname !== redirect.pathname ||
    callback.username !== "" ||
    callback.password !== ""
  ) throw new Error("Manual OpenAI Codex OAuth callback does not match the expected redirect");
  if (callback.searchParams.get("state") !== expected.state) throw new Error("Manual OpenAI Codex OAuth state is invalid");
  const providerError = callback.searchParams.get("error");
  if (providerError !== null) {
    throw new Error(`OpenAI Codex OAuth failed: ${oauthErrorCode(providerError, "authorization_failed")}`);
  }
  return {
    code: boundedPrintable(callback.searchParams.get("code"), "authorization code", 4096),
    state: expected.state,
  };
}

function manualOnlyBrowserSession(oauthClientId: string, port: number): LoopbackAuthorizationSession {
  const state = createOAuthState();
  const pkce = createPkcePair();
  const redirectUri = `http://localhost:${port}${OPENAI_CODEX_CALLBACK_PATH}`;
  const authorizationUrl = new URL(OPENAI_CODEX_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", oauthClientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", OPENAI_CODEX_SCOPES.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl,
    redirectUri,
    verifier: pkce.verifier,
    state,
    waitForCallback: () => new Promise<never>(() => undefined),
    cancel: () => undefined,
  };
}

function portUnavailable<T>(error: T): boolean {
  return Value.Check(ERROR_CODE_VALUE, error) && error.code === "EADDRINUSE";
}

async function browserAuthorization(options: OpenAICodexAuthorizationOptions, oauthClientId: string): Promise<OAuthCredential> {
  const callbackPort = options.callbackPort ?? OPENAI_CODEX_CALLBACK_PORT;
  let session: LoopbackAuthorizationSession;
  try {
    session = await createLoopbackAuthorization({
      authorizationEndpoint: OPENAI_CODEX_AUTHORIZATION_ENDPOINT,
      clientId: oauthClientId,
      scopes: OPENAI_CODEX_SCOPES,
      callbackPath: OPENAI_CODEX_CALLBACK_PATH,
      port: callbackPort,
      redirectHostname: "localhost",
      timeoutMs: DEVICE_TIMEOUT_MS,
    });
  } catch (error) {
    if (!portUnavailable(error) || options.requestManualAuthorization === undefined) throw error;
    session = manualOnlyBrowserSession(oauthClientId, callbackPort);
  }
  const abort = (): void => session.cancel(authAbortError(options.signal!, "OpenAI Codex login cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await options.showAuthorization({ url: session.authorizationUrl });
    await options.openUrl?.(session.authorizationUrl);
    const manualController = new AbortController();
    const manualSignal = options.signal === undefined
      ? manualController.signal
      : AbortSignal.any([manualController.signal, options.signal]);
    const callbackPromise = session.waitForCallback().then((value) => ({ source: "loopback" as const, value }));
    const manualPromise = options.requestManualAuthorization === undefined
      ? new Promise<never>(() => undefined)
      : options.requestManualAuthorization({
          authorizationUrl: session.authorizationUrl,
          redirectUri: session.redirectUri,
          state: session.state,
        }, manualSignal).then((value) => value === undefined
          ? new Promise<never>(() => undefined)
          : { source: "manual" as const, value: manualAuthorization(value, session) });
    let selected: Awaited<typeof callbackPromise> | Awaited<typeof manualPromise>;
    try {
      selected = await Promise.race([callbackPromise, manualPromise]);
    } finally {
      manualController.abort(new Error("OpenAI Codex authorization completed through another channel"));
    }
    if (selected.source === "manual") session.cancel(new Error("OpenAI Codex loopback superseded by manual authorization"));
    const token = await exchangeAuthorizationCode({
      tokenEndpoint: OPENAI_CODEX_TOKEN_ENDPOINT,
      clientId: oauthClientId,
      code: selected.value.code,
      redirectUri: session.redirectUri,
      verifier: session.verifier,
      ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
      ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
      ...optionalProperties(options.requestTimeoutMs === undefined ? undefined : { timeoutMs: options.requestTimeoutMs }),
    });
    return credential(token, oauthClientId, options.now ?? Date.now);
  } catch (error) {
    session.cancel(authFailureError(error, "OpenAI Codex authorization failed"));
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function requestDeviceAuthorization(
  options: OpenAICodexAuthorizationOptions,
  oauthClientId: string,
): Promise<DeviceAuthorization> {
  let response: Awaited<ReturnType<typeof requestOAuthJson>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await requestOAuthJson(OPENAI_CODEX_DEVICE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: oauthClientId }),
      }, {
        label: "OpenAI Codex device authorization endpoint",
        ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
        ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
        ...optionalProperties(options.requestTimeoutMs === undefined ? undefined : { timeoutMs: options.requestTimeoutMs }),
      });
    } catch (error) {
      if (attempt > 0 || !(error instanceof Error ? error.message : String(error)).endsWith("response was not JSON")) throw error;
      await (options.sleep ?? defaultSleep)(250, options.signal);
      continue;
    }
    if (response.ok || attempt > 0 || (response.status !== 429 && response.status < 500)) break;
    await (options.sleep ?? defaultSleep)(250, options.signal);
  }
  if (response === undefined) throw new Error("OpenAI Codex device authorization failed without a response");
  if (!response.ok) throw new Error(`OpenAI Codex device authorization failed (${response.status})`);
  const interval = isStringValue(response.value.interval) && /^[0-9]+(?:\.[0-9]+)?$/u.test(response.value.interval)
    ? Number(response.value.interval)
    : response.value.interval;
  if (!Value.Check(NUMBER_VALUE, interval) || !Number.isFinite(interval) || interval < 0 || interval > 300) {
    throw new Error("OpenAI Codex device authorization returned an invalid interval");
  }
  return {
    deviceAuthId: boundedPrintable(response.value.device_auth_id, "device authorization ID", 8192),
    userCode: boundedPrintable(response.value.user_code, "device user code", 1024),
    intervalMs: Math.max(1_000, Math.ceil(interval * 1000)),
  };
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, signal === undefined ? undefined : { signal });
  } catch (error) {
    if (signal?.aborted === true) throw authAbortError(signal, "OpenAI Codex login cancelled");
    throw error;
  }
}

async function exchangeDeviceAuthorizationCode(
  code: string,
  verifier: string,
  oauthClientId: string,
  options: OpenAICodexAuthorizationOptions,
): Promise<OAuthTokenResponse> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
    throw new Error("OpenAI Codex device authorization returned an invalid PKCE verifier");
  }
  const response = await requestOAuthJson(OPENAI_CODEX_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: oauthClientId,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    }),
  }, {
    label: "OpenAI Codex token endpoint",
    ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
    ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    ...optionalProperties(options.requestTimeoutMs === undefined ? undefined : { timeoutMs: options.requestTimeoutMs }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI Codex token exchange failed (${response.status} ${oauthErrorCode(response.value.error, "token_exchange_failed")})`);
  }
  return parseOAuthTokenResponse(response.value, "OpenAI Codex token endpoint");
}

async function deviceAuthorization(options: OpenAICodexAuthorizationOptions, oauthClientId: string): Promise<OAuthCredential> {
  const authorization = await requestDeviceAuthorization(options, oauthClientId);
  const verificationUrl = new URL(OPENAI_CODEX_DEVICE_VERIFICATION_URL);
  await options.showAuthorization({ url: verificationUrl, userCode: authorization.userCode });
  await options.openUrl?.(verificationUrl);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const expiresAt = now() + DEVICE_TIMEOUT_MS;
  let intervalMs = authorization.intervalMs;
  while (now() < expiresAt) {
    options.signal?.throwIfAborted();
    await sleep(intervalMs, options.signal);
    options.signal?.throwIfAborted();
    const response = await requestOAuthJson(OPENAI_CODEX_DEVICE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        device_auth_id: authorization.deviceAuthId,
        user_code: authorization.userCode,
      }),
    }, {
      label: "OpenAI Codex device token endpoint",
      ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
      ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
      ...optionalProperties(options.requestTimeoutMs === undefined ? undefined : { timeoutMs: options.requestTimeoutMs }),
    });
    if (response.ok) {
      const code = boundedPrintable(response.value.authorization_code, "device authorization code", 4096);
      const verifier = boundedPrintable(response.value.code_verifier, "device PKCE verifier", 4096);
      const token = await exchangeDeviceAuthorizationCode(code, verifier, oauthClientId, options);
      return credential(token, oauthClientId, now);
    }
    const errorValue = response.value.error;
    const error = oauthErrorCode(
      Value.Check(ERROR_CODE_VALUE, errorValue)
        ? errorValue.code
        : response.value.error,
      "device_authorization_failed",
    );
    if (response.status === 403 || response.status === 404 || error === "deviceauth_authorization_pending" || error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalMs = Math.min(300_000, intervalMs + 5_000);
      continue;
    }
    if (error === "access_denied") throw new Error("OpenAI Codex device authorization was denied");
    if (error === "expired_token") throw new Error("OpenAI Codex device authorization expired");
    throw new Error(`OpenAI Codex device authorization failed (${response.status} ${error})`);
  }
  throw new Error("OpenAI Codex device authorization timed out");
}

export async function authorizeOpenAICodex(options: OpenAICodexAuthorizationOptions): Promise<OAuthCredential> {
  options.signal?.throwIfAborted();
  const oauthClientId = validateOAuthClientId(options.clientId, "OpenAI OAuth client ID");
  return options.flow === "browser"
    ? browserAuthorization(options, oauthClientId)
    : deviceAuthorization(options, oauthClientId);
}

/** Refresh a Codex subscription credential while retaining and checking its account identity. */
export async function refreshOpenAICodexCredential(
  current: OAuthCredential,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<OAuthCredential> {
  if (current.provider !== "openai-codex") {
    throw new Error("OpenAI Codex OAuth refresh received a credential for another provider");
  }
  const oauthClientId = validateOAuthClientId(current.clientId, "OpenAI OAuth credential client ID");
  const refreshed = await refreshGenericOAuthWithFetch({
    ...current,
    clientId: oauthClientId,
    tokenEndpoint: OPENAI_CODEX_TOKEN_ENDPOINT,
  }, signal, fetchImplementation);
  const identity = openAICodexIdentity(refreshed.accessToken);
  if (current.accountId !== undefined && current.accountId !== identity.accountId) {
    throw new Error("OpenAI Codex OAuth refresh changed account identity; reauthentication is required");
  }
  if (current.subject !== undefined && identity.subject !== undefined && current.subject !== identity.subject) {
    throw new Error("OpenAI Codex OAuth refresh changed subject identity; reauthentication is required");
  }
  const refreshToken = refreshed.refreshToken ?? current.refreshToken;
  if (refreshToken === undefined) {
    throw new Error("OpenAI Codex OAuth refresh omitted a refresh token; reauthentication is required");
  }
  const subject = identity.subject ?? current.subject;
  return {
    ...current,
    accessToken: refreshed.accessToken,
    refreshToken,
    expiresAt: refreshed.expiresAt,
    tokenType: refreshed.tokenType ?? current.tokenType,
    scopes: [...(refreshed.scopes ?? current.scopes)],
    tokenEndpoint: OPENAI_CODEX_TOKEN_ENDPOINT,
    clientId: oauthClientId,
    accountId: identity.accountId,
    ...optionalProperties(subject === undefined ? undefined : { subject }),
  };
}

export function parseOpenAICodexTokenResponse<T>(value: T): OAuthTokenResponse {
  return parseOAuthTokenResponse(value, "OpenAI Codex token endpoint");
}
