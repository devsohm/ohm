import assert from "node:assert/strict";
import test from "node:test";
import { withScopedGlobalFetch } from "../../src/providers/scoped-global-fetch.js";

test("scoped fetch keeps each global wrapper's original fallback", async () => {
  const original = globalThis.fetch;
  let baseCalls = 0;
  let wrapperCalls = 0;
  try {
    globalThis.fetch = async () => { baseCalls += 1; return new Response("base"); };
    withScopedGlobalFetch(async () => new Response("first"), () => undefined);
    const previous = globalThis.fetch;
    globalThis.fetch = (input, init) => { wrapperCalls += 1; return previous(input, init); };
    const scoped = await withScopedGlobalFetch(async () => new Response("second"),
      async () => await globalThis.fetch("https://unused.invalid"));
    assert.equal(await scoped.text(), "second");
    assert.equal(await (await globalThis.fetch("https://unused.invalid")).text(), "base");
    assert.equal(baseCalls, 1);
    assert.equal(wrapperCalls, 1);
  } finally { globalThis.fetch = original; }
});

test("scoped fetch isolates concurrent and nested asynchronous operations", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("base");
    const read = async () => await (await globalThis.fetch("https://unused.invalid")).text();
    const values = await Promise.all(["one", "two"].map(async (value) =>
      await withScopedGlobalFetch(async () => new Response(value), async () => {
        await Promise.resolve();
        const nested = await withScopedGlobalFetch(async () => new Response("nested"), read);
        return [nested, await read()];
      })));
    assert.deepEqual(values, [["nested", "one"], ["nested", "two"]]);
    assert.equal(await read(), "base");
  } finally { globalThis.fetch = original; }
});
