import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, Editor, FullscreenTUI, TUI } from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

const identity = (value) => value;
const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

test("virtual terminal models bounded cursor cells, delayed wrapping, scrolling and disabled wrapping", () => {
  const terminal = new VirtualTerminal(4, 2);
  terminal.write("abcd");
  assert.deepEqual(terminal.getCursorPosition(), { x: 3, y: 0 });
  terminal.write("E");
  assert.deepEqual(terminal.getCursorPosition(), { x: 1, y: 1 });
  terminal.write("\r\nFGHIJ");
  assert.deepEqual(terminal.getViewport(), ["FGHI", "J"]);
  assert.deepEqual(terminal.getCursorPosition(), { x: 1, y: 1 });
  terminal.write("\x1b[999;999H");
  assert.deepEqual(terminal.getCursorPosition(), { x: 3, y: 1 });
  const rows = terminal.getScrollBuffer().length;
  terminal.write("\x1b[?7l\r12345");
  assert.deepEqual(terminal.getCursorPosition(), { x: 3, y: 1 });
  assert.equal(terminal.getViewport()[1], "1235");
  assert.equal(terminal.getScrollBuffer().length, rows);
  terminal.write("\x1b[99B");
  assert.deepEqual(terminal.getCursorPosition(), { x: 3, y: 1 });
});

for (const Surface of [TUI, FullscreenTUI]) {
  test(`${Surface.name} retains the real Editor caret across redraw, overlay, visibility and resize`, (context) => {
    const terminal = new VirtualTerminal(20, 6);
    const tui = new Surface(terminal, true, undefined, { mouse: false });
    context.after(() => tui.stop());
    const root = new Container();
    const editor = new Editor(tui, theme);
    editor.setText("abcdef");
    editor.handleInput("\x01");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    let footer = "footer";
    root.addChild(editor);
    root.addChild({ render: () => [footer], invalidate() {} });
    tui.addChild(root);
    tui.setFocus(editor);
    assert.equal(editor.render(20)[1].includes(CURSOR_MARKER), true);
    tui.start();
    tui.renderNow(true);
    assert.deepEqual(terminal.getCursorPosition(), { x: 3, y: 1 });
    assert.equal(terminal.cursorVisible, true);
    assert.equal(terminal.writes.some((write) => write.includes(CURSOR_MARKER)), false);

    editor.handleInput("\x1b[D");
    footer = "changed";
    tui.renderNow();
    assert.deepEqual(terminal.getCursorPosition(), { x: 2, y: 1 });
    assert.equal(terminal.getViewport()[3].trimEnd(), "changed");
    tui.setShowHardwareCursor(false);
    editor.handleInput("\x1b[D");
    tui.renderNow();
    assert.deepEqual(terminal.getCursorPosition(), { x: 1, y: 1 });
    assert.equal(terminal.cursorVisible, false);
    tui.setShowHardwareCursor(true);
    assert.equal(terminal.cursorVisible, true);

    const overlay = tui.showOverlay({
      focused: false,
      handleInput() {},
      render: () => [`p${CURSOR_MARKER}q`],
      invalidate() {},
    }, { row: 0, col: 5, width: 5 });
    tui.renderNow();
    assert.equal(editor.focused, false);
    assert.deepEqual(terminal.getCursorPosition(), { x: 6, y: 0 });
    overlay.hide();
    tui.renderNow();
    assert.equal(editor.focused, true);
    assert.deepEqual(terminal.getCursorPosition(), { x: 1, y: 1 });
    terminal.resize(12, 5);
    tui.renderNow();
    assert.deepEqual(terminal.getCursorPosition(), { x: 1, y: 1 });
    assert.equal(terminal.getViewport()[3].trimEnd(), "changed");
    tui.stop();
    assert.equal(terminal.cursorVisible, true);
    if (Surface === TUI) assert.deepEqual(terminal.getCursorPosition(), { x: 0, y: 4 });
  });

  for (const [name, line, column] of [
    ["styled wide text", `\x1b[31m界🙂\x1b[0m${CURSOR_MARKER}x`, 4],
    ["right edge", `${"x".repeat(20)}${CURSOR_MARKER}`, 19],
    ["empty row", CURSOR_MARKER, 0],
  ]) {
    test(`${Surface.name} positions ${name} in bounded terminal cells`, (context) => {
      const terminal = new VirtualTerminal(20, 6);
      const tui = new Surface(terminal, true, undefined, { mouse: false });
      context.after(() => tui.stop());
      let lines = ["prefix", line, "footer"];
      tui.addChild({ render: () => lines, invalidate() {} });
      tui.start();
      tui.renderNow(true);
      assert.deepEqual(terminal.getCursorPosition(), { x: column, y: 1 });
      assert.equal(terminal.getViewport()[2].trimEnd(), "footer");
      lines = ["prefix", "plain", "footer"];
      tui.renderNow();
      assert.deepEqual(terminal.getViewport().slice(0, 3).map((row) => row.trimEnd()), lines);
      assert.deepEqual(terminal.getCursorPosition(), Surface === TUI ? { x: 6, y: 2 } : { x: 19, y: 5 });
    });
  }
}

test("main-screen append restores its paint endpoint and stops targeting scrolled-out markers", (context) => {
  const terminal = new VirtualTerminal(12, 3);
  const tui = new TUI(terminal, true, undefined, { mouse: false });
  context.after(() => tui.stop());
  const lines = ["old0", "old1", `ab${CURSOR_MARKER}cd`, "footer"];
  tui.addChild({ render: () => lines, invalidate() {} });
  tui.start();
  tui.renderNow(true);
  assert.deepEqual(terminal.getCursorPosition(), { x: 2, y: 1 });
  lines.push("tail");
  tui.renderNow();
  assert.deepEqual(terminal.getViewport(), ["abcd", "footer", "tail"]);
  assert.deepEqual(terminal.getCursorPosition(), { x: 2, y: 0 });
  lines.push("next");
  tui.renderNow();
  assert.deepEqual(terminal.getViewport(), ["footer", "tail", "next"]);
  assert.deepEqual(terminal.getCursorPosition(), { x: 4, y: 2 });
});

test("main-screen handoff restores marker placement without repainting the captured frame", (context) => {
  const terminal = new VirtualTerminal(20, 6);
  const first = new TUI(terminal, true, undefined, { mouse: false });
  const second = new TUI(terminal, true, undefined, { mouse: false });
  context.after(() => { first.stop(); second.stop(); });
  const lines = [`ab${CURSOR_MARKER}cd`, "footer"];
  first.addChild({ render: () => lines, invalidate() {} });
  first.start();
  first.renderNow();
  const state = first.captureRenderState();
  first.stop({ preserveScreen: true });
  assert.deepEqual(terminal.getCursorPosition(), { x: 6, y: 1 });
  terminal.writes.length = 0;
  second.addChild({ render: () => lines, invalidate() {} });
  second.restoreRenderState(state);
  second.start();
  second.renderNow();
  assert.deepEqual(terminal.getCursorPosition(), { x: 2, y: 0 });
  assert.equal(terminal.writes.join("").includes("abcd"), false);
  lines.push("tail");
  second.renderNow();
  assert.deepEqual(terminal.getViewport().slice(0, 3), ["abcd", "footer", "tail"]);
  assert.deepEqual(terminal.getCursorPosition(), { x: 2, y: 0 });
});
