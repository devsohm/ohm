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
