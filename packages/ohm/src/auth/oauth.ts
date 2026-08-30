import { optionalProperties } from "../core/optional-properties.js";
import type { OAuthRefresher } from "./refresh.js";
import { requestOAuthJson } from "./oauth-http.js";
import {
  oauthErrorCode,
  oauthTokenExpiresAt,
  parseOAuthTokenResponse,
} from "./oauth-token.js";
import { defaultSecretRedactor } from "./redaction.js";
import { hasAsciiControl } from "./validation.js";

function hasBidiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (
      (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function secureEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("OAuth token endpoint must use HTTPS or loopback HTTP");
  }
  if (endpoint.username !== "" || endpoint.password !== "") throw new Error("OAuth token endpoint contains credentials");
  if (endpoint.hash !== "") throw new Error("OAuth token endpoint contains a fragment");
  return endpoint;
}

export async function refreshGenericOAuthWithFetch(
  credential: Parameters<OAuthRefresher>[0],
  signal: Parameters<OAuthRefresher>[1],
  fetchImplementation: typeof fetch,
  options: { timeoutMs?: number; now?: () => number } = {},
): ReturnType<OAuthRefresher> {
  if (credential.tokenEndpoint === undefined || credential.clientId === undefined) {
    throw new Error("OAuth credential has no public refresh endpoint/client registration");
  }
  if (
    credential.refreshToken === undefined ||
    credential.refreshToken === "" ||
    hasAsciiControl(credential.refreshToken) ||
    Buffer.byteLength(credential.refreshToken, "utf8") > 48 * 1024
  ) throw new Error("OAuth credential has no valid refresh token");
  if (
    credential.clientId === "" ||
    (hasAsciiControl(credential.clientId) || hasBidiControl(credential.clientId)) ||
    Buffer.byteLength(credential.clientId, "utf8") > 4096
  ) throw new Error("OAuth credential has no valid public client registration");
  const endpoint = secureEndpoint(credential.tokenEndpoint);
  const response = await requestOAuthJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
    }),
  }, {
    label: "OAuth refresh endpoint",
    fetch: fetchImplementation,
    ...optionalProperties(signal === undefined ? undefined : { signal }),
    ...optionalProperties(options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs }),
  });
  const record = response.value;
  if (!response.ok) {
    const code = oauthErrorCode(record.error, "refresh_failed");
    throw new Error(`OAuth refresh failed (${response.status} ${code})`);
  }
  const token = parseOAuthTokenResponse(record, "OAuth refresh endpoint");
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return {
    accessToken: token.accessToken,
    expiresAt: oauthTokenExpiresAt(token, (options.now ?? Date.now)()),
    ...optionalProperties(token.refreshToken === undefined ? undefined : { refreshToken: token.refreshToken }),
    tokenType: token.tokenType,
    ...optionalProperties(token.scope === undefined ? undefined : { scopes: token.scope.split(" ").filter(Boolean) }),
  };
}

export const refreshGenericOAuth: OAuthRefresher = async (credential, signal) =>
  await refreshGenericOAuthWithFetch(credential, signal, globalThis.fetch);
