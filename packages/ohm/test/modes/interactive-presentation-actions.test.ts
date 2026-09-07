import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import {
  createPortablePresentation,
  definePortablePresentationAction,
  portablePresentationShowEvent,
} from "../../src/interfaces/portable-presentation.js";
import { runInteractivePresentationAction } from "../../src/modes/interactive-presentation-actions.js";
import type { TerminalChoice } from "../../src/tui/types.js";

function terminal(answers: string[] = []) {
  const notices: string[] = [];
  const prompts: string[] = [];
  return {
    notices,
    prompts,
    async choose<T>(prompt: string, choices: TerminalChoice<T>[]): Promise<T> {
      prompts.push(prompt);
      return choices[0]!.value;
    },
    async question(prompt: string): Promise<string> {
      prompts.push(prompt);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`Unexpected input: ${prompt}`);
      return answer;
    },
    notify(message: string) { notices.push(message); },
  };
}

test("interactive actions collect typed fields and invoke the shared host boundary", async () => {
  const calls: Array<{ name: string; count: number }> = [];
  const presentation = createPortablePresentation("example", {
    id: "review",
    title: "Review changes",
    revision: 7,
    blocks: [],
    actions: [definePortablePresentationAction({
      id: "run",
      label: "Start review",
      inputSchema: Type.Object({ name: Type.String({ minLength: 1 }), count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
      run(input) { calls.push(input); return null; },
    })],
  });
  const ui = terminal(["", "workspace", "invalid", "0", "2"]);
  await runInteractivePresentationAction({
    listPortablePresentations: () => [portablePresentationShowEvent("example", presentation.document)],
    invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
  }, ui, new AbortController().signal);
  assert.deepEqual(calls, [{ name: "workspace", count: 2 }]);
  assert.equal(ui.notices.at(-1), "Start review completed");
  assert.equal(ui.notices.length, 4);
});

test("interactive actions do not invoke disabled actions or require input for empty objects", async () => {
  let calls = 0;
  const presentation = createPortablePresentation("example", {
    id: "counter",
    blocks: [],
    actions: [
      { id: "disabled", label: "Disabled", disabled: true, inputSchema: Type.Object({}, { additionalProperties: false }), run() { throw new Error("disabled"); } },
      { id: "increment", label: "Increment", inputSchema: Type.Object({}, { additionalProperties: false }), run() { calls++; return calls; } },
    ],
  });
  const ui = terminal();
  await runInteractivePresentationAction({
    listPortablePresentations: () => [portablePresentationShowEvent("example", presentation.document)],
    invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
  }, ui, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(ui.prompts, ["Plugin actions"]);
});

test("interactive actions name empty and multiple plugin views consistently", async () => {
  const ui = terminal();
  await runInteractivePresentationAction({
    listPortablePresentations: () => [],
    invokePortablePresentationAction: async () => { throw new Error("No action is available"); },
  }, ui, new AbortController().signal);
  assert.deepEqual(ui.notices, ["No plugin actions are available"]);
  const presentation = createPortablePresentation("example", {
    id: "counter",
    blocks: [],
    actions: [{ id: "increment", label: "Increment", inputSchema: Type.Object({}, { additionalProperties: false }), run() { return null; } }],
  });
  await runInteractivePresentationAction({
    listPortablePresentations: () => [
      portablePresentationShowEvent("example", presentation.document),
      portablePresentationShowEvent("other", presentation.document),
    ],
    invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
  }, ui, new AbortController().signal);
  assert.deepEqual(ui.prompts, ["Plugin views", "Plugin actions"]);
});

test("interactive action selection cannot invoke a stale presentation revision", async () => {
  let calls = 0;
  const definition = {
    id: "counter",
    blocks: [],
    actions: [{ id: "increment", label: "Increment", inputSchema: Type.Object({}, { additionalProperties: false }), run() { calls++; return null; } }],
  };
  const previous = createPortablePresentation("example", { ...definition, revision: 1 });
  const current = createPortablePresentation("example", { ...definition, revision: 2 });
  await assert.rejects(runInteractivePresentationAction({
    listPortablePresentations: () => [portablePresentationShowEvent("example", previous.document)],
    invokePortablePresentationAction: async (request, signal) => await current.invoke(request, signal),
  }, terminal(), new AbortController().signal), /revision is stale/u);
  assert.equal(calls, 0);
});

test("interactive action cancellation never dispatches the selected action", async () => {
  const abort = new AbortController();
  const presentation = createPortablePresentation("example", {
    id: "cancelled", blocks: [],
    actions: [{ id: "run", label: "Run", inputSchema: Type.Object({}), run() { throw new Error("must not run"); } }],
  });
  const ui = terminal();
  await assert.rejects(runInteractivePresentationAction({
    listPortablePresentations: () => [portablePresentationShowEvent("example", presentation.document)],
    invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
  }, {
    ...ui,
    async choose<T>(_prompt: string, choices: TerminalChoice<T>[]): Promise<T> {
      abort.abort(new Error("Cancelled"));
      return choices[0]!.value;
    },
  }, abort.signal), /Cancelled/u);
});

test("interactive actions accept record input and show bounded query results", async () => {
  const calls: Array<Record<string, string>> = [];
  const presentation = createPortablePresentation("example", {
    id: "records", blocks: [],
    actions: [definePortablePresentationAction({
      id: "query", label: "Query", inputSchema: Type.Record(Type.String(), Type.String()),
      run(input) { calls.push(input); return { found: "x".repeat(20_000) }; },
    })],
  });
  const ui = terminal(['{"key":"value"}']);
  await runInteractivePresentationAction({
    listPortablePresentations: () => [portablePresentationShowEvent("example", presentation.document)],
    invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
  }, ui, new AbortController().signal);
  assert.deepEqual(calls, [{ key: "value" }]);
  assert.match(ui.prompts[1]!, /JSON/u);
  assert.match(ui.notices.at(-1)!, /"found"/u);
  assert.ok(Buffer.byteLength(ui.notices.at(-1)!, "utf8") < 17 * 1024);
});

test("interactive action forms never send terminal controls from labels or property names", async () => {
  const control = "\u001b]52;c;Y2xpcGJvYXJk\u0007";
  const key = `name${control}`;
  let received = "";
  const presentation = createPortablePresentation("example", {
    id: "labels", title: `Title${control}`, blocks: [],
    actions: [definePortablePresentationAction({
      id: "input", label: `Label${control}`, inputSchema: Type.Object({ [key]: Type.String() }, { additionalProperties: false }),
      run(input) { received = input[key]!; return null; },
    })],
  });
  const ui = terminal(["value"]);
  await runInteractivePresentationAction({
    listPortablePresentations: () => [portablePresentationShowEvent("example", presentation.document)],
    invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
  }, ui, new AbortController().signal);
  assert.equal(received, "value", "display sanitization must not rename the schema property");
  for (const output of [...ui.prompts, ...ui.notices]) {
    assert.equal(output.includes("\u001b"), false);
    assert.equal(output.includes("\u0007"), false);
  }
});

test("interactive actions use JSON for open objects, including undeclared required keys", async () => {
  for (const schema of [
    { type: "object", properties: {}, additionalProperties: true, minProperties: 1 },
    { type: "object", properties: {}, required: ["key"] },
  ]) {
    const calls: unknown[] = [];
    const presentation = createPortablePresentation("example", {
      id: "open-object", blocks: [],
      actions: [{
        id: "submit", label: "Submit", inputSchema: schema,
        run(input) { calls.push(input); return null; },
      }],
    });
    const ui = terminal(['{"key":"value"}']);
    await runInteractivePresentationAction({
      listPortablePresentations: () => [portablePresentationShowEvent("example", presentation.document)],
      invokePortablePresentationAction: async (request, signal) => await presentation.invoke(request, signal),
    }, ui, new AbortController().signal);
    assert.deepEqual(calls, [{ key: "value" }]);
    assert.match(ui.prompts[1]!, /JSON/u);
  }
});
