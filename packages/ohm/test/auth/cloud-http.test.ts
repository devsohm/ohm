import assert from "node:assert/strict";
import test from "node:test";

import { CloudAuthIoError, requestBounded } from "../../src/auth/cloud-http.js";

test("cloud auth rejects request timeouts above the Node timer limit before fetching", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    requestBounded("https://example.invalid", {}, {
      fetch: async () => {
        fetchCalls += 1;
        return new Response("ok");
      },
      timeoutMs: 2_147_483_648,
      maxResponseBytes: 32,
      label: "test cloud auth",
    }),
    /timeoutMs must be an integer from 1 through 2147483647/u,
  );
  assert.equal(fetchCalls, 0);
});

test("cloud auth HTTP reader enforces its byte limit while streaming", async () => {
  await assert.rejects(
    requestBounded("https://example.invalid", {}, {
      fetch: async () => new Response("x".repeat(1024)),
      timeoutMs: 1000,
      maxResponseBytes: 32,
      label: "test cloud auth",
    }),
    (error: CloudAuthIoError) => {
      assert.equal(error.kind, "response_limit");
      assert.doesNotMatch(error.message, /x{4}/);
      return true;
    },
  );
});

test("cloud auth HTTP errors do not include URLs that might contain secrets", async () => {
  await assert.rejects(
    requestBounded("https://example.invalid/token?secret=value", {}, {
      fetch: async () => {
        throw new Error("https://example.invalid/token?secret=value");
      },
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      label: "test cloud auth",
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /secret=value|example\.invalid/);
      return true;
    },
  );
});

test("cloud auth overflow settles without awaiting source cancellation", async () => {
  let releaseCancel!: () => void;
  const pendingCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(33)); },
    cancel() { cancellations += 1; return pendingCancel; },
  });
  const request = requestBounded("https://example.invalid", {}, {
    fetch: async () => new Response(body), timeoutMs: 1000, maxResponseBytes: 32, label: "test cloud auth",
  });
  let settled = false;
  void request.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(request, { name: "CloudAuthIoError", kind: "response_limit" });
  void rejected.catch(() => undefined);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
    await rejected;
  } finally {
    releaseCancel();
    await Promise.allSettled([rejected]);
  }
});

for (const cancellation of ["caller", "timeout"] as const) {
  test(`cloud auth ${cancellation} cancellation bounds a custom fetch response body`, async () => {
    const abort = new AbortController();
    let closeBody!: () => void;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { closeBody = () => controller.close(); },
      cancel() { cancellations += 1; },
    });
    const request = requestBounded("https://example.invalid/token?secret=value", {}, {
      fetch: async () => new Response(body),
      timeoutMs: cancellation === "timeout" ? 10 : 1000,
      maxResponseBytes: 32,
      label: "test cloud auth",
      signal: abort.signal,
    });
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(request, (error: CloudAuthIoError) => {
      assert.equal(error.kind, cancellation === "timeout" ? "timeout" : "network");
      assert.doesNotMatch(error.message, /secret=value|example\.invalid/u);
      return true;
    });
    void rejected.catch(() => undefined);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (cancellation === "caller") abort.abort(new Error("secret=value"));
      else await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, true);
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
      await rejected;
    } finally {
      if (cancellations === 0) closeBody();
      await Promise.allSettled([rejected]);
    }
  });
}
