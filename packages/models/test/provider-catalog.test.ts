import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvider,
  createModels,
  fauxModel,
  fauxProvider,
  MemoryCredentialStore,
  getBuiltinProviders,
  getModels,
  kimiCodeModels,
  opencodeGoModels,
  type Credential,
  type CredentialStore,
} from "../src/index.ts";
import { model, userContext } from "./black-box-helpers.ts";
import { ollamaProvider, opencodeGoProvider } from "../src/builtin-providers.ts";

for (const factory of [ollamaProvider, opencodeGoProvider]) {
  for (const mode of ["HTTP error", "oversized body", "cancelled body"] as const) {
    test(`${factory.name} discovery releases a ${mode}`, async () => {
      const provider = factory();
      const before = provider.getModels();
      const abort = new AbortController();
      const cancellation = new Error("discovery cancelled");
      let cancelled = false;
      let writes = 0;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let opened!: () => void;
      const acquired = new Promise<void>((resolve) => { opened = resolve; });
      let chunks = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
        pull(controller) {
          opened();
          if (mode !== "oversized body") return;
          const fragment = chunks === 0 ? '{"padding":"' : chunks <= 9 ? "x".repeat(1024 * 1024) : '"}';
          controller.enqueue(new TextEncoder().encode(fragment));
          chunks += 1;
          if (chunks === 11) controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const response = new Response(stream, { status: mode === "HTTP error" ? 503 : 200 });
      const refreshing = provider.refreshModels!({
        allowNetwork: true, credential: { type: "api_key", key: "dummy" }, signal: abort.signal,
        fetch: async () => response,
        store: { async read() { return undefined; }, async write() { writes += 1; }, async delete() {} },
      });
      try {
        if (mode === "cancelled body") {
          await acquired;
          abort.abort(cancellation);
          const outcome = await Promise.race([
            refreshing.then(() => "fulfilled", (error) => error),
            new Promise<"pending">((resolve) => setImmediate(resolve, "pending")),
          ]);
          assert.equal(outcome, cancellation);
        } else {
          await assert.rejects(refreshing, mode === "HTTP error" ? /HTTP 503/u : /Response body exceeded/u);
        }
        assert.equal(cancelled, true);
        assert.equal(stream.locked, false);
        assert.equal(writes, 0);
        assert.deepEqual(provider.getModels(), before);
      } finally {
        if (!cancelled && mode !== "oversized body") streamController.close();
        await refreshing.catch(() => undefined);
      }
    });
  }
}

test("built-in providers expose native identity, catalog, and streaming surfaces", () => {
  const providers = getBuiltinProviders();
  const ids = new Set(providers.map((provider) => provider.id));
  for (const expected of ["openai", "anthropic", "google", "kimi-code", "openrouter", "opencode", "opencode-go", "xai"]) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }
  for (const provider of providers) {
    assert.ok(provider.id.length > 0);
    assert.ok(provider.name.length > 0);
    assert.equal(provider.getModels instanceof Function, true);
    assert.equal(provider.stream instanceof Function, true);
    assert.equal(provider.streamSimple instanceof Function, true);
    for (const entry of provider.getModels()) assert.equal(entry.provider, provider.id);
  }
});

test("Kimi Code keeps its strict direct shard empty rather than inventing output limits or per-token prices", () => {
  assert.deepEqual(kimiCodeModels, []);
  assert.deepEqual(getModels("kimi-code"), []);
});

test("a native Faux provider can be registered and queried without authentication", async () => {
  const runtime = createModels({ providers: [fauxProvider(() => ({ text: "ok" }))] });
  assert.equal(runtime.getProvider("faux")?.id, "faux");
  assert.equal(runtime.getModel("faux", "faux")?.id, fauxModel.id);
  assert.equal((await runtime.complete(fauxModel, userContext())).content[0]?.type, "text");
  assert.equal((await runtime.completeSimple(fauxModel, userContext())).content[0]?.type, "text");
});

test("login carries cancellation through the credential commit", async () => {
  const controller = new AbortController();
  const cancellation = new Error("login cancelled before storage");
  let stored = false;
  const credentials = {
    async read() { return undefined; },
    async list() { return []; },
    async modify(
      _provider: string,
      update: (current: Credential | undefined) => Credential | undefined | Promise<Credential | undefined>,
      signal?: AbortSignal,
    ): Promise<Credential | undefined> {
      const replacement = await update(undefined);
      controller.abort(cancellation);
      signal?.throwIfAborted();
      stored = replacement !== undefined;
      return replacement;
    },
    async delete() {},
  } satisfies CredentialStore;
  const runtime = createModels({
    credentials,
    providers: [createProvider({
      id: "cancelled-login",
      auth: {
        apiKey: {
          name: "Key",
          async login() { return { type: "api_key", key: "late-secret" }; },
          async resolve() { return undefined; },
        },
      },
    })],
  });

  await assert.rejects(runtime.login("cancelled-login", "api_key", {
    signal: controller.signal,
    async prompt() { return "unused"; },
    notify() {},
  }), (error) => error === cancellation);
  assert.equal(stored, false);
});

test("OpenCode Go keeps its direct shard empty rather than guessing routed metadata", () => {
  assert.deepEqual(opencodeGoModels, []);
  assert.deepEqual(getModels("opencode-go"), []);
});

test("model catalogs clone caller input and every public snapshot", async () => {
  const source = model("faux", { id: "safe", name: "Safe", provider: "custom" });
  const provider = createProvider({ id: "custom", models: [source] });
  source.name = "caller mutation";
  const providerSnapshot = provider.getModels();
  providerSnapshot[0]!.name = "provider snapshot mutation";

  const runtime = createModels({ providers: [provider] });
  const catalog = runtime.getModels("custom");
  assert.equal(catalog[0]?.name, "Safe");
  catalog[0]!.name = "runtime snapshot mutation";
  assert.equal(runtime.getModel("custom", "safe")?.name, "Safe");

  const available = await runtime.getAvailable("custom");
  available[0]!.name = "available mutation";
  assert.equal(runtime.getAvailableSnapshot()[0]?.name, "Safe");
});

test("model catalogs reject duplicates and invalid core bounds", () => {
  const duplicate = model("faux", { id: "duplicate", provider: "custom" });
  assert.throws(() => createModels({
    providers: [createProvider({ id: "custom", models: [duplicate, structuredClone(duplicate)] })],
  }), /Duplicate model id/u);

  const invalid = model("faux", { id: "invalid", provider: "custom", contextWindow: 0 });
  assert.throws(() => createModels({
    providers: [createProvider({ id: "custom", models: [invalid] })],
  }), /contextWindow must be a positive safe integer/u);
});

test("invalid provider replacement leaves the registered provider and catalog intact", () => {
  const original = createProvider({ id: "custom", models: [model("faux", { provider: "custom" })] });
  const runtime = createModels({ providers: [original] });
  const before = runtime.getModels();
  const invalid = createProvider({ id: "custom", models: [model("faux", { provider: "custom", maxTokens: 0 })] });
  assert.throws(() => runtime.setProvider(invalid), /maxTokens/u);
  assert.equal(runtime.getProvider("custom"), original);
  assert.deepEqual(runtime.getModels(), before);
});

for (const replace of [false, true]) {
  test(`refresh cannot publish a ${replace ? "replaced" : "removed"} provider's catalog`, async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = createProvider({
      id: "custom",
      models: [model("faux", { provider: "custom", id: "old" })],
      async refreshModels() {
        entered();
        await gate;
        return [model("faux", { provider: "custom", id: "stale" })];
      },
    });
    const runtime = createModels({ providers: [original] });
    const refreshing = runtime.refresh();
    await started;
    if (replace) runtime.setProvider(createProvider({ id: "custom", models: [model("faux", { provider: "custom", id: "new" })] }));
    else runtime.removeProvider("custom");
    release();
    await refreshing;
    assert.deepEqual(runtime.getModels().map((entry) => entry.id), replace ? ["new"] : []);
  });
}

test("availability does not apply a retired provider's filter to its replacement", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let filters = 0;
  const original = createProvider({
    id: "custom",
    models: [model("faux", { provider: "custom", id: "old" })],
    auth: { apiKey: { name: "Key", async resolve() { entered(); await gate; return { auth: { apiKey: "dummy" } }; } } },
    filterModels(entries) { filters += 1; return entries; },
  });
  const runtime = createModels({ providers: [original] });
  const available = runtime.getAvailable();
  await started;
  runtime.setProvider(createProvider({ id: "custom", models: [model("faux", { provider: "custom", id: "new" })] }));
  assert.deepEqual((await runtime.getAvailable()).map((entry) => entry.id), ["new"]);
  release();
  assert.deepEqual(await available, []);
  assert.equal(filters, 0);
  assert.deepEqual(runtime.getAvailableSnapshot().map((entry) => entry.id), ["new"]);
  assert.deepEqual((await runtime.getAvailable()).map((entry) => entry.id), ["new"]);
});

for (const simple of [false, true]) {
  test(`${simple ? "simple" : "API"} streaming uses the explicit key without refreshing stored OAuth`, async () => {
    const credentials = new MemoryCredentialStore();
    const expired = { type: "oauth" as const, access: "expired", refresh: "dummy-refresh", expires: 0 };
    await credentials.modify("custom", () => expired);
    let refreshes = 0;
    let selectedKey: string | undefined;
    const selected = model("faux", { provider: "custom" });
    const provider = createProvider({
      id: "custom", models: [selected],
      auth: { oauth: {
        name: "Dummy OAuth",
        async login() { return expired; },
        async refresh() { refreshes += 1; throw new Error("Unexpected OAuth refresh"); },
        async toAuth(credential) { return { apiKey: credential.access }; },
      } },
      transport(m, context, options) {
        selectedKey = options?.apiKey;
        return fauxProvider(() => ({ text: "ok" })).stream(m, context);
      },
    });
    const runtime = createModels({ credentials, providers: [provider] });
    const stream = simple
      ? runtime.streamSimple(selected, userContext(), { apiKey: "request-key" })
      : runtime.stream(selected, userContext(), { apiKey: "request-key" });
    assert.equal((await stream.result()).stopReason, "stop");
    assert.equal(selectedKey, "request-key");
    assert.equal(refreshes, 0);
    assert.deepEqual(await credentials.read("custom"), expired);
  });

  test(`${simple ? "simple" : "API"} streaming rejects pre-abort before credential resolution`, async () => {
    const cancellation = new Error("request cancelled");
    const signal = AbortSignal.abort(cancellation);
    let resolutions = 0;
    const selected = model("faux", { provider: "custom" });
    const runtime = createModels({ providers: [createProvider({
      id: "custom", models: [selected],
      auth: { apiKey: { name: "Key", async resolve() { resolutions += 1; return { auth: { apiKey: "dummy" } }; } } },
      transport: (m, context) => fauxProvider(() => ({ text: "ok" })).stream(m, context),
    })] });
    const stream = simple ? runtime.streamSimple(selected, userContext(), { signal }) : runtime.stream(selected, userContext(), { signal });
    await assert.rejects(stream.result(), (error) => error === cancellation);
    assert.equal(resolutions, 0);
  });
}
