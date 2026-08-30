import assert from "node:assert/strict";
import test from "node:test";

import { type Component, type TUI } from "@ohm/terminal";

import { createInteractiveDirectUiContext } from "../../src/tui/direct-ui.js";
import { TuiController } from "../../src/tui/controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "../../src/tui/frame-projector.js";
import { createFixtureFrameProjector, FakeInput, FakeOutput } from "./helpers.js";

test("direct extension callbacks expose the live renderer mode and immediate render", async () => {
  const controller = new TuiController({
    input: new FakeInput(),
    output: new FakeOutput(),
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
  });
  controller.start();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "public-tui-contract",
    process.cwd(),
    generation.signal,
  );
  let tui: TUI | undefined;
  let renders = 0;
  const component: Component = {
    render: () => {
      renders += 1;
      return ["contract"];
    },
    invalidate() {},
  };
  ui.setWidget("capture", (value) => {
    tui = value;
    return component;
  });
  assert.ok(tui !== undefined);
  assert.equal(tui.mode, "fullscreen");

  const redraws = tui.fullRedraws;
  tui.renderNow(true);
  assert.ok(tui.fullRedraws > redraws);
  assert.equal(renders, 1);
  await Promise.resolve();
  assert.equal(renders, 1);

  generation.abort(new Error("test complete"));
  controller.close();
});
