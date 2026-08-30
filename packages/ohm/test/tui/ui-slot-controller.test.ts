import assert from "node:assert/strict";
import test from "node:test";

import { Text } from "@ohm/terminal";

import { TuiController } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  type InternalTuiControllerOptions,
} from "../../src/tui/frame-projector.js";
import { projectRichTuiFrame } from "../../src/tui/rich-frame-projector.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

function fullController(rows = 24) {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(80, rows);
  const options: InternalTuiControllerOptions = {
    input,
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

test("controller UI slots compose, replace, fall back, and clean up by generation", async () => {
  const { controller, output } = fullController();
  const generationA = new AbortController();
  const generationB = new AbortController();
  const a = {};
  const b = {};

  controller.setExtensionUiSlot("owner-a", "session.beforeEditor", "summary", {
    lines: ["A append"],
    order: 1,
  }, a, generationA.signal);
  controller.setExtensionUiSlot("owner-b", "session.beforeEditor", "summary", {
    lines: ["B prepend"],
    placement: "prepend",
  }, b, generationB.signal);
  controller.setExtensionUiSlot("owner-a", "session.footer", "replacement", {
    lines: ["footer fallback"],
    placement: "replace",
    order: 1,
  }, {}, generationA.signal);
  const footerWinner = {};
  controller.setExtensionUiSlot("owner-b", "session.footer", "replacement", {
    lines: ["footer winner"],
    placement: "replace",
    order: 2,
  }, footerWinner, generationB.signal);
  controller.renderNow();

  const initial = viewport(output);
  assert.ok(initial.indexOf("B prepend") < initial.indexOf("A append"), initial);
  assert.match(initial, /footer winner/u);
  assert.doesNotMatch(initial, /footer fallback/u);

  controller.setExtensionUiSlot("owner-a", "session.beforeEditor", "summary", {
    lines: ["A updated"],
  }, {}, generationA.signal);
  controller.setExtensionUiSlot("owner-a", "session.beforeEditor", "summary", undefined, a);
  controller.renderNow();
  assert.match(viewport(output), /A updated/u, "a stale token cannot remove its replacement");

  generationB.abort(new Error("extension B refreshed"));
  await tick();
  controller.renderNow();
  const fallback = viewport(output);
  assert.doesNotMatch(fallback, /B prepend|footer winner/u);
  assert.match(fallback, /A updated/u);
  assert.match(fallback, /footer fallback/u);

  controller.clearExtensionUi();
  controller.renderNow();
  assert.doesNotMatch(viewport(output), /A updated|footer fallback/u);
  generationA.abort(new Error("test complete"));
  controller.close();
});

test("raw replacements outrank slots, which outrank earlier structured replacements", async () => {
  const { controller, output } = fullController();
  const structured = new AbortController();
  const slot = new AbortController();
  const raw = new AbortController();

  controller.setPersistentComponent("header-replacement", "structured", () => ({
    render: () => ({ lines: [{ spans: [{ text: "structured fallback" }] }] }),
  }), structured.signal);
  controller.setExtensionUiSlot("slot-owner", "session.header", "replacement", {
    lines: ["slot replacement"],
    placement: "replace",
  }, {}, slot.signal);
  controller.renderNow();
  assert.match(viewport(output), /slot replacement/u);
  assert.doesNotMatch(viewport(output), /structured fallback/u);

  controller.setRawPersistentComponent(
    "header-replacement",
    "raw",
    new Text("raw replacement", 0, 0),
    raw.signal,
  );
  controller.renderNow();
  assert.match(viewport(output), /raw replacement/u);
  assert.doesNotMatch(viewport(output), /slot replacement|structured fallback/u);

  raw.abort(new Error("raw extension ended"));
  await tick();
  controller.renderNow();
  assert.match(viewport(output), /slot replacement/u);

  slot.abort(new Error("slot extension ended"));
  await tick();
  controller.renderNow();
  assert.match(viewport(output), /structured fallback/u);
  structured.abort(new Error("test complete"));
  controller.close();
});

test("tiny rich frames retain the editor cursor while slot rows are budgeted", () => {
  const { controller, output } = fullController(4);
  controller.setEditorText("a🙂b");
  const generation = new AbortController();
  for (const [index, path] of ([
    "session.header",
    "session.beforeEditor",
    "session.afterEditor",
    "session.footer",
  ] as const).entries()) {
    controller.setExtensionUiSlot("owner", path, `slot-${index}`, {
      lines: [`slot ${index} row 1`, `slot ${index} row 2`],
    }, {}, generation.signal);
  }
  controller.renderNow();

  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  const lines = terminal.viewport();
  const cursor = terminal.cursor();
  assert.equal(lines.length, 4);
  assert.ok(cursor.row >= 0 && cursor.row < lines.length);
  assert.match(stripAnsi(lines[cursor.row] ?? ""), /a🙂b/u);
  generation.abort(new Error("test complete"));
  controller.close();
});

test("line and accessibility controllers reject persistent UI slots", () => {
  for (const mode of ["line", "accessible"] as const) {
    const controller = new TuiController({
      input: new FakeInput(),
      output: new FakeOutput(),
      mode,
      environment: { TERM: "dumb", NO_COLOR: "1" },
      handleSignals: false,
    });
    const generation = new AbortController();
    assert.throws(() => controller.setExtensionUiSlot(
      "owner",
      "session.header",
      "header",
      { lines: ["unsupported"] },
      {},
      generation.signal,
    ), /full rich TUI/u, mode);
    generation.abort(new Error("test complete"));
    controller.close();
  }
});
