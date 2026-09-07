import assert from "node:assert/strict";
import test from "node:test";

import type { Provider, ProviderModel, ProviderModelsStoreEntry } from "../../src/providers/index.js";
import { withRemoteCatalog } from "../../src/providers/remote-catalog.js";

const baseline: ProviderModel = {
  id: "baseline",
  name: "Baseline",
  api: "openai-responses",
  provider: "bounded-catalog",
  baseUrl: "https://api.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_384,
  maxTokens: 2_048,
};

const cached: ProviderModel = {
  ...baseline,
  id: "cached",
  name: "Cached",
};

function provider(): Provider {
  return {
    id: "bounded-catalog",
    name: "Bounded catalog",
    baseUrl: baseline.baseUrl,
    auth: {},
    getModels: () => [baseline],
    async *stream() {},
    async *streamSimple() {},
  };
}

function store(initial: ProviderModelsStoreEntry | undefined) {
  let value = initial;
  return {
    async read() { return value === undefined ? undefined : structuredClone(value); },
    async write(next: ProviderModelsStoreEntry) { value = structuredClone(next); },
    async delete() { value = undefined; },
  };
}

for (const mode of ["success", "HTTP error", "declared overflow", "streamed overflow", "abort"] as const) {
  test(`remote catalog releases response ownership on ${mode}`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let resolveAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { resolveAcquired = resolve; });
    let resolveCancellation!: () => void;
    const cancellationSettled = new Promise<void>((resolve) => { resolveCancellation = resolve; });
    const abort = new AbortController();
    const cancellation = new Error("catalog reader cancelled");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull(value) {
        resolveAcquired();
        if (mode === "success") {
          value.enqueue(Buffer.from(JSON.stringify({ models: [baseline] })));
          value.close();
          closed = true;
        } else if (mode === "streamed overflow") {
          value.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        }
      },
      cancel() {
        cancelled = true;
        return cancellationSettled;
      },
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (mode === "declared overflow") headers.set("content-length", String(8 * 1024 * 1024 + 1));
    globalThis.fetch = async () => new Response(body, { status: mode === "HTTP error" ? 503 : 200, headers });
    const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");
    const refreshing = wrapped.refreshModels!({
      allowNetwork: true,
      force: true,
      signal: abort.signal,
      store: store({ models: [cached], checkedAt: 0 }),
    });
    const observed = refreshing.then(() => "fulfilled", (error) => error);
    try {
      if (mode === "abort") {
        await acquired;
        abort.abort(cancellation);
      }
      const outcome = await Promise.race([
        observed,
        new Promise<"pending">((resolve) => setImmediate(resolve, "pending")),
      ]);
      if (mode === "success") assert.equal(outcome, "fulfilled");
      else if (mode === "abort") assert.equal(outcome, cancellation);
      else {
        assert.ok(outcome instanceof Error, "catalog operation must settle without awaiting body cancellation");
        assert.match(outcome.message, mode === "HTTP error" ? /503/u : /exceeds/u);
      }
      assert.equal(body.locked, false);
      assert.equal(cancelled, mode !== "success");
      if (mode !== "success") {
        assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
      }
    } finally {
      resolveCancellation();
      if (!cancelled && !closed) controller.close();
      await observed;
    }
  });
}

test("remote catalogs use a timeout signal, reject oversized bodies, and retain the last good overlay", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Response("{}", {
      headers: { "content-length": String(128 * 1024 * 1024) },
    });
  };
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await assert.rejects(wrapped.refreshModels!({
    allowNetwork: true,
    force: true,
    store: store({ models: [cached], checkedAt: 0 }),
  }), /catalog response exceeds/iu);

  assert.ok(requestSignal);
  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
});

test("remote catalogs reject excessive entry counts before model conversion", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    models: Array.from({ length: 4_097 }, (_, index) => ({ id: `model-${index}` })),
  });
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await assert.rejects(wrapped.refreshModels!({
    allowNetwork: true,
    force: true,
    store: store({ models: [cached], checkedAt: 0 }),
  }), /too many models/iu);

  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
});

test("remote catalogs reject deeply nested metadata before cloning it", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let nested = {};
  for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
  globalThis.fetch = async () => Response.json({
    models: [{ ...baseline, compat: nested }],
  });
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await assert.rejects(wrapped.refreshModels!({
    allowNetwork: true,
    force: true,
    store: store({ models: [cached], checkedAt: 0 }),
  }), /nested too deeply/iu);

  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
});

test("remote catalogs clear an overlay when the scoped cache is unavailable", async () => {
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await wrapped.refreshModels!({
    allowNetwork: false,
    store: store({ models: [cached], checkedAt: 0 }),
  });
  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);

  await wrapped.refreshModels!({
    allowNetwork: false,
    store: store(undefined),
  });
  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline"]);
});
