import assert from "node:assert/strict";
import test from "node:test";

import { TuiController } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  INTERNAL_TUI_TRANSCRIPT_SEARCH,
  type TuiFrameProjector,
  type TuiProjectedFrame,
} from "../../src/tui/frame-projector.js";
import { internalCreateRichTuiFrameProjector } from "../../src/tui/rich-frame-projector.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, envelope, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

function searchController() {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(48, 12);
  const projected = internalCreateRichTuiFrameProjector();
  const frames: TuiProjectedFrame[] = [];
  const requests: Array<{ offset: number; search: string | undefined }> = [];
  const projector: TuiFrameProjector = (request) => {
    requests.push({ offset: request.view.transcriptOffset, search: request.view.transcriptSearch?.query });
    const frame = projected(request);
    frames.push(frame);
    return frame;
  };
  const controller = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    [INTERNAL_TUI_FRAME_PROJECTOR]: projector,
  });
  return { input, output, controller, frames, requests };
}

function latest<Value>(values: readonly Value[]): Value {
  const value = values.at(-1);
  if (value === undefined) throw new Error("Expected a captured value");
  return value;
}

test("fullscreen transcript search edits incrementally, navigates, preserves manual scroll, and restores the draft", async () => {
  const { input, output, controller, frames, requests } = searchController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };

  controller.start();
  input.write("draft remains");
  for (let index = 0; index < 36; index += 1) {
    controller.render(envelope({
      type: "warning",
      code: `history-${index}`,
      message: index % 9 === 0 ? `needle result ${index}` : `ordinary history ${index}`,
    }, index + 1));
  }
  await tick();
  controller.renderNow();
  flush();

  input.write("\u001b[102;6u");
  input.write("nee");
  await tick();
  assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.query, "nee");
  input.write("dle");
  await tick();
  controller.renderNow();
  flush();

  let projection = latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH];
  assert.equal(projection?.query, "needle");
  assert.equal(projection?.matches.length, 4);
  assert.match(terminal.viewport().join("\n"), /\? needle\s+[1-4]\/4/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /draft remains/u);
  const initialSelected = projection?.selectedMatch;
  assert.notEqual(initialSelected, undefined);

  input.write(Buffer.from([7]));
  await tick();
  projection = latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH];
  assert.equal(projection?.selectedMatch, ((initialSelected ?? 0) + 1) % 4);
  input.write("\u001b[103;6u");
  await tick();
  assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.selectedMatch, initialSelected);

  input.write("\u001b[<64;2;5M\u001b[<64;2;5M");
  await tick();
  const manualOffset = latest(requests).offset;
  assert.ok(manualOffset > 0);
  controller.render(envelope({
    type: "warning",
    code: "streamed-search-result",
    message: "needle streamed result",
  }, 100));
  await tick();
  controller.renderNow();
  projection = latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH];
  assert.equal(projection?.matches.length, 5);
  assert.ok(latest(requests).offset > 0, "streaming output snapped an open search back to the bottom");

  input.write(Buffer.from([1]));
  input.write("x");
  await tick();
  assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.query, "xneedle");
  assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.matches.length, 0);

  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  await tick();
  controller.renderNow();
  flush();
  assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH], undefined);
  assert.match(terminal.viewport().join("\n"), /draft remains/u);

  input.write("\u001b[102;6u");
  await tick();
  assert.ok(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH]);
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  controller.renderNow();
  assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH], undefined);
  assert.match(stripAnsi(latest(frames).text), /draft remains/u);
  controller.close();
});

test("opening a core picker closes transcript search before routing picker keys", async () => {
  const { input, controller, frames } = searchController();
  controller.start();
  let selected: string | undefined;
  let choice: Promise<void> | undefined;

  try {
    input.write("\u001b[102;6u");
    await tick();
    assert.ok(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH]);

    choice = controller.choose("Pick", [
      { label: "one", value: "one" },
      { label: "two", value: "two" },
    ]).then((value) => { selected = value; }, () => undefined);
    await tick();
    input.write("\u001b[B\r");
    await tick();
    assert.equal(selected, "two");
    assert.equal(latest(frames)[INTERNAL_TUI_TRANSCRIPT_SEARCH], undefined);
  } finally {
    controller.close();
    await choice;
  }
});
