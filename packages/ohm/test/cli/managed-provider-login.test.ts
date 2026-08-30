import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthCredential,
  OAuthCredential,
  ProviderManagedAuthInteraction,
} from "../../src/auth/index.js";
import type { CredentialProfileState } from "../../src/auth/profiles.js";
import type { ProviderAuthMethod } from "../../src/auth/registry.js";
import { type InteractiveLoginRuntime, loginInteractively } from "../../src/cli/main.js";
import { STRING_VALUE } from "../../src/core/value-schemas.js";
import type { TuiController } from "../../src/tui/controller.js";
import type { TerminalChoice } from "../../src/tui/types.js";
import { Value } from "typebox/value";

interface ManagedLoginState {
  notifications: string[];
  questions: string[];
  choices: Array<{ message: string; values: string[] }>;
  stored: Array<{
    provider: string;
    credential: AuthCredential;
    options: { profile?: string; select?: boolean; signal?: AbortSignal };
  }>;
}

interface ManagedLoginRuntimeFixture {
  auth: {
    has(provider: string): boolean;
    profileState(provider: string): Promise<CredentialProfileState>;
    loginMethods(provider: string): Promise<ProviderAuthMethod[]>;
    binding(provider: string): { credentialId: string };
    authorizeManaged(
      provider: string,
      methodId: string,
      interaction: ProviderManagedAuthInteraction,
    ): Promise<OAuthCredential>;
    storeCredential(
      provider: string,
      credential: AuthCredential,
      options?: { profile?: string; select?: boolean; signal?: AbortSignal },
    ): Promise<void>;
  };
}

class ManagedLoginRuntimeAdapter implements InteractiveLoginRuntime {
  declare auth: InteractiveLoginRuntime["auth"];
  declare modelRegistry: InteractiveLoginRuntime["modelRegistry"];
  declare network: InteractiveLoginRuntime["network"];
  declare providers: InteractiveLoginRuntime["providers"];
}

function loadedRuntime(fixture: ManagedLoginRuntimeFixture): InteractiveLoginRuntime {
  return new Proxy(new ManagedLoginRuntimeAdapter(), {
    get(_target, property) {
      if (property === "auth") return fixture.auth;
      throw new Error(`Managed-login fixture does not implement runtime property ${String(property)}`);
    },
  });
}

function credential(): OAuthCredential {
  return {
    kind: "oauth",
    provider: "managed-account",
    accessToken: "managed-access",
    refreshToken: "managed-refresh",
    expiresAt: Date.now() + 60_000,
    tokenType: "Bearer",
    scopes: ["models.read"],
    providerData: { managedFlow: "subscription" },
  };
}

function fixture(
  authorize: (interaction: ProviderManagedAuthInteraction) => Promise<OAuthCredential>,
) {
  const state: ManagedLoginState = {
    notifications: [],
    questions: [],
    choices: [],
    stored: [],
  };
  const runtime = loadedRuntime({
    auth: {
      has: () => true,
      profileState: async (): Promise<CredentialProfileState> => { throw new Error("no saved profiles"); },
      loginMethods: async () => [{
        id: "managed:subscription",
        kind: "managed_oauth",
        label: "Managed subscription",
        detail: "Provider-owned sign-in",
        methodId: "subscription",
      }],
      binding: () => ({ credentialId: "managed-account" }),
      authorizeManaged: async (
        provider: string,
        methodId: string,
        interaction: ProviderManagedAuthInteraction,
      ) => {
        assert.equal(provider, "managed-provider");
        assert.equal(methodId, "subscription");
        return await authorize(interaction);
      },
      storeCredential: async (provider, value, options = {}) => {
        state.stored.push({ provider, credential: value, options });
      },
    },
  });
  const terminal: Pick<TuiController, "choose" | "notify" | "question" | "readSecret"> = {
    notify(message: string) { state.notifications.push(message); },
    async question(message: string) {
      state.questions.push(message);
      return "manual-answer";
    },
    async choose<ValueType>(message: string, options: Array<TerminalChoice<ValueType>>) {
      const values = options.map((option) => {
        if (!Value.Check(STRING_VALUE, option.value)) {
          throw new TypeError("Managed-login fixture expected string choice values");
        }
        return option.value;
      });
      state.choices.push({ message, values });
      return message === "Choose an account" ? options.at(-1)!.value : options[0]!.value;
    },
    async readSecret() { throw new Error("managed login must not request a raw secret"); },
  };
  return { runtime, terminal, state };
}

test("interactive managed login bridges provider-owned prompts and stores only normalized credentials", async () => {
  const returnedCredential = credential();
  const fixtureValue = fixture(async (interaction) => {
    assert.equal(interaction.signal.aborted, false);
    await interaction.showAuthorization({ url: "https://identity.example.test/authorize" });
    await interaction.showDeviceCode({
      userCode: "ABCD-1234",
      verificationUri: new URL("https://identity.example.test/device"),
      intervalSeconds: 2,
      expiresInSeconds: 300,
    });
    await interaction.showProgress("Waiting for provider approval");
    assert.equal(await interaction.prompt({ message: "Paste the confirmation code: " }), "manual-answer");
    assert.equal(await interaction.select({
      message: "Choose an account",
      options: [
        { id: "personal", label: "Personal" },
        { id: "work", label: "Work", detail: "Managed tenant" },
      ],
    }), "work");
    return returnedCredential;
  });

  const controller = new AbortController();
  assert.equal(await loginInteractively(
    fixtureValue.runtime,
    fixtureValue.terminal,
    "managed-provider",
    controller.signal,
    true,
  ), "managed-provider");
  assert.deepEqual(fixtureValue.state.notifications, [
    "Open this URL to sign in:\nhttps://identity.example.test/authorize",
    "Open https://identity.example.test/device and enter code ABCD-1234\nWaiting for authentication...",
    "Waiting for provider approval",
  ]);
  assert.deepEqual(fixtureValue.state.questions, ["Paste the confirmation code: "]);
  assert.deepEqual(fixtureValue.state.choices, [{
    message: "Choose an account",
    values: ["personal", "work"],
  }]);
  assert.deepEqual(fixtureValue.state.stored, [{
    provider: "managed-provider",
    credential: returnedCredential,
    options: { signal: controller.signal },
  }]);
});

test("interactive managed login rejects unsafe provider interaction output before storage", async () => {
  const fixtureValue = fixture(async (interaction) => {
    await interaction.showAuthorization({ url: "http://identity.example.test/authorize" });
    return credential();
  });
  await assert.rejects(
    loginInteractively(fixtureValue.runtime, fixtureValue.terminal, "managed-provider", undefined, true),
    /authorization URL is invalid/u,
  );
  assert.deepEqual(fixtureValue.state.stored, []);
  assert.deepEqual(fixtureValue.state.notifications, []);
});
