import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { TuiController, TuiSelectionCancelledError } from "../../src/tui/controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "../../src/tui/frame-projector.js";
import { createFixtureFrameProjector, FakeInput, FakeOutput } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

const pickers: Array<{
  name: string;
  open(controller: TuiController, signal: AbortSignal): Promise<number | void>;
}> = [
  { name: "choice", open: (controller, signal) => controller.choose("Choice", [{ label: "One", value: 1 }], signal) },
  {
    name: "model",
    open: (controller, signal) => controller.choosePicker("model", "Models", [{ id: "one", label: "One", value: 1 }], signal),
  },
  {
    name: "settings",
    open: (controller, signal) => controller.chooseSettings([{
      id: "theme", label: "Theme", value: "dark", values: ["dark", "light"], description: "Color theme",
    }], () => undefined, signal),
  },
  {
    name: "tree",
    open: (controller, signal) => controller.chooseSessionTree("Atlas", [{
      id: "one", label: "One", value: 1,
      tree: { eventId: "one", kind: "user", depth: 0, prefix: "", branches: [], paths: [], active: true },
    }], {}, signal),
  },
];

function fixture() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input, output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
  });
  controller.start();
  return { controller, input, output };
}

function viewport(output: FakeOutput): string {
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  return terminal.viewport().join("\n");
}

for (const picker of pickers) {
  for (const phase of ["active", "opening"] as const) {
    test(`${picker.name} picker preserves an ${phase} extension route`, async (t) => {
      const { controller, output } = fixture();
      t.after(() => controller.close());
      const generation = new AbortController();
      const cancellation = new AbortController();
      let rejected: Promise<void> | undefined;
      const attempt = () => {
        rejected = assert.rejects(picker.open(controller, cancellation.signal), /active plugin UI route/u);
        cancellation.abort(new Error("picker should have been refused"));
      };
      const route = controller.openPluginUiRoute("plugin", "route", "Route", () => {
        if (phase === "opening") attempt();
        return { render: () => ({ lines: [{ spans: [{ text: "ROUTE_BODY" }] }] }) };
      }, generation.signal);
      if (phase === "active") attempt();
      assert.ok(rejected);
      await rejected;
      assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
      controller.renderNow();
      assert.match(viewport(output), /ROUTE_BODY/u);
      route.close();
      controller.renderNow();
      assert.doesNotMatch(viewport(output), /ROUTE_BODY/u);
    });
  }

  test(`${picker.name} picker releases cancellation ownership before another picker opens`, async (t) => {
    const { controller, input } = fixture();
    t.after(() => controller.close());
    const first = new AbortController();
    const selection = picker.open(controller, first.signal);
    const rejected = assert.rejects(selection, /generation ended/u);
    assert.equal(getEventListeners(first.signal, "abort").length, 1);
    const staleAbort = getEventListeners(first.signal, "abort")[0]!;
    first.abort(new Error("generation ended"));
    await rejected;
    assert.equal(getEventListeners(first.signal, "abort").length, 0);

    const second = new AbortController();
    const next = controller.choose("Next", [{ label: "Two", value: 2 }], second.signal);
    staleAbort.call(first.signal, new Event("abort"));
    input.write("\r");
    assert.equal(await next, 2);
    assert.equal(getEventListeners(second.signal, "abort").length, 0);
  });
}

test("picker captures its selected value before the caller changes its catalog", async (t) => {
  const { controller, input } = fixture();
  t.after(() => controller.close());
  const items = [{ id: "one", label: "One", value: 1 }];
  const selected = controller.choosePicker("provider", "Provider", items);
  input.write("\r");
  items[0] = { id: "one", label: "Replacement", value: 2 };
  assert.equal(await selected, 1);
});

test("settings Escape remains successful completion while a choice Escape rejects", async (t) => {
  const { controller, input } = fixture();
  t.after(() => controller.close());
  const settings = pickers.find((picker) => picker.name === "settings")!;
  const signal = new AbortController().signal;
  const selection = settings.open(controller, signal);
  input.write("\u001b");
  await selection;
  assert.equal(getEventListeners(signal, "abort").length, 0);

  const choice = controller.choose("Choice", [{ label: "One", value: 1 }], signal);
  const rejected = assert.rejects(choice, TuiSelectionCancelledError);
  input.write("\u001b");
  await rejected;
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
