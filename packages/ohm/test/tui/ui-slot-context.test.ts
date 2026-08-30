import assert from "node:assert/strict";
import test from "node:test";

import { createOwnedInteractiveDirectUiContext } from "../../src/tui/direct-ui.js";
import { TuiController } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  type InternalTuiControllerOptions,
} from "../../src/tui/frame-projector.js";
import { projectRichTuiFrame } from "../../src/tui/rich-frame-projector.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

function fullController() {
  const output = new FakeOutput();
  const options: InternalTuiControllerOptions = {
    input: new FakeInput(),
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    [INTERNAL_TUI_FRAME_PROJECTOR]: projectRichTuiFrame,
  };
  const controller = new TuiController(options);
  controller.start();
  return { controller, output };
}

function viewport(output: FakeOutput): string {
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  return stripAnsi(terminal.viewport().join("\n"));
}

test("rich direct UI slots update atomically and end with their generation", async () => {
  const { controller, output } = fullController();
  const generation = new AbortController();
  const ui = createOwnedInteractiveDirectUiContext(
    controller,
    "extension-a",
    process.cwd(),
    generation.signal,
  );

  assert.equal(ui.capabilities?.slots, true);
  const handle = ui.slots.set("session.beforeEditor", "summary", {
    lines: ["first summary"],
    order: 1,
  });
  controller.renderNow();
  assert.match(viewport(output), /first summary/u);

  assert.throws(() => handle.update({ lines: ["\u001b[31munsafe"] }), /terminal-safe/u);
  controller.renderNow();
  assert.match(viewport(output), /first summary/u, "a rejected update retains the previous value");

  handle.update({ lines: ["updated summary"] });
  controller.renderNow();
  assert.match(viewport(output), /updated summary/u);
  assert.doesNotMatch(viewport(output), /first summary/u);

  generation.abort(new Error("extension refreshed"));
  await tick();
  controller.renderNow();
  assert.equal(handle.disposed, true);
  assert.doesNotMatch(viewport(output), /updated summary/u);
  controller.close();
});

test("line and accessibility direct UI contexts declare slots unavailable", () => {
  for (const mode of ["line", "accessible"] as const) {
    const controller = new TuiController({
      input: new FakeInput(),
      output: new FakeOutput(),
      mode,
      environment: { TERM: "dumb", NO_COLOR: "1" },
      handleSignals: false,
    });
    const generation = new AbortController();
    const ui = createOwnedInteractiveDirectUiContext(
      controller,
      `extension-${mode}`,
      process.cwd(),
      generation.signal,
    );
    assert.equal(ui.capabilities?.slots, false, mode);
    assert.throws(
      () => ui.slots.set("session.header", "summary", { lines: ["unsupported"] }),
      /full rich TUI/u,
      mode,
    );
    generation.abort(new Error("test complete"));
    controller.close();
  }
});
