import assert from "node:assert/strict";
import test from "node:test";
import {
  createImageModels, MemoryCredentialStore,
  type ImageGenerationOptions, type ImageModel, type ImageProvider, type ImageResult,
} from "../src/index.ts";
import { getImageModels, openrouterImagesProvider } from "../src/image-runtime.ts";

function model(id = "original"): ImageModel {
  return { id, name: id, provider: "images", baseUrl: "https://unused.example/v1", sizes: ["1024x1024"] };
}

function result(selected: ImageModel): ImageResult {
  return { model: selected.id, provider: selected.provider, images: [{ data: "aGk=", mimeType: "image/png" }] };
}

function provider(overrides: Partial<ImageProvider> = {}): ImageProvider {
  return { id: "images", name: "Images", models: [model()], generate: async (selected) => result(selected), ...overrides };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((release) => { resolve = release; });
  return { promise, resolve };
}

test("image collections isolate registration and detached catalog snapshots", () => {
  const entry = provider();
  const first = createImageModels({ providers: [entry] });
  const second = createImageModels({ providers: [entry] });
  entry.models[0]!.name = "caller mutation";
  first.getModel("images", "original")!.name = "snapshot mutation";
  assert.equal(first.getModel("images", "original")!.name, "original");
  assert.equal(second.getModel("images", "original")!.name, "original");
  assert.deepEqual(getImageModels("images"), [], "instances must not register compatibility globals");
  assert.throws(() => first.setProvider(provider({ models: [model(), model()] })), /duplicate/);
  assert.equal(first.getModels().length, 1, "invalid replacement preserves the old catalog");
  assert.equal(first.deleteProvider("images"), true);
  assert.equal(second.getModels().length, 1);
});

test("scoped OpenRouter image auth and request transport overrides do not use ambient credentials", async () => {
  const credentials = new MemoryCredentialStore();
  await credentials.modify("openrouter", () => ({ type: "api_key", key: "stored-image-key" }));
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,aGk=" } }] } }] });
  };
  const entry = openrouterImagesProvider({ headers: { "x-default": "default", "x-remove": "default" } });
  const collection = createImageModels({ credentials, env: {}, fetch, providers: [entry] });
  await collection.generateImage(entry.models[0]!, { prompt: "pixel" });
  await collection.generateImage(entry.models[0]!, { prompt: "pixel" }, {
    apiKey: "request-image-key", baseUrl: "https://override.example/v1", headers: { "X-Default": "request", "x-remove": null },
  });
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer stored-image-key");
  assert.equal(calls[1]!.url, "https://override.example/v1/chat/completions");
  assert.equal(calls[1]!.headers.get("authorization"), "Bearer request-image-key");
  assert.equal(calls[1]!.headers.get("x-default"), "request");
  assert.equal(calls[1]!.headers.has("x-remove"), false);
  const empty = createImageModels({ env: {}, fetch, providers: [entry] });
  await assert.rejects(empty.generateImage(entry.models[0]!, { prompt: "pixel" }), /requires an API key/);
  assert.equal(calls.length, 2);
});

test("image OAuth refresh uses the injected credential transaction without passing refresh secrets to generation", async () => {
  const credentials = new MemoryCredentialStore();
  await credentials.modify("images", () => ({ type: "oauth", access: "old-access", refresh: "private-refresh", expires: 0 }));
  let refreshes = 0;
  const seen: ImageGenerationOptions[] = [];
  const entry = provider({
    auth: { oauth: {
      name: "Images OAuth",
      login: async () => { throw new Error("login is host-owned"); },
      refresh: async (credential) => { refreshes += 1; return { ...credential, access: "fresh-access", expires: 100 }; },
      toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: "https://account.example/v1", headers: { "x-account": "resolved" } }),
    } },
    generate: async (selected, _request, invocation) => {
      assert.equal(selected.baseUrl, "https://account.example/v1");
      seen.push(invocation ?? {});
      return result(selected);
    },
  });
  const collection = createImageModels({ credentials, authContext: { now: () => 10 }, providers: [entry] });
  await Promise.all([collection.generateImage(model(), { prompt: "one" }), collection.generateImage(model(), { prompt: "two" })]);
  assert.equal(refreshes, 1);
  assert.deepEqual(seen, [{ apiKey: "fresh-access", headers: { "x-account": "resolved" } }, { apiKey: "fresh-access", headers: { "x-account": "resolved" } }]);
  assert.equal(JSON.stringify(seen).includes("private-refresh"), false);
  assert.equal((await credentials.read("images"))?.type, "oauth");
});

test("explicit image auth bypasses an unavailable store but keeps provider endpoint resolution", async () => {
  class UnavailableCredentials extends MemoryCredentialStore {
    override async read(): Promise<undefined> { throw new Error("store unavailable"); }
  }
  const collection = createImageModels({ credentials: new UnavailableCredentials(), providers: [provider({
    auth: { apiKey: { name: "Images key", resolve: async ({ credential }) => ({ auth: {
      apiKey: credential?.key ?? "fallback", baseUrl: "https://resolved.example/v1", headers: { "x-provider": "yes" },
    } }) } },
  })] });
  assert.deepEqual(await collection.getAuth("images", { apiKey: "request-key" }), {
    auth: { apiKey: "request-key", baseUrl: "https://resolved.example/v1", headers: { "x-provider": "yes" } }, source: "request",
  });
});

test("offline image discovery does not refresh expired OAuth credentials", async () => {
  const credentials = new MemoryCredentialStore();
  await credentials.modify("images", () => ({ type: "oauth", access: "expired", refresh: "private", expires: 0 }));
  let refreshes = 0;
  const collection = createImageModels({ credentials, providers: [provider({
    auth: { oauth: {
      name: "Images OAuth", login: async () => { throw new Error("not requested"); },
      refresh: async () => { refreshes += 1; throw new Error("must not refresh offline"); },
      toAuth: async (credential) => ({ apiKey: credential.access }),
    } },
    refreshModels: async (context) => {
      assert.equal(context.allowNetwork, false);
      assert.equal(context.auth, undefined);
      return [model("offline")];
    },
  })] });
  assert.equal((await collection.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(refreshes, 0);
  assert.equal(collection.getModels()[0]!.id, "offline");
});

test("image discovery dedupes per-instance refresh and preserves last-good catalogs across errors and replacement", async () => {
  let calls = 0;
  const gate = deferred<void>();
  const entry = provider({ refreshModels: async (context) => {
    calls += 1;
    assert.equal(context.allowNetwork, false);
    if (calls === 1) { await gate.promise; return [model("updated")]; }
    if (calls === 2) throw new Error("transient provider failure");
    return [model("retried")];
  } });
  const collection = createImageModels({ env: {}, providers: [entry] });
  const one = collection.refresh({ allowNetwork: false });
  const two = collection.refresh({ allowNetwork: false });
  gate.resolve();
  assert.equal((await one).errors.size, 0);
  await two;
  assert.equal(calls, 1);
  assert.equal((await collection.refresh({ allowNetwork: false })).errors.size, 1);
  assert.equal(collection.getModels()[0]!.id, "updated");
  assert.equal((await collection.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(collection.getModels()[0]!.id, "retried");

  const stale = deferred<readonly ImageModel[]>();
  collection.setProvider(provider({ refreshModels: () => stale.promise }));
  const old = collection.refresh();
  collection.setProvider(provider({ models: [model("replacement")], refreshModels: async () => [model("replacement-refresh")] }));
  await collection.refresh();
  stale.resolve([model("stale")]);
  await old;
  assert.equal(collection.getModels()[0]!.id, "replacement-refresh");
  collection.setProvider(provider({ refreshModels: async () => [{ ...model(), provider: "wrong" }] }));
  assert.equal((await collection.refresh()).errors.size, 1);
  assert.equal(collection.getModels()[0]!.id, "original");
});

test("aborted image auth and refresh do not generate or publish a candidate catalog", async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  let calls = 0;
  const collection = createImageModels({ providers: [provider({
    auth: { apiKey: { name: "Delayed key", resolve: async () => { started.resolve(); await gate.promise; return { auth: { apiKey: "key" } }; } } },
    generate: async (selected) => { calls += 1; return result(selected); },
    refreshModels: async () => { calls += 1; return [model("must-not-publish")]; },
  })] });
  const controller = new AbortController();
  const generating = collection.generateImage(model(), { prompt: "pixel", signal: controller.signal });
  const refreshing = collection.refresh({ signal: controller.signal });
  await started.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(generating, { name: "AbortError" });
  assert.equal((await refreshing).aborted, true);
  assert.equal(calls, 0);
  assert.equal(collection.getModels()[0]!.id, "original");
});
