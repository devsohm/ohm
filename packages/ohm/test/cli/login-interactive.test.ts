import assert from "node:assert/strict";
import test from "node:test";

import {
  browserLaunch,
  createInteractiveAuthorizationUi,
  type InteractiveLoginRuntime,
  loginInteractively,
} from "../../src/cli/main.js";
import type { CredentialProfileState, CredentialProfileSummary } from "../../src/auth/profiles.js";
import type { ProviderAuthMethod } from "../../src/auth/registry.js";
import type { AuthCredential } from "../../src/auth/types.js";
import { STRING_VALUE } from "../../src/core/value-schemas.js";
import { TuiController } from "../../src/tui/controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "../../src/tui/frame-projector.js";
import type { TerminalChoice } from "../../src/tui/types.js";
import { createFixtureFrameProjector, FakeInput, FakeOutput } from "../tui/helpers.js";
import { Value } from "typebox/value";

interface LoginRuntimeFixture {
  providers: {
    list(): Array<{ id: string }>;
  };
  modelRegistry: {
    models(): { getProviders(): Array<{ id: string }> };
    getProvider(provider: string): undefined;
    getProviderDisplayName(provider: string): string;
  };
  auth: {
    has(provider: string): boolean;
    profileState(provider: string): Promise<CredentialProfileState>;
    loginMethods(provider: string): Promise<ProviderAuthMethod[]>;
    binding(provider: string): { credentialId: string };
    selectFallback(provider: string): Promise<void>;
    selectProfile(provider: string, profile: string): Promise<void>;
    storeCredential(
      provider: string,
      credential: AuthCredential,
      options?: { profile?: string; select?: boolean; signal?: AbortSignal },
    ): Promise<void>;
  };
}

interface FakeLoginState {
  fallbacks: number;
  notifications: string[];
  selectedProfiles: string[];
  stored: Array<{
    credential: AuthCredential;
    options: { profile?: string; select?: boolean; signal?: AbortSignal };
  }>;
}

class LoginRuntimeAdapter implements InteractiveLoginRuntime {
  declare auth: InteractiveLoginRuntime["auth"];
  declare modelRegistry: InteractiveLoginRuntime["modelRegistry"];
  declare network: InteractiveLoginRuntime["network"];
  declare providers: InteractiveLoginRuntime["providers"];
}

function loadedRuntime(fixture: LoginRuntimeFixture): InteractiveLoginRuntime {
  return new Proxy(new LoginRuntimeAdapter(), {
    get(_target, property) {
      if (property === "providers") return fixture.providers;
      if (property === "modelRegistry") return fixture.modelRegistry;
      if (property === "auth") return fixture.auth;
      throw new Error(`Login fixture does not implement runtime property ${String(property)}`);
    },
  });
}

function loginMethod(
  kind: "local" | "external" | "environment" | "ambient" | "api_key" | "bearer",
  detail: string,
): ProviderAuthMethod {
  switch (kind) {
    case "local": return { id: "local", kind: "local", label: kind, detail };
    case "external": return { id: "external", kind: "external", label: kind, detail };
    case "environment": {
      return { id: "environment", kind: "environment", label: kind, detail, variable: "FIXTURE_API_KEY" };
    }
    case "ambient": {
      return { id: "ambient", kind: "ambient", label: kind, detail, ambientProvider: "aws" };
    }
    case "api_key": return { id: "api_key", kind: "api_key", label: kind, detail };
    case "bearer": return { id: "bearer", kind: "bearer", label: kind, detail };
  }
}

function fakeLogin(input: {
  methods: ProviderAuthMethod[];
  profiles?: CredentialProfileSummary[];
  choose?: <Value>(prompt: string, choices: Array<TerminalChoice<Value>>) => Value;
  question?: string;
  secret?: string | (() => string);
}) {
  const state: FakeLoginState = {
    fallbacks: 0,
    notifications: [],
    selectedProfiles: [],
    stored: [],
  };
  const runtime = loadedRuntime({
    providers: { list: () => [{ id: "fixture" }] },
    modelRegistry: { models: () => ({ getProviders: () => [] }), getProvider: () => undefined, getProviderDisplayName: (provider: string) => provider },
    auth: {
      has: () => true,
      profileState: async () => ({
        credentialId: "fixture-account",
        activeProfile: "default",
        fallbackSelected: false,
        profiles: input.profiles ?? [],
      }),
      loginMethods: async () => input.methods,
      binding: () => ({ credentialId: "fixture-account" }),
      selectFallback: async () => { state.fallbacks += 1; },
      selectProfile: async (_provider: string, profile: string) => { state.selectedProfiles.push(profile); },
      storeCredential: async (_provider, credential, options = {}) => {
        state.stored.push({ credential, options });
      },
    },
  });
  const terminal: Pick<TuiController, "choose" | "notify" | "question" | "readSecret"> = {
    choose: async <Value>(prompt: string, choices: Array<TerminalChoice<Value>>) =>
      input.choose?.(prompt, choices) ?? choices[0]!.value,
    question: async () => input.question ?? "",
    readSecret: async () => Value.Check(STRING_VALUE, input.secret)
      ? input.secret
      : input.secret?.() ?? "fixture-secret",
    notify: (message: string) => { state.notifications.push(message); },
  };
  return { runtime, terminal, state };
}

test("interactive OAuth notification and browser launch have one owner each", async () => {
  const notifications: string[] = [];
  const launches: Array<{ url: string; disabled: boolean }> = [];
  const terminal = {
    notify(message: string) { notifications.push(message); },
    async readSecret() { return ""; },
  } satisfies Pick<TuiController, "notify" | "readSecret">;
  const callbacks = createInteractiveAuthorizationUi(
    terminal,
    false,
    (url, disabled) => launches.push({ url: url.toString(), disabled }),
  );
  const url = new URL("https://identity.example.test/authorize");

  await callbacks.showAuthorization({ url });
  await callbacks.openUrl(url);

  assert.deepEqual(notifications, [`Open this URL to sign in:\n${url}`]);
  assert.deepEqual(launches, [{ url: url.toString(), disabled: false }]);
});

test("interactive OAuth callback input is transient and never enters question history", async () => {
  const secretPrompts: string[] = [];
  let questions = 0;
  const terminal = {
    notify() {},
    async readSecret(prompt: string) {
      secretPrompts.push(prompt);
      return "  callback-code  ";
    },
    async question() {
      questions += 1;
      return "history-backed-answer";
    },
  } satisfies Pick<TuiController, "notify" | "question" | "readSecret">;
  const callbacks = createInteractiveAuthorizationUi(terminal, true);

  assert.equal(
    await callbacks.requestManualAuthorization({
      authorizationUrl: new URL("https://identity.example.test/authorize"),
      redirectUri: "http://127.0.0.1/callback",
      state: "fixture-state",
    }, new AbortController().signal),
    "callback-code",
  );
  assert.deepEqual(secretPrompts, [
    "Paste the callback URL or authorization code, or press Enter to keep waiting: ",
  ]);
  assert.equal(questions, 0);
});

test("Windows browser launch keeps authorization URL metacharacters out of a shell", () => {
  const url = new URL("https://identity.example.test/authorize?first=one&second=two%7Cthree");
  assert.deepEqual(browserLaunch(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url.toString()],
  });
});

async function waitForOutput(output: FakeOutput, expected: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!output.text.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function startLogin() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
  });
  terminal.start();

  const state = { storedCredentials: 0 };
  const runtime = loadedRuntime({
    providers: { list: () => [] },
    modelRegistry: { models: () => ({ getProviders: () => [] }), getProvider: () => undefined, getProviderDisplayName: (provider: string) => provider },
    auth: {
      has: () => true,
      profileState: async (): Promise<CredentialProfileState> => { throw new Error("no saved profiles"); },
      loginMethods: async () => [{
        id: "api_key",
        kind: "api_key",
        label: "API key",
        detail: "Secure store",
      }],
      binding: () => ({ credentialId: "corp-account" }),
      selectFallback: async () => undefined,
      selectProfile: async () => undefined,
      storeCredential: async () => { state.storedCredentials += 1; },
    },
  });
  const controller = new AbortController();
  const login = loginInteractively(runtime, terminal, "corp", controller.signal);
  return { input, output, terminal, state, controller, login };
}

async function rejectsPromptly(login: Promise<string>, message: RegExp): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(Promise.race([
      login,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("credential login did not cancel promptly")), 250);
      }),
    ]), message);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test("interactive API-key login aborts a pending secret prompt without storing a credential", async () => {
  const fixture = startLogin();

  try {
    await waitForOutput(fixture.output, "corp API key: ");
    fixture.controller.abort(new Error("credential login cancelled"));
    await rejectsPromptly(fixture.login, /credential login cancelled/u);
    assert.equal(fixture.state.storedCredentials, 0);
  } finally {
    fixture.terminal.close();
    await fixture.login.catch(() => undefined);
  }
});

test("Escape cancels interactive API-key input without storing partial secret content", async () => {
  const fixture = startLogin();

  try {
    await waitForOutput(fixture.output, "corp API key: ");
    fixture.input.write(Buffer.concat([Buffer.from("partial-secret"), Buffer.from([27])]));
    await rejectsPromptly(fixture.login, /Secret input cancelled/u);
    assert.equal(fixture.state.storedCredentials, 0);
    assert.doesNotMatch(fixture.output.text, /partial-secret/u);
  } finally {
    fixture.terminal.close();
    await fixture.login.catch(() => undefined);
  }
});

test("interactive login handles provider-managed and fallback credential methods", async (t) => {
  for (const kind of ["local", "external"] as const) {
    await t.test(kind, async () => {
      const fixture = fakeLogin({ methods: [loginMethod(kind, `${kind} managed`)] });
      assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "fixture"), "fixture");
      assert.deepEqual(fixture.state.notifications, [`${kind} managed`]);
      assert.equal(fixture.state.fallbacks, 0);
    });
  }
  for (const kind of ["environment", "ambient"] as const) {
    await t.test(kind, async () => {
      const fixture = fakeLogin({ methods: [loginMethod(kind, `${kind} identity`)] });
      assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "fixture"), "fixture");
      assert.equal(fixture.state.fallbacks, 1);
      assert.deepEqual(fixture.state.stored, []);
    });
  }
});

test("interactive login stores API-key and bearer credentials with their provider binding", async (t) => {
  for (const kind of ["api_key", "bearer"] as const) {
    await t.test(kind, async () => {
      const fixture = fakeLogin({
        methods: [loginMethod(kind, `${kind} credential`)],
        secret: `${kind}-secret`,
      });
      assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "fixture"), "fixture");
      assert.deepEqual(fixture.state.stored, [{
        credential: kind === "api_key"
          ? { kind: "api_key", provider: "fixture-account", apiKey: "api_key-secret" }
          : { kind: "bearer", provider: "fixture-account", accessToken: "bearer-secret" },
        options: {},
      }]);
    });
  }
});

test("interactive login does not store a secret returned after cancellation", async () => {
  const controller = new AbortController();
  const cancellation = new Error("login cancelled after secret input");
  const fixture = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    secret: () => {
      controller.abort(cancellation);
      return "late-secret";
    },
  });

  await assert.rejects(
    loginInteractively(fixture.runtime, fixture.terminal, "fixture", controller.signal),
    <ErrorValue>(error: ErrorValue) => error === cancellation,
  );
  assert.deepEqual(fixture.state.stored, []);
});

test("interactive login reuses or creates isolated credential profiles", async () => {
  const saved = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    profiles: [{ name: "work", active: false, present: true, usable: true }],
  });
  assert.equal(await loginInteractively(saved.runtime, saved.terminal, "fixture"), "fixture");
  assert.deepEqual(saved.state.selectedProfiles, ["work"]);
  assert.deepEqual(saved.state.stored, []);

  const created = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    profiles: [{ name: "old", active: false, present: false, usable: false, error: "expired" }],
    choose: (prompt, choices) => prompt.startsWith("Credential profile")
      ? choices.at(-1)!.value
      : choices[0]!.value,
    question: "new-profile",
  });
  assert.equal(await loginInteractively(created.runtime, created.terminal, "fixture"), "fixture");
  assert.deepEqual(created.state.stored.map((entry) => entry.options), [{ profile: "new-profile", select: true }]);
});

test("interactive login rejects providers without a usable method or an empty secret", async () => {
  const unavailable = fakeLogin({ methods: [] });
  await assert.rejects(
    loginInteractively(unavailable.runtime, unavailable.terminal, "fixture"),
    /does not expose an interactive login method/u,
  );
  const empty = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    secret: "",
  });
  await assert.rejects(loginInteractively(empty.runtime, empty.terminal, "fixture"), /Credential is empty/u);
});

test("explicit xAI API-key login remains available without a registration warning", async () => {
  const previous = process.env.OHM_XAI_OAUTH_CLIENT_ID;
  delete process.env.OHM_XAI_OAUTH_CLIENT_ID;
  try {
    const fixture = fakeLogin({
      methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
      secret: "xai-test-key",
    });
    assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "xai"), "xai");
    assert.deepEqual(fixture.state.notifications, []);
    assert.equal(fixture.state.stored.length, 1);
  } finally {
    if (previous === undefined) delete process.env.OHM_XAI_OAUTH_CLIENT_ID;
    else process.env.OHM_XAI_OAUTH_CLIENT_ID = previous;
  }
});

test("interactive login discovers providers after the operator selects an authentication path", async () => {
  const prompts: Array<{ prompt: string; values: unknown[] }> = [];
  const fixture = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    choose: (prompt, choices) => {
      prompts.push({ prompt, values: choices.map((choice) => choice.value) });
      return choices[0]!.value;
    },
  });
  assert.equal(await loginInteractively(fixture.runtime, fixture.terminal), "fixture");
  assert.deepEqual(prompts, [{ prompt: "Select provider", values: ["fixture"] }]);
  assert.equal(fixture.state.stored.length, 1);
});

test("interactive login reports when no authentication path has a registered provider", async () => {
  const fixture = fakeLogin({ methods: [] });
  await assert.rejects(loginInteractively(fixture.runtime, fixture.terminal), /No interactive login is registered/u);
});
