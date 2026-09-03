import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FullscreenTUI, TUI, visibleWidth } from "../dist/index.js";

class MemoryTerminal {
  columns = 40;
  rows = 12;
  kittyProtocolActive = false;
  writes = [];
  input;
  resize;
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

class MutableComponent {
  value = "first";
  render() { return [this.value]; }
  invalidate() {}
}

class RecordingTUI extends TUI {
  composites = [];
  compositeLineAt(background, foreground, column, width, frameWidth) {
    this.composites.push({ background, column, width });
    return super.compositeLineAt(background, foreground, column, width, frameWidth);
  }
}

class RecordingFullscreenTUI extends FullscreenTUI {
  frame = [];
  frameComposed(lines) {
    super.frameComposed(lines);
    this.frame = [...lines];
  }
}

describe("public TUI renderer contract", () => {
  it("identifies regular and fullscreen renderers", () => {
    assert.equal(new TUI(new MemoryTerminal()).mode, "regular");
    assert.equal(new FullscreenTUI(new MemoryTerminal()).mode, "fullscreen");
  });

  it("can render synchronously when an extension needs the new frame immediately", () => {
    const terminal = new MemoryTerminal();
    const tui = new TUI(terminal);
    const component = new MutableComponent();
    tui.addChild(component);
    tui.start();
    tui.renderNow(true);
    terminal.writes.length = 0;

    component.value = "second";
    tui.renderNow();

    assert.match(terminal.writes.join(""), /second/u);
    tui.stop();
  });

  it("hands an unchanged main-screen frame to a replacement without repainting it", () => {
    const terminal = new MemoryTerminal();
    const first = new TUI(terminal);
    first.addChild({ render: () => ["steady"], invalidate() {} });
    first.start();
    first.renderNow();

    const state = first.captureRenderState();
    terminal.writes.length = 0;
    first.stop({ preserveScreen: true });

    assert.deepEqual(terminal.writes, []);
    assert.deepEqual(state, { columns: 40, lines: ["steady"] });
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.lines), true);

    const second = new TUI(terminal);
    const component = new MutableComponent();
    component.value = "steady";
    second.addChild(component);
    second.restoreRenderState(state);
    second.start();
    second.renderNow();

    assert.deepEqual(terminal.writes, []);
    assert.equal(second.fullRedraws, 0);

    component.value = "changed";
    second.renderNow();
    assert.match(terminal.writes.join(""), /changed/u);
    assert.equal(terminal.writes.join("").includes("\x1b[2J\x1b[H"), false);
    second.stop();
  });

  it("keeps captured main-screen state detached from later frames", () => {
    const terminal = new MemoryTerminal();
    const tui = new TUI(terminal);
    const component = new MutableComponent();
    tui.addChild(component);
    tui.start();
    tui.renderNow();

    const state = tui.captureRenderState();
    component.value = "second";
    tui.renderNow();

    assert.deepEqual(state.lines, ["first"]);
    tui.stop();
  });

  it("falls back to a full repaint when restored state has a different width", () => {
    const terminal = new MemoryTerminal();
    const first = new TUI(terminal);
    first.addChild({ render: () => ["steady"], invalidate() {} });
    first.start();
    first.renderNow();
    terminal.columns = 60;
    terminal.resize();
    const state = first.captureRenderState();
    assert.equal(state.columns, 40);
    first.stop({ preserveScreen: true });

    terminal.writes.length = 0;
    const second = new TUI(terminal);
    second.addChild({ render: () => ["steady"], invalidate() {} });
    second.restoreRenderState(state);
    second.start();
    second.renderNow();

    assert.equal(terminal.writes.join("").includes("\x1b[2J\x1b[H"), true);
    second.stop();
  });

  it("does not let main-screen state bypass fullscreen cleanup", () => {
    const terminal = new MemoryTerminal();
    const fullscreen = new FullscreenTUI(terminal, undefined, undefined, { mouse: false });
    fullscreen.setRoot({ render: () => ["full"], invalidate() {} });
    fullscreen.start();
    fullscreen.renderNow();

    assert.throws(() => fullscreen.captureRenderState(), /main-screen/u);
    terminal.writes.length = 0;
    fullscreen.stop({ preserveScreen: true });

    assert.equal(terminal.writes.join("").includes("\x1b[?1049l"), true);
  });

  it("positions overlays by percentage and honors their minimum width", () => {
    const tui = new RecordingTUI(new MemoryTerminal());
    tui.addChild({
      render: () => Array.from({ length: 12 }, (_, index) => `row${index}`),
      invalidate() {},
    });
    tui.showOverlay(
      { render: () => ["overlay"], invalidate() {} },
      { width: 5, minWidth: 9, row: "50%", col: "25%" },
    );

    tui.renderNow();

    assert.deepEqual(tui.composites, [{ background: "row5", column: 7, width: 9 }]);
  });

  it("keeps overlays visible and bounded when margins exceed a tiny viewport", () => {
    for (const [columns, rows] of [[1, 1], [2, 1]]) {
      const terminal = new MemoryTerminal();
      terminal.columns = columns;
      terminal.rows = rows;
      const tui = new RecordingFullscreenTUI(terminal);
      tui.addChild({ render: () => ["b".repeat(columns)], invalidate() {} });
      tui.showOverlay(
        { render: () => ["x"], invalidate() {} },
        { anchor: "center", margin: 10 },
      );

      tui.renderNow();

      assert.equal(tui.frame.length, rows);
      assert.equal(tui.frame.some((line) => line.includes("x")), true);
      assert.equal(tui.frame.every((line) => visibleWidth(line) <= columns), true);
    }
  });
});
