import { optionalProperties } from "../core/optional-properties.js";
import { createOpenRouterLoopback } from "../auth/openrouter-loopback.js";
import { assertRedactableSecret, defaultSecretRedactor } from "../auth/redaction.js";
import { STRING_VALUE, hasControlCharacters } from "../core/value-schemas.js";
import type {
  ProviderAuth,
  ProviderAuthInteraction,
} from "./models.js";
import { Value } from "typebox/value";

function openRouterApiKey<Input>(value: Input): string {
  if (
    !Value.Check(STRING_VALUE, value) ||
    value === "" ||
    /\s/u.test(value) ||
    hasControlCharacters(value) ||
    Buffer.byteLength(value, "utf8") > 48 * 1024
  ) throw new TypeError("OpenRouter browser login returned an invalid API key");
  assertRedactableSecret(value, "OpenRouter API key");
  defaultSecretRedactor.register(value);
  return value;
}

function authorizationSignal(
  interaction: ProviderAuthInteraction,
  lifecycleSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (interaction.signal === undefined) return lifecycleSignal;
  if (lifecycleSignal === undefined) return interaction.signal;
  return AbortSignal.any([interaction.signal, lifecycleSignal]);
}

/** @internal Direct-provider adapter for OpenRouter's client-ID-free browser PKCE key exchange. */
export function openRouterBrowserAccount(options: {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
} = {}): NonNullable<ProviderAuth["providerAccount"]> {
  return {
    name: "OpenRouter browser login",
    loginLabel: "Sign in with OpenRouter",
    async login(interaction) {
      const signal = authorizationSignal(interaction, options.signal);
      const session = await createOpenRouterLoopback({
        ...optionalProperties(options.fetch === undefined ? undefined : { fetch: options.fetch }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      });
      try {
        await interaction.notify({
          type: "auth_url",
          url: session.authorizationUrl.toString(),
          instructions: "Open this URL to sign in with OpenRouter:",
        });
        const key = openRouterApiKey(await session.waitForKey());
        return {
          type: "api_key",
          key,
        };
      } catch (error) {
        session.cancel(new Error("OpenRouter browser login did not complete"));
        throw error;
      }
    },
  };
}
