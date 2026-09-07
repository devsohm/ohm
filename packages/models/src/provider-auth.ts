import type { ApiKeyAuth, AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./contracts.js";

export interface ProviderAuthRequest {
  apiKey?: string;
  signal?: AbortSignal;
  allowRefresh?: boolean;
}

/** Resolve credentials for one owned provider without exposing refresh credentials to transports. */
export async function resolveProviderAuth(
  provider: { id: string; auth?: ProviderAuth },
  context: AuthContext,
  credentials: CredentialStore,
  request: ProviderAuthRequest = {},
): Promise<AuthResult | undefined> {
  request.signal?.throwIfAborted();
  const auth = provider.auth;
  let credential = request.apiKey === undefined
    ? await credentials.read(provider.id)
    : { type: "api_key" as const, key: request.apiKey };
  request.signal?.throwIfAborted();
  if (credential?.type === "oauth" && auth?.oauth) {
    const oauth = auth.oauth;
    if (credential.expires <= (context.now?.() ?? Date.now())) {
      if (request.allowRefresh === false) return undefined;
      credential = await credentials.modify(provider.id, async (stored) => {
        if (stored?.type !== "oauth" || stored.expires > (context.now?.() ?? Date.now())) return stored;
        return { ...await oauth.refresh(stored, request.signal), type: "oauth" };
      }, request.signal);
    }
    if (credential?.type === "oauth") {
      const resolved = await oauth.toAuth(credential);
      request.signal?.throwIfAborted();
      return { auth: resolved, source: "stored OAuth credential" };
    }
  }
  const input: Parameters<ApiKeyAuth["resolve"]>[0] = { ctx: { ...context, provider: provider.id } };
  if (credential?.type === "api_key") input.credential = credential;
  const result = await auth?.apiKey?.resolve(input);
  request.signal?.throwIfAborted();
  return request.apiKey === undefined ? result : {
    ...result,
    auth: { ...result?.auth, apiKey: request.apiKey },
    source: "request",
  };
}
