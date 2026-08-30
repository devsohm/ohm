import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FullscreenTUI, TUI } from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

describe("render scheduling", () => {
  it("coalesces invalidation bursts and skips terminal writes for an unchanged frame", async () => {
    const terminal = new VirtualTerminal(20, 4);
    const component = {
      line: "ready",
      renders: 0,
      render() {
        this.renders += 1;
        return [this.line];
      },
      invalidate() {},
    };
    const tui = new TUI(terminal);
    tui.addChild(component);
    tui.start();
    await terminal.waitForRender();

    const rendersBeforeBurst = component.renders;
    terminal.writes.length = 0;
    for (let index = 0; index < 1_000; index += 1) tui.requestRender();
    await terminal.waitForRender();

    assert.equal(component.renders, rendersBeforeBurst + 1);
    assert.deepEqual(terminal.writes, []);
    tui.stop();
  });

  it("preserves a full-redraw request while a normal render is already queued", async () => {
    const terminal = new VirtualTerminal(20, 4);
    const component = {
      line: "before",
      renders: 0,
      render() {
        this.renders += 1;
        return [this.line];
      },
      invalidate() {},
    };
    const tui = new TUI(terminal);
    tui.addChild(component);
    tui.start();
    await terminal.waitForRender();

    const rendersBeforeChange = component.renders;
    terminal.writes.length = 0;
    component.line = "after";
    tui.requestRender();
    tui.requestRender(true);
    await terminal.waitForRender();

    assert.equal(component.renders, rendersBeforeChange + 1);
    assert.equal(terminal.writes.length, 1);
    assert.equal(terminal.writes[0].includes("\x1b[2J\x1b[H"), true);
    assert.match(terminal.writes[0], /after/u);
    tui.stop();
  });

  it("invalidates a queued render after a synchronous render", async () => {
    const terminal = new VirtualTerminal(20, 4);
    const component = {
      renders: 0,
      render() {
        this.renders += 1;
        return ["ready"];
      },
      invalidate() {},
    };
    const tui = new TUI(terminal);
    tui.addChild(component);
    tui.start();
    tui.renderNow();

    assert.equal(component.renders, 1);
    await Promise.resolve();
    assert.equal(component.renders, 1);
    tui.stop();
  });

  it("repaints only changed ordinary-text rows in a fullscreen frame", async () => {
    const terminal = new VirtualTerminal(20, 4);
    const component = {
      lines: ["north", "east", "south", "west"],
      render() { return [...this.lines]; },
      invalidate() {},
    };
    const tui = new FullscreenTUI(terminal, undefined, undefined, { mouse: false });
    tui.setRoot(component);
    tui.start();
    await terminal.waitForRender();
    terminal.writes.length = 0;

    component.lines[1] = "EAST";
    tui.requestRender();
    await terminal.waitForRender();

    const output = terminal.writes.join("");
    assert.match(output, /EAST/u);
    assert.equal(output.includes("north"), false);
    assert.equal(output.includes("south"), false);
    assert.equal(output.includes("west"), false);
    assert.deepEqual(terminal.getViewport().map((line) => line.trimEnd()), ["north", "EAST", "south", "west"]);

    terminal.writes.length = 0;
    component.lines = ["north"];
    tui.requestRender();
    await terminal.waitForRender();

    assert.equal(terminal.writes.join("").includes("north"), false);
    assert.deepEqual(terminal.getViewport().map((line) => line.trimEnd()), ["north", "", "", ""]);
    tui.stop();
  });

  it("keeps the conservative fullscreen repaint for terminal-control rows", async () => {
    const terminal = new VirtualTerminal(20, 3);
    const component = {
      lines: ["north", "\x1b[31meast\x1b[0m", "south"],
      render() { return [...this.lines]; },
      invalidate() {},
    };
    const tui = new FullscreenTUI(terminal, undefined, undefined, { mouse: false });
    tui.setRoot(component);
    tui.start();
    await terminal.waitForRender();
    terminal.writes.length = 0;

    component.lines[1] = "\x1b[32mEAST\x1b[0m";
    tui.requestRender();
    await terminal.waitForRender();

    const output = terminal.writes.join("");
    assert.equal(output.includes("north"), true);
    assert.equal(output.includes("south"), true);
    assert.equal(output.includes("\x1b7"), false);
    tui.stop();
  });
});
