import { Type } from "typebox";
import { Value } from "typebox/value";

import { optionalProperties } from "../core/optional-properties.js";
import { hasAsciiControl, hasWhitespaceOrAsciiControl, isStringValue } from "./validation.js";
export interface OAuthTokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
}

const MAX_TOKEN_BYTES = 48 * 1024;
const MAX_SCOPE_BYTES = 16 * 1024;
const MAX_SCOPE_COUNT = 256;
const MAX_SCOPE_ITEM_BYTES = 1024;
const MAX_EXPIRES_IN_SECONDS = 366 * 24 * 60 * 60;
const NUMBER_VALUE = Type.Number();
const OAUTH_TOKEN_RESPONSE_VALUE = Type.Object({
  access_token: Type.Optional(Type.Unknown()),
  refresh_token: Type.Optional(Type.Unknown()),
  token_type: Type.Optional(Type.Unknown()),
  expires_in: Type.Optional(Type.Unknown()),
  scope: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });

function token<T>(value: T, label: string, options: { required: boolean; bearer?: boolean }): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (
    !isStringValue(value) ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    hasAsciiControl(value) ||
    (options.bearer === true && hasWhitespaceOrAsciiControl(value))
  ) {
    throw new Error(`${label} has an invalid token value`);
  }
  return value;
}

function expiresIn<T>(value: T, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = isStringValue(value) && /^[1-9][0-9]{0,8}$/u.test(value)
    ? Number(value)
    : value;
  if (
    !Value.Check(NUMBER_VALUE, parsed) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_EXPIRES_IN_SECONDS
  ) {
    throw new Error(`${label} has an invalid expires_in`);
  }
  return parsed;
}

function scope<T>(value: T, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    !isStringValue(value) ||
    Buffer.byteLength(value, "utf8") > MAX_SCOPE_BYTES ||
    hasAsciiControl(value)
  ) {
    throw new Error(`${label} has an invalid scope`);
  }
  const entries = value.split(/ +/u).filter(Boolean);
  if (
    entries.length > MAX_SCOPE_COUNT ||
    entries.some((entry) =>
      Buffer.byteLength(entry, "utf8") > MAX_SCOPE_ITEM_BYTES || hasWhitespaceOrAsciiControl(entry))
  ) {
    throw new Error(`${label} has an invalid scope`);
  }
  return entries.join(" ");
}

/** Validate the interoperable Bearer-token subset used by every provider adapter. */
export function parseOAuthTokenResponse<T>(value: T, label: string): OAuthTokenResponse {
  if (!Value.Check(OAUTH_TOKEN_RESPONSE_VALUE, value)) {
    throw new Error(`${label} returned an invalid token response`);
  }
  const accessToken = token(value.access_token, label, { required: true, bearer: true });
  if (accessToken === undefined) throw new Error(`${label} has an invalid token value`);
  const refreshToken = token(value.refresh_token, label, { required: false });
  const tokenType = value.token_type === undefined ? "Bearer" : value.token_type;
  if (!isStringValue(tokenType) || tokenType.toLowerCase() !== "bearer") {
    throw new Error(`${label} returned an unsupported token_type`);
  }
  const lifetime = expiresIn(value.expires_in, label);
  const grantedScope = scope(value.scope, label);
  return {
    accessToken,
    tokenType: "Bearer",
    ...optionalProperties(lifetime === undefined ? undefined : { expiresIn: lifetime }),
    ...optionalProperties(refreshToken === undefined ? undefined : { refreshToken }),
    ...optionalProperties(grantedScope === undefined ? undefined : { scope: grantedScope }),
  };
}

export function oauthErrorCode<T>(value: T, fallback: string): string {
  return isStringValue(value) && /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : fallback;
}

export function oauthTokenExpiresAt(response: OAuthTokenResponse, now = Date.now()): number {
  if (!Number.isFinite(now)) throw new TypeError("OAuth expiry clock is invalid");
  const expiresAt = now + (response.expiresIn ?? 3600) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("OAuth token response produced an invalid expiry");
  }
  return expiresAt;
}
