import assert from "node:assert/strict";
import { it } from "node:test";
import { FullscreenTUI, TUI, VStack, VIEWPORT_POINTER_TARGET, VIEWPORT_POINTER_REGIONS } from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

class Pointer {
  [VIEWPORT_POINTER_TARGET] = true;
  events = [];
  focused = false;
  inputs = [];
  constructor(lines = ["pointer"], capture = false) { this.lines = lines; this.capture = capture; }
  render(width) { return this.lines.map((line) => line.slice(0, width)); }
  invalidate() {}
  handleInput(data) { this.inputs.push(data); }
  handleViewportPointer(event, width, height) {
    this.events.push({ ...event, width, height });
    return { handled: true, capture: this.capture && event.type === "press" };
  }
}

it("preserves modifiers, repeated clicks, and drag state in the existing pointer events", async () => {
  const terminal = new VirtualTerminal(20, 8);
  const tui = new FullscreenTUI(terminal);
  const target = new Pointer(["pointer"], true);
  tui.setRoot(target);
  tui.start();
  await terminal.waitForRender();
  terminal.sendInput("\x1b[<28;2;2M\x1b[<28;2;2m\x1b[<28;2;2M\x1b[<28;2;2m");
  assert.deepEqual(target.events.map(({ type, shift, alt, ctrl, clickCount }) => ({ type, shift, alt, ctrl, clickCount })), [
    { type: "press", shift: true, alt: true, ctrl: true, clickCount: 1 },
    { type: "release", shift: true, alt: true, ctrl: true, clickCount: 1 },
    { type: "press", shift: true, alt: true, ctrl: true, clickCount: 2 },
    { type: "release", shift: true, alt: true, ctrl: true, clickCount: 2 },
  ]);
  terminal.sendInput("\x1b[<0;3;2M\x1b[<32;5;3M\x1b[<0;5;3m\x1b[<35;6;3M\x1b[<92;6;3M");
  assert.equal(target.events[5].dragging, true);
  assert.equal(target.events[6].dragging, true);
  assert.equal(target.events[7].dragging, false);
  assert.equal(target.events[7].clickCount, 0);
  assert.equal(target.events[8].type, "wheel");
  assert.equal(target.events[8].deltaRows, -3);
  assert.equal(target.events[8].ctrl, true);
  tui.stop();
});

for (const fullscreen of [false, true]) {
  it(`${fullscreen ? "fullscreen" : "regular"} overlays expose current bounds and own pointer capture`, async () => {
    const terminal = new VirtualTerminal(20, 8);
    const tui = fullscreen ? new FullscreenTUI(terminal) : new TUI(terminal, false, undefined, { mouse: true });
    const base = new Pointer(Array.from({ length: 8 }, () => "base"));
    if (fullscreen) tui.setRoot(base);
    else tui.addChild(base);
    tui.setFocus(base);
    tui.start();
    await terminal.waitForRender();
    const panel = new Pointer(["panel", "panel"], true);
    const handle = tui.showOverlay(panel, { width: 6, row: 2, col: 4, visible: (width) => width >= 10 });
    assert.equal(handle.getBounds(), undefined);
    await terminal.waitForRender();
    assert.deepEqual(handle.getBounds(), { row: 2, column: 4, width: 6, height: 2 });
    assert.equal(Object.isFrozen(handle.getBounds()), true);
    terminal.sendInput("\x1b[<0;6;4M\x1b[<32;19;7M");
    assert.deepEqual(panel.events.map(({ type, row, column, width, height }) => ({ type, row, column, width, height })), [
      { type: "press", row: 1, column: 1, width: 6, height: 2 },
      { type: "move", row: 4, column: 14, width: 6, height: 2 },
    ]);
    assert.equal(base.events.length, 0);
    handle.setHidden(true);
    assert.equal(handle.getBounds(), undefined);
    assert.equal(panel.events.at(-1).type, "cancel");
    assert.equal(base.focused, true);
    await terminal.waitForRender();
    terminal.sendInput("\x1b[<0;6;4M\x1b[<0;6;4m");
    assert.equal(base.events.length, 2);
    handle.setHidden(false);
    await terminal.waitForRender();
    terminal.resize(8, 4);
    assert.equal(handle.getBounds(), undefined);
    await terminal.waitForRender();
    assert.equal(handle.getBounds(), undefined);
    terminal.resize(16, 6);
    await terminal.waitForRender();
    assert.deepEqual(handle.getBounds(), { row: 2, column: 4, width: 6, height: 2 });
    handle.hide();
    handle.focus();
    handle.setHidden(false);
    assert.equal(handle.getBounds(), undefined);
    assert.equal(handle.isFocused(), false);
    tui.stop();
  });
}

it("cancels a captured child removed during layout and releases capture after button release", async () => {
  const terminal = new VirtualTerminal(20, 8);
  const tui = new FullscreenTUI(terminal);
  const first = new Pointer(["first"], true);
  const second = new Pointer(["second"]);
  let child = first;
  const root = {
    [VIEWPORT_POINTER_REGIONS]: true,
    viewportPointerRegions: () => [{ component: child, row: 0, column: 0, width: 20, height: 8 }],
    render: () => ["root"], invalidate() {},
  };
  tui.setRoot(root);
  tui.start();
  await terminal.waitForRender();
  terminal.sendInput("\x1b[<0;2;2M");
  child = second;
  tui.requestRender();
  await terminal.waitForRender();
  assert.equal(first.events.at(-1).type, "cancel");
  terminal.sendInput("\x1b[<0;2;2m\x1b[<35;3;2M");
  assert.equal(second.events.at(-1).type, "move");
  terminal.sendInput("\x1b[O");
  assert.equal(second.events.at(-1).type, "cancel");
  tui.stop();
});

it("keeps overlays on the visible main screen when content extends into scrollback", async () => {
  const terminal = new VirtualTerminal(20, 4);
  const tui = new TUI(terminal, false, undefined, { mouse: true });
  const base = new Pointer(Array.from({ length: 10 }, (_, index) => `row ${index}`));
  tui.addChild(base);
  const panel = new Pointer(["panel"]);
  const handle = tui.showOverlay(panel, { row: 1, col: 2, width: 5 });
  tui.start();
  await terminal.waitForRender();
  assert.deepEqual(handle.getBounds(), { row: 1, column: 2, width: 5, height: 1 });
  assert.equal(terminal.getViewport()[1].includes("panel"), true);
  terminal.sendInput("\x1b[<0;4;2M");
  assert.equal(panel.events[0].column, 1);
  assert.equal(panel.events[0].row, 0);
  tui.stop();
});

it("routes nested overlay layouts and never clicks through a plain covering overlay", async () => {
  const terminal = new VirtualTerminal(20, 8);
  const tui = new FullscreenTUI(terminal);
  const base = new Pointer(["base"]);
  tui.setRoot(base);
  tui.setFocus(base);
  tui.start();
  await terminal.waitForRender();
  const nested = new Pointer(["nested"]);
  const panel = tui.showOverlay(new VStack([
    { render: () => ["heading"], invalidate() {} }, nested,
  ]), { row: 1, col: 2, width: 8 });
  await terminal.waitForRender();
  terminal.sendInput("\x1b[<0;4;3M\x1b[<0;4;3m");
  assert.equal(nested.events[0].row, 0);
  assert.equal(nested.events[0].column, 1);
  const cover = tui.showOverlay({ render: () => ["plain"], invalidate() {} }, { row: 2, col: 2, width: 8, nonCapturing: true });
  await terminal.waitForRender();
  terminal.sendInput("\x1b[<0;4;3M\x1b[<0;4;3m");
  assert.equal(nested.events.length, 2);
  assert.equal(base.events.length, 0);
  cover.hide();
  panel.hide();
  tui.stop();
});

it("does not restore hidden or removed overlay focus ancestry", async () => {
  const terminal = new VirtualTerminal(20, 8);
  const tui = new TUI(terminal);
  const base = new Pointer(["base"]);
  const lower = new Pointer(["lower"]);
  const upper = new Pointer(["upper"]);
  tui.addChild(base);
  tui.setFocus(base);
  tui.start();
  const first = tui.showOverlay(lower);
  const second = tui.showOverlay(upper);
  first.setHidden(true);
  second.hide();
  assert.equal(base.focused, true);
  assert.equal(lower.focused, false);
  first.setHidden(false);
  const third = tui.showOverlay(upper);
  first.hide();
  third.hide();
  assert.equal(base.focused, true);
  terminal.sendInput("x");
  assert.deepEqual(base.inputs, ["x"]);
  tui.stop();
});

it("restores terminal modes even if a captured component throws during cancellation", async () => {
  const terminal = new VirtualTerminal(20, 8);
  const tui = new FullscreenTUI(terminal);
  const pointer = new Pointer(["pointer"], true);
  const receive = pointer.handleViewportPointer.bind(pointer);
  pointer.handleViewportPointer = (event, width, height) => {
    if (event.type === "cancel") throw new Error("cleanup failed");
    return receive(event, width, height);
  };
  tui.setRoot(pointer);
  tui.start();
  await terminal.waitForRender();
  terminal.sendInput("\x1b[<0;2;2M");
  assert.throws(() => tui.stop(), /cleanup failed/);
  assert.equal(terminal.onInput, undefined);
  assert.equal(terminal.writes.join("").includes("\x1b[?1006l"), true);
  assert.equal(terminal.writes.join("").includes("\x1b[?1049l"), true);
});
