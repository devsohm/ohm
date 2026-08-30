import type {
  ApiKeyAuth,
  AuthInteraction,
  AuthNotification,
  AuthResult,
  Credential,
  CredentialStore,
  OAuthAuth,
  OAuthCredentials,
  JsonObject,
  JsonValue,
} from "./contracts.js";

const encoder = new TextEncoder();
const TOKEN_RESPONSE_LIMIT = 64 * 1024;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function randomOAuthValue(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError("OAuth random value size must be between 16 and 128 bytes");
  }
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return base64Url(value);
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomOAuthValue(48);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface OAuthTokenRequestOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function oauthTokenRequest(
  url: string,
  body: Record<string, string>,
  options: OAuthTokenRequestOptions = {},
): Promise<OAuthTokenResponse> {
  validateOAuthEndpoint(url);
  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    ...options.headers,
  };
  const request: RequestInit = {
    method: "POST",
    headers,
    body: new URLSearchParams(body),
  };
  if (options.signal !== undefined) request.signal = options.signal;
  const response = await (options.fetch ?? globalThis.fetch)(url, request);
  const text = await boundedText(response, TOKEN_RESPONSE_LIMIT);
  let parsed: JsonValue | undefined;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) throw new Error(oauthError(parsed, "OAuth token request failed with HTTP " + response.status));
  const token = parseOAuthTokenResponse(parsed);
  if (token === undefined) {
    throw new Error("OAuth token response did not contain an access token");
  }
  return token;
}

function validateOAuthEndpoint(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new TypeError("OAuth endpoints must use HTTPS or loopback HTTP");
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("OAuth response exceeded 64 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return value !== null && value !== undefined && value.constructor === String ? String(value) : undefined;
}

function jsonNumber(value: JsonValue | undefined): number | undefined {
  if (value === null || value === undefined || value.constructor !== Number) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && value.constructor === Object;
}

function parseOAuthTokenResponse(value: JsonValue | undefined): OAuthTokenResponse | undefined {
  if (!isJsonObject(value)) return undefined;
  const accessToken = jsonString(value.access_token);
  if (accessToken === undefined || accessToken === "") return undefined;
  const token: OAuthTokenResponse = { access_token: accessToken };
  const refreshToken = jsonString(value.refresh_token);
  const expiresIn = jsonNumber(value.expires_in);
  const tokenType = jsonString(value.token_type);
  if (refreshToken !== undefined) token.refresh_token = refreshToken;
  if (expiresIn !== undefined) token.expires_in = expiresIn;
  if (tokenType !== undefined) token.token_type = tokenType;
  return token;
}

function oauthError(value: JsonValue | undefined, fallback: string): string {
  if (!isJsonObject(value)) return fallback;
  const description = jsonString(value.error_description);
  if (description !== undefined) return description;
  const message = jsonString(value.message);
  if (message !== undefined) return message;
  const error = jsonString(value.error);
  if (error !== undefined) return error;
  return fallback;
}

export interface BrowserOAuthConfig {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri?: string;
  extraAuthorize?: Record<string, string>;
  extraToken?: Record<string, string>;
  tokenHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function browserOAuthMethod(config: BrowserOAuthConfig): OAuthAuth {
  validateOAuthEndpoint(config.authorizationUrl);
  validateOAuthEndpoint(config.tokenUrl);
  if (!config.clientId.trim()) throw new TypeError("OAuth client registration is required");
  const redirectUri = config.redirectUri ?? "http://127.0.0.1:1455/auth/callback";
  validateOAuthEndpoint(redirectUri);
  return {
    name: config.name,
    async login(interaction) {
      const pkce = await createPkcePair();
      const state = randomOAuthValue();
      const url = new URL(config.authorizationUrl);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state,
        ...config.extraAuthorize,
      }).toString();
      await interaction.notify({ type: "auth_url", url: url.toString() });
      const answer = await interaction.prompt({
        type: "manual_code",
        message: "Paste the OAuth callback URL or authorization code",
      });
      if (!answer.trim()) throw new Error("OAuth authorization was cancelled");
      const code = callbackCode(answer.trim(), state);
      const requestOptions: OAuthTokenRequestOptions = {};
      if (config.fetch !== undefined) requestOptions.fetch = config.fetch;
      if (interaction.signal !== undefined) requestOptions.signal = interaction.signal;
      if (config.tokenHeaders !== undefined) requestOptions.headers = config.tokenHeaders;
      const token = await oauthTokenRequest(config.tokenUrl, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: pkce.verifier,
        ...config.extraToken,
      }, requestOptions);
      return tokenCredential(token, undefined, config.now);
    },
    async refresh(credential, signal) {
      if (!credential.refresh) return credential;
      const requestOptions: OAuthTokenRequestOptions = {};
      if (config.fetch !== undefined) requestOptions.fetch = config.fetch;
      if (signal !== undefined) requestOptions.signal = signal;
      if (config.tokenHeaders !== undefined) requestOptions.headers = config.tokenHeaders;
      const token = await oauthTokenRequest(config.tokenUrl, {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: credential.refresh,
        ...config.extraToken,
      }, requestOptions);
      return tokenCredential(token, credential.refresh, config.now);
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

function callbackCode(answer: string, expectedState: string): string {
  if (!answer.includes("://")) return answer;
  const url = new URL(answer);
  const error = url.searchParams.get("error");
  if (error) throw new Error(url.searchParams.get("error_description") ?? error);
  if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth callback state did not match");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not contain a code");
  return code;
}

function tokenCredential(
  token: OAuthTokenResponse,
  previousRefresh?: string,
  now: () => number = Date.now,
): OAuthCredentials {
  return {
    type: "oauth",
    access: token.access_token,
    refresh: token.refresh_token ?? previousRefresh ?? "",
    expires: now() + Math.max(0, token.expires_in ?? 3600) * 1000,
  };
}

export async function modifyCredential(
  store: CredentialStore,
  provider: string,
  update: (current: Credential | undefined) => Credential | undefined | Promise<Credential | undefined>,
): Promise<Credential | undefined> {
  return store.modify(provider, update);
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceOAuthConfig {
  name: string;
  clientId: string;
  deviceUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function formRequest(
  body: Record<string, string>,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  const request: RequestInit = {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  };
  if (signal !== undefined) request.signal = signal;
  return request;
}

function parseDeviceAuthorization(value: JsonValue): DeviceAuthorization | undefined {
  if (!isJsonObject(value)) return undefined;
  const deviceCode = jsonString(value.device_code);
  const userCode = jsonString(value.user_code);
  const verificationUri = jsonString(value.verification_uri);
  const expiresIn = jsonNumber(value.expires_in);
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined || expiresIn === undefined) {
    return undefined;
  }
  const device: DeviceAuthorization = {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
  };
  const completeUri = jsonString(value.verification_uri_complete);
  const interval = jsonNumber(value.interval);
  if (completeUri !== undefined) device.verification_uri_complete = completeUri;
  if (interval !== undefined) device.interval = interval;
  return device;
}

export function deviceOAuthMethod(config: DeviceOAuthConfig): OAuthAuth {
  validateOAuthEndpoint(config.deviceUrl);
  validateOAuthEndpoint(config.tokenUrl);
  if (!config.clientId.trim()) throw new TypeError("OAuth client registration is required");
  return {
    name: config.name,
    async login(interaction) {
      const fetcher = config.fetch ?? globalThis.fetch;
      const response = await fetcher(config.deviceUrl, formRequest(
        { client_id: config.clientId, scope: config.scopes.join(" ") },
        config.headers,
        interaction.signal,
      ));
      const parsed = await boundedText(response, TOKEN_RESPONSE_LIMIT);
      let deviceValue: JsonValue;
      try { deviceValue = JSON.parse(parsed); } catch { throw new Error("OAuth device authorization returned invalid JSON"); }
      const device = parseDeviceAuthorization(deviceValue);
      if (!response.ok || device === undefined || !device.device_code || !Number.isFinite(device.expires_in)) {
        throw new Error("OAuth device authorization failed");
      }
      const notification: Extract<AuthNotification, { type: "device_code" }> = {
        type: "device_code",
        userCode: device.user_code,
        verificationUri: device.verification_uri_complete ?? device.verification_uri,
        expiresInSeconds: device.expires_in,
      };
      if (device.interval !== undefined) notification.intervalSeconds = device.interval;
      await interaction.notify(notification);
      const now = config.now ?? Date.now;
      const deadline = now() + Math.max(0, device.expires_in) * 1000;
      let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
      while (now() < deadline) {
        await abortableDelay(intervalMs, interaction.signal);
        const tokenResponse = await fetcher(config.tokenUrl, formRequest(
          {
            client_id: config.clientId,
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
          config.headers,
          interaction.signal,
        ));
        const tokenText = await boundedText(tokenResponse, TOKEN_RESPONSE_LIMIT);
        let tokenValue: JsonValue;
        try { tokenValue = JSON.parse(tokenText); } catch { throw new Error("OAuth device token response returned invalid JSON"); }
        const token = parseOAuthTokenResponse(tokenValue);
        if (token !== undefined) return tokenCredential(token, undefined, config.now);
        const tokenError = isJsonObject(tokenValue) ? jsonString(tokenValue.error) : undefined;
        if (tokenError === "slow_down") intervalMs += 5000;
        else if (tokenError !== "authorization_pending") throw new Error(oauthError(tokenValue, "OAuth device flow failed"));
      }
      throw new Error("OAuth device code expired");
    },
    async refresh(credential, signal) {
      if (!credential.refresh) return credential;
      const requestOptions: OAuthTokenRequestOptions = {};
      if (config.fetch !== undefined) requestOptions.fetch = config.fetch;
      if (signal !== undefined) requestOptions.signal = signal;
      if (config.headers !== undefined) requestOptions.headers = config.headers;
      const token = await oauthTokenRequest(config.tokenUrl, {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: credential.refresh,
      }, requestOptions);
      return tokenCredential(token, credential.refresh, config.now);
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export function apiKeyMethod(name = "API key", environment: readonly string[] = []): ApiKeyAuth {
  return {
    name,
    async login(interaction: AuthInteraction) {
      const answer = await interaction.prompt({ type: "secret", message: "API key" });
      const key = answer.trim();
      if (!key || key.includes("\0")) throw new TypeError("API key must not be empty");
      return { type: "api_key", key };
    },
    async resolve({ ctx, credential }) {
      if (credential?.key?.trim()) {
        const result: AuthResult = { auth: { apiKey: credential.key }, source: "stored credential" };
        if (credential.env !== undefined) result.env = credential.env;
        return result;
      }
      for (const name of environment) {
        const value = credential?.env?.[name] ?? await ctx.env(name);
        if (value?.trim()) {
          const result: AuthResult = { auth: { apiKey: value }, source: name };
          if (credential?.env !== undefined) result.env = credential.env;
          return result;
        }
      }
      return undefined;
    },
  };
}
