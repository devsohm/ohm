import assert from "node:assert/strict";
import test from "node:test";
import activate from "../src/index.mjs";

function store() {
  let value;
  let revision = 0;
  return {
    async read(_scope, { signal } = {}) { signal?.throwIfAborted(); return { value: structuredClone(value), revision: String(revision) }; },
    async replace(_scope, next, options) {
      options.signal?.throwIfAborted();
      if (options.expectedRevision !== String(revision)) throw new Error("configuration conflict");
      value = structuredClone(next);
      revision += 1;
    },
  };
}

async function fixture(config = store()) {
  let tool;
  let command;
  let beforeRun;
  let definition;
  let cleanup;
  await activate({
    config,
    facets: { async register(facet) {
      cleanup = facet.setup({ presentation: { show(value) {
        definition = value;
        return { disposed: false, get document() { return definition; }, update(next) { definition = next; } };
      } } });
    } },
    registerTool(value) { tool = value; },
    registerCommand(_name, value) { command = value; },
    on(_name, callback) { beforeRun = callback; },
  });
  return { config, tool, command, beforeRun, cleanup, presentation: () => definition };
}

test("explicit notes survive refresh and only the last six enter model context", async () => {
  const first = await fixture();
  for (let index = 0; index < 8; index += 1) await first.tool.execute("call", { action: "remember", text: `note ${index}` });
  first.cleanup();
  const second = await fixture(first.config);
  const recalled = await second.tool.execute("call", { action: "recall" });
  assert.equal(recalled.details.notes.length, 8);
  const context = await second.beforeRun({}, {});
  assert.equal(context.message.display, false);
  assert.equal(context.message.content.includes('"text":"note 0"'), false);
  assert.equal(context.message.content.includes('"text":"note 7"'), true);
});

test("portable memory actions save, redraw, and forget through the same store", async () => {
  const runtime = await fixture();
  await runtime.command.handler("", { ui: { notify() {} } });
  const signal = new AbortController().signal;
  await runtime.presentation().actions[0].run({ text: "Use the local fixture" }, { signal });
  assert.match(runtime.presentation().blocks[0].items[0], /Use the local fixture/u);
  const recalled = await runtime.tool.execute("call", { action: "recall" });
  await runtime.presentation().actions[1].run({ id: recalled.details.notes[0].id }, { signal });
  assert.deepEqual(runtime.presentation().blocks[0].items, []);
});

test("cancellation never writes and concurrent updates cannot overwrite each other", async () => {
  const runtime = await fixture();
  await assert.rejects(runtime.tool.execute("call", { action: "remember", text: "cancelled" }, AbortSignal.abort(new Error("cancelled"))), /cancelled/u);
  const results = await Promise.allSettled([
    runtime.tool.execute("call", { action: "remember", text: "first" }),
    runtime.tool.execute("call", { action: "remember", text: "second" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await runtime.tool.execute("call", { action: "recall" })).details.notes.length, 1);
});
