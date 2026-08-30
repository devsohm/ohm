import { appendFileSync } from "node:fs";

import { TuiController } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  INTERNAL_TUI_TRANSCRIPT_SEARCH,
  type TuiFrameProjector,
} from "../../src/tui/frame-projector.js";
import { internalCreateRichTuiFrameProjector } from "../../src/tui/rich-frame-projector.js";
import { envelope } from "../tui/helpers.js";

const markerPath = process.env.OHM_TRANSCRIPT_SEARCH_PTY_MARKERS;
if (markerPath === undefined) throw new Error("Missing transcript-search PTY marker path");

const marked = new Set<string>();
const mark = (value: string): void => {
  if (marked.has(value)) return;
  marked.add(value);
  appendFileSync(markerPath, `${value}\n`, "utf8");
};

const projected = internalCreateRichTuiFrameProjector();
let sawSearch = false;
let controller: TuiController | undefined;
const projector: TuiFrameProjector = (request) => {
  const frame = projected(request);
  const search = frame[INTERNAL_TUI_TRANSCRIPT_SEARCH];
  if (search !== undefined) {
    sawSearch = true;
    mark(`search:${search.query}:${search.matches.length}`);
    if (search.selectedMatch !== undefined) mark(`selected:${search.selectedMatch}`);
  } else if (sawSearch) {
    sawSearch = false;
    mark("closed");
    setImmediate(() => {
      controller?.close();
      process.stdout.write("transcript-search-pty-complete\n");
    });
  }
  return frame;
};

controller = new TuiController({
  input: process.stdin,
  output: process.stdout,
  environment: process.env,
  handleSignals: false,
  [INTERNAL_TUI_FRAME_PROJECTOR]: projector,
});
controller.start();
for (let index = 0; index < 24; index += 1) {
  controller.render(envelope({
    type: "warning",
    code: `pty-${index}`,
    message: index % 8 === 0 ? `needle pty result ${index}` : `pty history ${index}`,
  }, index + 1));
}
controller.renderNow();
mark("ready");
