import assert from "node:assert/strict";
import test from "node:test";

import { TuiController } from "../../src/tui/controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "../../src/tui/frame-projector.js";
import type { TuiAction } from "../../src/tui/types.js";
import { createFixtureFrameProjector, FakeInput, FakeOutput, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

const terminals = [
  { name: "wide", columns: 80, rows: 28, ascii: false },
  { name: "narrow", columns: 40, rows: 14, ascii: false },
  { name: "ASCII", columns: 40, rows: 14, ascii: true },
];

function fixture(size: typeof terminals[number]) {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(size.columns, size.rows);
  const actions: TuiAction[] = [];
  const controller = new TuiController({
    input, output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0", OHM_ASCII: size.ascii ? "1" : "0" },
    handleSignals: false,
    onAction: (action) => { actions.push(action); },
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
  });
  controller.start();
  const viewport = () => {
    controller.renderNow();
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
    return terminal.viewport().join("\n").replaceAll(/\s+/gu, " ").trim();
  };
  return { controller, input, actions, viewport };
}

async function escape(input: FakeInput): Promise<void> {
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

for (const terminal of terminals) {
  test(`session confirmation in a ${terminal.name} viewport preserves target, cancellation, and Enter action`, async (t) => {
    const { controller, input, actions, viewport } = fixture(terminal);
    t.after(() => controller.close());
    controller.setEditorText("draft remains");
    controller.setPickerItems("session", [{ id: "older", label: "Older", value: "older" }]);
    controller.openPicker("session", "Resume Session", "old");
    input.write(Buffer.from([4]));
    let frame = viewport();
    assert.ok(frame.includes(terminal.ascii ? 'Delete "Older"?' : "Delete “Older”?"));
    assert.match(frame, /otherwise permanent\./u);
    assert.ok(frame.includes(terminal.ascii ? "Enter delete | Esc cancel" : "Enter delete · Esc cancel"));
    assert.match(frame, /Waiting for input/u);
    assert.doesNotMatch(frame, /0\/0|No matches|confirm>/u);
    if (terminal.ascii) {
      assert.equal(frame, 'Delete session Delete "Older"? Recycle when available; otherwise permanent. Enter delete | Esc cancel Waiting for input ? offline');
    }
    assert.equal(actions.length, 0);

    await escape(input);
    frame = viewport();
    assert.match(frame, /Resume Session.*Filter old/u);
    assert.doesNotMatch(frame, /Waiting for input/u);
    assert.equal(actions.length, 0);
    input.write(Buffer.from([4]));
    assert.match(viewport(), /Delete session/u);
    input.write("\r");
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, "session_delete");
    if (actions[0]?.type === "session_delete") {
      assert.equal(actions[0].item.value, "older");
      assert.equal(actions[0].query, "old");
    }
    assert.match(viewport(), /Resume Session/u);
    await escape(input);
    assert.equal(controller.getEditorText(), "draft remains");
  });

  test(`Atlas label input in a ${terminal.name} viewport preserves prefill, cancel, save, and draft`, async (t) => {
    const { controller, input, viewport } = fixture(terminal);
    t.after(() => controller.close());
    controller.setEditorText("draft remains");
    const changes: Array<{ eventId: string; label: string | undefined }> = [];
    const selection = controller.chooseSessionTree("Atlas", [{
      id: "entry", label: "User prompt", value: "entry",
      tree: { eventId: "entry", kind: "user", depth: 0, prefix: "", branches: [], paths: [], active: true, label: "bookmark" },
    }], {
      onLabelChange: (eventId, label) => {
        changes.push({ eventId, label });
        return label === undefined ? {} : { label };
      },
    });
    void selection.catch(() => undefined);
    input.write("L");
    let frame = viewport();
    assert.match(frame, /Edit entry label.*label> bookmark/u);
    assert.ok(frame.includes(terminal.ascii ? "Enter save | empty removes | Esc cancel" : "Enter save · empty removes · Esc cancel"));
    assert.match(frame, /Waiting for input/u);
    assert.doesNotMatch(frame, /0\/0|No matches/u);
    if (terminal.ascii) {
      assert.equal(frame, "Edit entry label label> bookmark Enter save | empty removes | Esc cancel Waiting for input ? offline");
    }
    input.write(" cancelled");
    await escape(input);
    assert.deepEqual(changes, []);
    assert.match(viewport(), /\[bookmark\] User prompt/u);
    assert.doesNotMatch(viewport(), /Waiting for input/u);

    input.write("L");
    assert.match(viewport(), /label> bookmark/u);
    input.write(Buffer.from([21]));
    input.write("revised\r");
    await tick();
    frame = viewport();
    assert.deepEqual(changes, [{ eventId: "entry", label: "revised" }]);
    assert.match(frame, /\[revised\] User prompt/u);
    assert.doesNotMatch(frame, /Waiting for input/u);
    input.write("\r");
    assert.equal(await selection, "entry");
    assert.equal(controller.getEditorText(), "draft remains");
  });
}

test("ASCII prompt chrome preserves Unicode session names and label values", async (t) => {
  const { controller, input, viewport } = fixture({ name: "ASCII", columns: 40, rows: 14, ascii: true });
  t.after(() => controller.close());
  controller.setPickerItems("session", [{ id: "older", label: "保存 界", value: "older" }]);
  controller.openPicker("session");
  input.write(Buffer.from([4]));
  assert.ok(viewport().includes('Delete "保存 界"?'));
  assert.ok(viewport().includes("Enter delete | Esc cancel"));
  await escape(input);
  await escape(input);

  const selection = controller.chooseSessionTree("Atlas", [{
    id: "entry", label: "User prompt", value: "entry",
    tree: { eventId: "entry", kind: "user", depth: 0, prefix: "", branches: [], paths: [], active: true, label: "標記界" },
  }], { onLabelChange: (_eventId, label) => label === undefined ? {} : { label } });
  void selection.catch(() => undefined);
  input.write("L");
  assert.ok(viewport().includes("label> 標記界"));
  assert.ok(viewport().includes("Enter save | empty removes | Esc cancel"));
  await escape(input);
  input.write("\r");
  assert.equal(await selection, "entry");
});
