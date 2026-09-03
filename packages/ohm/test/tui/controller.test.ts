import { optionalProperties } from "../../src/core/optional-properties.js";
import { isFunctionValue, isRecordValue, isStringValue } from "../../src/tui/value-guards.js";
import { terminalPattern } from "../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { ImageBlock } from "../../src/core/types.js";
import type { RuntimeToolRendererBinding } from "../../src/tui/components.js";
import { TuiController, TuiSelectionCancelledError } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  INTERNAL_TUI_FRAME_PROJECTOR_CLEAR,
  INTERNAL_TUI_TOOL_DETAIL_CACHE,
  type TuiFrameProjector,
} from "../../src/tui/frame-projector.js";
import { Keybindings } from "../../src/tui/keybindings.js";
import {
  internalCreateOhmNativeToolDetailCache,
  internalPrewarmOhmNativeToolDetail,
} from "../../src/tui/native-renderer/view.js";
import { internalCreateRichTuiFrameProjector } from "../../src/tui/rich-frame-projector.js";
import { parseThemeDefinition } from "../../src/tui/theme.js";
import type {
  TuiAction,
  TuiControllerOptions,
  TuiInputImageAttachment,
  TuiTranscriptItem,
  TuiViewState,
} from "../../src/tui/types.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { createFixtureFrameProjector, FakeInput, FakeOutput, FakeSignals, envelope, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function terminalWords(value: string): string {
  return stripAnsi(value).replaceAll("│", " ").replace(/\s+/gu, " ").trim();
}

function occurrences(value: string, selected: string): number {
  return value.split(selected).length - 1;
}

function textComponent(text: string) {
  return { render: () => [text], invalidate() {} };
}

function fullController(options: {
  signals?: FakeSignals;
  actions?: TuiAction[];
  terminal?: "kitty" | "iterm2" | "vscode";
  theme?: string;
  doubleEscapeAction?: "atlas" | "none";
  remote?: boolean;
  environment?: NodeJS.ProcessEnv;
  tmuxOptionsProbe?: NonNullable<TuiControllerOptions["tmuxOptionsProbe"]>;
  keybindings?: Keybindings;
  openHyperlink?: NonNullable<TuiControllerOptions["openHyperlink"]>;
  frameProjector?: TuiFrameProjector;
} = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const toolDetailCache = internalCreateOhmNativeToolDetailCache();
  const controller = new TuiController({
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
      ...optionalProperties(options.terminal === "kitty" ? { KITTY_WINDOW_ID: "1" } : undefined),
      ...optionalProperties(options.terminal === "iterm2" ? { ITERM_SESSION_ID: "session" } : undefined),
      ...optionalProperties(options.terminal === "vscode" ? { TERM_PROGRAM: "vscode" } : undefined),
      ...optionalProperties(options.remote === true ? { SSH_CONNECTION: "test" } : undefined),
      ...options.environment,
    },
    ...optionalProperties(options.signals === undefined ? undefined : { signalSource: options.signals }),
    handleSignals: options.signals !== undefined,
    ...optionalProperties(options.actions === undefined ? undefined : { onAction: (action) => { options.actions?.push(action); } }),
    ...optionalProperties(options.doubleEscapeAction === undefined ? undefined : { doubleEscapeAction: options.doubleEscapeAction }),
    ...optionalProperties(options.theme === undefined ? undefined : { theme: options.theme }),
    ...optionalProperties(options.tmuxOptionsProbe === undefined ? undefined : { tmuxOptionsProbe: options.tmuxOptionsProbe }),
    ...optionalProperties(options.keybindings === undefined ? undefined : { keybindings: options.keybindings }),
    ...optionalProperties(options.openHyperlink === undefined ? undefined : { openHyperlink: options.openHyperlink }),
    [INTERNAL_TUI_FRAME_PROJECTOR]: options.frameProjector ?? createFixtureFrameProjector(),
    [INTERNAL_TUI_TOOL_DETAIL_CACHE]: toolDetailCache,
  });
  return { input, output, controller, toolDetailCache };
}

function png(width = 20, height = 10): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function inputImage(label = "clipboard") {
  const data = png(20, 10).toString("base64");
  return {
    block: { type: "image" as const, mediaType: "image/png", data },
    label,
    coordinates: {
      originalWidth: 40,
      originalHeight: 20,
      width: 20,
      height: 10,
      scaleX: 2,
      scaleY: 2,
      orientationApplied: false,
      resized: true,
      converted: false,
    },
  };
}

test("full TUI owns one rich viewport with raw mode, Unicode editing, and cleanup", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  assert.equal(controller.selectedThemeName(), "signal");
  assert.equal(input.isRaw, true);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?7l", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2004h", "u"));
  const answer = controller.question("you> ");
  input.write("he🙂");
  input.write(Buffer.from([127]));
  input.write("llo\r");
  assert.equal(await answer, "hello");
  controller.close();
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.equal(input.isPaused(), true);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049l", "u"));
  assert.ok(output.text.lastIndexOf("\u001b[?7h") < output.text.lastIndexOf("\u001b[?1049l"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2004l", "u"));
});

test("the default hardware cursor marks the live editor insertion point", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  controller.start();
  const answer = controller.question("you> ");
  input.write("hey");
  await tick();
  controller.renderNow();
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  const viewport = terminal.viewport();
  const editorRow = viewport.findIndex((line) => line.includes("hey"));
  assert.notEqual(editorRow, -1);
  assert.deepEqual(terminal.cursor(), {
    row: editorRow,
    column: viewport[editorRow]!.indexOf("hey") + 3,
  });
  assert.ok(output.text.lastIndexOf("\u001b[?25h") > output.text.lastIndexOf("\u001b[?25l"));

  controller.setOperatorPreferences({ showHardwareCursor: false });
  await tick();
  controller.renderNow();
  assert.ok(output.text.lastIndexOf("\u001b[?25l") > output.text.lastIndexOf("\u001b[?25h"));
  input.write("\r");
  assert.equal(await answer, "hey");
  controller.close();
});

test("signal is selectable at startup without custom-theme discovery", () => {
  const { controller } = fullController({ theme: "signal" });
  assert.equal(controller.selectedThemeName(), "signal");
  assert.equal(controller.selectedThemeSetting(), "signal");
  assert.deepEqual(controller.themeNames(), ["mono", "signal"]);
  controller.close();
});

test("custom paired themes follow terminal color reports alongside both built-in themes", () => {
  const { input, output, controller } = fullController();
  controller.setCustomThemes([
    parseThemeDefinition({ schemaVersion: 1, name: "paper", base: "light", styles: { accent: { foreground: 16 } } }),
    parseThemeDefinition({ schemaVersion: 1, name: "ocean", base: "dark", styles: { accent: { foreground: 255 } } }),
  ]);
  assert.deepEqual(controller.themeNames(), ["mono", "ocean", "paper", "signal"]);
  controller.setTheme("paper/ocean");
  const changes: string[] = [];
  controller.onThemeChange((change) => changes.push(`${change.reason}:${change.current}`));
  controller.start();
  assert.equal(controller.selectedThemeName(), "ocean");
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2031h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?996n", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\]11;\\?\\u0007", "u"));

  input.write("\u001b[?997;2n");
  assert.equal(controller.selectedThemeName(), "paper");
  assert.deepEqual(changes, ["terminal:paper"]);

  controller.setTheme("mono");
  assert.equal(controller.selectedThemeName(), "mono");
  assert.equal(controller.selectedThemeSetting(), "mono");
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2031l", "u"));
  controller.setTheme("signal");
  assert.equal(controller.selectedThemeName(), "signal");
  assert.equal(controller.selectedThemeSetting(), "signal");
  controller.close();
});

test("startup content is present in the first full-screen frame", () => {
  const { output, controller } = fullController();
  controller.setContext({ status: "idle" });
  controller.setStartup("Ready from startup", "Ready from startup");
  assert.match(output.text, /Ready from startup/u);
  controller.close();
});

test("committed startup help can still be revealed with the default tool-expansion key", async () => {
  const { input, output, controller } = fullController();
  controller.setStartup("compact startup", "expanded startup resources");
  output.chunks.length = 0;
  input.write("\u000f");
  await tick();
  assert.match(output.text, /expanded startup resources/u);
  controller.close();
});

test("startup content added during global expansion retracts before inline commit", async () => {
  const { input, output, controller } = fullController();
  output.rows = 12;
  controller.start();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.setStartup("compact startup", "expanded-startup-marker");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /expanded-startup-marker/u);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();

  assert.doesNotMatch(terminal.buffer().join("\n"), /expanded-startup-marker/u);
  assert.match(terminal.viewport().join("\n"), /compact startup/u);
  controller.close();
});

test("run start renders working feedback before the first provider delta", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }));
  await tick();
  assert.match(output.text, /Preparing request · 0s · Esc to cancel/u);
  assert.doesNotMatch(output.text, /provider delta/u);
  controller.close();
});

test("ending an activity keeps the reserved status row when clear-on-shrink is enabled", async () => {
  const { output, controller } = fullController();
  controller.setOperatorPreferences({ clearOnShrink: true });
  controller.start();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }));
  await tick();
  output.chunks.length = 0;

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 2));
  await tick();

  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[2K\\u001b\\[1B\\r\\u001b\\[2K", "u"));
  controller.close();
});

test("full TUI shows active question prompts without adding a normal composer prefix", async () => {
  const { input, output, controller } = fullController();
  controller.start();

  const answer = controller.question("Approval required: fixture\n[y] once: ");
  await tick();
  assert.match(output.text, /Approval required: fixture/u);
  assert.match(output.text, /\[y\] once/u);
  output.chunks.length = 0;
  input.write("y\r");
  assert.equal(await answer, "y");
  await tick();
  assert.doesNotMatch(output.text, /Approval required: fixture/u);

  const cancellation = new AbortController();
  const aborted = controller.question("Temporary question: ", cancellation.signal);
  await tick();
  assert.match(output.text, /Temporary question/u);
  output.chunks.length = 0;
  cancellation.abort(new Error("question cancelled"));
  await assert.rejects(aborted, /question cancelled/u);
  await tick();
  assert.doesNotMatch(output.text, /Temporary question/u);
  controller.close();
});

test("full TUI keeps the next question alive behind an action picker", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [{
    id: "fixture-model",
    label: "Fixture model",
    value: { provider: "fixture", model: "fixture-model" },
  }]);
  controller.openPicker("model", "Models");

  const answer = controller.question("you> ");
  input.write("\r");
  await tick();
  assert.equal(actions[0]?.type, "select");
  input.write("next prompt\r");
  assert.equal(await answer, "next prompt");
  controller.close();
});

test("full TUI cancels a terminal text question with Escape or Ctrl+C", async () => {
  for (const inputBytes of [Buffer.from([27]), Buffer.from([3])]) {
    const { input, controller } = fullController();
    controller.start();
    const answer = controller.question("Exact model/deployment ID: ");
    input.write(inputBytes);
    await assert.rejects(answer, TuiSelectionCancelledError);
    assert.equal(controller.getEditorText(), "");
    controller.close();
  }
});

test("the primary chat question ignores a lone Escape and still accepts input", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ", undefined, { cancelable: false });
  input.write(Buffer.from([27]));
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  input.write("still here\r");
  assert.equal(await answer, "still here");
  controller.close();
});

test("the rich viewport restores its alternate screen around suspension", async () => {
  const { output, controller } = fullController();
  controller.start();
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049h", "u"));
  await controller.editExternally(async (text) => text);
  assert.equal(output.text.match(terminalPattern("\\u001b\\[\\?1049h", "gu"))?.length, 2);
  assert.equal(output.text.match(terminalPattern("\\u001b\\[\\?1049l", "gu"))?.length, 1);
  assert.equal(output.text.match(terminalPattern("\\u001b\\[\\?7l", "gu"))?.length, 2);
  assert.equal(output.text.match(terminalPattern("\\u001b\\[\\?7h", "gu"))?.length, 1);
  controller.close();
  assert.equal(output.text.match(terminalPattern("\\u001b\\[\\?1049l", "gu"))?.length, 2);
  assert.equal(output.text.match(terminalPattern("\\u001b\\[\\?7h", "gu"))?.length, 2);
});

test("the rich viewport owns mouse modes and leaves without replaying mutable transcript rows", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.render(envelope({ type: "warning", code: "replay", message: "alternate replay marker" }));
  await tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  controller.close();

  assert.match(output.text, terminalPattern("\\u001b\\[\\?1000h\\u001b\\[\\?1002h\\u001b\\[\\?1006h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1003h", "u"));
  const mouseOff = output.text.lastIndexOf("\u001b[?1006l\u001b[?1002l\u001b[?1000l");
  const keyboardOff = output.text.lastIndexOf("\u001b[>4m");
  const screenOff = output.text.lastIndexOf("\u001b[?1049l");
  assert.ok(mouseOff >= 0 && mouseOff < screenOff);
  assert.ok(keyboardOff >= 0 && keyboardOff < screenOff);
  assert.doesNotMatch(output.text.slice(screenOff), /alternate replay marker/u);
});

test("the rich viewport keeps button-motion reporting but omits all-motion reporting in multiplexers", () => {
  for (const environment of [
    { TMUX: "/tmp/tmux-1000/default,1,0" },
    { ZELLIJ: "1" },
    { STY: "screen-session" },
    { TERM: "tmux-256color" },
    { TERM: "screen-256color" },
  ]) {
    const { output, controller } = fullController({ environment });
    controller.start();
    controller.close();
    assert.equal(output.text.includes("\u001b[?1002h"), true);
    assert.equal(output.text.includes("\u001b[?1006h"), true);
    assert.equal(output.text.includes("\u001b[?1004h"), true);
    assert.equal(output.text.includes("\u001b[?1003h"), false);
    assert.equal(output.text.includes("\u001b[?1003l"), false);
  }
});

test("alternate-screen mouse reports never become editor input", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("\u001b[<64;");
  input.write("4;3M");
  input.write(Buffer.from([0x1b, 0x5b, 0x4d]));
  input.write(Buffer.from([32, 37, 35]));
  input.write("kept\r");
  assert.equal(await answer, "kept");
  controller.close();
});

test("built-in controls remain keyboard-operated when mouse reports arrive", async () => {
  const views: TuiViewState[] = [];
  const projector: TuiFrameProjector = (request) => {
    views.push(request.view);
    const overlay = request.view.overlay;
    const lines = overlay === undefined
      ? [
          ...request.view.transcript.map((entry) => entry.title ?? entry.text ?? entry.kind),
          request.view.editorText || "composer",
        ]
      : [overlay.query || "query", ...overlay.items.map((item) => item.label)];
    return {
      text: lines.join("\n"),
      cursor: { row: lines.length, column: 1 },
    };
  };
  const { input, controller } = fullController({ frameProjector: projector });
  controller.start();
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "mouse-keyboard-only",
      role: "assistant",
      content: [
        { type: "tool_call", callId: "mouse-tool", name: "read", arguments: { path: "a" } },
        { type: "thinking", thinking: "Visible thinking", visibility: "summary" },
      ],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 1));
  controller.render(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 2));
  await tick();

  const before = views.at(-1)?.transcript.map((entry) => entry.expanded);
  input.write("\u001b[<0;1;1M\u001b[<0;1;1m\u001b[<0;1;2M\u001b[<0;1;2m");
  await tick();
  assert.deepEqual(views.at(-1)?.transcript.map((entry) => entry.expanded), before);

  controller.setEditorText("a🙂b");
  await tick();
  input.write("\u001b[<0;2;3M\u001b[<0;2;3mX");
  await tick();
  assert.equal(controller.getEditorText(), "a🙂bX");

  let settled = false;
  const selected = controller.choose("Pick", [{ label: "a🙂bX", value: "chosen" }])
    .finally(() => { settled = true; });
  await tick();
  input.write("\u001b[<0;1;2M\u001b[<0;1;2m\u001b[<65;1;2M");
  await tick();
  assert.equal(settled, false);
  assert.equal(views.at(-1)?.overlay?.selected, 0);
  input.write("a🙂b");
  await tick();
  input.write("\u001b[<0;3;1M\u001b[<0;3;1mX");
  await tick();
  assert.equal(views.at(-1)?.overlay?.query, "a🙂bX");
  input.write("\r");
  assert.equal(await selected, "chosen");

  const changes: Array<{ previous: string; next: string }> = [];
  const settings = controller.chooseSettings([{
    id: "theme",
    label: "Theme",
    description: "Terminal theme",
    value: "dark",
    values: ["dark", "light"],
  }], (item, next) => {
    changes.push({ previous: item.value, next });
  });
  await tick();
  input.write("\u001b[<0;1;2M\u001b[<0;1;2m");
  await tick();
  assert.deepEqual(changes, []);
  input.write("\u001b[C");
  await tick();
  assert.deepEqual(changes, [{ previous: "dark", next: "light" }]);
  input.write("\u001b");
  await settings;
  controller.close();
});

test("alternate-screen OSC 8 links open on click while drags copy text", async () => {
  const opened: string[] = [];
  const { input, output, controller } = fullController({
    terminal: "vscode",
    remote: true,
    openHyperlink: (url) => { opened.push(url.toString()); },
  });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "alternate-link",
      role: "assistant",
      content: [{ type: "text", text: "Read [docs](https://example.test/guide)" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  flush();
  const row = terminal.viewport().findIndex((line) => line.includes("docs"));
  const column = terminal.viewport()[row]?.indexOf("docs") ?? -1;
  assert.ok(row >= 0 && column >= 0);
  const x = column + 1;
  const y = row + 1;

  input.write(`\u001b[<0;${x};${y}M`);
  input.write(`\u001b[<0;${x};${y}m`);
  await tick();
  assert.deepEqual(opened, ["https://example.test/guide"]);

  output.chunks.length = 0;
  renderedChunks = 0;
  input.write(`\u001b[<0;${x};${y}M`);
  input.write(`\u001b[<32;${x + 1};${y}M`);
  input.write(`\u001b[<0;${x + 1};${y}m`);
  await tick();
  assert.deepEqual(opened, ["https://example.test/guide"]);
  assert.match(output.text, terminalPattern("\\u001b\\]52;c;ZG8=\\u0007", "u"));
  controller.close();
});

test("no-op mouse motion does not redraw the rich TUI", async () => {
  const delegate = internalCreateRichTuiFrameProjector();
  let projections = 0;
  const { input, controller } = fullController({
    frameProjector: (request) => {
      projections += 1;
      return delegate(request);
    },
  });
  controller.start();
  await tick();
  const settled = projections;

  input.write("\u001b[<35;2;2M");
  input.write("\u001b[<35;3;2M");
  await tick();

  assert.equal(projections, settled);
  controller.close();
});

test("successful rich selection copy clears its highlight and shows an expiring toast", async () => {
  const { input, output, controller } = fullController({ remote: true });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "copy-toast",
      role: "assistant",
      content: [{ type: "text", text: "copy target" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  controller.renderNow();
  flush();
  const row = terminal.viewport().findIndex((line) => line.includes("copy target"));
  const column = terminal.viewport()[row]?.indexOf("copy target") ?? -1;
  assert.ok(row >= 0 && column >= 0);

  input.write(`\u001b[<0;${column + 1};${row + 1}M`);
  input.write(`\u001b[<32;${column + 2};${row + 1}M`);
  const copiedAt = output.text.length;
  input.write(`\u001b[<0;${column + 2};${row + 1}m`);
  await tick();
  controller.renderNow();
  flush();
  assert.match(output.text, terminalPattern("\\u001b\\]52;c;Y28=\\u0007", "u"));
  assert.match(terminal.viewport().join("\n"), /Copied/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /Copied selection/u);
  const copiedOutput = output.text.slice(copiedAt);
  assert.ok(
    copiedOutput.lastIndexOf("\u001b[7m") < copiedOutput.lastIndexOf("copy target"),
    "the successful copy render did not restore the selected transcript text",
  );

  const toastDeadline = Date.now() + 3_000;
  while (terminal.viewport().join("\n").includes("Copied") && Date.now() < toastDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.renderNow();
    flush();
  }
  assert.doesNotMatch(terminal.viewport().join("\n"), /Copied/u);
  controller.close();
});

test("disabled copy-on-select retains the highlight until the explicit copy action", async () => {
  const { input, output, controller } = fullController();
  const copied: string[] = [];
  controller.copyToClipboard = async (value) => { copied.push(value); };
  controller.setOperatorPreferences({ fullscreenCopyOnSelect: false });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "manual-copy",
      role: "assistant",
      content: [{ type: "text", text: "manual copy target" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  controller.renderNow();
  flush();
  const row = terminal.viewport().findIndex((line) => line.includes("manual copy target"));
  const column = terminal.viewport()[row]?.indexOf("manual copy target") ?? -1;
  assert.ok(row >= 0 && column >= 0);

  const selectedAt = output.text.length;
  input.write(`\u001b[<0;${column + 1};${row + 1}M`);
  input.write(`\u001b[<32;${column + 2};${row + 1}M`);
  input.write(`\u001b[<0;${column + 2};${row + 1}m`);
  await tick();
  controller.renderNow();
  assert.deepEqual(copied, []);
  assert.match(output.text.slice(selectedAt), terminalPattern("\\u001b\\[7m", "u"));

  input.write("\u0018");
  await tick();
  controller.renderNow();
  flush();
  assert.deepEqual(copied, ["ma"]);
  assert.match(terminal.viewport().join("\n"), /Copied/u);
  const copiedAt = output.text.lastIndexOf("manual copy target");
  assert.ok(output.text.lastIndexOf("\u001b[7m") < copiedAt);
  controller.close();
});

test("closing an overlay clears a dragged selection before restoring the composer", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.setEditorText("keep draft");
  await tick();
  controller.renderNow();
  flush();
  const editorRow = terminal.viewport().findIndex((line) => line.includes("keep draft"));
  assert.ok(editorRow >= 0);
  const restoredRuleRow = editorRow + 1;

  const settings = controller.chooseSettings([{
    id: "theme",
    label: "Theme",
    description: "Terminal color theme",
    value: "dark",
    values: ["dark", "light"],
  }], () => undefined);
  await tick();
  controller.renderNow();

  const selectionAt = output.text.length;
  input.write(`\u001b[<0;1;${restoredRuleRow + 1}M`);
  input.write(`\u001b[<32;70;${restoredRuleRow + 1}M`);
  await tick();
  controller.renderNow();
  assert.match(output.text.slice(selectionAt), terminalPattern("\\u001b\\[7m", "u"));
  const closingAt = output.text.length;
  input.write(Buffer.from([27]));
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  await settings;
  output.resize(78, output.rows);
  await tick();
  controller.renderNow();

  assert.doesNotMatch(
    output.text.slice(closingAt),
    terminalPattern("\\u001b\\[7m", "u"),
    "an overlay-owned screen selection must not move onto the restored composer",
  );
  assert.equal(controller.getEditorText(), "keep draft");
  controller.close();
});

test("failed rich selection copy retains its highlight and uses the existing warning path", async () => {
  const { input, output, controller } = fullController();
  controller.copyToClipboard = async () => {
    throw new Error("clipboard helper denied the copy");
  };
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "copy-warning",
      role: "assistant",
      content: [{ type: "text", text: "failed copy target" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  controller.renderNow();
  flush();
  const row = terminal.viewport().findIndex((line) => line.includes("failed copy target"));
  const column = terminal.viewport()[row]?.indexOf("failed copy target") ?? -1;
  assert.ok(row >= 0 && column >= 0);

  const failedAt = output.text.length;
  input.write(`\u001b[<0;${column + 1};${row + 1}M`);
  input.write(`\u001b[<32;${column + 2};${row + 1}M`);
  input.write(`\u001b[<0;${column + 2};${row + 1}m`);
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /clipboard helper denied the copy/u);
  assert.match(output.text.slice(failedAt), terminalPattern("\\u001b\\[7m", "u"));
  assert.doesNotMatch(terminal.viewport().join("\n"), /Copied/u);
  controller.close();
});

test("a delayed copy completion does not clear a newer rich selection", async () => {
  const { input, output, controller } = fullController();
  const copied: string[] = [];
  let completeFirstCopy: (() => void) | undefined;
  const firstCopy = new Promise<void>((resolve) => {
    completeFirstCopy = resolve;
  });
  controller.copyToClipboard = async (value) => {
    copied.push(value);
    if (copied.length === 1) await firstCopy;
  };
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "copy-generation",
      role: "assistant",
      content: [{ type: "text", text: "alpha beta" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  controller.renderNow();
  flush();
  const row = terminal.viewport().findIndex((line) => line.includes("alpha beta"));
  const column = terminal.viewport()[row]?.indexOf("alpha beta") ?? -1;
  assert.ok(row >= 0 && column >= 0);

  input.write(`\u001b[<0;${column + 1};${row + 1}M`);
  input.write(`\u001b[<32;${column + 2};${row + 1}M`);
  input.write(`\u001b[<0;${column + 2};${row + 1}m`);
  await tick();
  assert.equal(copied.length, 1);

  input.write(`\u001b[<0;${column + 7};${row + 1}M`);
  input.write(`\u001b[<32;${column + 9};${row + 1}M`);
  completeFirstCopy?.();
  await tick();
  input.write(`\u001b[<0;${column + 9};${row + 1}m`);
  await tick();

  assert.equal(copied.length, 2);
  controller.close();
});

test("paste-image hotkey emits an app action without inserting text", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  const answer = controller.question("you> ");
  input.write(Buffer.from(process.platform === "win32" ? [27, 118] : [22]));
  await tick();
  assert.deepEqual(actions, [{ type: "paste_image" }]);
  input.write("hello\r");
  assert.equal(await answer, "hello");
  controller.close();
});

test("input images remain out of terminal cells and accompany the submitted question", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const attachment = inputImage();
  assert.equal(controller.attachInputImage(attachment), 1);
  await tick();
  assert.match(output.text, /Attachments · clipboard \(image\/png 20x10\)/u);
  assert.doesNotMatch(output.text, new RegExp(attachment.block.data, "u"));
  const answer = controller.question("you> ");
  input.write("inspect this\r");
  assert.equal(await answer, "inspect this");
  assert.deepEqual(controller.takeSubmittedImages(), [attachment]);
  assert.deepEqual(controller.takeSubmittedImages(), []);
  controller.close();
});

test("pending input images follow draft scopes and active steering submissions", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setDraftScope("first");
  const attachment = inputImage("first image");
  controller.attachInputImage(attachment);
  controller.setEditorText("first draft");
  controller.setDraftScope("second");
  controller.setEditorText("second draft");
  controller.setDraftScope("first");
  let steered: { line: string; images?: readonly TuiInputImageAttachment[] } | undefined;
  controller.setSteering((line, images) => {
    steered = { line, ...optionalProperties(images === undefined ? undefined : { images }) };
  });
  input.write("\r");
  await tick();
  assert.equal(steered?.line, "first draft");
  assert.deepEqual(steered?.images, [attachment]);
  controller.close();
});

test("canonical tool-result images join their lifecycle card without exposing base64 as text", async () => {
  const { input, output, controller } = fullController({ terminal: "kitty" });
  const data = png(12, 8).toString("base64");
  const resultText = [
    ...Array.from({ length: 11 }, (_, index) => `image metadata ${index + 1}`),
    "read image",
  ].join("\n");
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({
    type: "tool_completed",
    callId: "read-terminal-image",
    name: "read",
    index: 0,
    isError: false,
    preview: resultText,
    result: {
      type: "tool_result",
      callId: "read-terminal-image",
      name: "read",
      content: resultText,
      isError: false,
      images: [{ type: "image", mediaType: "image/png", data }],
    },
  }, 1));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "tool-terminal-image",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "read-terminal-image",
        name: "read",
        content: resultText,
        isError: false,
        images: [{ type: "image", mediaType: "image/png", data }],
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 2));
  await tick();
  assert.match(output.text, /\[Image: image\/png 12x8\]/u);
  assert.doesNotMatch(output.text, new RegExp(data.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  output.chunks.length = 0;
  input.write(Buffer.from([15]));
  await tick();
  assert.match(output.text, /read image/u);
  controller.close();
});

test("unsupported and accessibility terminals retain image captions without exposing URLs", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    handleSignals: false,
    environment: { TERM: "dumb" },
  });
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "remote-image",
      role: "user",
      content: [{ type: "image", mediaType: "image/png", url: "https://secret.example.test/image.png?token=private" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  assert.match(output.text, /\[Image: image\/png\]/u);
  assert.doesNotMatch(output.text, terminalPattern("secret\\.example|token=private|\\u001b", "u"));
  controller.close();
});

test("known OSC 8 terminals link host-parsed Markdown and unknown terminals keep literal URLs", async () => {
  const render = async (terminal: "vscode" | undefined) => {
    const { output, controller } = fullController({ ...optionalProperties(terminal === undefined ? undefined : { terminal }) });
    controller.start();
    output.chunks.length = 0;
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: `assistant-link-${terminal ?? "unknown"}`,
        role: "assistant",
        content: [{ type: "text", text: "Read [docs](https://example.test/guide)" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }));
    await tick();
    const text = output.text;
    controller.close();
    return text;
  };
  assert.match(await render("vscode"), terminalPattern("\\u001b\\]8;;https:\\/\\/example\\.test\\/guide\\u001b\\\\docs\\u001b\\]8;;\\u001b\\\\", "u"));
  const fallback = await render(undefined);
  assert.match(fallback, /\[docs\]\(https:\/\/example\.test\/guide\)/u);
  assert.doesNotMatch(fallback, terminalPattern("\\u001b\\]8;", "u"));
});

test("full TUI negotiates Kitty keyboard input from a fragmented reply and restores it", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  assert.match(output.text, terminalPattern("\\u001b\\[>7u\\u001b\\[\\?u\\u001b\\[c", "u"));
  output.chunks.length = 0;
  input.write("\u001b[?");
  input.write("7u");
  await tick();
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[>7u", "u"));

  const answer = controller.question("you> ");
  input.write("\u001b[13;1:3u");
  input.write("\u001b[104;1u\u001b[105;1u\u001b[13;1:1u");
  assert.equal(await answer, "hi");
  controller.close();
  assert.match(output.text, terminalPattern("\\u001b\\[<u", "u"));
  assert.ok(output.text.indexOf("\u001b[<u") < output.text.lastIndexOf("\u001b[?2004l"));
});

test("full TUI falls back to modify-other-keys and can upgrade after a late Kitty reply", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  input.write("\u001b[?1;");
  input.write("2c");
  await tick();
  assert.match(output.text, terminalPattern("\\u001b\\[>4;2m", "u"));

  output.chunks.length = 0;
  input.write("\u001b[?3u");
  await tick();
  assert.match(output.text, terminalPattern("\\u001b\\[>4m", "u"));
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[>7u", "u"));
  controller.close();
  assert.match(output.text, terminalPattern("\\u001b\\[<u", "u"));
});

test("a zero enhanced-keyboard reply falls back without pushing keyboard state twice", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  input.write("\u001b[?0u");
  await tick();
  assert.match(output.text, terminalPattern("\\u001b\\[>4;2m", "u"));
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[>7u", "u"));
  output.chunks.length = 0;
  controller.close();
  assert.match(output.text, terminalPattern("\\u001b\\[<u\\u001b\\[>4m", "u"));
});

test("enhanced keyboard input drains late releases before shutdown", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("\u001b[?7u");
  await tick();
  output.chunks.length = 0;
  const drain = controller.drainInput(250, 30);
  setTimeout(() => input.write("discarded"), 10);
  setTimeout(() => input.write("\u001b[13;1:3u"), 20);
  await drain;
  assert.match(output.text, terminalPattern("\\u001b\\[<u", "u"));
  const answer = controller.question("you> ");
  input.write("kept\r");
  assert.equal(await answer, "kept");
  controller.close();
});

test("suspend restores cooked mode and redraws after SIGCONT", {
  skip: process.platform === "win32",
}, async () => {
  const signals = new FakeSignals();
  const { input, output, controller } = fullController({ signals });
  controller.start();
  input.write("\u001b[?7u");
  await tick();
  output.chunks.length = 0;
  let stopped = false;
  controller.suspend(() => { stopped = true; });
  assert.equal(stopped, true);
  assert.equal(input.isRaw, false);
  assert.match(output.text, terminalPattern("\\u001b\\[<u.*\\u001b\\[\\?2004l", "us"));
  output.chunks.length = 0;
  signals.signal("SIGCONT");
  await tick();
  assert.equal(input.isRaw, true);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2004h.*\\u001b\\[>7u\\u001b\\[\\?u\\u001b\\[c", "us"));
  controller.close();
});

test("external-editor suspension restores enhanced input before returning to canonical mode", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("\u001b[?7u");
  await tick();
  output.chunks.length = 0;
  await controller.editExternally(async (text) => text);
  const pop = output.text.indexOf("\u001b[<u");
  const pasteOff = output.text.indexOf("\u001b[?2004l");
  const pasteOn = output.text.lastIndexOf("\u001b[?2004h");
  const query = output.text.lastIndexOf("\u001b[?u\u001b[c");
  assert.ok(pop >= 0 && pop < pasteOff);
  assert.ok(pasteOff < pasteOn && pasteOn < query);
  controller.close();
});

test("full TUI uses a bounded negotiation deadline when a terminal does not reply", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.match(output.text, terminalPattern("\\u001b\\[>4;2m", "u"));
  controller.close();
  assert.match(output.text, terminalPattern("\\u001b\\[>4m", "u"));
});

test("full TUI hides secret input and resumes normal questions", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const secret = controller.readSecret("API key: ");
  input.write("never-render-this-key\r");
  assert.equal(await secret, "never-render-this-key");
  assert.doesNotMatch(output.text, /never-render-this-key/u);
  assert.ok(output.text.indexOf("\u001b[?2004l") < output.text.indexOf("API key: "));
  assert.match(output.text.slice(output.text.indexOf("API key: ")), terminalPattern("\\u001b\\[\\?2004h", "u"));
  const answer = controller.question("you> ");
  input.write("ready\r");
  assert.equal(await answer, "ready");
  controller.close();
});

test("terminal clipboard copy emits only a bounded OSC 52 payload", async () => {
  const { output, controller } = fullController({ remote: true });
  controller.start();
  await controller.copyToClipboard("copy me");
  assert.match(output.text, terminalPattern("\\u001b\\]52;c;Y29weSBtZQ==\\u0007", "u"));
  await assert.rejects(controller.copyToClipboard("x".repeat(75_001)), /75,000-byte/u);
  await assert.rejects(controller.copyToClipboard("x".repeat(100 * 1024 + 1)), /100 KiB/u);
  controller.close();
});

test("TUI secret input is not echoed by a real PTY", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-secret.ts", import.meta.url));
  const command = [process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });

  await waitForOutput(() => rendered, "API key: ");
  child.stdin.write("tui-secret-never-render\n");
  await waitForOutput(() => rendered, "Continue: ");
  child.stdin.write("yes\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, /tui-secret-never-render/u);
  assert.match(rendered, /tui-secret-complete/u);
});

test("real PTY paste-image hotkey attaches metadata without echoing payload bytes", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-clipboard-attachment.ts", import.meta.url));
  const command = `stty cols 64 rows 12; TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  await waitForOutput(() => rendered, "Clipboard prompt:");
  child.stdin.write(Buffer.from([22]));
  await waitForOutput(() => rendered, "clipboard-pty (image/png 12x8)");
  child.stdin.write("inspect\r");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const base64 = png(12, 8).toString("base64");
  const digest = createHash("sha256").update(png(12, 8)).digest("hex").slice(0, 12);
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, new RegExp(`clipboard-pty:inspect:1:${digest}`, "u"));
  assert.doesNotMatch(rendered, new RegExp(base64, "u"));
  assert.doesNotMatch(rendered, /clipboard-pty-error/u);
});

test("real PTY expands tools across a width resize inside the one rich viewport", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-inline-expand-resize.ts", import.meta.url));
  const command = `stty cols 80 rows 18; TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });

  await waitForOutput(() => rendered, "pty-final-answer");
  child.stdin.write(Buffer.from([15]));
  await waitForOutput(() => rendered, "pty-expanded-tail");
  await waitForOutput(() => rendered, "pty-width-resized");
  child.stdin.write(Buffer.from([15]));
  await waitForOutput(() => rendered, "pty-expand-resize-complete");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, terminalPattern("\\u001b\\[\\?1049h", "u"));
  assert.match(rendered, terminalPattern("\\u001b\\[\\?1049l", "u"));
  assert.doesNotMatch(rendered, terminalPattern("\\u001b\\[3J", "u"));
  assert.match(rendered, /pty-expanded-tail/u);
  const starts = rendered.match(terminalPattern("\\u001b\\[\\?2026h", "gu"))?.length ?? 0;
  const ends = rendered.match(terminalPattern("\\u001b\\[\\?2026l", "gu"))?.length ?? 0;
  assert.ok(starts >= 3, rendered);
  assert.equal(ends, starts);
});

test("real PTY exposes live reasoning, text, tool arguments, and progress before completion", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-live-stream.ts", import.meta.url));
  const command = `stty cols 64 rows 18; TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, /pty-reasoning-live/u);
  assert.match(rendered, /pty-text-live/u);
  assert.match(rendered, /pty-tool-progress/u);
  assert.match(rendered, /pty-final-answer/u);
  const partial = rendered.indexOf("pty-live-fragment");
  const boundary = rendered.indexOf("pty-before-canonical");
  assert.ok(partial >= 0 && boundary > partial, rendered);
  const progress = rendered.indexOf("pty-tool-progress");
  const toolCompletionBoundary = rendered.indexOf("pty-before-tool-complete");
  assert.ok(progress >= 0 && toolCompletionBoundary > progress, rendered);
  assert.match(rendered, /pty-live-stream-complete/u);
});

test("real PTY differentially grows and shrinks the rich viewport", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-row-diff.ts", import.meta.url));
  const command = `stty cols 48 rows 8; TERM=xterm-256color NO_COLOR=1 OHM_SYNC_UPDATE=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, /row-diff-pty-complete/u);
  assert.match(rendered, /row-diff-committed/u);
  assert.match(rendered, /surface-initial/u);
  assert.match(rendered, /surface-expanded-2/u);
  assert.match(rendered, /surface-shrunk/u);
  assert.doesNotMatch(rendered, terminalPattern("\\u001b\\[3J", "u"));
  assert.match(rendered, terminalPattern("\\u001b\\[\\?1049h", "u"));
  assert.match(rendered, terminalPattern("\\u001b\\[\\?1049l", "u"));
  const starts = rendered.match(terminalPattern("\\u001b\\[\\?2026h", "gu"))?.length ?? 0;
  const ends = rendered.match(terminalPattern("\\u001b\\[\\?2026l", "gu"))?.length ?? 0;
  assert.ok(starts >= 3, rendered);
  assert.equal(ends, starts);
});

test("real PTY keeps image payloads inside the bounded Kitty protocol channel", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-terminal-image.ts", import.meta.url));
  // The runner may live inside tmux; the synthetic child deliberately models a direct Kitty terminal.
  const command = `unset TMUX TERM_PROGRAM TERMINAL_EMULATOR JETBRAINS_IDE WT_SESSION; stty cols 48 rows 12; TERM=xterm-256color KITTY_WINDOW_ID=1 NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "/tmp/ohm-parent-tmux,1,0" },
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const data = png().toString("base64");
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, terminalPattern("\\u001b_Ga=T,f=100,q=2,C=1", "u"));
  assert.equal(rendered.split(data).length - 1, 1);
  assert.match(rendered, /terminal-image-pty-complete/u);
  assert.doesNotMatch(rendered, terminalPattern("\\u001b\\[3J", "u"));
});

test("real PTY accepts fragmented Kitty replies, filters releases, and restores keyboard mode", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-keyboard.ts", import.meta.url));
  const command = `TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });

  await waitForOutput(() => rendered, "\u001b[?u\u001b[c");
  child.stdin.write("\u001b[?");
  child.stdin.write("7u");
  await waitForOutput(() => rendered, "\u001b[>7u");
  child.stdin.write("\u001b[104;1u\u001b[105;1u\u001b[13;1:3u\u001b[13;1:1u");
  await waitForOutput(() => rendered, "keyboard-pty:hi");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, terminalPattern("\\u001b\\[>7u", "u"));
  assert.match(rendered, terminalPattern("\\u001b\\[<u", "u"));
  assert.doesNotMatch(rendered, /keyboard-pty-timeout|keyboard-pty-error/u);
});

test("large bracketed paste renders only a marker and expands at submission", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const payload = Array.from({ length: 12 }, (_, index) => `controller-private-${index}`).join("\n");
  const answer = controller.question("you> ");
  output.chunks.length = 0;
  input.write(`\u001b[200~${payload}\u001b[201~`);
  await tick();
  assert.match(output.text, /\[paste #1 \+12 lines\]/u);
  assert.doesNotMatch(output.text, /controller-private-/u);
  input.write("\r");
  assert.equal(await answer, payload);
  controller.close();
});

test("large-paste payload survives draft scopes and marker-preserving external edits", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setDraftScope("one");
  const payload = Array.from({ length: 11 }, (_, index) => `scope-private-${index}`).join("\n");
  const answer = controller.question("you> ");
  input.write(`\u001b[200~${payload}\u001b[201~`);
  controller.setDraftScope("two");
  controller.setDraftScope("one");
  await controller.editExternally(async (text) => `before ${text} after`);
  await tick();
  assert.match(output.text, /before \[paste #1 \+11 lines\] after/u);
  assert.doesNotMatch(output.text, /scope-private-/u);
  input.write("\r");
  assert.equal(await answer, `before ${payload} after`);
  controller.close();
});

test("real PTY never echoes a large paste payload while preserving its submitted digest", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-large-paste.ts", import.meta.url));
  const command = `TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const payload = Array.from({ length: 12 }, (_, index) => `pty-private-${index}`).join("\n");
  const digest = createHash("sha256").update(payload).digest("hex");

  await waitForOutput(() => rendered, "\u001b[?u\u001b[c");
  child.stdin.write(`\u001b[200~${payload}\u001b[201~`);
  await waitForOutput(() => rendered, "[paste #1 +12 lines]");
  assert.doesNotMatch(rendered, /pty-private-/u);
  child.stdin.write("\r");
  await waitForOutput(() => rendered, `paste-pty:${Buffer.byteLength(payload)}:${digest}`);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, /pty-private-|paste-pty-timeout|paste-pty-error/u);
});

test("controller exposes jump, kill, yank, and yank-pop editing defaults", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("hello world");
  input.write(Buffer.from([1]));
  input.write(Buffer.from([29]));
  input.write("o");
  input.write("X");
  input.write(Buffer.from([11]));
  input.write(Buffer.from([25]));
  input.write("\r");
  assert.equal(await answer, "hellXo world");
  controller.close();
});

test("Ctrl+Z undoes a typed word and Ctrl+Shift+Z redoes it without suspending", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  input.write("draft");
  input.write(Buffer.from([26]));
  assert.equal(controller.getEditorText(), "");
  assert.deepEqual(actions, []);
  input.write("\u001b[122;6u");
  assert.equal(controller.getEditorText(), "draft");
  assert.deepEqual(actions, []);
  controller.close();
});

test("controller dispatches remapped kill, yank, and yank-pop actions", async () => {
  const { input, controller } = fullController();
  controller.setKeybindings(new Keybindings({
    "tui.editor.deleteToLineEnd": "alt+k",
    "tui.editor.yank": "alt+p",
    "tui.editor.yankPop": "alt+n",
  }));
  controller.start();
  const answer = controller.question("you> ");
  input.write("first");
  input.write(Buffer.from([1]));
  input.write("\u001bk");
  assert.equal(controller.getEditorText(), "");
  input.write("second");
  input.write(Buffer.from([1]));
  input.write("\u001bk");
  assert.equal(controller.getEditorText(), "");
  input.write("\u001bp");
  assert.equal(controller.getEditorText(), "second");
  input.write("\u001bn");
  assert.equal(controller.getEditorText(), "first");
  input.write("\r");
  assert.equal(await answer, "first");
  controller.close();
});

test("PageUp moves within a multiline editor viewport before paging transcript", async () => {
  const { input, controller } = fullController();
  controller.start();
  const lines = Array.from({ length: 8 }, (_, index) => String(index));
  controller.setEditorText(lines.join("\n"));
  const answer = controller.question("you> ");
  input.write("\u001b[5~");
  input.write("X\r");
  lines[2] = "2X";
  assert.equal(await answer, lines.join("\n"));
  controller.close();
});

test("visual-row navigation uses the composer text width at exact wrap boundaries", async () => {
  const { input, output, controller } = fullController();
  output.resize(12, 10);
  controller.start();
  const first = controller.question("you> ");
  input.write("history\r");
  assert.equal(await first, "history");

  const answer = controller.question("you> ");
  input.write("abcdefghi");
  input.write("\u001b[A");
  input.write("\r");
  assert.equal(await answer, "abcdefghi");
  controller.close();
});

test("drafts survive picker use and session-scope switches", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setDraftScope("one");
  input.write("alpha draft");
  const selection = controller.choose("Models", [
    { label: "small", value: "small" },
    { label: "beta smart", value: "smart" },
  ]);
  input.write("beta\r");
  assert.equal(await selection, "smart");
  controller.setDraftScope("two");
  input.write("other draft");
  controller.setDraftScope("one");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "alpha draft");
  controller.close();
});

test("cancelling a picker is a typed user action", async () => {
  const { input, controller } = fullController();
  controller.start();
  const selection = controller.choose("Models", [{ label: "small", value: "small" }]);
  input.write(Buffer.from([3]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("Escape cancels modal and pending selections before the permanent interrupt handler", async () => {
  const { input, controller } = fullController();
  let interrupted = 0;
  controller.start();
  controller.setInterruptHandler(() => { interrupted += 1; });

  const selection = controller.choose("Models", [{ label: "small", value: "small" }]);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  assert.equal(interrupted, 0);

  const question = controller.question("Exact model/deployment ID: ");
  input.write(Buffer.from([27]));
  await assert.rejects(question, TuiSelectionCancelledError);
  assert.equal(interrupted, 0);
  controller.close();
});

test("an empty session picker remains usable and explains all-workspace recovery", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const selection = controller.choosePicker("session", "Resume Session", []);
  await tick();
  assert.match(output.text, /No sessions in this workspace/u);
  assert.match(output.text, /\/resume --all to search every/u);
  input.write("\u001b");
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("the combined-model picker preserves the draft", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [
    { id: "openai/gpt", label: "openai / gpt", value: { provider: "openai", model: "gpt" } },
    { id: "anthropic/claude", label: "anthropic / claude", value: { provider: "anthropic", model: "claude" } },
  ]);
  input.write("keep me");
  input.write(Buffer.from([12]));
  input.write("claude\r");
  assert.equal(actions[0]?.type, "model_open");
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") {
    assert.equal(actions[1].picker, "model");
    assert.deepEqual(actions[1].item.value, { provider: "anthropic", model: "claude" });
  }
  assert.equal(actions.length, 2);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "keep me");
  controller.close();
});

test("an empty model picker explains that authentication lives under /login", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", []);
  input.write(Buffer.from([12]));
  await tick();
  assert.match(terminalWords(output.text), /No available models\. Use \/login to connect a provider\./u);
  input.write("\u001b");
  controller.close();
});

test("an empty connected model picker reports catalog recovery instead of asking for login", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", []);
  controller.setModelPickerEmptyMessage("Connected provider catalogs are unavailable: corp (network). Retry /model or /refresh.");
  input.write(Buffer.from([12]));
  await tick();
  const visible = terminalWords(output.text);
  assert.match(visible, /Connected provider catalogs are unavailable: corp \(network\)/u);
  assert.match(visible, /\/model or \/refresh\./u);
  assert.doesNotMatch(output.text, /Use \/login to connect/u);
  input.write("\u001b");
  controller.close();
});

test("a refreshing model picker retains live rows and never misdiagnoses loading as missing authentication", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setModelPickerItems([
    { id: "openai/gpt", label: "openai / gpt", value: { provider: "openai", model: "gpt" } },
  ]);
  controller.setModelPickerLoading(true);
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /Refreshing live available models/u);
  assert.match(output.text, /gpt \[openai\]/u);
  assert.doesNotMatch(output.text, /Use \/login/u);

  controller.addModelPickerItems([
    { id: "anthropic/claude", label: "anthropic / claude", value: { provider: "anthropic", model: "claude" } },
  ]);
  await tick();
  assert.match(output.text, /claude \[anthropic\]/u);
  controller.close();
});

test("an initially empty refreshing picker shows an explicit loading state", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setModelPickerLoading(true);
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /Loading live available models/u);
  assert.doesNotMatch(output.text, /Use \/login/u);
  controller.close();
});

test("model picker filtering selects the first ranked catalog row", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  const alphaOne = { id: "p/alpha-one", label: "p / alpha-one", value: { provider: "p", model: "alpha-one" } };
  const alphaTwo = { id: "p/alpha-two", label: "p / alpha-two", value: { provider: "p", model: "alpha-two" } };
  const zeta = { id: "p/zeta", label: "p / zeta", value: { provider: "p", model: "zeta" } };
  controller.setModelPickerItems([alphaOne, alphaTwo, zeta]);

  input.write(Buffer.from([12]));
  input.write("\u001b[B\u001b[Balpha\r");
  assert.equal(actions[0]?.type, "model_open");
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") assert.deepEqual(actions[1].item.value, alphaOne.value);

  controller.close();
});

test("model picker shows provider badges, marks the active model, and wraps arrow navigation", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "openai", model: "alpha" });
  controller.setPickerItems("model", [
    { id: "openai/alpha", label: "openai / alpha", value: { provider: "openai", model: "alpha" } },
    { id: "anthropic/beta", label: "anthropic / beta", value: { provider: "anthropic", model: "beta" } },
  ]);

  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /alpha \[openai\] ✓/u);
  assert.match(output.text, /beta \[anthropic\]/u);
  assert.doesNotMatch(output.text, /beta \[anthropic\] ✓/u);

  input.write("\u001b[A\r");
  assert.equal(actions[0]?.type, "model_open");
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") assert.deepEqual(actions[1].item.value, { provider: "anthropic", model: "beta" });

  input.write(Buffer.from([12]));
  input.write("\u001b[B\u001b[B\r");
  assert.equal(actions[2]?.type, "model_open");
  assert.equal(actions[3]?.type, "select");
  if (actions[3]?.type === "select") assert.deepEqual(actions[3].item.value, { provider: "openai", model: "alpha" });
  controller.close();
});

test("model picker initially highlights the current model instead of the first catalog row", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "p", model: "beta" });
  const alpha = { id: "p/alpha", label: "p / alpha", value: { provider: "p", model: "alpha" } };
  const beta = { id: "p/beta", label: "p / beta", value: { provider: "p", model: "beta" } };
  controller.setModelPickerItems([alpha, beta]);

  input.write(Buffer.from([12]));
  input.write("\r");

  assert.equal(actions[0]?.type, "model_open");
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") assert.deepEqual(actions[1].item.value, beta.value);
  controller.close();
});

test("picker command decks describe remapped navigation and actions", async () => {
  const { input, output, controller } = fullController();
  controller.setKeybindings(new Keybindings({
    "tui.select.up": "alt+k",
    "tui.select.down": "alt+j",
    "tui.select.confirm": "alt+o",
    "tui.select.cancel": "alt+x",
    "app.session.delete": "alt+d",
  }));
  controller.setPickerItems("model", [
    { id: "p/one", label: "p / one", value: { provider: "p", model: "one" } },
  ]);
  controller.start();
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /Alt\+K\/Alt\+J navigate/u);
  assert.match(output.text, /Alt\+O select · Alt\+X cancel/u);
  input.write("\u001bx");

  output.chunks.length = 0;
  const session = controller.choosePicker("session", "Resume Session", [{
    id: "session",
    label: "Session",
    value: "session",
    session: {
      path: "/workspace/session",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }]);
  await tick();
  assert.match(output.text, /Alt\+O open · Alt\+D delete · Alt\+X close/u);
  assert.doesNotMatch(output.text, /rename/iu);
  input.write("\u001bx");
  await assert.rejects(session, TuiSelectionCancelledError);
  controller.close();
});

test("session-tree picker folds, toggles paths, cycles sibling endpoints, and preserves the draft", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("draft survives");
  const rows = [
    { id: "root", label: "Root prompt", value: "root", tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main", "sibling"], active: true } },
    { id: "main", label: "Main prompt", value: "main", tree: { eventId: "main", kind: "user", depth: 1, prefix: "   ├─ ", branches: ["main"], paths: ["main"], active: true } },
    { id: "sibling", label: "Sibling prompt", value: "sibling", tree: { eventId: "sibling", kind: "user", depth: 1, prefix: "   └─ ", branches: ["sibling"], paths: ["sibling"], active: false } },
  ];
  const selection = controller.chooseSessionTree("Session Tree", rows);
  await tick();
  assert.match(output.text, /Ctrl\+← fold/u);

  input.write("\u001b[A");
  input.write("\u001b[1;5D");
  await tick();
  assert.match(output.text, /Folded root/u);
  input.write("\u001b[1;5C");
  await tick();
  assert.match(output.text, /Unfolded root/u);

  input.write(Buffer.from([16]));
  await tick();
  assert.match(terminalWords(output.text), /default · active path/u);
  input.write(Buffer.from([16]));
  input.write("\u001b[1;5C\u001b[1;5C");
  input.write("\r");
  assert.equal(await selection, "sibling");

  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "draft survives");

  const cancelled = controller.chooseSessionTree("Session Tree", rows);
  input.write(Buffer.from([27]));
  await assert.rejects(cancelled, TuiSelectionCancelledError);
  controller.close();
});

test("session-tree picker restores an explicitly requested selection", async () => {
  const { input, controller } = fullController();
  controller.start();
  const selection = controller.chooseSessionTree("Session Tree", [
    { id: "root", label: "Root prompt", value: "root", tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main", "sibling"], active: true } },
    { id: "main", label: "Main prompt", value: "main", tree: { eventId: "main", kind: "user", depth: 1, prefix: "   ├─ ", branches: ["main"], paths: ["main"], active: true } },
    { id: "sibling", label: "Sibling prompt", value: "sibling", tree: { eventId: "sibling", kind: "user", depth: 1, prefix: "   └─ ", branches: ["sibling"], paths: ["sibling"], active: false } },
  ], { initialEventId: "sibling" });
  input.write("\r");

  assert.equal(await selection, "sibling");
  controller.close();
});

test("session-tree picker restores its selection after an empty search", async () => {
  const { input, controller } = fullController();
  controller.start();
  const selection = controller.chooseSessionTree("Session Tree", [
    { id: "root", label: "Root prompt", value: "root", tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main"], active: true } },
    { id: "leaf", label: "Leaf prompt", value: "leaf", tree: { eventId: "leaf", parentEventId: "root", kind: "user", depth: 1, prefix: "   └─ ", branches: ["main"], paths: ["main"], active: true } },
  ], { initialEventId: "leaf" });
  input.write("no-match");
  await tick();
  input.write(Buffer.alloc("no-match".length, 127));
  await tick();
  input.write("\r");

  assert.equal(await selection, "leaf");
  controller.close();
});

test("session-tree picker selects the nearest visible ancestor when a filter hides the selection", async () => {
  const { input, controller } = fullController();
  controller.start();
  const selection = controller.chooseSessionTree("Session Tree", [
    { id: "root", label: "Root prompt", value: "root", tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main"], active: true } },
    { id: "answer", label: "Assistant answer", value: "answer", tree: { eventId: "answer", parentEventId: "root", kind: "assistant", depth: 1, prefix: "   └─ ", branches: ["main"], paths: ["main"], active: true } },
  ], { initialEventId: "answer" });
  input.write(Buffer.from([21]));
  await tick();
  input.write("\r");

  assert.equal(await selection, "root");
  controller.close();
});

test("session-tree help follows remapped tree actions", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.setKeybindings(new Keybindings({
    "app.tree.foldOrUp": "alt+h",
    "app.tree.unfoldOrDown": "alt+l",
    "app.tree.togglePath": "alt+a",
  }));
  controller.start();
  const selection = controller.chooseSessionTree("Session Tree", [{
    id: "root",
    label: "Root prompt",
    value: { text: "Root prompt text" },
    tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: ["main"], paths: ["main"], active: true },
  }]);
  await tick();
  assert.match(output.text, /Alt\+H fold/u);
  assert.match(output.text, /Alt\+L unfold/u);
  assert.match(output.text, /Alt\+A path/u);
  assert.match(output.text, /Ctrl\+X copy/u);
  input.write(Buffer.from([24]));
  await tick();
  assert.deepEqual(actions, [{ type: "copy_text", text: "Root prompt text", label: "selected tree entry" }]);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("session-tree labels, timestamps, and filters remain interactive without selecting an entry", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const changes: Array<{ eventId: string; label?: string }> = [];
  const selection = controller.chooseSessionTree("Session Tree", [
    { id: "user", label: "User prompt", value: "user", tree: { eventId: "user", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main"], active: true } },
    { id: "assistant", label: "Assistant answer", value: "assistant", tree: { eventId: "assistant", kind: "assistant", depth: 1, prefix: "   ├─ ", branches: [], paths: ["main"], active: true } },
    { id: "tool", label: "Tool output", value: "tool", tree: { eventId: "tool", kind: "tool", depth: 1, prefix: "   └─ ", branches: ["main"], paths: ["main"], active: true } },
  ], {
    onLabelChange(eventId, label) {
      changes.push({ eventId, ...optionalProperties(label === undefined ? undefined : { label }) });
      return label === undefined ? {} : { label, labelTimestamp: "2026-07-10T12:34:56.000Z" };
    },
  });
  input.write(Buffer.from([21]));
  await tick();
  assert.match(terminalWords(output.text), /Filter: user-only/u);
  input.write("L");
  await tick();
  assert.match(output.text, /Add entry label/u);
  input.write("bookmark\r");
  await tick();
  assert.deepEqual(changes, [{ eventId: "user", label: "bookmark" }]);
  assert.match(output.text, /Labeled user: bookmark/u);

  input.write(Buffer.from([12]));
  input.write("T");
  await tick();
  assert.match(terminalWords(output.text), /labeled-only · all paths/u);
  assert.match(output.text, /\[bookmark\] User prompt/u);
  assert.match(output.text, /2026-07-10 12:34 User prompt/u);
  input.write("L");
  input.write(Buffer.from([21]));
  input.write("\r");
  await tick();
  assert.deepEqual(changes.at(-1), { eventId: "user" });
  assert.match(output.text, /No matching tree entries/u);

  input.write(Buffer.from([15]));
  await tick();
  assert.match(output.text, /Filter: all/u);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("an exact command picker match submits on the first Enter", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/");
  input.write("exit\r");
  assert.equal(await answer, "/exit");
  controller.close();
});

test("a partial command picker selection submits on the first Enter", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/");
  input.write("ex\r");
  assert.equal(await answer, "/export");
  controller.close();
});

test("command picker arrow navigation wraps across both ends", async () => {
  const { input, controller } = fullController();
  controller.setPickerItems("command", [
    { id: "alpha", label: "/alpha", value: "/alpha" },
    { id: "beta", label: "/beta", value: "/beta" },
  ]);
  controller.start();

  const wrappedDown = controller.question("you> ");
  input.write("/");
  input.write("\u001b[B\u001b[B\r");
  assert.equal(await wrappedDown, "/alpha");

  const wrappedUp = controller.question("you> ");
  input.write("/");
  input.write("\u001b[A\r");
  assert.equal(await wrappedUp, "/beta");
  controller.close();
});

test("command picker preserves arguments and submits an unmatched slash command", async () => {
  const first = fullController();
  first.controller.start();
  first.controller.addPickerItems("command", [{
    id: "runtime-command:reference-demo",
    label: "/reference-demo",
    value: "/reference-demo",
  }]);
  const command = first.controller.question("you> ");
  first.input.write("/");
  first.input.write("reference-demo interactive-check");
  first.input.write("\r");
  assert.equal(await command, "/reference-demo interactive-check");
  first.controller.close();

  const second = fullController();
  second.controller.start();
  const unmatched = second.controller.question("you> ");
  second.input.write("/");
  second.input.write("not-a-command\r");
  assert.equal(await unmatched, "/not-a-command");
  second.controller.close();
});

test("argument-taking default commands remain available in command completion", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/");
  input.write("export session.jsonl");
  input.write("\r");
  assert.equal(await answer, "/export session.jsonl");
  controller.close();
});

test("async command argument completion applies only to the unchanged editor snapshot", async () => {
  const { input, controller } = fullController();
  const generation = new AbortController();
  let finish!: (value: readonly { value: string }[]) => void;
  controller.start();
  controller.setCommandItems([{ id: "deploy", label: "/deploy", value: "/deploy" }]);
  controller.setCommandCompletionProvider(async () => await new Promise((resolve) => { finish = resolve; }), generation.signal);
  input.write("/deploy d\t");
  await tick();
  input.write("x");
  finish([{ value: "dev" }]);
  await tick();
  assert.equal(controller.getEditorText(), "/deploy dx");
  generation.abort();
  controller.close();
});

test("command completions are generation-owned and malformed providers cannot mutate input", async () => {
  const { input, output, controller } = fullController();
  const stale = new AbortController();
  let finish!: (value: readonly { value: string }[]) => void;
  controller.start();
  controller.setCommandItems([{ id: "deploy", label: "/deploy", value: "/deploy" }]);
  controller.setCommandCompletionProvider(async () => await new Promise((resolve) => { finish = resolve; }), stale.signal);
  input.write("/deploy d\t");
  await tick();
  stale.abort(new Error("runtime refreshed"));
  finish([{ value: "stale" }]);
  await tick();
  assert.equal(controller.getEditorText(), "/deploy d");

  const current = new AbortController();
  controller.setCommandCompletionProvider(async () => [{ value: "bad\0value" }], current.signal);
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "/deploy d");
  assert.match(output.text, /Command completion failed/u);
  current.abort();
  controller.close();
});

test("line command completion exposes bounded choices without requiring the full TUI", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const generation = new AbortController();
  const controller = new TuiController({ input, output, mode: "line", environment: { TERM: "dumb" }, handleSignals: false });
  controller.start();
  controller.setCommandCompletionProvider(async () => [
    { value: "dev", label: "Development" },
    { value: "prod", label: "Production" },
  ], generation.signal);
  input.write("/deploy d\t");
  await tick();
  assert.match(output.text, /Development/u);
  input.write("\u001b[B\r");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "/deploy prod");
  generation.abort();
  controller.close();
});

test("composable autocomplete applies bounded grapheme ranges and ignores stale generations", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  controller.start();
  controller.setAutocompleteProvider(async (text, cursor) => [{ start: 0, end: cursor, value: text.toUpperCase(), label: "Upper" }], generation.signal);
  input.write("go\t");
  await tick();
  assert.equal(controller.getEditorText(), "GO");

  let finish!: (value: readonly { start: number; end: number; value: string }[]) => void;
  const stale = new AbortController();
  controller.setAutocompleteProvider(async () => await new Promise((resolve) => { finish = resolve; }), stale.signal);
  input.write("x\t");
  await tick();
  stale.abort(new Error("extension refreshed"));
  finish([{ start: 0, end: 3, value: "stale" }]);
  await tick();
  assert.equal(controller.getEditorText(), "GOx");

  const malformed = new AbortController();
  controller.setAutocompleteProvider(async () => [{ start: -1, end: 0, value: "bad" }], malformed.signal);
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "GOx");
  assert.match(output.text, /Autocomplete failed/u);
  controller.close();
});

test("TUI notifications redact registered secrets from autocomplete failures", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  const secret = "registered-autocomplete-secret-value";
  defaultSecretRedactor.register(secret);
  controller.start();
  controller.setAutocompleteProvider(async () => {
    throw new Error(`before-${secret}-after`);
  }, generation.signal);
  input.write("x\t");
  await tick();
  assert.match(output.text, /Autocomplete failed: before-\[REDACTED\]-after/u);
  assert.doesNotMatch(output.text, new RegExp(secret, "u"));
  generation.abort();
  controller.close();
});

test("TUI callback failures never inspect hostile thrown values", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  let traps = 0;
  const failure = new Proxy(new Error("autocomplete failed"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("TUI callback failure was inspected");
    },
  });
  controller.start();
  controller.setAutocompleteProvider(async () => { throw failure; }, generation.signal);

  input.write("x\t");
  await tick();

  assert.equal(traps, 0);
  assert.match(output.text, /Autocomplete failed: \[Thrown object\]/u);
  generation.abort();
  controller.close();
});

test("autocomplete preserves an explicit grapheme cursor after a multiline replacement", async () => {
  const { input, controller } = fullController();
  const generation = new AbortController();
  controller.start();
  controller.setAutocompleteProvider(async (_text, cursor) => [{
    start: 0,
    end: cursor,
    value: "🙂\nnext",
    cursor: 1,
  }], generation.signal);
  controller.setEditorText("replace");
  input.write("\t");
  await tick();
  input.write("!");
  await tick();
  assert.equal(controller.getEditorText(), "🙂!\nnext");
  generation.abort();
  controller.close();
});

test("autocomplete is re-queried when cursor movement changes its context", async () => {
  const { input, controller } = fullController();
  const generation = new AbortController();
  const requests: Array<{ text: string; cursor: number; force: boolean | undefined }> = [];
  const provider = Object.assign(async (text: string, cursor: number, _signal: AbortSignal, options?: { force?: boolean }) => {
    requests.push({ text, cursor, force: options?.force });
    return [];
  }, { triggerCharacters: ["@"] as const });
  controller.start();
  controller.setAutocompleteProvider(provider, generation.signal);
  controller.setEditorText("@alpha");

  input.write("\u001b[D");
  await tick();

  assert.deepEqual(requests, [{ text: "@alpha", cursor: 5, force: false }]);
  generation.abort();
  controller.close();
});

test("editor middleware is structural, bounded, and cannot retain input after generation abort", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  controller.start();
  controller.setEditorMiddleware((event, snapshot) => event.key === "text"
    ? { action: "replace", text: `${snapshot.text}[${event.text}]` }
    : { action: "pass" }, generation.signal);
  input.write("x");
  await tick();
  assert.equal(controller.getEditorText(), "[x]");
  generation.abort(new Error("extension refreshed"));
  input.write("y");
  await tick();
  assert.equal(controller.getEditorText(), "[x]y");

  const malformed = new AbortController();
  controller.setEditorMiddleware(() => ({ action: "replace", text: "bad", cursor: -1 }), malformed.signal);
  input.write("z");
  await tick();
  assert.equal(controller.getEditorText(), "[x]yz");
  assert.match(output.text, /Editor middleware failed/u);
  controller.close();
});

test("editor renderer is structural, preserves host input semantics, and expires with its generation", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  controller.start();
  controller.setEditorRenderer({
    render(view) {
      const text = `custom:${view.text}`;
      return {
        lines: [{ spans: [{ text, role: "accent" }] }],
        cursor: { row: 0, column: "custom:".length + view.cursor },
      };
    },
  }, generation.signal);
  input.write("x");
  await tick();
  assert.equal(controller.getEditorText(), "x");
  assert.match(output.text, /custom:x/u);

  generation.abort(new Error("extension refreshed"));
  input.write("y");
  await tick();
  assert.equal(controller.getEditorText(), "xy");

  const malformed = new AbortController();
  controller.setEditorRenderer({ render: () => ({ lines: [{ spans: [{ text: "no cursor" }] }] }) }, malformed.signal);
  controller.renderNow();
  await tick();
  assert.match(output.text, /Editor renderer failed/u);
  controller.close();
});

test("editor renderer failure notices redact credential-shaped exception text", async () => {
  const { output, controller } = fullController();
  const generation = new AbortController();
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  controller.start();
  controller.setEditorRenderer({
    render() {
      throw new Error(secret);
    },
  }, generation.signal);
  controller.renderNow();
  await tick();
  assert.match(output.text, /Editor renderer failed: \[REDACTED\]/u);
  assert.doesNotMatch(output.text, new RegExp(secret, "u"));
  controller.close();
});

test("extension shortcuts stop at their generation boundary", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  const generation = new AbortController();
  controller.start();
  controller.setExtensionShortcuts([{ shortcut: "alt+z", description: "fixture" }], generation.signal);
  input.write("\u001bz");
  await tick();
  assert.equal(actions[0]?.type, "extension_shortcut");
  if (actions[0]?.type === "extension_shortcut") assert.equal(actions[0].generation, generation.signal);
  generation.abort(new Error("runtime refreshed"));
  input.write("\u001bz");
  await tick();
  assert.equal(actions.length, 1);
  controller.close();
});

test("extension input and editor dialogs work in full and accessibility modes", async () => {
  const full = fullController();
  full.controller.start();
  full.controller.setEditorText("preserved draft");
  const edited = full.controller.editor("Edit value", "prefill");
  full.input.write("!\r");
  assert.equal(await edited, "prefill!");
  assert.equal(full.controller.getEditorText(), "preserved draft");
  full.controller.close();

  const input = new FakeInput();
  const output = new FakeOutput();
  const line = new TuiController({ input, output, mode: "line", environment: { TERM: "dumb" }, handleSignals: false });
  line.start();
  const value = line.requestInput("Fixture input", "optional");
  assert.match(output.text, /Fixture input \(optional\)/u);
  input.write("\r");
  assert.equal(await value, "");
  line.close();
});

test("session management commands have exact command-palette entries", async () => {
  for (const expected of ["/session", "/atlas"]) {
    const { input, controller } = fullController();
    controller.start();
    const answer = controller.question("you> ");
    input.write(`/${expected.slice(1)}\r`);
    assert.equal(await answer, expected);
    controller.close();
  }

  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/name release candidate\r");
  assert.equal(await answer, "/name release candidate");
  controller.close();
});

test("suspend, new, and Atlas application actions are independently remappable", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.setKeybindings(new Keybindings({
    "app.suspend": "alt+z",
    "app.session.new": "alt+n",
    "app.session.atlas": "alt+a",
  }));
  controller.start();
  input.write("\u001bz\u001bn\u001ba");
  await tick();
  assert.deepEqual(actions, [
    { type: "suspend" },
    { type: "submit", text: "/new" },
    { type: "submit", text: "/atlas" },
  ]);
  controller.close();
});

test("repeated Ctrl+O expands every completed tool while input is blocked", async () => {
  const { input, output, controller } = fullController();
  output.rows = 40;
  controller.start();
  for (const [offset, callId] of ["call-1", "call-2"].entries()) {
    const content = Array.from({ length: 12 }, (_, index) => `${callId}-line-${index + 1}`).join("\n");
    const sequence = offset * 3 + 1;
    controller.render(envelope({ type: "tool_requested", callId, name: "read", input: { path: `${callId}.txt` }, index: offset }, sequence));
    controller.render(envelope({
      type: "tool_completed",
      callId,
      name: "read",
      index: offset,
      isError: false,
      preview: content,
    }, sequence + 1));
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: `tool-message-${offset + 1}`,
        role: "tool",
        content: [{ type: "tool_result", callId, name: "read", content, isError: false }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, sequence + 2));
    await tick();
  }
  assert.equal(controller.getToolOutputExpanded(), false);
  output.chunks.length = 0;
  controller.setInputBlocked("Finishing tool output…", "busy");
  input.write(Buffer.from([15]));
  await tick();
  assert.equal(controller.getToolOutputExpanded(), true);
  assert.equal(output.text.split("call-1-line-12").length - 1, 1);
  assert.equal(output.text.split("call-2-line-12").length - 1, 1);
  assert.doesNotMatch(output.text, /more lines/u);
  output.chunks.length = 0;
  input.write(Buffer.from([15, 15]));
  await tick();
  assert.equal(controller.getToolOutputExpanded(), true);
  input.write(Buffer.from([15]));
  await tick();
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.setInputBlocked();
  controller.close();
});

test("Ctrl+O changes tool output without replacing an existing host status", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  await tick();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();
  controller.render(envelope({ type: "tool_requested", callId: "feedback-call", name: "read", input: {}, index: 0 }, 1));
  controller.render(envelope({
    type: "tool_completed",
    callId: "feedback-call",
    name: "read",
    index: 0,
    isError: false,
    preview: "feedback output",
  }, 2));
  await tick();
  flush();

  controller.setTransientStatus("existing host status");
  await tick();
  flush();
  input.write(Buffer.from([15]));
  await tick();
  flush();
  assert.equal(controller.getToolOutputExpanded(), true);
  assert.match(terminal.viewport().join("\n"), /existing host status/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /Tool output:/u);

  input.write(Buffer.from([15]));
  await tick();
  flush();
  assert.equal(controller.getToolOutputExpanded(), false);
  assert.match(terminal.viewport().join("\n"), /existing host status/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /Tool output:/u);
  controller.close();
});

test("Ctrl+O width and height rebuilds preserve scrollback identity and the editor", async () => {
  const { input, output, controller } = fullController();
  output.rows = 18;
  controller.start();
  await tick();

  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  const toolContent = [
    "chronology-visible-head",
    ...Array.from({ length: 9 }, (_, index) => `chronology-detail-${index + 1}`),
    "chronology-expanded-tail",
  ].join("\n");
  controller.replaceTranscript([
    envelope({
      type: "message_appended",
      message: {
        id: "chronology-user",
        role: "user",
        content: [{ type: "text", text: "inspect chronology" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1),
    envelope({
      type: "message_appended",
      message: {
        id: "chronology-tool-request",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "chronology-call",
          name: "read",
          arguments: { path: "chronology.txt" },
        }],
        stopReason: "tool_calls",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 2),
    envelope({
      type: "message_appended",
      message: {
        id: "chronology-tool-result",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "chronology-call",
          name: "read",
          content: toolContent,
          isError: false,
        }],
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    }, 3),
    envelope({
      type: "message_appended",
      message: {
        id: "chronology-final",
        role: "assistant",
        content: [{ type: "text", text: "chronology-final-answer" }],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    }, 4),
    envelope({ type: "assistant_completed", finishReason: "stop" }, 5),
  ], "main");
  await tick();
  controller.renderNow();
  flush();
  controller.setEditorText("resize-draft");
  await tick();
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();

  const visible = terminal.viewport().join("\n");
  assert.match(visible, /chronology-expanded-tail/u);
  assert.ok(
    visible.lastIndexOf("chronology-expanded-tail") < visible.lastIndexOf("chronology-final-answer"),
    visible,
  );
  assert.doesNotMatch(terminal.scrollback().join("\n"), /chronology-expanded-tail/u);
  assert.ok(occurrences(terminal.scrollback().join("\n"), "chronology-final-answer") <= 1);

  output.chunks.length = 0;
  renderedChunks = 0;
  terminal.resize(72, 18);
  output.resize(72, 18);
  await tick();
  controller.renderNow();
  flush();

  const resizedVisible = terminal.viewport().join("\n");
  assert.match(resizedVisible, /chronology-expanded-tail/u);
  assert.ok(
    resizedVisible.lastIndexOf("chronology-expanded-tail") < resizedVisible.lastIndexOf("chronology-final-answer"),
    resizedVisible,
  );
  assert.doesNotMatch(terminal.scrollback().join("\n"), /chronology-expanded-tail/u);
  assert.ok(occurrences(terminal.scrollback().join("\n"), "chronology-final-answer") <= 1);
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[3J", "u"));
  const cursorBeforeHeightChange = terminal.cursor();

  output.chunks.length = 0;
  renderedChunks = 0;
  terminal.resize(72, 20);
  output.resize(72, 20);
  await tick();
  controller.renderNow();
  flush();

  const grownBuffer = terminal.buffer().join("\n");
  assert.equal(controller.getToolOutputExpanded(), true);
  assert.equal(controller.getEditorText(), "resize-draft");
  assert.equal(terminal.cursor().column, cursorBeforeHeightChange.column);
  assert.match(grownBuffer, /chronology-expanded-tail/u);
  assert.equal(occurrences(grownBuffer, "chronology-final-answer"), 1, grownBuffer);

  terminal.resize(72, 12);
  output.resize(72, 12);
  await tick();
  controller.renderNow();
  flush();

  const shrunkBuffer = terminal.buffer().join("\n");
  assert.equal(controller.getToolOutputExpanded(), true);
  assert.equal(controller.getEditorText(), "resize-draft");
  assert.match(shrunkBuffer, /chronology-expanded-tail/u);
  assert.equal(occurrences(shrunkBuffer, "chronology-final-answer"), 1, shrunkBuffer);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const collapsedBuffer = terminal.buffer().join("\n");
  assert.doesNotMatch(collapsedBuffer, /chronology-expanded-tail/u);
  assert.equal(collapsedBuffer.match(/chronology-final-answer/gu)?.length, 1, collapsedBuffer);
  controller.close();
});

test("collapsing a large completed read keeps its bounded preview and final answer visible", async () => {
  const { input, output, controller } = fullController();
  output.rows = 16;
  controller.start();
  await tick();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.replaceTranscript([
    envelope({
      type: "message_appended",
      message: {
        id: "large-tool-request",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "large-tool-call",
          name: "read",
          arguments: { path: "large.txt" },
        }],
        stopReason: "tool_calls",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1),
    envelope({
      type: "message_appended",
      message: {
        id: "large-tool-result",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "large-tool-call",
          name: "read",
          content: [
            "large-completed-head",
            ...Array.from({ length: 30 }, (_, index) => `large-completed-detail-${index + 1}`),
            "large-completed-tail",
          ].join("\n"),
          isError: false,
        }],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 2),
    envelope({
      type: "message_appended",
      message: {
        id: "large-final-answer",
        role: "assistant",
        content: [{ type: "text", text: "large completed final answer" }],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    }, 3),
    envelope({ type: "assistant_completed", finishReason: "stop" }, 4),
    envelope({ type: "run_completed", finishReason: "stop" }, 5),
  ], "main");
  await tick();
  controller.renderNow();
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /large-completed-tail/u);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();

  const collapsed = terminal.viewport().join("\n");
  assert.match(terminalWords(collapsed), /read · done .*large\.txt/u);
  assert.match(collapsed, /large completed final answer/u);
  assert.match(collapsed, /large-completed-detail-2/u);
  assert.match(collapsed, /Ctrl\+O/u);
  assert.doesNotMatch(collapsed, /large-completed-(?:tail|detail-(?:[3-9]|1\d|2\d|30))/u);
  assert.doesNotMatch(terminal.scrollback().join("\n"), /large-completed-(?:head|tail|detail)/u);
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.close();
});

test("a completed run keeps explicit tool expansion until the user collapses it", async () => {
  const { input, output, controller } = fullController();
  output.rows = 18;
  controller.start();
  await tick();

  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  const toolContent = [
    "released-visible-head",
    ...Array.from({ length: 9 }, (_, index) => `released-detail-${index + 1}`),
    "released-expanded-tail",
  ].join("\n");
  controller.replaceTranscript([
    envelope({
      type: "message_appended",
      message: {
        id: "released-user",
        role: "user",
        content: [{ type: "text", text: "inspect release cleanup" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1),
    envelope({
      type: "message_appended",
      message: {
        id: "released-tool-request",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "released-call",
          name: "read",
          arguments: { path: "released.txt" },
        }],
        stopReason: "tool_calls",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 2),
    envelope({
      type: "message_appended",
      message: {
        id: "released-tool-result",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "released-call",
          name: "read",
          content: toolContent,
          isError: false,
        }],
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    }, 3),
    envelope({
      type: "message_appended",
      message: {
        id: "released-final",
        role: "assistant",
        content: [{ type: "text", text: "released-final-answer" }],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    }, 4),
    envelope({ type: "assistant_completed", finishReason: "stop" }, 5),
  ], "main");
  await tick();
  controller.renderNow();
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /released-expanded-tail/u);

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 6));
  await tick();
  controller.renderNow();
  flush();

  const completed = terminal.viewport().join("\n");
  const buffer = terminal.buffer().join("\n");
  assert.match(completed, /released-expanded-tail/u);
  assert.equal(buffer.match(/released-final-answer/gu)?.length, 1);
  assert.match(buffer, /released-expanded-tail/u);
  assert.equal(controller.getToolOutputExpanded(), true);
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /released-expanded-tail/u);
  controller.close();
});

test("Ctrl+O expands and later collapses existing compaction and branch summaries", async () => {
  const { input, output, controller } = fullController();
  output.rows = 24;
  controller.start();
  await tick();

  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.render(envelope({ type: "compaction_started", reason: "threshold" }, 1));
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "released-compaction-summary",
      role: "assistant",
      content: [{ type: "text", text: "released-compaction-expanded-body" }],
      purpose: "compaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["one", "two"],
    firstKeptMessageId: "two",
    tokensBefore: 48_000,
    fromExtension: false,
  }, 2));
  controller.render(envelope({
    type: "branch_summary_created",
    summary: {
      id: "released-branch-summary",
      role: "assistant",
      content: [{ type: "text", text: "released-branch-expanded-body" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    sourceBranch: "main",
    sourceEventIds: ["one"],
  }, 3));
  await tick();
  controller.renderNow();
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const afterToggle = terminal.viewport().join("\n");
  assert.match(afterToggle, /released-compaction-expanded-body/u);
  assert.match(afterToggle, /released-branch-expanded-body/u);
  assert.equal(controller.getToolOutputExpanded(), true);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const afterCollapse = terminal.viewport().join("\n");
  assert.doesNotMatch(afterCollapse, /released-(?:compaction|branch)-expanded-body/u);
  assert.equal(controller.getToolOutputExpanded(), false);

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 4));
  await tick();
  controller.renderNow();
  flush();

  const completed = terminal.viewport().join("\n");
  assert.doesNotMatch(completed, /released-(?:compaction|branch)-expanded-body/u);
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.close();
});

test("completed public reasoning remains above the final answer without duplication", async () => {
  const { output, controller } = fullController();
  output.rows = 14;
  controller.start();
  await tick();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({
    type: "reasoning_delta",
    part: 0,
    text: "reasoning before marker",
    visibility: "summary",
  }, 3));
  controller.render(envelope({ type: "text_delta", part: 0, text: "final answer marker" }, 4));
  await tick();
  controller.renderNow();
  flush();
  controller.render(envelope({
    type: "reasoning_delta",
    part: 1,
    text: "trailing reasoning marker",
    visibility: "summary",
  }, 5));
  await tick();
  controller.renderNow();
  flush();

  const live = terminal.buffer().join("\n");
  const liveTrailingIndex = live.lastIndexOf("trailing reasoning marker");
  const liveAnswerIndex = live.lastIndexOf("final answer marker");
  assert.ok(liveTrailingIndex >= 0 && liveTrailingIndex < liveAnswerIndex, live);
  assert.doesNotMatch(live.slice(liveAnswerIndex + "final answer marker".length), /trailing reasoning marker/u);

  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "reasoning-placement-message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning before marker", visibility: "summary" },
        { type: "text", text: "final answer marker" },
        { type: "thinking", thinking: "trailing reasoning marker", visibility: "summary" },
      ],
      stopReason: "stop",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 6));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 7));
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 8));
  await tick();
  controller.renderNow();
  flush();

  const buffer = terminal.buffer().join("\n");
  const answerIndex = buffer.indexOf("final answer marker");
  const thoughtIndex = buffer.indexOf("Thinking");
  assert.ok(thoughtIndex >= 0 && thoughtIndex < answerIndex, buffer);
  assert.equal(occurrences(buffer, "reasoning before marker"), 1);
  assert.equal(occurrences(buffer, "trailing reasoning marker"), 1);
  assert.equal(occurrences(buffer, "final answer marker"), 1);
  assert.doesNotMatch(
    buffer.slice(answerIndex + "final answer marker".length),
    /reasoning (?:before|marker)|trailing reasoning|final answer/u,
  );
  controller.close();
});

test("expanded live compaction remains visible across durable refresh until collapsed", async () => {
  const { input, output, controller } = fullController();
  output.rows = 12;
  controller.start();
  await tick();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "compaction_started", reason: "threshold" }, 2));
  const summaryBody = [
    "private compaction body head",
    ...Array.from({ length: 16 }, (_, index) => `private compaction detail ${index + 1}`),
    "private compaction body tail",
  ].join("\n");
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "live-compaction-message",
      role: "assistant",
      content: [{ type: "text", text: summaryBody }],
      purpose: "compaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["one", "two"],
    firstKeptMessageId: "two",
    tokensBefore: 87_583,
    fromExtension: false,
    usage: { inputTokens: 11_452, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_449 },
  }, 3));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /private compaction (?:body|detail)/u);

  controller.replaceTranscript([{
    type: "session_summary",
    id: "durable-compaction-entry",
    summaryType: "compaction",
    text: summaryBody,
    tokensBefore: 87_583,
    usage: { inputTokens: 11_452, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_449 },
  }], "main", { preserveExisting: true });
  controller.render(envelope({ type: "warning", code: "after-compact-refresh", message: "after compact refresh" }, 4));
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 5));
  await tick();
  controller.renderNow();
  flush();

  const buffer = terminal.buffer().join("\n");
  assert.match(buffer, /private compaction (?:body|detail)/u);
  assert.match(buffer, /after compact refresh/u);
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const collapsed = terminal.buffer().join("\n");
  assert.match(collapsed, /Context compacted/u);
  assert.doesNotMatch(collapsed, /private compaction (?:body|detail)/u);
  controller.close();
});

test("durable compact refresh renders a live summary that had not reached inline scrollback", async () => {
  const { output, controller } = fullController();
  controller.start();
  await tick();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "compaction_started", reason: "manual" }, 2));
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "unrendered-live-compaction-message",
      role: "assistant",
      content: [{ type: "text", text: "unrendered private compaction body" }],
      purpose: "compaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["one"],
    firstKeptMessageId: "one",
    tokensBefore: 50_000,
    fromExtension: false,
  }, 3));
  controller.replaceTranscript([{
    type: "session_summary",
    id: "unrendered-durable-compaction-entry",
    summaryType: "compaction",
    text: "unrendered private compaction body",
    tokensBefore: 50_000,
  }], "main", { preserveExisting: true });
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 4));
  await tick();
  controller.renderNow();
  flush();

  const buffer = terminal.buffer().join("\n");
  assert.equal(occurrences(buffer, "Context compacted"), 1);
  assert.doesNotMatch(buffer, /unrendered private compaction body/u);
  controller.close();
});

test("preserved compact refresh aliases the newest summary after model pruning", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    limits: { maxTranscriptEntries: 2 },
  });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const previous: TuiTranscriptItem[] = [{
    type: "session_summary",
    id: "old-1",
    summaryType: "compaction",
    text: "old body one",
    tokensBefore: 10,
  }, {
    type: "session_summary",
    id: "old-2",
    summaryType: "compaction",
    text: "old body two",
    tokensBefore: 20,
  }];

  controller.start();
  await tick();
  flush();
  controller.replaceTranscript(previous, "main");
  await tick();
  controller.renderNow();
  flush();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "test" }, 1));
  controller.render(envelope({ type: "compaction_started", reason: "manual" }, 2));
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "live-message",
      role: "assistant",
      content: [{ type: "text", text: "current hidden body" }],
      purpose: "compaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["one"],
    firstKeptMessageId: "one",
    tokensBefore: 100,
    fromExtension: false,
  }, 3));
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 4));
  await tick();
  controller.renderNow();
  flush();
  const before = occurrences(terminal.buffer().join("\n"), "Context compacted");
  assert.ok(before > 0);

  controller.replaceTranscript([...previous, {
    type: "session_summary",
    id: "current-durable",
    summaryType: "compaction",
    text: "current hidden body",
    tokensBefore: 100,
  }], "main", { preserveExisting: true });
  await tick();
  controller.renderNow();
  flush();

  const buffer = terminal.buffer().join("\n");
  assert.equal(occurrences(buffer, "Context compacted"), before);
  assert.doesNotMatch(buffer, /current hidden body/u);
  controller.close();
});

test("Ctrl+O keeps a new tool expanded after completion until explicitly collapsed", async () => {
  const { input, output, controller } = fullController();
  output.rows = 18;
  controller.start();
  await tick();

  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({
    type: "tool_requested",
    callId: "born-tool-call",
    name: "read",
    input: { path: "born-tool.txt" },
    index: 0,
  }, 2));
  controller.render(envelope({
    type: "tool_started",
    callId: "born-tool-call",
    name: "read",
    input: { path: "born-tool.txt" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 3));
  const toolContent = [
    "born-tool-head",
    ...Array.from({ length: 9 }, (_, index) => `born-tool-detail-${index + 1}`),
    "born-tool-expanded-tail",
  ].join("\n");
  controller.render(envelope({
    type: "tool_completed",
    callId: "born-tool-call",
    name: "read",
    index: 0,
    isError: false,
    preview: toolContent,
    result: {
      type: "tool_result",
      callId: "born-tool-call",
      name: "read",
      content: toolContent,
      isError: false,
    },
  }, 4));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "born-tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "born-tool-call",
        name: "read",
        content: toolContent,
        isError: false,
      }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 5));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "born-tool-final",
      role: "assistant",
      content: [{ type: "text", text: "born-tool-final-answer" }],
      stopReason: "stop",
      createdAt: "2026-01-01T00:00:02.000Z",
    },
  }, 6));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 7));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /born-tool-expanded-tail/u);

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 8));
  await tick();
  controller.renderNow();
  flush();

  const completed = terminal.viewport().join("\n");
  assert.match(completed, /born-tool-expanded-tail/u);
  assert.equal(controller.getToolOutputExpanded(), true);
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /born-tool-expanded-tail/u);
  controller.close();
});

test("compaction and branch summaries born while tool output is expanded follow the active expansion", async () => {
  const { input, output, controller } = fullController();
  output.rows = 24;
  controller.start();
  await tick();

  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "compaction_started", reason: "threshold" }, 2));
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "born-compaction-summary",
      role: "assistant",
      content: [{ type: "text", text: "born-compaction-expanded-body" }],
      purpose: "compaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["one", "two"],
    firstKeptMessageId: "two",
    tokensBefore: 48_000,
    fromExtension: false,
  }, 3));
  controller.render(envelope({
    type: "branch_summary_created",
    summary: {
      id: "born-branch-summary",
      role: "assistant",
      content: [{ type: "text", text: "born-branch-expanded-body" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    sourceBranch: "main",
    sourceEventIds: ["one"],
  }, 4));
  await tick();
  controller.renderNow();
  flush();
  const duringRun = terminal.viewport().join("\n");
  assert.match(duringRun, /born-compaction-expanded-body/u);
  assert.match(duringRun, /born-branch-expanded-body/u);

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 5));
  await tick();
  controller.renderNow();
  flush();

  const completed = terminal.viewport().join("\n");
  assert.match(completed, /born-compaction-expanded-body/u);
  assert.match(completed, /born-branch-expanded-body/u);
  assert.equal(controller.getToolOutputExpanded(), true);
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /born-(?:compaction|branch)-expanded-body/u);
  controller.close();
});

test("an extension entry born while tool output is expanded follows the temporary expansion", async () => {
  const { input, output, controller } = fullController();
  output.rows = 14;
  controller.start();
  const generation = new AbortController();
  controller.setSessionRenderers({
    renderEntry: (_entry, options) => textComponent(
      options.expanded ? "born-extension-expanded-body" : "born-extension-collapsed",
    ),
    renderMessage: () => undefined,
  }, generation.signal);
  await tick();

  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.renderSessionEntry({
    type: "custom",
    id: "born-extension-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "progress",
    data: { phase: "running" },
  });
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /born-extension-expanded-body/u);

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 2));
  await tick();
  controller.renderNow();
  flush();

  const completed = terminal.viewport().join("\n");
  assert.match(completed, /born-extension-expanded-body/u);
  assert.equal(controller.getToolOutputExpanded(), true);
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const collapsed = terminal.viewport().join("\n");
  assert.doesNotMatch(collapsed, /born-extension-expanded-body/u);
  assert.match(collapsed, /born-extension-collapsed/u);
  generation.abort();
  controller.close();
});

test("a new run collapses an idle expanded extension entry before inline commit", async () => {
  const { input, output, controller } = fullController();
  output.rows = 14;
  controller.start();
  const generation = new AbortController();
  controller.setSessionRenderers({
    renderEntry: () => undefined,
    renderMessage: (_message, options) => textComponent(
      options.expanded ? "idle-expanded-marker" : "idle-collapsed",
    ),
  }, generation.signal);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  input.write(Buffer.from([15]));
  await tick();
  controller.renderSessionEntry({
    type: "custom_message",
    id: "idle-expanded-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "fixture",
    content: "fallback",
    display: true,
  });
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /idle-expanded-marker/u);

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  await tick();
  controller.renderNow();
  flush();
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();

  assert.doesNotMatch(terminal.buffer().join("\n"), /idle-expanded-marker/u);
  assert.match(terminal.viewport().join("\n"), /idle-collapsed/u);
  generation.abort();
  controller.close();
});

test("Ctrl+X requests a copy of the latest assistant message", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  input.write(Buffer.from([24]));
  await tick();
  assert.deepEqual(actions, [{ type: "copy" }]);
  controller.close();
});

test("PageUp inspects retained transcript rows and keeps reasoning interactive", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.replaceTranscript([
    envelope({
      type: "message_appended",
      message: {
        id: "paged-reasoning-user",
        role: "user",
        content: [{ type: "text", text: "inspect reasoning history" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1),
    envelope({
      type: "message_appended",
      message: {
        id: "paged-reasoning-answer",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "paged reasoning body", visibility: "summary" },
          { type: "text", text: "paged reasoning answer" },
        ],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 2),
    envelope({ type: "run_completed", finishReason: "stop" }, 3),
  ], "main");
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "paged-reasoning-next-user",
      role: "user",
      content: [{ type: "text", text: "next question" }],
      createdAt: "2026-01-01T00:00:02.000Z",
    },
  }, 4));
  for (let index = 0; index < 30; index += 1) {
    controller.render(envelope({ type: "warning", code: `note-${index}`, message: `history-${index}` }, index + 5));
  }
  await tick();
  output.chunks.length = 0;
  for (let page = 0; page < 8 && !/Thinking/u.test(output.text); page += 1) {
    input.write("\u001b[5~");
    await tick();
  }
  assert.match(output.text, /history-[0-9]+/u);
  assert.match(output.text, /Thinking/u);
  assert.equal(controller.toggleReasoning(), true);
  output.chunks.length = 0;
  input.write("\u001b[1;5F");
  await tick();
  assert.doesNotMatch(output.text, /history-(?:[0-9]|1[0-9])\b/u);
  assert.match(output.text, /history-2[0-9]\b/u);
  controller.close();
});

test("fullscreen transcript stays scrolled while new output streams and resumes following at the bottom", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 40; index += 1) {
    controller.render(envelope({ type: "warning", code: `note-${index}`, message: `history-${index}` }, index + 1));
  }
  await tick();
  controller.renderNow();
  flush();

  input.write("\u001b[<64;10;5M".repeat(4));
  await tick();
  controller.renderNow();
  flush();
  const scrolled = terminal.viewport().join("\n");
  assert.doesNotMatch(scrolled, /history-39/u);
  const visibleHistory = [...scrolled.matchAll(/history-(\d+)/gu)].map((match) => match[1]);
  assert.ok(visibleHistory.length > 1);

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 41));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 42));
  for (let index = 0; index < 20; index += 1) {
    controller.render(envelope({
      type: "text_delta",
      text: `stream-tail-${index}\n`,
      part: 0,
    }, index + 43));
  }
  await tick();
  controller.renderNow();
  flush();
  const whileStreaming = terminal.viewport().join("\n");
  assert.doesNotMatch(whileStreaming, /stream-tail/u);
  assert.match(whileStreaming, new RegExp(`history-${visibleHistory[0]}\\b`, "u"));

  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /stream-tail-19/u);
  controller.close();
});

test("Ctrl+O preserves a scrolled transcript anchor and keeps follow-tail at the bottom", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 40; index += 1) {
    controller.render(envelope({ type: "warning", code: `toggle-note-${index}`, message: `toggle-history-${index}` }, index + 1));
  }
  const toolOutput = Array.from({ length: 30 }, (_, index) => `toggle-tool-row-${index + 1}`).join("\n");
  controller.render(envelope({
    type: "tool_requested",
    callId: "toggle-anchor-tool",
    name: "read",
    input: { path: "anchor.txt" },
    index: 0,
  }, 41));
  controller.render(envelope({
    type: "tool_completed",
    callId: "toggle-anchor-tool",
    name: "read",
    index: 0,
    isError: false,
    preview: toolOutput,
  }, 42));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "toggle-anchor-tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "toggle-anchor-tool",
        name: "read",
        content: toolOutput,
        isError: false,
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 43));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "toggle-anchor-final",
      role: "assistant",
      content: [{ type: "text", text: "toggle-anchor-final-answer" }],
      stopReason: "stop",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 44));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /toggle-anchor-final-answer/u);

  input.write("\u001b[<64;10;5M".repeat(10));
  await tick();
  controller.renderNow();
  flush();
  const beforeToggle = terminal.viewport().join("\n");
  const anchoredHistory = [...beforeToggle.matchAll(/toggle-history-(\d+)/gu)].map((match) => match[1]);
  assert.ok(anchoredHistory.length > 1);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const expandedWhileScrolled = terminal.viewport().join("\n");
  assert.deepEqual(
    [...expandedWhileScrolled.matchAll(/toggle-history-(\d+)/gu)].map((match) => match[1]),
    anchoredHistory,
  );
  assert.doesNotMatch(expandedWhileScrolled, /toggle-tool-row/u);

  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  const expandedTail = terminal.viewport().join("\n");
  assert.match(expandedTail, /toggle-tool-row-30/u);
  assert.match(expandedTail, /toggle-anchor-final-answer/u);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const collapsedTail = terminal.viewport().join("\n");
  assert.match(collapsedTail, /toggle-tool-row-3/u);
  assert.match(collapsedTail, /Ctrl\+O/u);
  assert.doesNotMatch(collapsedTail, /toggle-tool-row-(?:[4-9]|1\d|2\d|30)/u);
  assert.match(collapsedTail, /toggle-anchor-final-answer/u);
  controller.close();
});

test("fullscreen transcript can be scrolled after assistant and tool streaming has started", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 40; index += 1) {
    controller.render(envelope({ type: "warning", code: `active-note-${index}`, message: `active-history-${index}` }, index + 1));
  }
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 41));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 42));
  for (let index = 0; index < 8; index += 1) {
    controller.render(envelope({
      type: "reasoning_delta",
      text: `reasoning-stream-${index}\n`,
      part: 0,
      visibility: "summary",
    }, index + 43));
  }
  for (let index = 0; index < 12; index += 1) {
    controller.render(envelope({ type: "text_delta", text: `assistant-stream-${index}\n`, part: 0 }, index + 51));
  }
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /assistant-stream-11/u);

  input.write("\u001b[<64;10;5M".repeat(12));
  await tick();
  controller.renderNow();
  flush();
  const afterWheel = terminal.viewport().join("\n");
  assert.doesNotMatch(afterWheel, /assistant-stream-11/u);
  const anchoredHistory = [...afterWheel.matchAll(/active-history-(\d+)/gu)].map((match) => match[1]);
  assert.ok(anchoredHistory.length > 1);

  controller.render(envelope({
    type: "tool_requested",
    callId: "active-scroll-tool",
    name: "bash",
    input: { command: "printf live" },
    index: 0,
  }, 63));
  controller.render(envelope({
    type: "tool_started",
    callId: "active-scroll-tool",
    name: "bash",
    input: { command: "printf live" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 64));
  for (let index = 0; index < 12; index += 1) {
    controller.render(envelope({
      type: "tool_progress",
      callId: "active-scroll-tool",
      name: "bash",
      index: 0,
      sequence: index,
      progress: {
        type: "output",
        stream: "stdout",
        delta: `tool-stream-${index}\n`,
        stdoutBytes: (index + 1) * 15,
        stderrBytes: 0,
        elapsedMs: index + 1,
      },
    }, index + 65));
    await tick();
  }
  controller.renderNow();
  flush();
  const whileToolStreams = terminal.viewport().join("\n");
  assert.doesNotMatch(whileToolStreams, /tool-stream/u);
  assert.match(whileToolStreams, new RegExp(`active-history-${anchoredHistory[0]}\\b`, "u"));
  assert.deepEqual(
    [...whileToolStreams.matchAll(/active-history-(\d+)/gu)].map((match) => match[1]),
    anchoredHistory,
  );

  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /tool-stream-11/u);
  controller.render(envelope({
    type: "tool_progress",
    callId: "active-scroll-tool",
    name: "bash",
    index: 0,
    sequence: 12,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "tool-stream-follow-tail\n",
      stdoutBytes: 200,
      stderrBytes: 0,
      elapsedMs: 20,
    },
  }, 77));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /tool-stream-follow-tail/u);
  controller.close();
});

test("blocked input still permits transcript navigation during a live run", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 30; index += 1) {
    controller.render(envelope({ type: "warning", code: `blocked-note-${index}`, message: `blocked-history-${index}` }, index + 1));
  }
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 31));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 32));
  for (let index = 0; index < 12; index += 1) {
    controller.render(envelope({ type: "text_delta", text: `blocked-stream-${index}\n`, part: 0 }, index + 33));
  }
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /blocked-stream-11/u);

  controller.setInputBlocked("Working… Esc to cancel", "busy");
  input.write("\u001b[5~");
  await tick();
  controller.renderNow();
  flush();
  const paged = terminal.viewport().join("\n");
  assert.doesNotMatch(paged, /blocked-stream-11/u);
  const pagedRows = [...paged.matchAll(/blocked-(?:history|stream)-[^\s│]+/gu)].map((match) => match[0]);
  assert.ok(pagedRows.length > 1);

  controller.render(envelope({ type: "text_delta", text: "blocked-stream-new-tail\n", part: 0 }, 45));
  await tick();
  controller.renderNow();
  flush();
  const whileStreaming = terminal.viewport().join("\n");
  assert.deepEqual(
    [...whileStreaming.matchAll(/blocked-(?:history|stream)-[^\s│]+/gu)].map((match) => match[0]),
    pagedRows,
  );
  assert.doesNotMatch(whileStreaming, /blocked-stream-new-tail/u);

  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /blocked-stream-new-tail/u);
  controller.setInputBlocked();
  controller.close();
});

test("stream redraws yield to wheel input and coalesce a provider microtask burst", async () => {
  const { input, output, controller } = fullController();
  output.resize(96, 20);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 250; index += 1) {
    controller.render(envelope({ type: "warning", code: `burst-note-${index}`, message: `burst-history-${index}` }, index + 1));
  }
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 251));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 252));
  controller.render(envelope({
    type: "tool_requested",
    callId: "burst-tool",
    name: "bash",
    input: { command: "printf burst" },
    index: 0,
  }, 253));
  controller.render(envelope({
    type: "tool_started",
    callId: "burst-tool",
    name: "bash",
    input: { command: "printf burst" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 254));
  await tick();
  controller.renderNow();
  flush();
  output.chunks.length = 0;
  renderedChunks = 0;

  let writesBeforeWheel = -1;
  await new Promise<void>((resolve) => {
    let index = 0;
    const stream = (): void => {
      if (index < 10) {
        controller.render(envelope({
          type: "reasoning_delta",
          text: `burst-reasoning-${index}\n`,
          part: 0,
          visibility: "summary",
        }, 255 + index));
      } else if (index < 25) {
        controller.render(envelope({ type: "text_delta", text: `burst-answer-${index}\n`, part: 0 }, 255 + index));
      } else {
        controller.render(envelope({
          type: "tool_progress",
          callId: "burst-tool",
          name: "bash",
          index: 0,
          sequence: index - 25,
          progress: {
            type: "output",
            stream: "stdout",
            delta: `burst-tool-output-${index}\n`,
            stdoutBytes: (index - 24) * 24,
            stderrBytes: 0,
            elapsedMs: index,
          },
        }, 255 + index));
      }
      if (index === 15) {
        writesBeforeWheel = output.chunks.length;
        input.write("\u001b[<64;10;8M".repeat(12));
      }
      index += 1;
      if (index < 50) queueMicrotask(stream);
      else resolve();
    };
    queueMicrotask(stream);
  });
  await tick();
  controller.renderNow();
  flush();

  assert.equal(writesBeforeWheel, 0, "stream deltas must not redraw ahead of pending terminal input");
  const scrolled = terminal.viewport().join("\n");
  assert.match(scrolled, /burst-history-\d+/u);
  assert.doesNotMatch(scrolled, /burst-tool-output/u);
  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /burst-answer-24/u);
  assert.match(terminal.viewport().join("\n"), /Running bash/u);
  controller.close();
});

test("active tool animation does not promote a deferred redraw ahead of wheel input", async () => {
  const { input, output, controller } = fullController();
  output.resize(80, 20);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const indicator = new AbortController();
  controller.setWorkingIndicator({ frames: [".", "o"], intervalMs: 50 }, indicator.signal);
  try {
    controller.start();
    input.write("\u001b[?1;2c");
    await tick();
    for (let index = 0; index < 80; index += 1) {
      controller.render(envelope({
        type: "warning",
        code: `timer-overlap-${index}`,
        message: `timer-overlap-history-${index}`,
      }, index + 1));
    }
    controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 81));
    controller.render(envelope({ type: "assistant_started", step: 1 }, 82));
    controller.render(envelope({
      type: "tool_requested",
      callId: "timer-overlap-tool",
      name: "bash",
      input: { command: "long-running-command" },
      index: 0,
    }, 83));
    controller.render(envelope({
      type: "tool_started",
      callId: "timer-overlap-tool",
      name: "bash",
      input: { command: "long-running-command" },
      index: 0,
      recoveryMode: "never_repeat",
    }, 84));
    await tick();
    controller.renderNow();
    flush();

    const baselineChunks = output.chunks.length;
    let writesBeforeWheel = -1;
    const wheel = new Promise<void>((resolve) => {
      setImmediate(() => {
        writesBeforeWheel = output.chunks.length - baselineChunks;
        input.write("\u001b[<64;10;8M".repeat(12));
        resolve();
      });
    });
    controller.render(envelope({
      type: "tool_progress",
      callId: "timer-overlap-tool",
      name: "bash",
      index: 0,
      sequence: 0,
      progress: {
        type: "output",
        stream: "stdout",
        delta: "timer-overlap-live-tail\n",
        stdoutBytes: 24,
        stderrBytes: 0,
        elapsedMs: 50,
      },
    }, 85));
    const activityDeadline = performance.now() + 80;
    while (performance.now() < activityDeadline) {
      // Keep both immediates pending until the active-tool timer becomes due.
    }
    await wheel;
    await tick();
    controller.renderNow();
    flush();

    assert.equal(writesBeforeWheel, 0, "active-tool animation must not redraw ahead of pending terminal input");
    assert.match(terminal.viewport().join("\n"), /timer-overlap-history-\d+/u);
    assert.doesNotMatch(terminal.viewport().join("\n"), /timer-overlap-live-tail/u);
  } finally {
    indicator.abort(new Error("test complete"));
    controller.close();
  }
});

test("dense live edit arguments do not starve the rich viewport input loop", async () => {
  const { input, output, controller } = fullController();
  output.resize(72, 16);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const renderer = new AbortController();
  const expandedStates: boolean[] = [];
  controller.setToolRenderers({
    has: (name) => name === "edit",
    renderCall: (_name, view) => {
      expandedStates.push(view.expanded);
      return undefined;
    },
    renderResult: () => undefined,
  }, renderer.signal);
  controller.start();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "edit" }, 3));
  controller.setInputBlocked("Generating response · Esc to cancel", "busy");

  const rawArguments = JSON.stringify({
    path: "src/live-edit.ts",
    edits: Array.from({ length: 250 }, (_, index) => ({
      oldText: `old-${index}-${"x".repeat(192)}`,
      newText: `new-${index}-${"y".repeat(192)}`,
    })),
  });
  let sequence = 4;
  const startedAt = performance.now();
  for (let offset = 0; offset < rawArguments.length; offset += 32) {
    controller.render(envelope({
      type: "tool_call_delta",
      index: 0,
      jsonFragment: rawArguments.slice(offset, offset + 32),
    }, sequence));
    sequence += 1;
  }
  const enqueueMs = performance.now() - startedAt;
  assert.ok(enqueueMs < 500, `live edit delta ingestion blocked for ${enqueueMs.toFixed(1)} ms`);

  await tick();
  controller.renderNow();
  flush();
  const live = terminal.viewport().join("\n");
  assert.match(
    terminalWords(live),
    /edit · receiving input .*src\/live-edit\.ts · receiving [\d,]+ argument bytes/u,
  );
  assert.equal(occurrences(live, "src/live-edit.ts"), 1);
  assert.doesNotMatch(live, /old-0|new-249/u);
  assert.doesNotMatch(live, /"(?:path|edits|oldText|newText)"\s*:/u);

  expandedStates.length = 0;
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.equal(expandedStates.at(-1), true);
  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  assert.equal(expandedStates.at(-1), false);

  renderer.abort();
  controller.close();
});

test("the first valid extension argument delta reaches a self-owned live renderer", () => {
  const { output, controller } = fullController();
  const generation = new AbortController();
  let observed: Parameters<RuntimeToolRendererBinding["renderCall"]>[1] | undefined;
  controller.setToolRenderers({
    has: (name) => name === "custom_live",
    renderShell: () => "self",
    renderCall: (_name, view) => {
      observed = view;
      const query = isRecordValue(view.input) && isStringValue(view.input.query)
        ? view.input.query
        : "missing";
      return { lines: [{ spans: [{ text: `SELF ${query}` }] }] };
    },
    renderResult: () => undefined,
  }, generation.signal);
  controller.start();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "custom_live" }, 3));
  output.chunks.length = 0;
  controller.render(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: "{\"query\":\"first-delta\"}",
  }, 4));
  controller.renderNow();

  assert.deepEqual(observed?.input, { query: "first-delta" });
  assert.equal(observed?.argsComplete, false);
  assert.equal(observed?.status, "pending");
  assert.match(stripAnsi(output.text), /SELF first-delta/u);
  assert.doesNotMatch(stripAnsi(output.text), /\{"query":"first-delta"\}/u);
  generation.abort();
  controller.close();
});

test("dense tool progress preserves stream order, stale-sequence filtering, and latest partial results", async () => {
  const { controller } = fullController();
  const renderer = new AbortController();
  let observedProgress: { output?: string; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number } | undefined;
  let observedPartial: string | undefined;
  controller.setToolRenderers({
    has: (name) => name === "bash",
    renderCall: (_name, view) => {
      observedProgress = view.progress;
      return undefined;
    },
    renderResult: (_name, view) => {
      if (view.isPartial === true) observedPartial = view.result?.content;
      return undefined;
    },
  }, renderer.signal);
  controller.start();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({
    type: "tool_requested",
    callId: "dense-progress",
    name: "bash",
    input: { command: "printf progress" },
    index: 0,
  }, 2));
  controller.render(envelope({
    type: "tool_started",
    callId: "dense-progress",
    name: "bash",
    input: { command: "printf progress" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 3));
  const progress = (
    sequence: number,
    stream: "stdout" | "stderr",
    delta: string,
    stdoutBytes: number,
    stderrBytes: number,
  ): void => controller.render(envelope({
    type: "tool_progress",
    callId: "dense-progress",
    name: "bash",
    index: 0,
    sequence,
    progress: { type: "output", stream, delta, stdoutBytes, stderrBytes, elapsedMs: sequence },
  }, sequence + 10));

  progress(10, "stdout", "TEN", 3, 0);
  controller.renderNow();
  assert.equal(observedProgress?.output, "TEN");
  progress(9, "stdout", "STALE", 8, 0);
  progress(11, "stdout", "ELEVEN", 9, 0);
  progress(12, "stderr", "ERR", 9, 3);
  progress(13, "stdout", "THIRTEEN", 17, 3);
  controller.renderNow();
  assert.deepEqual(observedProgress, {
    output: "TENELEVENERRTHIRTEEN",
    stdout: "TENELEVENTHIRTEEN",
    stderr: "ERR",
    stdoutBytes: 17,
    stderrBytes: 3,
    elapsedMs: 13,
    truncated: false,
  });

  controller.render(envelope({
    type: "tool_progress",
    callId: "dense-progress",
    name: "bash",
    index: 0,
    sequence: 14,
    progress: { type: "result", content: "older partial", isError: false },
  }, 24));
  controller.render(envelope({
    type: "tool_progress",
    callId: "dense-progress",
    name: "bash",
    index: 0,
    sequence: 15,
    progress: { type: "result", content: "latest partial", isError: false },
  }, 25));
  controller.renderNow();
  assert.equal(observedPartial, "latest partial");

  controller.render(envelope({
    type: "tool_completed",
    callId: "dense-progress",
    name: "bash",
    index: 0,
    isError: false,
    preview: "done",
  }, 26));
  controller.render(envelope({
    type: "tool_requested",
    callId: "dense-progress",
    name: "bash",
    input: { command: "printf reused" },
    index: 1,
  }, 27));
  controller.render(envelope({
    type: "tool_started",
    callId: "dense-progress",
    name: "bash",
    input: { command: "printf reused" },
    index: 1,
    recoveryMode: "never_repeat",
  }, 28));
  const delta = "0123456789abcdefghijklmnopqrstuv";
  const startedAt = performance.now();
  for (let sequence = 0; sequence < 1_024; sequence += 1) {
    controller.render(envelope({
      type: "tool_progress",
      callId: "dense-progress",
      name: "bash",
      index: 1,
      sequence,
      progress: {
        type: "output",
        stream: "stdout",
        delta,
        stdoutBytes: (sequence + 1) * Buffer.byteLength(delta, "utf8"),
        stderrBytes: 0,
      },
    }, sequence + 29));
  }
  const enqueueMs = performance.now() - startedAt;
  assert.ok(enqueueMs < 200, `live progress ingestion blocked for ${enqueueMs.toFixed(1)} ms`);
  controller.renderNow();
  assert.equal(observedProgress?.stdoutBytes, 32 * 1_024);
  assert.match(observedProgress?.output ?? "", /0123456789abcdefghijklmnopqrstuv$/u);

  renderer.abort();
  controller.close();
});

test("round-robin tool streams coalesce by active call instead of event adjacency", () => {
  const toolNames = ["bash", "read", "write", "edit", "grep", "find", "ls", "custom_tool"];
  const argumentController = fullController().controller;
  argumentController.start();
  let envelopeSequence = 1;
  const argumentsByIndex = toolNames.map((name, index) => JSON.stringify({
    path: `src/live-${index}.ts`,
    payload: `${name}-${"x".repeat(32_000)}`,
  }).padEnd(32 * 1_024, " "));
  for (const [index, name] of toolNames.entries()) {
    argumentController.render(envelope({ type: "tool_call_started", index, name }, envelopeSequence));
    envelopeSequence += 1;
  }
  const argumentStartedAt = performance.now();
  for (let fragment = 0; fragment < 1_024; fragment += 1) {
    for (let index = 0; index < toolNames.length; index += 1) {
      argumentController.render(envelope({
        type: "tool_call_delta",
        index,
        jsonFragment: argumentsByIndex[index]!.slice(fragment * 32, (fragment + 1) * 32),
      }, envelopeSequence));
      envelopeSequence += 1;
    }
  }
  const argumentEnqueueMs = performance.now() - argumentStartedAt;
  assert.ok(argumentEnqueueMs < 200, `interleaved tool arguments blocked for ${argumentEnqueueMs.toFixed(1)} ms`);
  argumentController.renderNow();
  argumentController.close();

  const progressController = fullController().controller;
  const renderer = new AbortController();
  const observed = new Map<string, {
    output?: string;
    stdout: string;
    stderr: string;
    stdoutBytes: number;
    stderrBytes: number;
    elapsedMs?: number;
    truncated: boolean;
  }>();
  progressController.setToolRenderers({
    has: () => true,
    renderCall: (_name, view) => {
      if (view.progress !== undefined) observed.set(view.callId, { ...view.progress });
      return undefined;
    },
    renderResult: () => undefined,
  }, renderer.signal);
  progressController.start();
  envelopeSequence = 1;
  for (const [index, name] of toolNames.entries()) {
    const callId = `round-robin-${index}`;
    progressController.render(envelope({
      type: "tool_requested",
      callId,
      name,
      input: { path: `src/live-${index}.ts` },
      index,
    }, envelopeSequence));
    envelopeSequence += 1;
    progressController.render(envelope({
      type: "tool_started",
      callId,
      name,
      input: { path: `src/live-${index}.ts` },
      index,
      recoveryMode: "never_repeat",
    }, envelopeSequence));
    envelopeSequence += 1;
  }
  const expectedOutput = toolNames.map<string[]>(() => []);
  const expectedStdout = toolNames.map<string[]>(() => []);
  const expectedStderr = toolNames.map<string[]>(() => []);
  const progressStartedAt = performance.now();
  for (let sequence = 0; sequence < 1_024; sequence += 1) {
    for (let index = 0; index < toolNames.length; index += 1) {
      const stream = sequence % 2 === 0 ? "stdout" : "stderr";
      const delta = `${index}:${sequence.toString().padStart(4, "0")}`.padEnd(32, stream === "stdout" ? "o" : "e");
      expectedOutput[index]!.push(delta);
      (stream === "stdout" ? expectedStdout : expectedStderr)[index]!.push(delta);
      progressController.render(envelope({
        type: "tool_progress",
        callId: `round-robin-${index}`,
        name: toolNames[index]!,
        index,
        sequence,
        progress: {
          type: "output",
          stream,
          delta,
          stdoutBytes: Math.ceil((sequence + 1) / 2) * 32,
          stderrBytes: Math.floor((sequence + 1) / 2) * 32,
          elapsedMs: sequence,
        },
      }, envelopeSequence));
      envelopeSequence += 1;
    }
  }
  const progressEnqueueMs = performance.now() - progressStartedAt;
  assert.ok(progressEnqueueMs < 200, `interleaved tool progress blocked for ${progressEnqueueMs.toFixed(1)} ms`);
  progressController.renderNow();
  for (let index = 0; index < toolNames.length; index += 1) {
    assert.deepEqual(observed.get(`round-robin-${index}`), {
      output: expectedOutput[index]!.join(""),
      stdout: expectedStdout[index]!.join(""),
      stderr: expectedStderr[index]!.join(""),
      stdoutBytes: 16_384,
      stderrBytes: 16_384,
      elapsedMs: 1_023,
      truncated: false,
    });
  }
  renderer.abort();
  progressController.close();
});

test("every built-in tool keeps wheel, PageUp, scrollbar drag, and interrupt input live through its lifecycle", async () => {
  const tools = [
    { name: "read", input: { path: "src/read.ts", offset: 1, limit: 2_000 } },
    { name: "bash", input: { command: "printf '%s\\n' live" } },
    {
      name: "edit",
      input: {
        path: "src/edit.ts",
        oldText: Array.from({ length: 1_500 }, (_, index) => `old-${index}-${"x".repeat(48)}`).join("\n"),
        newText: Array.from({ length: 1_500 }, (_, index) => `new-${index}-${"y".repeat(48)}`).join("\n"),
      },
    },
    {
      name: "write",
      input: {
        path: "src/write.ts",
        content: Array.from({ length: 3_000 }, (_, index) => `write-${index}-${"z".repeat(48)}`).join("\n"),
      },
    },
    { name: "grep", input: { pattern: "needle", path: "src", limit: 2_000 } },
    { name: "find", input: { pattern: "*.ts", path: "src", limit: 2_000 } },
    { name: "ls", input: { path: "src", limit: 2_000 } },
  ] as const;

  for (const tool of tools) {
    const { input, output, controller } = fullController({ doubleEscapeAction: "none" });
    output.resize(72, 16);
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    let renderedChunks = 0;
    let sequence = 1;
    const frameLatencies: number[] = [];
    const flush = (): void => {
      for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
      renderedChunks = output.chunks.length;
    };
    const projectControllerFrame = (): void => {
      const startedAt = performance.now();
      controller.renderNow();
      frameLatencies.push(performance.now() - startedAt);
      flush();
    };
    const atTail = async (): Promise<void> => {
      input.write("\u001b[1;5F");
      await tick();
      projectControllerFrame();
    };
    const expectHistory = (phase: string): void => {
      assert.match(
        terminal.viewport().join("\n"),
        new RegExp(`matrix-${tool.name}-history-\\d+`, "u"),
        `${tool.name} ${phase} navigation did not leave the live tail`,
      );
    };
    const exerciseNavigation = async (phase: string): Promise<void> => {
      await atTail();
      input.write("\u001b[<64;10;6M".repeat(16));
      await tick();
      projectControllerFrame();
      expectHistory(`${phase} wheel`);

      await atTail();
      const beforePageUp = terminal.viewport().join("\n");
      input.write("\u001b[5~");
      await tick();
      projectControllerFrame();
      const afterPageUp = terminal.viewport().join("\n");
      assert.notEqual(afterPageUp, beforePageUp, `${tool.name} ${phase} PageUp left the viewport stuck`);
      assert.match(
        afterPageUp,
        new RegExp(`matrix-${tool.name}-history-\\d+`, "u"),
        `${tool.name} ${phase} PageUp did not expose retained history`,
      );
      input.write("\u001b[5~".repeat(8));
      await tick();
      projectControllerFrame();
      expectHistory(`${phase} repeated PageUp`);

      await atTail();
      const thumbRow = terminal.viewport().findIndex((line) => line.endsWith("█"));
      assert.ok(thumbRow >= 0, `${tool.name} ${phase} did not expose its transcript scrollbar`);
      input.write(`\u001b[<0;${output.columns};${thumbRow + 1}M`);
      input.write(`\u001b[<32;${output.columns};1M`);
      input.write(`\u001b[<0;${output.columns};1m`);
      await tick();
      projectControllerFrame();
      assert.match(
        terminal.viewport().join("\n"),
        new RegExp(`matrix-${tool.name}-history-(?:0|1)\\b`, "u"),
        `${tool.name} ${phase} scrollbar drag did not reach the retained transcript head`,
      );
    };

    try {
      controller.setOperatorPreferences({ fullscreenScrollbar: "always" });
      controller.start();
      for (let index = 0; index < 90; index += 1) {
        controller.render(envelope({
          type: "warning",
          code: `matrix-${tool.name}-${index}`,
          message: `matrix-${tool.name}-history-${index}`,
        }, sequence));
        sequence += 1;
      }
      await tick();
      controller.renderNow();
      flush();
      controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, sequence));
      sequence += 1;
      controller.render(envelope({ type: "assistant_started", step: 1 }, sequence));
      sequence += 1;
      controller.render(envelope({ type: "tool_call_started", index: 0, name: tool.name }, sequence));
      sequence += 1;

      const rawArguments = JSON.stringify(tool.input);
      let inputDelayMs = -1;
      let inputBlockingCpuMs = -1;
      const inputBlockingCpuStarted = process.cpuUsage();
      const inputPriority = new Promise<void>((resolve) => {
        const startedAt = performance.now();
        setImmediate(() => {
          inputDelayMs = performance.now() - startedAt;
          const usage = process.cpuUsage(inputBlockingCpuStarted);
          inputBlockingCpuMs = (usage.user + usage.system) / 1_000;
          input.write("\u001b[<64;10;6M".repeat(16));
          resolve();
        });
      });
      for (let offset = 0; offset < rawArguments.length; offset += 128) {
        controller.render(envelope({
          type: "tool_call_delta",
          index: 0,
          jsonFragment: rawArguments.slice(offset, offset + 128),
        }, sequence));
        sequence += 1;
      }
      await inputPriority;
      await tick();
      projectControllerFrame();
      assert.ok(
        inputBlockingCpuMs < 100,
        `${tool.name} argument streaming occupied JavaScript for ${inputBlockingCpuMs.toFixed(1)} ms (${inputDelayMs.toFixed(1)} ms wall)`,
      );
      expectHistory("argument streaming wheel");

      controller.render(envelope({
        type: "tool_call_completed",
        index: 0,
        id: `matrix-${tool.name}`,
        name: tool.name,
        rawArguments,
        arguments: tool.input,
      }, sequence));
      sequence += 1;
      controller.render(envelope({
        type: "tool_requested",
        callId: `matrix-${tool.name}`,
        name: tool.name,
        input: tool.input,
        index: 0,
      }, sequence));
      sequence += 1;
      await exerciseNavigation("requested");

      controller.render(envelope({
        type: "tool_started",
        callId: `matrix-${tool.name}`,
        name: tool.name,
        input: tool.input,
        index: 0,
        recoveryMode: "never_repeat",
      }, sequence));
      sequence += 1;
      await exerciseNavigation("started");

      controller.render(envelope({
        type: "tool_progress",
        callId: `matrix-${tool.name}`,
        name: tool.name,
        index: 0,
        sequence: 0,
        progress: {
          type: "output",
          stream: "stdout",
          delta: Array.from({ length: 300 }, (_, index) => `matrix-${tool.name}-progress-${index}`).join("\n"),
          stdoutBytes: 8_192,
          stderrBytes: 0,
          elapsedMs: 250,
        },
      }, sequence));
      sequence += 1;
      await exerciseNavigation("progress");

      let interrupts = 0;
      controller.setInterruptHandler(() => { interrupts += 1; });
      input.write("\u001b");
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      await tick();
      assert.equal(interrupts, 1, `${tool.name} active execution did not prioritize Escape`);

      controller.render(envelope({
        type: "tool_completed",
        callId: `matrix-${tool.name}`,
        name: tool.name,
        index: 0,
        isError: false,
        preview: `matrix-${tool.name}-settled`,
        result: {
          type: "tool_result",
          callId: `matrix-${tool.name}`,
          name: tool.name,
          content: `matrix-${tool.name}-settled`,
          isError: false,
        },
      }, sequence));
      await exerciseNavigation("settled");
      input.write("\u001b");
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      await tick();
      assert.equal(interrupts, 2, `${tool.name} settled transcript did not prioritize Escape`);

      const slowestFrame = Math.max(...frameLatencies);
      assert.ok(slowestFrame < 100, `${tool.name} slowest lifecycle frame took ${slowestFrame.toFixed(1)} ms`);
    } finally {
      controller.close();
    }
  }
});

test("successive streaming I/O turns pace redraws without delaying transcript input", async () => {
  const { input, output, controller } = fullController({ doubleEscapeAction: "none" });
  output.resize(72, 16);
  controller.setOperatorPreferences({ showTerminalProgress: false, fullscreenScrollbar: "always" });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  let sequence = 1;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 90; index += 1) {
    controller.render(envelope({
      type: "warning",
      code: `paced-${index}`,
      message: `paced-history-${index}`,
    }, sequence));
    sequence += 1;
  }
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, sequence));
  sequence += 1;
  controller.render(envelope({ type: "assistant_started", step: 1 }, sequence));
  sequence += 1;
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "write" }, sequence));
  sequence += 1;
  controller.render(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: "{\"path\":\"src/paced.ts\",\"content\":\"",
  }, sequence));
  sequence += 1;
  await tick();
  controller.renderNow();
  flush();
  output.chunks.length = 0;
  renderedChunks = 0;

  let delivered = 0;
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const deliver = (): void => {
      const selected = delivered % 3;
      controller.render(envelope(selected === 0
        ? { type: "tool_call_delta", index: 0, jsonFragment: "x".repeat(256) }
        : selected === 1
          ? { type: "text_delta", text: "t", part: 0 }
          : { type: "reasoning_delta", text: "r", part: 0, visibility: "summary" }, sequence));
      sequence += 1;
      delivered += 1;
      if (performance.now() - startedAt < 220) setImmediate(deliver);
      else resolve();
    };
    setImmediate(deliver);
  });
  await tick();
  const elapsedMs = performance.now() - startedAt;
  const redraws = output.chunks.length;
  assert.ok(delivered > 20, `provider delivered only ${delivered} successive I/O turns`);
  assert.ok(
    redraws <= Math.ceil(elapsedMs / 16) + 3,
    `${delivered} successive I/O turns produced ${redraws} redraws in ${elapsedMs.toFixed(1)} ms`,
  );
  flush();

  const streamDelta = (): void => {
    controller.render(envelope({
      type: "tool_call_delta",
      index: 0,
      jsonFragment: "y".repeat(256),
    }, sequence));
    sequence += 1;
  };
  const atTail = async (): Promise<void> => {
    input.write("\u001b[1;5F");
    await tick();
    controller.renderNow();
    flush();
  };

  await atTail();
  streamDelta();
  const beforeWheel = output.chunks.length;
  input.write("\u001b[<64;10;6M".repeat(16));
  await tick();
  flush();
  assert.ok(output.chunks.length > beforeWheel, "wheel input did not promote the pending stream frame");
  assert.match(terminal.viewport().join("\n"), /paced-history-\d+/u);

  await atTail();
  streamDelta();
  const beforePageUp = output.chunks.length;
  input.write("\u001b[5~");
  await tick();
  flush();
  assert.ok(output.chunks.length > beforePageUp, "PageUp did not promote the pending stream frame");
  assert.match(terminal.viewport().join("\n"), /paced-history-\d+/u);

  await atTail();
  const thumbRow = terminal.viewport().findIndex((line) => line.endsWith("█"));
  assert.ok(thumbRow >= 0);
  streamDelta();
  const beforeDrag = output.chunks.length;
  input.write(`\u001b[<0;${output.columns};${thumbRow + 1}M`);
  input.write(`\u001b[<32;${output.columns};1M`);
  input.write(`\u001b[<0;${output.columns};1m`);
  await tick();
  flush();
  assert.ok(output.chunks.length > beforeDrag, "scrollbar drag did not promote the pending stream frame");
  assert.match(terminal.viewport().join("\n"), /paced-history-(?:0|1)\b/u);

  let interrupts = 0;
  controller.setInterruptHandler(() => { interrupts += 1; });
  streamDelta();
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  await tick();
  assert.equal(interrupts, 1, "Escape did not cancel while a paced stream frame was pending");
  controller.close();
});

test("streaming cadence is anchored to frame start instead of adding projection time", async () => {
  const frameStarts: number[] = [];
  const fixtureProjector = createFixtureFrameProjector();
  const slowProjector: TuiFrameProjector = (request) => {
    frameStarts.push(performance.now());
    const finishAt = performance.now() + 8;
    while (performance.now() < finishAt) {
      // Deliberately model a non-trivial rich projection cost.
    }
    return fixtureProjector(request);
  };
  const { controller } = fullController({ frameProjector: slowProjector });
  controller.start();
  frameStarts.length = 0;
  let sequence = 1;
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, sequence++));
  controller.render(envelope({ type: "assistant_started", step: 1 }, sequence++));

  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const deliver = (): void => {
      controller.render(envelope({ type: "text_delta", text: "x", part: 0 }, sequence++));
      if (performance.now() - startedAt < 180) setImmediate(deliver);
      else resolve();
    };
    setImmediate(deliver);
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.close();

  const intervals = frameStarts.slice(1).map((value, index) => value - frameStarts[index]!);
  assert.ok(intervals.length >= 5, `only observed ${intervals.length + 1} streamed frames`);
  const ordered = [...intervals].sort((left, right) => left - right);
  const median = ordered[Math.floor(ordered.length / 2)]!;
  assert.ok(median < 21, `median frame-start interval was ${median.toFixed(1)} ms`);
  assert.ok(median >= 13, `streaming cadence was effectively uncapped at ${median.toFixed(1)} ms`);
});

test("fullscreen scrollbar drag remains interactive while the assistant stream grows", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.setOperatorPreferences({ fullscreenScrollbar: "always" });
  controller.start();
  for (let index = 0; index < 40; index += 1) {
    controller.render(envelope({ type: "warning", code: `live-drag-${index}`, message: `live-drag-history-${index}` }, index + 1));
  }
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 41));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 42));
  for (let index = 0; index < 8; index += 1) {
    controller.render(envelope({ type: "text_delta", text: `live-drag-stream-${index}\n`, part: 0 }, index + 43));
  }
  await tick();
  controller.renderNow();
  flush();
  const thumbRow = terminal.viewport().findIndex((line) => line.endsWith("█"));
  assert.ok(thumbRow >= 0);

  input.write(`\u001b[<0;${output.columns};${thumbRow + 1}M`);
  for (let index = 8; index < 16; index += 1) {
    controller.render(envelope({ type: "text_delta", text: `live-drag-stream-${index}\n`, part: 0 }, index + 43));
    await tick();
    controller.renderNow();
    flush();
  }
  input.write(`\u001b[<32;${output.columns};1M`);
  input.write(`\u001b[<0;${output.columns};1m`);
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /live-drag-history-0/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /live-drag-stream-15/u);

  controller.render(envelope({ type: "text_delta", text: "live-drag-stream-anchored\n", part: 0 }, 60));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /live-drag-history-0/u);
  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /live-drag-stream-anchored/u);
  controller.close();
});

test("fullscreen scrollbar drag targets the retained transcript", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.setOperatorPreferences({ fullscreenScrollbar: "always" });
  controller.start();
  for (let index = 0; index < 40; index += 1) {
    controller.render(envelope({ type: "warning", code: `drag-${index}`, message: `drag-history-${index}` }, index + 1));
  }
  await tick();
  controller.renderNow();
  flush();
  const thumbRow = terminal.viewport().findIndex((line) => line.endsWith("█"));
  assert.ok(thumbRow >= 0);

  input.write(`\u001b[<0;${output.columns};${thumbRow + 1}M`);
  input.write(`\u001b[<32;${output.columns};1M`);
  input.write(`\u001b[<0;${output.columns};1m`);
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /drag-history-0/u);
  controller.close();
});

test("fullscreen edge selection keeps scrolling until focus loss cancels it", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 40; index += 1) {
    controller.render(envelope({ type: "warning", code: `select-${index}`, message: `select-history-${index}` }, index + 1));
  }
  await tick();
  controller.renderNow();
  flush();
  const selectedRow = terminal.viewport().findIndex((line) => line.includes("select-history"));
  assert.ok(selectedRow > 0);

  input.write(`\u001b[<0;2;${selectedRow + 1}M`);
  input.write("\u001b[<32;2;1M");
  await new Promise<void>((resolve) => setTimeout(resolve, 180));
  input.write("\u001b[O");
  await tick();
  controller.renderNow();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /select-history-39/u);

  const cancelled = terminal.viewport().join("\n");
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
  controller.renderNow();
  flush();
  assert.equal(terminal.viewport().join("\n"), cancelled);
  controller.close();
});

test("rich viewport Ctrl+Home, Ctrl+End, and marked-message keys navigate the retained transcript", async () => {
  const { input, output, controller } = fullController();
  output.resize(56, 12);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  for (let index = 0; index < 12; index += 1) {
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: `user-${index}`,
        role: "user",
        content: [{ type: "text", text: `user marker ${index} with enough text to retain` }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, (index * 2) + 1));
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: `assistant-${index}`,
        role: "assistant",
        content: [{ type: "text", text: `assistant marker ${index} with enough text to retain` }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, (index * 2) + 2));
  }
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /assistant marker 11/u);

  input.write("\u001b[1;5H");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /user marker 0/u);

  input.write("\u001b[1;6B");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /user marker 1/u);

  input.write("\u001b[1;6A");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /user marker 0/u);

  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /assistant marker 11/u);
  controller.close();
});

test("rich viewport distinguishes retained-history navigation from transcript eviction", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    limits: { maxTranscriptEntries: 10 },
  });
  output.resize(56, 12);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };

  controller.start();
  for (let index = 0; index < 14; index += 1) {
    controller.render(envelope({
      type: "warning",
      code: `history-${index}`,
      message: `retained history ${index}`,
    }, index + 1));
  }
  await tick();
  controller.renderNow();
  flush();

  const tail = terminal.viewport().join("\n");
  assert.match(tail, /retained history 13/u);
  assert.match(tail, /Older transcript entries were discarded/u);
  assert.doesNotMatch(tail, /retained history [0-3]\b/u);

  input.write("\u001b[5~");
  await tick();
  controller.renderNow();
  flush();
  const paged = terminal.viewport().join("\n");
  assert.match(paged, /Older transcript/iu);
  assert.match(paged, /retained history (?:[4-9]|1[0-2])\b/u);

  input.write("\u001b[1;5H");
  await tick();
  controller.renderNow();
  flush();
  const top = terminal.viewport().join("\n");
  assert.match(top, /retained history 4\b/u);
  assert.doesNotMatch(top, /retained history [0-3]\b/u);

  input.write("\u001b[1;5F");
  await tick();
  controller.renderNow();
  flush();
  const restoredTail = terminal.viewport().join("\n");
  assert.match(restoredTail, /retained history 13\b/u);
  assert.match(restoredTail, /Older transcript entries were discarded/u);
  controller.close();
});

test("Ctrl+L opens the combined model picker without consuming the draft", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [
    {
      id: "anthropic/claude-sonnet",
      label: "anthropic / claude-sonnet",
      value: { provider: "anthropic", model: "claude-sonnet" },
    },
  ]);
  input.write("keep this draft");
  input.write(Buffer.from([12]));
  input.write("sonnet\r");
  assert.equal(actions[0]?.type, "model_open");
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") {
    assert.equal(actions[1].picker, "model");
    assert.deepEqual(actions[1].item.value, { provider: "anthropic", model: "claude-sonnet" });
  }
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "keep this draft");
  controller.close();
});

test("the global model picker can open with a fuzzy query already populated", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", [
    { id: "openai/gpt", label: "openai / gpt", value: { provider: "openai", model: "gpt" } },
    { id: "openai-codex/gpt", label: "openai-codex / gpt", value: { provider: "openai-codex", model: "gpt" } },
  ]);
  controller.openPicker("model", "Models", "codex");
  await tick();
  assert.match(output.text, /Filter codex/u);
  assert.match(output.text, /gpt \[openai-codex\]/u);
  assert.doesNotMatch(output.text, /gpt \[openai\]/u);
  controller.close();
});

test("session picker exposes sort, named, path, and threaded controls", async () => {
  const { input, output, controller } = fullController({
    keybindings: new Keybindings({ "app.session.resume": "alt+s" }),
  });
  controller.start();
  controller.setPickerItems("session", [
    {
      id: "parent",
      label: "Parent session",
      detail: "2 messages",
      session: {
        name: "Parent session",
        path: "/tmp/sessions.db#parent",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        current: true,
      },
      value: "parent",
    },
    {
      id: "child",
      label: "Unnamed child",
      detail: "1 message",
      session: {
        path: "/tmp/sessions.db#child",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        parentId: "parent",
      },
      value: "child",
    },
  ]);

  input.write("\u001bs");
  await tick();
  assert.match(terminalWords(output.text), /Resume Session .*workspace · all · threaded · path off/u);
  assert.match(output.text, /└─ Unnamed child/u);

  output.chunks.length = 0;
  input.write(Buffer.from([19]));
  input.write(Buffer.from([14]));
  input.write(Buffer.from([16]));
  await tick();
  assert.match(terminalWords(output.text), /workspace · named · recent · path on/u);
  assert.match(output.text, /\/tmp\/sessions\.db#parent/u);
  assert.doesNotMatch(output.text, /Unnamed child/u);
  controller.close();
});

test("the session catalog remains the Resume surface", async () => {
  const { output, controller } = fullController();
  controller.setPickerItems("session", [{
    id: "current",
    label: "Implementation",
    detail: "3 messages",
    session: {
      name: "Implementation",
      path: "/tmp/sessions.db#current",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      current: true,
    },
    value: "/tmp/sessions.db#current",
  }], { scope: "current", query: "" });

  controller.start();
  controller.openPicker("session", "Resume session");
  await tick();

  const words = terminalWords(output.text);
  assert.match(words, /Resume Session/u);
  assert.match(words, /workspace · all · threaded · path off/u);
  assert.match(words, /Enter open/u);
  assert.doesNotMatch(words, /Session Atlas|journal \+ sessions|inspect\/resume/u);
  controller.close();
});

test("opening the session picker from its shortcut requests one lazy catalog refresh", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({
    actions,
    keybindings: new Keybindings({ "app.session.resume": "alt+s" }),
  });
  controller.start();
  controller.setPickerItems("session", []);

  input.write("\u001bs");
  await tick();

  assert.deepEqual(actions, [{ type: "session_open" }]);
  controller.close();
});

test("session picker switches live between current and all-workspace catalogs", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.setPickerItems("session", [{
    id: "current",
    label: "Current",
    value: "current",
    session: { path: "local", updatedAt: "2026-01-01", createdAt: "2026-01-01", current: true },
  }]);
  controller.start();
  controller.openPicker("session", "Resume Session");
  input.write(Buffer.from([1]));
  await tick();
  assert.deepEqual(actions, [{ type: "session_scope", scope: "all" }]);
  assert.match(output.text, /all workspaces/u);
  assert.match(output.text, /Loading all workspaces/u);
  controller.setPickerItems("session", [{
    id: "other",
    label: "Other workspace",
    value: "indexed:other",
    session: { path: "indexed:other", workspace: "/other", updatedAt: "2026-01-02", createdAt: "2026-01-02" },
  }]);
  controller.setSessionPickerScope("all");
  await tick();
  assert.match(output.text, /Other workspace/u);
  input.write(Buffer.from([1]));
  await tick();
  assert.deepEqual(actions.at(-1), { type: "session_scope", scope: "current" });
  controller.close();
});

test("session picker requests full-catalog searches and explicit bounded next pages", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.setPickerItems("session", [{
    id: "recent",
    label: "Recent",
    value: "recent",
    session: { path: "local", updatedAt: "2026-01-01", createdAt: "2026-01-01", current: true },
  }]);
  controller.setSessionPickerPagination(true, "1 session loaded · Right loads the next page");
  controller.start();
  controller.openPicker("session", "Resume Session");
  await tick();
  assert.match(output.text, /Right more/u);

  for (const character of "archive") {
    input.write(character);
    await tick();
  }
  assert.deepEqual(actions, [], "typing must not launch one full catalog scan per character");
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(actions, [{ type: "session_search", scope: "current", query: "archive" }]);

  controller.setPickerItems("session", [{
    id: "archive",
    label: "Archive",
    value: "archive",
    session: { path: "local", updatedAt: "2025-01-01", createdAt: "2025-01-01" },
  }], { scope: "current", query: "archive" });
  controller.setSessionPickerPagination(true, "1 matching session loaded · Right loads the next page");
  input.write("\u001b[C");
  await tick();
  assert.deepEqual(actions.at(-1), { type: "session_more", scope: "current", query: "archive" });
  controller.close();
});

test("closing the session picker cancels a pending catalog search", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.setPickerItems("session", []);
  controller.start();
  controller.openPicker("session", "Resume Session");

  input.write("archive");
  await tick();
  input.write("\u001b");
  await tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(actions, []);
  controller.close();
});

test("session picker waits for matching delayed search rows before selecting", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.setPickerItems("session", [{
    id: "stale",
    label: "Archive stale",
    value: "stale",
    session: { path: "stale", updatedAt: "2024-01-01", createdAt: "2024-01-01" },
  }]);
  controller.start();
  controller.openPicker("session", "Resume Session");

  input.write("archive");
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(actions, [{ type: "session_search", scope: "current", query: "archive" }]);

  input.write("\r");
  await tick();
  assert.equal(actions.some((action) => action.type === "select"), false);

  controller.setPickerItems("session", [{
    id: "wrong",
    label: "Archive wrong request",
    value: "wrong",
    session: { path: "wrong", updatedAt: "2025-01-01", createdAt: "2025-01-01" },
  }], { scope: "current", query: "archived" });
  input.write("\r");
  await tick();
  assert.equal(actions.some((action) => action.type === "select"), false);

  controller.setPickerItems("session", [{
    id: "fresh",
    label: "Archive fresh",
    value: "fresh",
    session: { path: "fresh", updatedAt: "2026-01-01", createdAt: "2026-01-01" },
  }], { scope: "current", query: "archive" });
  input.write("\r");
  await tick();

  const selected = actions.find((action) => action.type === "select");
  assert.equal(selected?.type === "select" ? selected.item.value : undefined, "fresh");
  controller.close();
});

test("line session search stays immediate and does not consume selection", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const actions: TuiAction[] = [];
  const controller = new TuiController({
    input,
    output,
    mode: "line",
    environment: { TERM: "dumb" },
    handleSignals: false,
    onAction: (action) => actions.push(action),
  });
  const archive = {
    id: "archive",
    label: "Archive",
    value: "archive",
    session: { path: "local", updatedAt: "2025-01-01", createdAt: "2025-01-01" },
  };
  controller.setPickerItems("session", [archive]);
  controller.start();
  controller.openPicker("session", "Resume Session");

  input.write("a");
  await tick();
  assert.deepEqual(actions, [{ type: "session_search", scope: "current", query: "a" }]);
  controller.setPickerItems("session", [archive], { scope: "current", query: "a" });
  input.write("\r");
  await tick();

  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") assert.equal(actions[1].item.value, "archive");
  controller.close();
});

test("session picker ignores the former rename key, confirms deletion, and protects the active session", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({
    actions,
    keybindings: new Keybindings({ "app.session.resume": "alt+s" }),
  });
  controller.start();
  controller.setPickerItems("session", [
    {
      id: "active",
      label: "Active",
      session: {
        name: "Active",
        path: "/tmp/sessions.db#active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        current: true,
      },
      value: "active",
    },
    {
      id: "older",
      label: "Older",
      session: {
        name: "Older",
        path: "/tmp/sessions.db#older",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      value: "older",
    },
  ]);

  input.write("\u001bs");
  await tick();
  assert.deepEqual(actions, [{ type: "session_open" }]);
  actions.length = 0;
  input.write(Buffer.from([18]));
  await tick();
  assert.equal(Number(actions.length), 0);
  assert.doesNotMatch(terminalWords(output.text), /Rename session/u);

  input.write(Buffer.from([4]));
  await tick();
  assert.match(terminalWords(output.text), /active session cannot be deleted/iu);
  assert.equal(Number(actions.length), 0);

  input.write("\u001b[B");
  input.write("old");
  await tick();
  input.write(Buffer.from([4]));
  await tick();
  assert.match(terminalWords(output.text), /Delete session/u);
  assert.match(terminalWords(output.text), /Delete “Older”\?/u);
  input.write("\r");
  await tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(actions.length, 1, "deletion must cancel the pending catalog search");
  assert.equal(actions[0]?.type, "session_delete");
  if (actions[0]?.type === "session_delete") {
    assert.equal(actions[0].item.value, "older");
    assert.equal(actions[0].query, "old");
  }
  assert.match(terminalWords(output.text), /Resume Session .*workspace · all · threaded/u);
  controller.close();
});

test("a refreshed keymap replaces an application shortcut immediately", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", [{ id: "model", label: "custom model", value: "model" }]);
  controller.setKeybindings(new Keybindings({ "app.model.select": "ctrl+k" }));
  input.write(Buffer.from([11]));
  await tick();
  assert.match(output.text, /custom model/u);
  controller.close();
});

test("at completion inserts a selected workspace file and Tab completes a unique path", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setPickerItems("file", [
    { id: "src/main.ts", label: "src/main.ts", value: "src/main.ts" },
    { id: "README.md", label: "README.md", value: "README.md" },
  ]);
  input.write("@");
  input.write("main\r");
  input.write(" and \u001b[200~@READ\u001b[201~");
  input.write("\t");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "@src/main.ts and @README.md");
  controller.close();
});

test("Ctrl+G round-trips the current draft through an external editor operation", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("before");
  let outputWhileEditing = "";
  await controller.editExternally(async (text) => {
    outputWhileEditing = output.text;
    return `${text} after`;
  });
  assert.match(outputWhileEditing, terminalPattern("\\u001b\\[\\?2004l", "u"));
  assert.match(outputWhileEditing, terminalPattern("\\u001b\\[\\?7h", "u"));
  assert.match(outputWhileEditing, terminalPattern("\\u001b\\[\\?1049l", "u"));
  assert.ok(outputWhileEditing.lastIndexOf("\u001b[?7h") < outputWhileEditing.lastIndexOf("\u001b[?1049l"));
  assert.match(output.text.slice(outputWhileEditing.length), terminalPattern("\\u001b\\[\\?2004h", "u"));
  assert.match(output.text.slice(outputWhileEditing.length), terminalPattern("\\u001b\\[\\?7l", "u"));
  assert.match(output.text.slice(outputWhileEditing.length), terminalPattern("\\u001b\\[\\?1049h", "u"));
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "before after");
  assert.deepEqual(input.rawChanges.slice(-2), [false, true]);
  controller.close();
});

test("closing the TUI cancels an active external editor operation", async () => {
  const { controller } = fullController();
  controller.start();
  let observedSignal: AbortSignal | undefined;
  const editing = controller.editExternally(async (_text, signal) => {
    observedSignal = signal;
    return await new Promise<string>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  });
  assert.equal(observedSignal?.aborted, false);
  controller.close();
  await assert.rejects(editing, /Terminal closed/u);
  assert.equal(observedSignal?.aborted, true);
});

test("an active turn still accepts explicit next-turn model and thinking changes plus follow-up input", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "anthropic", model: "beta" });
  controller.setPickerItems("model", [
    { id: "openai/alpha", label: "alpha", value: { provider: "openai", model: "alpha" } },
    { id: "anthropic/beta", label: "beta", value: { provider: "anthropic", model: "beta" } },
  ]);
  controller.setSteering((line) => actions.push({ type: "steer", text: line }));
  input.write(Buffer.from([12]));
  input.write("alpha\r");
  input.write("\u001b[Z");
  input.write("later\u001b\r");
  await tick();
  assert.deepEqual(actions[0], { type: "model_open" });
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") assert.deepEqual(actions[1].item.value, { provider: "openai", model: "alpha" });
  assert.deepEqual(actions[2], { type: "cycle_thinking" });
  assert.deepEqual(actions[3], { type: "steer", text: "/follow later" });
  controller.close();
});

test("controller maps Alt+Enter follow-up and Escape cancellation through the steering channel", async () => {
  const { input, controller } = fullController();
  const lines: string[] = [];
  controller.start();
  controller.setSteering((line) => lines.push(line));
  input.write("after this\u001b\r");
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  await tick();
  assert.deepEqual(lines, ["/follow after this", "/cancel"]);
  controller.close();
});

test("a rejected asynchronous Escape cancellation emits one error action without an unhandled rejection", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  const unhandled: unknown[] = [];
  const onUnhandled = (cause: unknown) => { unhandled.push(cause); };
  let rejectCancellation: ((cause: Error) => void) | undefined;
  const lines: string[] = [];
  process.on("unhandledRejection", onUnhandled);
  try {
    controller.start();
    controller.setSteering((line) => {
      lines.push(line);
      return new Promise<void>((_resolve, reject) => {
        rejectCancellation = reject;
      });
    });
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    await tick();
    assert.deepEqual(lines, ["/cancel"]);
    rejectCancellation?.(new Error("cancel rejected"));
    await tick();
    await tick();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, "error");
    if (actions[0]?.type === "error") assert.equal(actions[0].error.message, "cancel rejected");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    controller.close();
  }
});

test("active steer and follow-up submissions stay visible until queue or transcript acknowledgement", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const steered: Array<{ text: string; imageCount: number }> = [];
  controller.start();
  controller.setSteering((text, images, recovered) => {
    steered.push({ text, imageCount: (images?.length ?? 0) + (recovered?.length ?? 0) });
  });
  controller.attachInputImage(inputImage("active image"));
  input.write("change direction\r");
  await tick();
  flush();
  assert.deepEqual(steered, [{ text: "change direction", imageCount: 1 }]);
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.match(terminal.viewport().join("\n"), /change direction · \[1 image\]/u);

  controller.setQueuedMessages([{ mode: "steer", text: "change direction", imageCount: 1 }]);
  await tick();
  flush();
  assert.equal(occurrences(terminal.viewport().join("\n"), "change direction"), 1);

  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "durable-steer",
      role: "user",
      content: [
        { type: "text", text: "change direction" },
        { type: "image", mediaType: "image/png", data: png().toString("base64") },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  controller.setQueuedMessages([]);
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);

  input.write("then verify\u001b\r");
  await tick();
  flush();
  assert.deepEqual(steered.at(-1), { text: "/follow then verify", imageCount: 0 });
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.match(terminal.viewport().join("\n"), /then verify/u);
  controller.setQueuedMessages([{ mode: "follow_up", text: "then verify" }]);
  await tick();
  flush();
  assert.equal(occurrences(terminal.viewport().join("\n"), "then verify"), 1);

  assert.equal(controller.restoreQueuedMessages([{ mode: "follow_up", text: "then verify" }]), 1);
  await tick();
  flush();
  assert.equal(controller.getEditorText(), "then verify");
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);

  controller.setEditorText("new session message");
  input.write("\r");
  await tick();
  controller.replaceTranscript([], "next-session");
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);
  controller.close();
});

test("canonical queue transformations replace optimistic steering without leaving a stale receipt", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.setSteering(() => {});
  input.write("raw steering text\r");
  controller.setQueuedMessages([{ mode: "steer", text: "expanded steering text" }]);
  await tick();
  flush();
  const queued = terminal.viewport().join("\n");
  assert.match(queued, /Queued · 1/u);
  assert.doesNotMatch(queued, /raw steering text/u);
  assert.equal(occurrences(queued, "expanded steering text"), 1);

  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "transformed-steer",
      role: "user",
      content: [{ type: "text", text: "extension-transformed steering text" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  controller.render(envelope({ type: "steering_queued" }));
  controller.setQueuedMessages([]);
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);
  controller.close();
});

test("active-run settlement clears rejected receipts but keeps acknowledged queued messages", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.setSteering(() => {});
  input.write("rejected steering\r");
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.match(terminal.viewport().join("\n"), /rejected steering/u);

  controller.render(envelope({ type: "run_completed", finishReason: "stop" }));
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);

  input.write("accepted follow-up\u001b\r");
  controller.setQueuedMessages([{ mode: "follow_up", text: "accepted follow-up" }]);
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }));
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.equal(occurrences(terminal.viewport().join("\n"), "accepted follow-up"), 1);
  controller.restoreQueuedMessages([{ mode: "follow_up", text: "accepted follow-up" }]);
  controller.setEditorText("rejected after context settlement");
  input.write("\r");
  controller.setContext({ active: false });
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);
  controller.close();
});

test("identical active submissions retain their queue multiplicity through acknowledgement", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.setSteering(() => {});
  controller.setQueuedMessages([{ mode: "steer", text: "same direction" }]);
  input.write("same direction\r");
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 2/u);
  assert.equal(occurrences(terminal.viewport().join("\n"), "same direction"), 2);

  controller.setQueuedMessages([
    { mode: "steer", text: "same direction" },
    { mode: "steer", text: "same direction" },
  ]);
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 2/u);
  assert.equal(occurrences(terminal.viewport().join("\n"), "same direction"), 2);
  controller.restoreQueuedMessages([
    { mode: "steer", text: "same direction" },
    { mode: "steer", text: "same direction" },
  ]);
  controller.close();
});

test("coalesced queue consumption keeps an unseen receipt while a rendered queue clear does not resurrect it", async () => {
  const { input, output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  controller.setSteering(() => {});
  input.write("consumed before frame\r");
  controller.setQueuedMessages([{ mode: "steer", text: "consumed before frame" }]);
  controller.setQueuedMessages([]);
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.match(terminal.viewport().join("\n"), /consumed before frame/u);

  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "coalesced-steer",
      role: "user",
      content: [{ type: "text", text: "consumed before frame" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  controller.render(envelope({ type: "steering_queued" }));
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);

  input.write("externally cleared\r");
  controller.setQueuedMessages([{ mode: "steer", text: "canonical external clear" }]);
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.match(terminal.viewport().join("\n"), /canonical external clear/u);
  controller.setQueuedMessages([]);
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);
  controller.close();
});

test("an asynchronous active-delivery rejection clears one receipt and emits one error action", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  let rejectDelivery: ((cause: Error) => void) | undefined;
  controller.start();
  controller.setSteering(() => new Promise<void>((_resolve, reject) => {
    rejectDelivery = reject;
  }));
  input.write("queue beyond limit\r");
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Queued · 1/u);
  assert.match(terminal.viewport().join("\n"), /queue beyond limit/u);

  rejectDelivery?.(new Error("queue rejected"));
  await tick();
  flush();
  assert.doesNotMatch(terminal.viewport().join("\n"), /Queued ·/u);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "error");
  if (actions[0]?.type === "error") assert.equal(actions[0].error.message, "queue rejected");
  controller.close();
});

test("an asynchronous active-command rejection emits one error without an optimistic receipt or unhandled rejection", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = () => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (cause: unknown) => { unhandled.push(cause); };
  let rejectDelivery: ((cause: Error) => void) | undefined;
  const lines: string[] = [];
  process.on("unhandledRejection", onUnhandled);
  try {
    controller.start();
    controller.setSteering((line) => {
      lines.push(line);
      return new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      });
    });
    input.write("/deferred-test\r");
    await tick();
    flush();
    assert.deepEqual(lines, ["/deferred-test"]);
    assert.doesNotMatch(terminal.viewport().join("\n"), /Steering:|Follow-up:/u);

    rejectDelivery?.(new Error("command delivery rejected"));
    await tick();
    await tick();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, "error");
    if (actions[0]?.type === "error") assert.equal(actions[0].error.message, "command delivery rejected");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    controller.close();
  }
});

test("Alt+Up requests dequeue and restored messages preserve the current draft", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setQueuedMessages([
    { mode: "steer", text: "change direction" },
    { mode: "follow_up", text: "then verify" },
  ]);
  input.write("current draft");
  input.write("\u001b[1;3A");
  await tick();
  assert.deepEqual(actions, [{ type: "dequeue" }]);
  assert.match(output.text, /Queued · 2/u);
  assert.match(output.text, /change direction/u);
  assert.match(output.text, /then verify/u);
  assert.equal(controller.restoreQueuedMessages([
    { mode: "steer", text: "change direction" },
    { mode: "follow_up", text: "then verify" },
  ]), 2);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "change direction\n\nthen verify\n\ncurrent draft");
  controller.close();
});

test("queued embedded and URL images restore invisibly as exact pending payloads and remain visible until submit", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const images = [
    { type: "image" as const, mediaType: "image/png", data: "iVBORw==" },
    { type: "image" as const, mediaType: "image/jpeg", url: "https://images.example.test/two.jpg" },
  ];
  const queued = {
    mode: "follow_up",
    text: "compare these",
    images,
  } as const;
  controller.setQueuedMessages([queued]);
  await tick();
  assert.match(output.text, /Queued · 1/u);
  assert.match(output.text, /compare these · \[2 images\]/u);
  assert.equal(controller.restoreQueuedMessages([queued]), 1);
  controller.setDraftScope("other-session");
  assert.equal(controller.getEditorText(), "");
  controller.setDraftScope("default");
  controller.setEditorText("compare these after editing");
  await tick();
  assert.match(output.text, /recovered 1 \(embedded\).*image\/png/u);
  assert.match(output.text, /recovered 2 \(URL\)/u);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "compare these after editing");
  assert.deepEqual(controller.takeSubmittedRecoveredImages(), images);
  controller.close();
});

test("restored image payloads cross the active steering callback exactly once", async () => {
  const { input, controller } = fullController();
  const images = [
    { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" },
    { type: "image" as const, mediaType: "image/jpeg", url: "https://images.example.test/active.jpg" },
  ];
  let observed: { text: string; recovered: readonly ImageBlock[] } | undefined;
  controller.start();
  controller.setSteering((text, _attachments, recovered) => {
    observed = { text, recovered: recovered ?? [] };
  });
  controller.restoreQueuedMessages([{ mode: "steer", text: "active recovered", images }]);
  controller.setEditorText("active recovered edited");
  input.write("\r");
  await tick();
  assert.deepEqual(observed, { text: "active recovered edited", recovered: images });
  assert.deepEqual(controller.takeSubmittedRecoveredImages(), []);
  controller.close();
});

test("clearing a restored queue draft requests durable lease release", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.restoreQueuedMessages([{ mode: "follow_up", text: "restore then clear" }]);
  input.write(Buffer.from([3]));
  await tick();
  assert.deepEqual(actions, [{ type: "queue_restore_discard" }]);
  assert.equal(controller.getEditorText(), "");
  controller.close();
});

test("Ctrl+C clears once and exits on a second press while Ctrl+D exits only when empty", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  input.write("draft");
  input.write(Buffer.from([3]));
  assert.equal(controller.getEditorText(), "");
  input.write(Buffer.from([3]));
  await tick();
  assert.deepEqual(actions, [{ type: "exit" }]);
  actions.length = 0;
  input.write(Buffer.from([4]));
  await tick();
  assert.deepEqual(actions, [{ type: "exit" }]);
  controller.close();
});

test("double Escape on an empty editor follows the configured Atlas or none action", async () => {
  for (const [configured, expected] of [["atlas", "/atlas"], ["none", undefined]] as const) {
    const actions: TuiAction[] = [];
    const { input, controller } = fullController({ actions, doubleEscapeAction: configured });
    controller.start();
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    const submission = actions.find((action) => action.type === "submit");
    assert.equal(submission?.type === "submit" ? submission.text : undefined, expected);
    controller.close();
  }
});

test("Escape dismisses a displayed local warning without consuming the next double-Escape sequence", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions, doubleEscapeAction: "atlas" });
  output.resize(72, 14);
  controller.start();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.notify("Model catalogs: openai-codex (unavailable)", "warning");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminalWords(terminal.viewport().join("\n")), /Model catalogs: openai-codex \(unavailable\)/u);

  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  controller.renderNow();
  flush();
  assert.doesNotMatch(terminalWords(terminal.viewport().join("\n")), /Model catalogs: openai-codex \(unavailable\)/u);
  assert.deepEqual(actions, []);

  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(actions, [{ type: "submit", text: "/atlas" }]);

  controller.notify("Model catalogs: openai-codex (timeout)", "warning");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminalWords(terminal.viewport().join("\n")), /Model catalogs: openai-codex \(timeout\)/u);
  controller.close();
});

test("an unhandled permanent interrupt falls through to coalesced double Escape", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions, doubleEscapeAction: "atlas" });
  let attempts = 0;
  controller.start();
  controller.setInterruptHandler(() => {
    attempts += 1;
    return false;
  });
  input.write(Buffer.from([27, 27]));
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(attempts, 2);
  assert.deepEqual(actions, [{ type: "submit", text: "/atlas" }]);
  controller.close();
});

test("input EOF exits and settles a pending question", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  const answer = controller.question("you> ");

  input.end();

  await assert.rejects(answer, /Terminal closed/u);
  await tick();
  assert.deepEqual(actions, [{ type: "exit" }]);
});

test("Shift+Enter inserts a newline and Alt+D deletes the next word", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("one two");
  input.write("\u001b[H\u001b[C\u001b[C\u001b[C\u001b[C");
  input.write("\u001bd");
  input.write("\u001b[13;2u");
  input.write("three\r");
  assert.equal(await answer, "one \nthree");
  controller.close();
});

test("line fallback supports questions without alternate-screen control codes", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  output.isTTY = false;
  const controller = new TuiController({ input, output, environment: { TERM: "dumb" }, handleSignals: false });
  const answer = controller.question("prompt> ");
  input.write("plain input\n");
  assert.equal(await answer, "plain input");
  assert.doesNotMatch(output.text, /1049/u);
  assert.match(output.text, /prompt>/u);
  controller.close();
});

test("line fallback uses a line-oriented picker", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  output.isTTY = false;
  const controller = new TuiController({ input, output, environment: { TERM: "dumb" }, handleSignals: false });
  const selection = controller.choose("Select model", [
    { label: "Alpha", detail: "fast", value: "alpha" },
    { label: "Beta", detail: "deep", value: "beta" },
  ]);
  await tick();
  assert.match(output.text, /1\. Alpha — fast/u);
  assert.match(output.text, /type to search, Enter for 1, or \/cancel/u);
  input.write("2\n");
  assert.equal(await selection, "beta");
  controller.close();
});

test("line and accessibility fallbacks keep settings and tree navigation usable", async () => {
  for (const mode of ["line", "accessible"] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    input.isTTY = false;
    output.isTTY = false;
    const controller = new TuiController({
      input,
      output,
      mode,
      environment: { TERM: "dumb", NO_COLOR: "1" },
      handleSignals: false,
    });
    controller.start();

    const settingChanges: Array<{ id: string; value: string }> = [];
    const settings = controller.chooseSettings([{
      id: "images",
      label: "Images",
      description: "Render image attachments",
      value: "off",
      values: ["off", "on"],
    }], (item, value) => { settingChanges.push({ id: item.id, value }); });
    await tick();
    assert.match(output.text, /Settings/u);
    input.write("1\n");
    await tick();
    assert.match(output.text, /Images \(current: off\)/u);
    input.write("2\n");
    await tick();
    input.write("2\n");
    await settings;
    assert.deepEqual(settingChanges, [{ id: "images", value: "on" }]);

    const tree = controller.chooseSessionTree("Session Tree", [
      {
        id: "root",
        label: "Root prompt",
        value: "root",
        tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main"], active: true },
      },
      {
        id: "leaf",
        label: "Current answer",
        value: "leaf",
        tree: { eventId: "leaf", parentEventId: "root", kind: "assistant", depth: 1, prefix: "   └─ ", branches: ["main"], paths: ["main"], active: true },
      },
    ]);
    await tick();
    assert.match(output.text, /1\. \* Current answer/u);
    input.write("2\n");
    assert.equal(await tree, "root");
    controller.close();
  }
});

test("steering alone does not label shell work as model generation", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  controller.setContext({ active: false, status: "idle" });
  controller.setSteering(() => {});
  await tick();
  assert.doesNotMatch(output.text, /Generating response/u);
  controller.close();
});

test("line fallback submits slash commands without opening an interactive picker", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  output.isTTY = false;
  const controller = new TuiController({ input, output, environment: { TERM: "dumb" }, handleSignals: false });
  const answer = controller.question("prompt> ");
  input.write("/exit\n");
  assert.equal(await answer, "/exit");
  assert.doesNotMatch(output.text, /Commands|search>/u);
  controller.close();
});

test("accessibility mode never emits cursor-control sequences", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    environment: { TERM: "xterm", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  controller.render(envelope({ type: "warning", code: "note", message: "visible warning" }));
  const answer = controller.question("answer> ");
  input.write("yes\n");
  assert.equal(await answer, "yes");
  assert.match(output.text, /\[warning\] visible warning/u);
  assert.doesNotMatch(output.text, terminalPattern("\\u001b", "u"));
  controller.close();
});

test("accessibility mode streams planning details and reports retry and compaction outcomes", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    limits: { maxToolPreviewBytes: 32 },
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;

  controller.render(envelope({
    type: "reasoning_delta",
    text: "inspect the failure",
    part: 0,
    visibility: "summary",
  }, 1));
  controller.render(envelope({
    type: "reasoning_completed",
    text: "inspect the failure",
    part: 0,
    visibility: "summary",
  }, 2));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "shell" }, 3));
  controller.render(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: "{\"command\":\"printf a very long tool argument\"}",
  }, 4));
  controller.render(envelope({
    type: "tool_call_completed",
    index: 0,
    name: "shell",
    rawArguments: "{\"command\":\"printf a very long tool argument\"}",
    arguments: { command: "printf a very long tool argument" },
  }, 5));
  controller.render(envelope({
    type: "tool_progress",
    callId: "call-accessible",
    name: "shell",
    index: 0,
    sequence: 0,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "live tool output",
      stdoutBytes: 16,
      stderrBytes: 0,
      elapsedMs: 1_000,
    },
  }, 6));
  controller.render(envelope({
    type: "tool_progress",
    callId: "call-accessible",
    name: "shell",
    index: 0,
    sequence: 1,
    progress: {
      type: "result",
      content: "partial structured result",
      isError: false,
    },
  }, 7));
  controller.render(envelope({
    type: "retry_attempt_started",
    attempt: 2,
    provider: "openai",
    model: "gpt-test",
    step: 1,
  }, 8));
  controller.render(envelope({ type: "summarization_retry_finished" }, 9));
  controller.render(envelope({ type: "assistant_completed", finishReason: "context_limit" }, 10));
  controller.render(envelope({
    type: "compaction_started",
    reason: "threshold",
    estimatedTokensBefore: 12_500,
  }, 11));
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "summary",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      purpose: "compaction",
    },
    sourceMessageIds: ["old-1", "old-2"],
    firstKeptMessageId: "new",
    tokensBefore: 12_345,
    fromExtension: false,
    usage: {
      inputTokens: 2_930,
      cacheReadTokens: 35_584,
      cacheWriteTokens: 0,
      outputTokens: 3_449,
      totalTokens: 41_963,
    },
  }, 12));
  controller.render(envelope({ type: "compaction_started", reason: "overflow" }, 13));
  controller.render(envelope({
    type: "compaction_failed",
    reason: "overflow",
    aborted: false,
    willRetry: false,
    fromExtension: false,
    errorMessage: "summary unavailable",
  }, 14));

  assert.match(output.text, /\[reasoning\] inspect the failure/u);
  assert.match(output.text, /\[tool planning\] shell \(call 1\)/u);
  assert.match(output.text, /\[tool input 1\] \{"command":"printf a very long/u);
  assert.doesNotMatch(output.text, /tool argument/u);
  assert.match(output.text, /\[tool stdout\] shell: live tool output/u);
  assert.match(output.text, /\[tool partial\] shell: partial structured result/u);
  assert.match(output.text, /\[retry\] Attempt 2 started · openai\/gpt-test/u);
  assert.match(output.text, /\[status\] Summary retry finished/u);
  assert.match(output.text, /\[discarded\] Incomplete response discarded before context recovery/u);
  assert.match(output.text, /\[status\] Compacting older context · 12,500 projected tokens/u);
  assert.match(output.text, /\[status\] Context compacted · 2 messages · 12,345 tokens before/u);
  assert.match(output.text, /prompt 38,514 · cache hit 92\.4% · output 3,449/u);
  assert.match(output.text, /\[failed\] Compaction overflow · summary unavailable/u);
  assert.doesNotMatch(output.text, terminalPattern("\\u001b", "u"));
  controller.close();
});

test("append-only modes report one plain compaction receipt with verified counters", () => {
  for (const mode of ["line", "accessible"] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const controller = new TuiController({
      input,
      output,
      mode,
      environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
      handleSignals: false,
    });
    controller.start();
    output.chunks.length = 0;

    controller.render(envelope({
      type: "compaction_completed",
      summary: {
        id: `${mode}-summary`,
        role: "assistant",
        content: [{ type: "text", text: "retained summary remains private in append-only output" }],
        purpose: "compaction",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
      sourceMessageIds: ["one", "two"],
      firstKeptMessageId: "two",
      tokensBefore: 230_607,
      fromExtension: false,
      usage: { inputTokens: 29_092, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_359 },
    }, 1));

    const lines = output.text.trim().split("\n");
    assert.equal(lines.length, 1, `${mode}: ${output.text}`);
    assert.match(
      lines[0] ?? "",
      /^\[status\] Context compacted · 2 messages · 230,607 tokens before · summary request · prompt 29,092 · output 1,359$/u,
    );
    assert.doesNotMatch(output.text, terminalPattern("retained summary remains private|(?:->|→)|\\u001b", "u"));
    controller.close();
  }
});

test("append-only compaction receipts do not invent an omitted cache-read count", () => {
  for (const mode of ["line", "accessible"] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const controller = new TuiController({
      input,
      output,
      mode,
      environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
      handleSignals: false,
    });
    controller.start();
    output.chunks.length = 0;

    controller.render(envelope({
      type: "compaction_completed",
      summary: {
        id: `${mode}-summary-without-cache-count`,
        role: "assistant",
        content: [{ type: "text", text: "private retained summary" }],
        purpose: "compaction",
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      sourceMessageIds: ["one"],
      firstKeptMessageId: "one",
      tokensBefore: 14_721,
      fromExtension: false,
      usage: { inputTokens: 4_483, outputTokens: 1_180 },
    }, 1));

    assert.match(
      output.text,
      /summary request · prompt not reported · output 1,180/u,
    );
    assert.doesNotMatch(output.text, /cache (?:read|write)/u);
    controller.close();
  }
});

test("line output never renders provider traces and renders explicit summaries", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "line",
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;

  controller.render(envelope({
    type: "reasoning_delta",
    text: "must stay private",
    part: 0,
    visibility: "provider_trace",
  }, 1));
  assert.doesNotMatch(output.text, /must stay private/u);
  controller.render(envelope({
    type: "reasoning_completed",
    text: "must stay private",
    part: 0,
    visibility: "provider_trace",
    redacted: true,
  }, 2));
  assert.doesNotMatch(output.text, /must stay private/u);

  controller.render(envelope({
    type: "reasoning_delta",
    text: "safe provider summary",
    part: 1,
    visibility: "provider_trace",
  }, 3));
  assert.doesNotMatch(output.text, /safe provider summary/u);
  controller.render(envelope({
    type: "reasoning_completed",
    text: "safe provider summary",
    part: 1,
    visibility: "provider_trace",
  }, 4));
  assert.doesNotMatch(output.text, /safe provider summary/u);
  controller.render(envelope({
    type: "reasoning_delta",
    text: "must also stay private",
    part: 2,
    visibility: "summary",
  }, 5));
  assert.doesNotMatch(output.text, /must also stay private/u);
  controller.render(envelope({
    type: "reasoning_completed",
    text: "",
    part: 2,
    visibility: "summary",
    redacted: true,
  }, 6));
  assert.doesNotMatch(output.text, /must also stay private/u);
  controller.render(envelope({
    type: "reasoning_completed",
    text: "safe summary",
    part: 3,
    visibility: "summary",
  }, 7));
  assert.match(output.text, /\[reasoning\] safe summary/u);
  controller.close();
});

test("append-only output keeps completed summary reasoning before following answer text", () => {
  for (const mode of ["line", "accessible"] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const controller = new TuiController({
      input,
      output,
      mode,
      environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
      handleSignals: false,
    });
    controller.start();
    output.chunks.length = 0;

    controller.render(envelope({ type: "assistant_started", step: 1 }, 1));
    controller.render(envelope({
      type: "reasoning_started",
      part: 0,
      visibility: "summary",
    }, 2));
    controller.render(envelope({
      type: "reasoning_delta",
      text: "ordered summary",
      part: 0,
      visibility: "summary",
    }, 3));
    controller.render(envelope({ type: "text_delta", text: "ordered answer", part: 0 }, 4));
    assert.doesNotMatch(output.text, /ordered (?:summary|answer)/u);

    controller.render(envelope({
      type: "reasoning_completed",
      text: "ordered summary",
      part: 0,
      visibility: "summary",
    }, 5));
    const summaryIndex = output.text.indexOf("ordered summary");
    const answerIndex = output.text.indexOf("ordered answer");
    assert.ok(summaryIndex >= 0 && summaryIndex < answerIndex, `${mode}: ${output.text}`);
    assert.equal(occurrences(output.text, "ordered summary"), 1);
    assert.equal(occurrences(output.text, "ordered answer"), 1);
    controller.close();
  }
});

test("append-only output preserves a live answer and omits an unplaceable late summary", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "line",
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;

  controller.render(envelope({ type: "assistant_started", step: 1 }, 1));
  controller.render(envelope({ type: "text_delta", text: "live answer", part: 0 }, 2));
  assert.match(output.text, /live answer/u);
  controller.render(envelope({
    type: "reasoning_started",
    part: 1,
    visibility: "summary",
  }, 3));
  controller.render(envelope({
    type: "reasoning_delta",
    text: "late summary",
    part: 1,
    visibility: "summary",
  }, 4));
  controller.render(envelope({
    type: "reasoning_completed",
    text: "late summary",
    part: 1,
    visibility: "summary",
  }, 5));

  assert.equal(occurrences(output.text, "live answer"), 1);
  assert.doesNotMatch(output.text, /late summary/u);
  controller.close();
});

test("append-only output never reveals redacted reasoning while releasing buffered answer text", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "line",
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;

  controller.render(envelope({ type: "assistant_started", step: 1 }, 1));
  controller.render(envelope({
    type: "reasoning_started",
    part: 0,
    visibility: "summary",
  }, 2));
  controller.render(envelope({
    type: "reasoning_delta",
    text: "redacted material",
    part: 0,
    visibility: "summary",
  }, 3));
  controller.render(envelope({ type: "text_delta", text: "released answer", part: 0 }, 4));
  assert.doesNotMatch(output.text, /released answer/u);
  controller.render(envelope({
    type: "reasoning_completed",
    text: "",
    part: 0,
    visibility: "summary",
    redacted: true,
  }, 5));

  assert.doesNotMatch(output.text, /redacted material/u);
  assert.equal(occurrences(output.text, "released answer"), 1);
  controller.close();
});

test("append-only output keeps partial text before an output-limit warning", () => {
  for (const mode of ["line", "accessible"] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const controller = new TuiController({
      input,
      output,
      mode,
      environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
      handleSignals: false,
    });
    controller.start();
    output.chunks.length = 0;

    controller.render(envelope({ type: "assistant_started", step: 1 }, 1));
    controller.render(envelope({ type: "text_delta", text: "partial answer", part: 0 }, 2));
    controller.render(envelope({ type: "assistant_completed", finishReason: "length" }, 3));

    const answerIndex = output.text.indexOf("partial answer");
    const warningIndex = output.text.indexOf("output-token limit");
    assert.ok(answerIndex >= 0 && warningIndex > answerIndex, `${mode}: ${output.text}`);
    assert.equal(occurrences(output.text, "output-token limit"), 1);
    controller.close();
  }
});

test("accessibility transcript replacement does not lose visible history behind non-rendering events", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    environment: { TERM: "xterm", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;
  const events: TuiTranscriptItem[] = [envelope({ type: "text_delta", text: "retained visible history", part: 0 }, 1)];
  for (let sequence = 2; sequence <= 2_002; sequence += 1) {
    events.push(envelope({ type: "run_state", state: "streaming" }, sequence));
  }

  controller.replaceTranscript(events, "main");

  assert.match(output.text, /retained visible history/u);
  assert.doesNotMatch(output.text, terminalPattern("\\u001b", "u"));
  controller.close();
});

test("line transcript replacement writes only the retained bounded projection", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "line",
    limits: { maxTranscriptEntries: 3 },
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;
  const events = Array.from({ length: 5 }, (_, index) => envelope({
    type: "warning",
    code: `history-${index + 1}`,
    message: `saved warning ${index + 1}`,
  }, index + 1));

  controller.replaceTranscript(events, "main");

  assert.doesNotMatch(output.text, /saved warning [12]/u);
  assert.equal(output.text.match(/saved warning [345]/gu)?.length, 3);
  controller.close();
});

test("append-only transcript replacement retains completed public reasoning", () => {
  for (const mode of ["line", "accessible"] as const) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const controller = new TuiController({
      input,
      output,
      mode,
      environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
      handleSignals: false,
    });
    controller.start();
    output.chunks.length = 0;

    controller.replaceTranscript([envelope({
      type: "message_appended",
      message: {
        id: `append-only-reasoning-${mode}`,
        role: "assistant",
        content: [
          { type: "thinking", thinking: "retained public reasoning", visibility: "summary" },
          { type: "text", text: "retained answer" },
        ],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1)], "main");

    assert.match(output.text, /retained public reasoning/u, `${mode}: ${output.text}`);
    assert.match(output.text, /retained answer/u, `${mode}: ${output.text}`);
    controller.close();
  }
});

test("refresh transcript replacement preserves committed rows without reordering or duplicating them", async () => {
  const { output, controller } = fullController();
  controller.start();
  const snapshot = [
    envelope({
      type: "message_appended",
      message: {
        id: "refresh-user",
        role: "user",
        content: [{ type: "text", text: "inspect the file" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1),
    envelope({
      type: "message_appended",
      message: {
        id: "refresh-planning",
        role: "assistant",
        content: [
          { type: "text", text: "I will read it" },
          { type: "tool_call", callId: "refresh-call", name: "read", arguments: { path: "src/main.ts" } },
        ],
        stopReason: "tool_calls",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 2),
    envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 3),
    envelope({
      type: "message_appended",
      message: {
        id: "refresh-tool",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "refresh-call",
          name: "read",
          content: "file contents",
          isError: false,
        }],
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    }, 4),
    envelope({
      type: "message_appended",
      message: {
        id: "refresh-final",
        role: "assistant",
        content: [{ type: "text", text: "final answer" }],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    }, 5),
    envelope({ type: "assistant_completed", finishReason: "stop" }, 6),
  ];

  output.chunks.length = 0;
  controller.replaceTranscript(snapshot, "main");
  await tick();
  const initial = terminalWords(output.text);
  assert.ok(initial.indexOf("I will read it") < initial.indexOf("src/main.ts"));
  assert.ok(initial.indexOf("src/main.ts") < initial.indexOf("final answer"));

  output.chunks.length = 0;
  controller.replaceTranscript(snapshot, "main", { preserveExisting: true });
  await tick();
  assert.doesNotMatch(terminalWords(output.text), /inspect the file|I will read it|file contents|final answer/u);
  controller.close();
});

test("an unchanged same-session refresh preserves the paged transcript viewport", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const snapshot: TuiTranscriptItem[] = Array.from({ length: 40 }, (_, index) => envelope({
    type: "message_appended",
    message: {
      id: `refresh-page-${index}`,
      role: "user",
      content: [{ type: "text", text: `refresh-history-${index}` }],
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    },
  }, index + 1));

  controller.start();
  controller.replaceTranscript(snapshot, "main");
  await tick();
  controller.renderNow();
  flush();
  input.write("\u001b[<64;10;5M".repeat(4));
  await tick();
  controller.renderNow();
  flush();
  const before = terminal.viewport().join("\n");
  assert.doesNotMatch(before, /refresh-history-39/u);
  const anchor = /refresh-history-(\d+)/u.exec(before)?.[1];
  assert.ok(anchor !== undefined);

  controller.replaceTranscript(snapshot, "main", { preserveExisting: true });
  await tick();
  controller.renderNow();
  flush();
  const after = terminal.viewport().join("\n");
  assert.doesNotMatch(after, /refresh-history-39/u);
  assert.match(after, new RegExp(`refresh-history-${anchor}\\b`, "u"));
  controller.close();
});

test("a post-turn same-session refresh preserves the paged transcript viewport", async () => {
  const { input, output, controller } = fullController();
  output.resize(64, 14);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const history: TuiTranscriptItem[] = Array.from({ length: 40 }, (_, index) => envelope({
    type: "message_appended",
    message: {
      id: `post-turn-page-${index}`,
      role: "user",
      content: [{ type: "text", text: `post-turn-history-${index}` }],
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    },
  }, index + 1));
  const userMessage = {
    id: "post-turn-user",
    role: "user" as const,
    content: [{ type: "text" as const, text: "post-turn user prompt" }],
    createdAt: "2026-01-01T00:01:00.000Z",
  };
  const assistantMessage = {
    id: "post-turn-assistant",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "post-turn final answer" }],
    stopReason: "stop" as const,
    createdAt: "2026-01-01T00:01:01.000Z",
  };
  const liveItems = [
    envelope({ type: "message_appended", message: userMessage }, 41),
    envelope({ type: "message_appended", message: assistantMessage }, 42),
    envelope({ type: "assistant_completed", finishReason: "stop", rawReason: "completed" }, 43),
  ] satisfies TuiTranscriptItem[];

  controller.start();
  controller.replaceTranscript(history, "main");
  for (const item of liveItems) controller.render(item);
  await tick();
  controller.renderNow();
  flush();
  input.write("\u001b[<64;10;5M".repeat(4));
  await tick();
  controller.renderNow();
  flush();
  const before = terminal.viewport().join("\n");
  assert.doesNotMatch(before, /post-turn final answer/u);
  const anchor = /post-turn-history-(\d+)/u.exec(before)?.[1];
  assert.ok(anchor !== undefined);

  const refreshed = [
    ...history,
    envelope({ type: "message_appended", message: userMessage }, 101),
    envelope({ type: "message_appended", message: assistantMessage }, 102),
    envelope({ type: "assistant_completed", finishReason: "stop" }, 103),
  ];
  controller.replaceTranscript(refreshed, "main", { preserveExisting: true });
  await tick();
  controller.renderNow();
  flush();
  const after = terminal.viewport().join("\n");
  assert.doesNotMatch(after, /post-turn final answer/u);
  assert.match(after, new RegExp(`post-turn-history-${anchor}\\b`, "u"));
  controller.close();
});

test("refresh keeps canonical summaries aligned with global tool expansion", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  let renderedChunks = 0;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();
  const snapshot: TuiTranscriptItem[] = [{
    type: "session_summary",
    id: "refresh-compaction-summary",
    summaryType: "compaction",
    text: "refresh-compaction-expanded-body",
    tokensBefore: 51_000,
  }, {
    type: "session_summary",
    id: "refresh-branch-summary",
    summaryType: "branch_summary",
    text: "refresh-branch-expanded-body",
  }];

  controller.replaceTranscript(snapshot, "main");
  await tick();
  flush();
  input.write(Buffer.from([15]));
  await tick();
  flush();
  assert.match(
    terminal.viewport().join("\n"),
    /refresh-(?:compaction|branch)-expanded-body/u,
  );

  controller.replaceTranscript(snapshot, "main", { preserveExisting: true });
  await tick();
  controller.render(envelope({ type: "warning", code: "after-summary-refresh", message: "after summary refresh" }, 1));
  await tick();
  flush();

  const refreshed = terminal.viewport().join("\n");
  assert.match(refreshed, /refresh-(?:compaction|branch)-expanded-body/u);
  assert.equal(refreshed.match(/after summary refresh/gu)?.length, 1);
  assert.equal(controller.getToolOutputExpanded(), true);
  controller.close();
});

test("rebuilt expanded tool output collapses without entering native scrollback", async () => {
  const { input, output, controller } = fullController();
  output.rows = 16;
  controller.start();
  await tick();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.render(envelope({ type: "tool_requested", callId: "expansion-seed", name: "read", input: {}, index: 0 }, 1));
  controller.render(envelope({
    type: "tool_completed",
    callId: "expansion-seed",
    name: "read",
    index: 0,
    isError: false,
    preview: "seed tool body",
  }, 2));
  await tick();
  flush();
  input.write(Buffer.from([15]));
  await tick();
  flush();
  assert.equal(controller.getToolOutputExpanded(), true);

  const rebuiltToolContent = [
    "rebuilt-expanded-body-head",
    ...Array.from({ length: 18 }, (_, index) => `rebuilt-expanded-detail-${index + 1}`),
    "rebuilt-expanded-body-tail",
  ].join("\n");
  controller.replaceTranscript([
    envelope({
      type: "message_appended",
      message: {
        id: "rebuilt-tool-request",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "rebuilt-tool-call",
          name: "read",
          arguments: { path: "rebuilt.txt" },
        }],
        stopReason: "tool_calls",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1),
    envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 2),
    envelope({
      type: "message_appended",
      message: {
        id: "rebuilt-tool-result",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "rebuilt-tool-call",
          name: "read",
          content: rebuiltToolContent,
          isError: false,
        }],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 3),
    envelope({
      type: "message_appended",
      message: {
        id: "rebuilt-final-answer",
        role: "assistant",
        content: [{ type: "text", text: "rebuilt answer anchor" }],
        stopReason: "stop",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    }, 4),
    envelope({ type: "assistant_completed", finishReason: "stop" }, 5),
  ], "main");
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport().join("\n"), /rebuilt-expanded-body-tail/u);

  input.write(Buffer.from([15]));
  await tick();
  controller.renderNow();
  flush();
  const collapsed = terminal.viewport().join("\n");
  assert.match(terminalWords(collapsed), /read · done .*rebuilt\.txt/u);
  assert.match(collapsed, /17 more rows/u);
  assert.match(collapsed, /Ctrl\+O details/u);
  assert.doesNotMatch(collapsed, /rebuilt-expanded-body-tail|rebuilt-expanded-detail-18/u);
  assert.doesNotMatch(
    terminal.buffer().join("\n"),
    /rebuilt-expanded-body-tail|rebuilt-expanded-detail-18/u,
  );
  controller.close();
});

test("refresh preserves local notices emitted after the replacement generation starts", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.notify("replacement extension is ready", "status");
  controller.replaceTranscript([], "main", { preserveExisting: true });
  await tick();

  assert.match(terminalWords(output.text), /replacement extension is ready/u);
  controller.close();
});

test("ordinary refresh preserves a fresh local error", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.notify("Extension refresh failed", "error");

  controller.replaceTranscript([], "main", { preserveExisting: true });
  await tick();

  assert.match(terminalWords(output.text), /Extension refresh failed/u);
  controller.close();
});

test("starting a real turn removes stale local status blocks from the rich viewport", async () => {
  const { output, controller } = fullController();
  controller.start();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  controller.replaceTranscript([{
    type: "session_summary",
    id: "turn-cleanup-compaction",
    summaryType: "compaction",
    text: "Retained compacted context",
    tokensBefore: 158_184,
  }], "main");
  controller.notify("Exported session.html", "status");
  controller.notify("Connected provider", "status");
  controller.notify("Review this warning", "warning");
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /Exported session\.html|Connected provider/u);

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  await tick();
  flush();
  const viewport = terminal.viewport().join("\n");
  assert.match(viewport, /Context compacted/u);
  assert.match(viewport, /Review this warning/u);
  assert.doesNotMatch(viewport, /Exported session\.html|Connected provider/u);
  controller.close();
});

test("turn cleanup preserves a paged rich-transcript anchor while rows shrink", async () => {
  const { input, output, controller } = fullController({
    frameProjector: internalCreateRichTuiFrameProjector(),
  });
  output.resize(64, 14);
  controller.setOperatorPreferences({ clearOnShrink: true });
  controller.start();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  for (let index = 0; index < 10; index += 1) {
    controller.render(envelope({
      type: "warning",
      code: `turn-anchor-${index}`,
      message: `turn-anchor-history-${index}`,
    }, index + 1));
  }
  for (let index = 0; index < 6; index += 1) {
    controller.notify(`transient-turn-status-${index}\nsecond row`, "status");
  }
  for (let index = 10; index < 30; index += 1) {
    controller.render(envelope({
      type: "warning",
      code: `turn-anchor-${index}`,
      message: `turn-anchor-history-${index}`,
    }, index + 1));
  }
  await tick();
  controller.renderNow();
  flush();

  input.write("\u001b[5~");
  await tick();
  controller.renderNow();
  flush();
  const before = terminal.viewport().join("\n");
  const anchoredRows = [...before.matchAll(/turn-anchor-history-(\d+)/gu)].map((match) => match[1]);
  assert.ok(anchoredRows.length > 2);

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 100));
  await tick();
  controller.renderNow();
  flush();
  const after = terminal.viewport().join("\n");
  assert.deepEqual(
    [...after.matchAll(/turn-anchor-history-(\d+)/gu)].map((match) => match[1]),
    anchoredRows,
  );
  assert.doesNotMatch(terminal.buffer().join("\n"), /transient-turn-status/u);
  assert.equal(terminal.scrollback().length, 0);

  terminal.resize(72, 16);
  output.resize(72, 16);
  await tick();
  controller.renderNow();
  flush();
  const resizedLines = terminal.viewport();
  const resizedAnchorRow = resizedLines.findIndex((line) => /turn-anchor-history-\d+/u.test(line));
  const resizedAnchor = /turn-anchor-history-\d+/u.exec(resizedLines[resizedAnchorRow] ?? "")?.[0];
  assert.ok(resizedAnchorRow >= 0 && resizedAnchor !== undefined);

  controller.render(envelope({
    type: "warning",
    code: "turn-anchor-live-append",
    message: "turn-anchor-live-appended-tail",
  }, 101));
  await tick();
  controller.renderNow();
  flush();
  assert.match(terminal.viewport()[resizedAnchorRow] ?? "", new RegExp(`${resizedAnchor}\\b`, "u"));
  controller.close();
});

test("turn cleanup keeps the first durable row visible when transient rows are within or after the viewport", async (t) => {
  const scenarios = [
    { placement: "within", warningsBefore: 21, statuses: 1, warningsAfter: 3, pageUps: 0 },
    { placement: "after", warningsBefore: 30, statuses: 6, warningsAfter: 0, pageUps: 3 },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.placement, async () => {
      const { input, output, controller } = fullController();
      output.resize(64, 14);
      controller.setOperatorPreferences({ clearOnShrink: true });
      controller.start();
      const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
      let renderedChunks = 0;
      const flush = (): void => {
        for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
        renderedChunks = output.chunks.length;
      };
      flush();

      const renderWarnings = (start: number, count: number): void => {
        for (let index = start; index < start + count; index += 1) {
          controller.render(envelope({
            type: "warning",
            code: `${scenario.placement}-anchor-${index}`,
            message: `${scenario.placement}-anchor-history-${index}`,
          }, index + 1));
        }
      };
      renderWarnings(0, scenario.warningsBefore);
      for (let index = 0; index < scenario.statuses; index += 1) {
        controller.notify(`transient-${scenario.placement}-status-${index}\nsecond row`, "status");
      }
      renderWarnings(scenario.warningsBefore, scenario.warningsAfter);
      await tick();
      controller.renderNow();
      flush();

      input.write(scenario.placement === "within"
        ? "\u001b[<64;10;5M"
        : "\u001b[5~".repeat(scenario.pageUps));
      await tick();
      controller.renderNow();
      flush();
      const before = terminal.viewport();
      if (scenario.placement === "within") assert.match(before.join("\n"), /transient-within-status/u);
      const anchorRow = before.findIndex((line) => new RegExp(`${scenario.placement}-anchor-history-\\d+`, "u").test(line));
      const anchor = new RegExp(`${scenario.placement}-anchor-history-\\d+`, "u").exec(before[anchorRow] ?? "")?.[0];
      assert.ok(anchorRow >= 0 && anchor !== undefined);

      controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 100));
      await tick();
      controller.renderNow();
      flush();
      const after = terminal.viewport();
      assert.match(after.join("\n"), new RegExp(`${anchor}\\b`, "u"));
      if (scenario.placement === "after") {
        assert.match(after[anchorRow] ?? "", new RegExp(`${anchor}\\b`, "u"));
      }
      assert.doesNotMatch(terminal.buffer().join("\n"), new RegExp(`transient-${scenario.placement}-status`, "u"));
      assert.equal(terminal.scrollback().length, 0);
      controller.close();
    });
  }
});

test("refresh does not replay a committed local notice in the inline transcript", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.notify("committed refresh notice", "status");
  await tick();

  output.chunks.length = 0;
  controller.replaceTranscript([], "main", { preserveExisting: true });
  await tick();

  assert.doesNotMatch(terminalWords(output.text), /committed refresh notice/u);
  controller.close();
});

test("accessibility refresh does not replay a committed local notice", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  controller.notify("accessible refresh notice", "status");

  output.chunks.length = 0;
  controller.replaceTranscript([], "main", { preserveExisting: true });

  assert.doesNotMatch(output.text, /accessible refresh notice/u);
  controller.close();
});

test("refresh aliases live summary rows to their durable snapshot without replaying them", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    environment: { TERM: "dumb", OHM_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  controller.render(envelope({ type: "compaction_started", reason: "threshold" }, 1));
  controller.render(envelope({
    type: "compaction_completed",
    summary: {
      id: "live-compaction-summary",
      role: "assistant",
      content: [{ type: "text", text: "durable compacted context" }],
      purpose: "compaction",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["one"],
    firstKeptMessageId: "one",
    tokensBefore: 42_000,
    fromExtension: false,
  }, 2));
  controller.render(envelope({
    type: "branch_summary_created",
    summary: {
      id: "live-branch-summary",
      role: "assistant",
      content: [{ type: "text", text: "durable branch context" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    sourceBranch: "main",
    sourceEventIds: ["one"],
  }, 3));
  await tick();

  output.chunks.length = 0;
  const snapshot: TuiTranscriptItem[] = [{
    type: "session_summary",
    id: "durable-compaction-entry",
    summaryType: "compaction",
    text: "durable compacted context",
    tokensBefore: 42_000,
  }, {
    type: "session_summary",
    id: "durable-branch-entry",
    summaryType: "branch_summary",
    text: "durable branch context",
  }];
  controller.replaceTranscript(snapshot, "main", { preserveExisting: true });
  controller.render(envelope({ type: "warning", code: "after-refresh", message: "after refresh" }, 4));
  await tick();

  assert.doesNotMatch(output.text, /durable compacted context|durable branch context/u);
  assert.equal(terminalWords(output.text).match(/after refresh/gu)?.length, 1);
  controller.close();
});

test("resize causes a fresh bounded frame", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  output.resize(42, 12);
  await tick();
  assert.ok(output.chunks.length > 0);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2026h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[2K", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[2J\\u001b\\[H", "u"));
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[3J", "u"));
  controller.close();
});

test("ordinary editor input updates one live row instead of clearing the surface", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  input.write("x");
  await tick();
  assert.match(output.text, terminalPattern("\\u001b\\[\\?2026h", "u"));
  assert.equal(output.text.match(terminalPattern("\\u001b\\[2K", "gu"))?.length, 1);
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[(?:J|2J|3J|H)", "u"));
  controller.close();
});

test("signals and stream errors restore terminal state and report actions", () => {
  const signals = new FakeSignals();
  const actions: TuiAction[] = [];
  const first = fullController({ signals, actions });
  first.controller.start();
  signals.signal("SIGTERM");
  assert.equal(first.input.isRaw, false);
  assert.deepEqual(actions, [{ type: "signal", signal: "SIGTERM" }]);
  assert.match(first.output.text, terminalPattern("\\u001b\\[\\?2004l", "u"));
  assert.match(first.output.text, terminalPattern("\\u001b\\[\\?7h", "u"));
  assert.match(first.output.text, terminalPattern("\\u001b\\[\\?1049l", "u"));
  assert.ok(first.output.text.lastIndexOf("\u001b[?7h") < first.output.text.lastIndexOf("\u001b[?1049l"));

  const failures: TuiAction[] = [];
  const second = fullController({ actions: failures });
  second.controller.start();
  second.input.emit("error", new Error("boom"));
  assert.equal(second.input.isRaw, false);
  assert.equal(failures[0]?.type, "error");
  if (failures[0]?.type === "error") assert.equal(failures[0].error.message, "boom");
  assert.match(second.output.text, terminalPattern("\\u001b\\[\\?2004l", "u"));
  assert.match(second.output.text, terminalPattern("\\u001b\\[\\?7h", "u"));
  assert.match(second.output.text, terminalPattern("\\u001b\\[\\?1049l", "u"));
  assert.ok(second.output.text.lastIndexOf("\u001b[?7h") < second.output.text.lastIndexOf("\u001b[?1049l"));
});

test("clearing model context removes a disconnected provider from the footer", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setContext({ provider: "openai", model: "gpt-test" });
  await tick();
  output.chunks.length = 0;
  controller.clearModelContext();
  await tick();
  assert.doesNotMatch(output.text, /openai|gpt-test/u);
  controller.close();
});

test("closing rejects a pending question after restoring terminal state", async () => {
  const { input, controller } = fullController();
  controller.start();
  const question = controller.question("waiting> ");
  controller.close();
  await assert.rejects(question, /Terminal closed/u);
  assert.equal(input.isRaw, false);
});

test("rendered provider events are escaped before reaching the terminal", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.render(envelope({ type: "warning", code: "unsafe", message: "safe\u001b[2Jowned" }));
  await tick();
  assert.match(output.text, /safeowned/u);
  assert.doesNotMatch(output.text, terminalPattern("safe\\u001b\\[2Jowned", "u"));
  controller.close();
});

test("controller exposes both built-ins plus declarative extension themes", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  controller.start();
  assert.throws(() => controller.setCustomThemes([{
    schemaVersion: 1,
    name: "signal",
    base: "dark",
    styles: { accent: { foreground: 203 } },
  }]), /conflicts with a built-in theme/u);
  controller.setCustomThemes([parseThemeDefinition({
    schemaVersion: 1,
    name: "ocean",
    styles: { accent: { foreground: "#00aaff" } },
  })]);
  assert.deepEqual(controller.themeNames(), ["mono", "ocean", "signal"]);
  output.chunks.length = 0;
  controller.setTheme("ocean");
  await tick();
  assert.equal(controller.selectedThemeName(), "ocean");
  controller.setCustomThemes([]);
  assert.equal(controller.selectedThemeName(), "mono");
  assert.deepEqual(controller.themeNames(), ["mono", "signal"]);
  controller.close();
});

test("custom theme selection and catalog invalidation emit generation-owned changes", () => {
  const { controller } = fullController();
  const generation = new AbortController();
  const changes: Array<[string, string, string]> = [];
  controller.start();
  controller.onThemeChange((change) => changes.push([change.previous, change.current, change.reason]), generation.signal);
  controller.setCustomThemes([parseThemeDefinition({
    schemaVersion: 1,
    name: "reactive",
    styles: { accent: { foreground: "#001122" } },
  })]);
  controller.setTheme("reactive");
  controller.setCustomThemes([parseThemeDefinition({
    schemaVersion: 1,
    name: "reactive",
    styles: { accent: { foreground: "#334455" } },
  })]);
  assert.deepEqual(changes, [
    ["signal", "reactive", "selection"],
    ["reactive", "reactive", "catalog"],
  ]);
  generation.abort();
  controller.setTheme("mono");
  assert.equal(changes.length, 2);
  controller.close();
});

test("extension status, widget, and title render through bounded TUI primitives", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  controller.setExtensionStatus("probe:ready", "probe ready");
  controller.setExtensionWidget("probe:panel", "first line\nsecond line");
  controller.setTitle("probe\u001b]2;owned");
  await tick();
  assert.match(output.text, /probe ready/u);
  assert.match(output.text, /first line/u);
  assert.match(output.text, /second line/u);
  assert.match(output.text, terminalPattern("\\u001b\\]0;probe2;owned\\u0007", "u"));
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\]2;owned", "u"));
  controller.close();
});

test("terminal lifecycle keeps bounded identity, progress overlap, and close cleanup synchronized", () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;

  controller.setContext({
    threadId: "thread-ignored",
    sessionName: `Release\nCandidate\u0007${"🙂".repeat(80)}`,
    workspace: "/home/test/ohm-workspace\u001b]2;owned\u0007",
    active: true,
    status: "streaming",
  });
  assert.equal(occurrences(output.text, "\u001b]9;4;3\u0007"), 1);
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\]2;owned", "u"));
  const titles = [...output.text.matchAll(terminalPattern("\\u001b\\]0;([^\\u0007]*)\\u0007", "gu"))];
  const title = titles.at(-1)?.[1] ?? "";
  assert.match(title, /^ohm · Release Candidate/u);
  assert.match(title, /ohm-workspace$/u);
  assert.ok(Buffer.byteLength(title, "utf8") <= 256);

  controller.setInputBlocked("Summarizing branch… Esc to cancel", "summary");
  controller.setContext({ active: false, status: "failed" });
  assert.equal(occurrences(output.text, "\u001b]9;4;0;\u0007"), 0);
  controller.setInputBlocked();
  assert.equal(occurrences(output.text, "\u001b]9;4;0;\u0007"), 1);

  controller.setContext({ active: true, status: "streaming" });
  controller.close();
  assert.match(output.text, terminalPattern("\\u001b\\]9;4;0;\\u0007\\u001b\\]0;\\u0007", "u"));
});

test("terminal progress preference gates startup and clears live progress when disabled", () => {
  const disabled = fullController();
  disabled.controller.setOperatorPreferences({ showTerminalProgress: false });
  disabled.controller.start();
  disabled.output.chunks.length = 0;
  disabled.controller.setContext({ active: true, status: "streaming" });
  disabled.controller.close();
  assert.doesNotMatch(disabled.output.text, terminalPattern("\\u001b\\]9;4;", "u"));

  const live = fullController();
  live.controller.start();
  live.output.chunks.length = 0;
  live.controller.setContext({ active: true, status: "streaming" });
  assert.equal(occurrences(live.output.text, "\u001b]9;4;3\u0007"), 1);

  live.output.chunks.length = 0;
  live.controller.setOperatorPreferences({ showTerminalProgress: false });
  assert.equal(occurrences(live.output.text, "\u001b]9;4;0;\u0007"), 1);
  assert.equal(occurrences(live.output.text, "\u001b]9;4;3\u0007"), 0);

  live.output.chunks.length = 0;
  live.controller.setOperatorPreferences({ showTerminalProgress: true });
  assert.equal(occurrences(live.output.text, "\u001b]9;4;3\u0007"), 1);
  live.controller.close();
});

test("terminal lifecycle clears progress and title when the output stream fails", () => {
  const actions: TuiAction[] = [];
  const { output, controller } = fullController({ actions });
  controller.start();
  output.chunks.length = 0;
  controller.setContext({ workspace: "/work/failure", active: true, status: "streaming" });

  output.emit("error", new Error("fixture output failure"));

  assert.equal(actions.at(-1)?.type, "error");
  assert.match(output.text, terminalPattern("\\u001b\\]9;4;0;\\u0007\\u001b\\]0;\\u0007", "u"));
});

test("tmux modified-Enter diagnostics are asynchronous, bounded, sanitized, and compatibility-aware", async () => {
  let outsideProbeCalls = 0;
  const outside = fullController({
    tmuxOptionsProbe: async () => {
      outsideProbeCalls += 1;
      return { extendedKeys: "off", extendedKeysFormat: "xterm" };
    },
  });
  outside.controller.start();
  await tick();
  assert.equal(outsideProbeCalls, 0);
  outside.controller.close();

  const compatible = fullController({
    environment: { TMUX: "/tmp/tmux-compatible,1,0" },
    tmuxOptionsProbe: async () => ({ extendedKeys: "on", extendedKeysFormat: "csi-u" }),
  });
  compatible.controller.start();
  await tick();
  assert.doesNotMatch(stripAnsi(compatible.output.text), /modified Enter/u);
  compatible.controller.close();

  const incompatible = fullController({
    environment: { TMUX: "/tmp/tmux-incompatible,1,0" },
    tmuxOptionsProbe: async () => ({
      extendedKeys: "off\u001b]2;owned\u0007",
      extendedKeysFormat: "xterm\u001b[2J",
    }),
  });
  incompatible.controller.start();
  incompatible.output.chunks.length = 0;
  await tick();
  await tick();
  assert.match(stripAnsi(incompatible.output.text), /ohm detected tmux extended-keys=off/u);
  assert.doesNotMatch(incompatible.output.text, terminalPattern("\\u001b\\]2;owned|\\u001b\\[2J", "u"));
  incompatible.controller.close();

  let observedSignal: AbortSignal | undefined;
  const hanging = fullController({
    environment: { TMUX: "/tmp/tmux-hanging,1,0" },
    tmuxOptionsProbe: async (signal) => {
      observedSignal = signal;
      return await new Promise(() => undefined);
    },
  });
  const startedAt = performance.now();
  hanging.controller.start();
  assert.ok(performance.now() - startedAt < 100, "tmux diagnostics blocked terminal startup");
  await tick();
  hanging.controller.close();
  assert.equal(observedSignal?.aborted, true);
});

test("extension working controls replace and hide the bounded host activity row", async () => {
  const shown = fullController();
  shown.controller.start();
  shown.output.chunks.length = 0;
  shown.controller.setExtensionWorkingMessage("probe", "Indexing workspace\u001b[2J");
  shown.controller.setContext({ active: true, status: "streaming" });
  await tick();
  assert.match(shown.output.text, /Indexing workspace/u);
  assert.doesNotMatch(shown.output.text, terminalPattern("\\u001b\\[2J", "u"));
  shown.controller.close();

  const hidden = fullController();
  hidden.controller.start();
  hidden.controller.setExtensionWorkingVisible("probe", false);
  hidden.controller.setContext({ active: true, status: "streaming" });
  await tick();
  assert.doesNotMatch(hidden.output.text, /Preparing request/u);
  hidden.controller.close();
});

test("transient host status replaces one live row and clears without entering the transcript", async () => {
  const full = fullController();
  full.controller.start();
  full.output.chunks.length = 0;
  full.controller.setTransientStatus("shell stdout one");
  await tick();
  assert.match(full.output.text, /shell stdout one/u);
  full.output.chunks.length = 0;
  full.controller.setTransientStatus("shell stderr two");
  await tick();
  assert.match(full.output.text, /shell stderr two/u);
  full.controller.setTransientStatus();
  await tick();
  full.output.chunks.length = 0;
  full.controller.notify("after shell");
  await tick();
  assert.doesNotMatch(full.output.text, /shell stdout one|shell stderr two/u);
  full.controller.close();

  const input = new FakeInput();
  const output = new FakeOutput();
  const accessible = new TuiController({ input, output, mode: "accessible", environment: { TERM: "dumb" }, handleSignals: false });
  accessible.start();
  output.chunks.length = 0;
  accessible.setTransientStatus("first");
  accessible.setTransientStatus("second");
  accessible.setTransientStatus();
  assert.match(output.text, /\r\[status\] first/u);
  assert.match(output.text, /\r\[status\] second/u);
  assert.match(output.text, /\r\s+\r/u);
  accessible.close();
});

test("runtime command components render safely, receive keys, and end with their generation", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  let disposed = 0;
  const result = controller.custom<string>((host) => ({
    render: () => ({
      lines: [{ spans: [{ text: "extension panel", role: "accent" }], fill: true }],
      cursor: { row: 0, column: 9 },
    }),
    handleKey: (event) => {
      if (event.key !== "text" || event.text === undefined) return false;
      host.close(event.text);
      return true;
    },
    dispose: () => { disposed += 1; },
  }));
  await tick();
  assert.match(output.text, /extension panel/u);
  input.write("z");
  assert.equal(await result, "z");
  assert.equal(disposed, 1);

  const generation = new AbortController();
  const expired = controller.custom(() => ({
    render: () => ({ lines: [{ spans: [{ text: "temporary" }] }] }),
    dispose: () => { disposed += 1; },
  }), undefined, generation.signal);
  generation.abort(new Error("extension refresh"));
  assert.equal(await expired, undefined);
  assert.equal(disposed, 2);
  controller.close();
});

test("runtime command components receive the physical dimensions of a tiny terminal", async () => {
  const { input, output, controller } = fullController();
  output.resize(12, 4);
  const dimensions: Array<[number, number]> = [];
  const result = controller.custom<string>((host) => ({
    render: (context) => {
      dimensions.push([context.width, context.height]);
      return { lines: [{ spans: [{ text: "panel" }] }] };
    },
    handleKey: (event) => {
      if (event.text === undefined) return false;
      host.close(event.text);
      return true;
    },
  }));
  await tick();
  assert.deepEqual(dimensions.at(-1), [12, 4]);
  input.write("x");
  assert.equal(await result, "x");
  controller.close();
});

test("runtime overlay handles toggle visibility and focus without stealing non-capturing input", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setEditorText("draft");
  let handle: import("../../src/tui/components.js").RuntimeUiComponentHandle | undefined;
  const result = controller.custom<string>((host) => ({
    render: () => ({ lines: [{ spans: [{ text: "floating panel", role: "accent" }], fill: true }] }),
    handleKey: (event) => {
      if (event.key !== "text" || event.text === undefined) return false;
      host.close(event.text);
      return true;
    },
  }), {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: 20, margin: 1, nonCapturing: true },
    onHandle: (value) => { handle = value; },
  });
  await tick();
  assert.match(output.text, /floating panel/u);
  assert.equal(handle?.isFocused(), false);
  input.write("a");
  await tick();
  handle?.setHidden(true);
  const hiddenOffset = output.text.length;
  await tick();
  assert.doesNotMatch(output.text.slice(hiddenOffset), /floating panel/u);
  handle?.setHidden(false);
  handle?.focus();
  assert.equal(handle?.isFocused(), true);
  input.write("z");
  assert.equal(await result, "z");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "drafta");
  controller.close();
});

test("the top visible runtime overlay receives local pointer input and captures drags", async () => {
  const { input, controller } = fullController();
  controller.start();
  const lowerEvents: string[] = [];
  const upperEvents: string[] = [];
  const lower = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "lower" }] }] }),
    handlePointer: (event) => {
      lowerEvents.push(event.type);
      return { handled: true };
    },
  }), { overlayOptions: { row: 1, col: 1, width: 8 } });
  const upper = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "upper" }] }] }),
    handlePointer: (event, context) => {
      upperEvents.push(`${event.type}:${event.row}:${event.column}:${event.shift}:${context.width}`);
      if (event.type === "press") return { handled: true, capture: true };
      if (event.type === "release") return { handled: true, releaseCapture: true };
      return { handled: true };
    },
  }), { overlayOptions: { row: 1, col: 1, width: 8 } });
  await tick();

  input.write("\u001b[<4;3;2M");
  input.write("\u001b[<32;80;20M");
  input.write("\u001b[<0;80;20m");
  await tick();

  assert.deepEqual(lowerEvents, []);
  assert.deepEqual(upperEvents, [
    "press:0:1:true:8",
    "move:0:7:false:8",
    "release:0:7:false:8",
  ]);
  assert.equal(upper.isFocused(), true);
  upper.close();
  lower.close();
  controller.close();
});

test("persistent structured slots receive exact local pointer input and preserve core fallthrough", async () => {
  const { input, output, controller } = fullController();
  output.resize(40, 16);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const generation = new AbortController();
  const events: string[] = [];
  controller.start();
  controller.setPersistentComponent("header", "fixture:cropped", () => ({
    render: () => ({
      lines: Array.from({ length: 3 }, (_, row) => ({ spans: [{ text: `cropped-${row}` }] })),
    }),
    handlePointer: (event, context) => {
      events.push(`${event.type}:${event.row}:${event.column}:${event.shift}:${context.width}`);
      return {};
    },
  }), generation.signal);
  for (const [key, prefix] of [["later-a", "later-a"], ["later-b", "later-b"]] as const) {
    controller.setPersistentComponent("header", `fixture:${key}`, () => ({
      render: () => ({
        lines: Array.from({ length: 3 }, (_, row) => ({ spans: [{ text: `${prefix}-${row}` }] })),
      }),
    }), generation.signal);
  }
  await tick();
  controller.renderNow();
  flush();
  const visible = terminal.viewport();
  const markerRow = visible.findIndex((line) => line.includes("earlier extension rows"));
  const componentRow = visible.findIndex((line) => line.includes("cropped-1"));
  assert.ok(markerRow >= 0);
  assert.ok(componentRow > markerRow);

  input.write(`\u001b[<0;3;${markerRow + 1}M`);
  input.write(`\u001b[<0;3;${markerRow + 1}m`);
  input.write(`\u001b[<4;3;${componentRow + 1}M`);
  input.write(`\u001b[<36;5;${componentRow + 1}M`);
  input.write(`\u001b[<0;5;${componentRow + 1}m`);
  await tick();

  assert.deepEqual(events, ["press:1:2:true:40"]);
  generation.abort(new Error("done"));
  controller.close();
});

test("persistent component truncation keeps real rows interactive and its marker passive", async () => {
  const { input, output, controller } = fullController();
  output.resize(40, 16);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  const generation = new AbortController();
  const events: string[] = [];
  controller.start();
  controller.setPersistentComponent("header", "fixture:bounded", () => ({
    render: () => ({
      lines: Array.from({ length: 6 }, (_, row) => ({ spans: [{ text: `bounded-${row}` }] })),
    }),
    handlePointer: (event) => {
      events.push(`${event.type}:${event.row}`);
      return { handled: true };
    },
  }), generation.signal);
  await tick();
  controller.renderNow();
  flush();
  const visible = terminal.viewport();
  const componentRow = visible.findIndex((line) => line.includes("bounded-1"));
  const markerRow = visible.findIndex((line) => line.includes("more rows"));
  assert.ok(componentRow >= 0);
  assert.ok(markerRow > componentRow);

  input.write(`\u001b[<0;2;${componentRow + 1}M`);
  input.write(`\u001b[<0;2;${componentRow + 1}m`);
  input.write(`\u001b[<0;2;${markerRow + 1}M`);
  input.write(`\u001b[<0;2;${markerRow + 1}m`);
  await tick();

  assert.deepEqual(events, ["press:1", "release:1"]);
  generation.abort();
  controller.close();
});

test("persistent pointer capture is bounded and cancelled once on focus loss or replacement", async () => {
  const { input, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const replacement = new AbortController();
  const events: string[] = [];
  controller.setPersistentComponent("header", "fixture:capture", () => ({
    render: () => ({ lines: [{ spans: [{ text: "capturing header" }] }] }),
    handlePointer: (event) => {
      events.push(`${event.type}:${event.row}:${event.column}`);
      if (event.type === "press") return { handled: true, capture: true };
      if (event.type === "release") return { handled: true, releaseCapture: true };
      return { handled: true };
    },
  }), generation.signal);
  await tick();

  input.write("\u001b[<0;2;1M");
  input.write("\u001b[<32;80;24M");
  input.write("\u001b[O");
  await tick();
  input.write("\u001b[<0;2;1M");
  await tick();
  controller.setPersistentComponent("header", "fixture:capture", () => ({
    render: () => ({ lines: [{ spans: [{ text: "replacement header" }] }] }),
  }), replacement.signal);
  input.write("\u001b[<0;80;24m");
  await tick();

  assert.deepEqual(events, [
    "press:0:1",
    "move:0:79",
    "cancel:-1:-1",
    "press:0:1",
    "cancel:-1:-1",
  ]);
  generation.abort();
  replacement.abort();
  controller.close();
});

test("painted overlay cells mask persistent pointer targets while transparent cells fall through", async () => {
  const { input, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const persistent: number[] = [];
  const overlayEvents: number[] = [];
  controller.setPersistentComponent("header", "fixture:masked", () => ({
    render: () => ({ lines: [{ spans: [{ text: "under overlay" }] }] }),
    handlePointer: (event) => {
      if (event.type === "press") persistent.push(event.column);
      return { handled: true };
    },
  }), generation.signal);
  const overlay = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "XX" }] }] }),
    handlePointer: (event) => {
      if (event.type === "press") overlayEvents.push(event.column);
      return {};
    },
  }), { overlayOptions: { row: 0, col: 0, width: 8, nonCapturing: true } });
  await tick();

  input.write("\u001b[<0;2;1M");
  input.write("\u001b[<0;2;1m");
  input.write("\u001b[<0;5;1M");
  await tick();

  assert.deepEqual(overlayEvents, [1, 4]);
  assert.deepEqual(persistent, [4]);
  overlay.close();
  generation.abort();
  controller.close();
});

test("an unhandled runtime pointer press leaves the complete selection gesture with the core viewport", async () => {
  const { input, controller } = fullController({ remote: true });
  controller.start();
  const events: string[] = [];
  const overlay = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "selectable" }] }] }),
    handlePointer: (event) => {
      events.push(event.type);
      return {};
    },
  }), { overlayOptions: { row: 1, col: 1, width: 12 } });
  await tick();

  input.write("\u001b[<0;2;2M");
  input.write("\u001b[<32;4;2M");
  input.write("\u001b[<0;4;2m");
  await tick();

  assert.deepEqual(events, ["press"]);
  overlay.close();
  controller.close();
});

test("extension UI routes translate pointer rows below host chrome", async () => {
  const { input, controller } = fullController();
  controller.start();
  const events: string[] = [];
  const generation = new AbortController();
  const handle = controller.openExtensionUiRoute("fixture", "details", "Details", () => ({
    render: () => ({ lines: [{ spans: [{ text: "route row" }] }] }),
    handlePointer: (event, context) => {
      events.push(`${event.type}:${event.row}:${context.height}`);
      return { handled: true };
    },
  }), generation.signal);
  await tick();

  input.write("\u001b[<0;2;2M");
  await tick();

  assert.deepEqual(events, ["press:0:23"]);
  handle.close();
  controller.close();
});

test("extension overlays stack independently and route keys to the focused layer", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setEditorText("draft");
  const keys: string[] = [];
  let disposed = 0;
  const first = controller.showOverlay<string>((host) => ({
    render: () => ({ lines: [{ spans: [{ text: "first overlay", role: "accent" }], fill: true }] }),
    handleKey: (event) => {
      keys.push(`first:${event.text ?? event.key}`);
      if (event.text === "1") host.close("first-result");
      return true;
    },
    dispose: () => { disposed += 1; },
  }), { overlayOptions: { anchor: "top-left", width: 16 } });
  const second = controller.showOverlay<string>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "second overlay", role: "success" }], fill: true }] }),
    handleKey: (event) => {
      keys.push(`second:${event.text ?? event.key}`);
      return true;
    },
    dispose: () => { disposed += 1; },
  }), { overlayOptions: { anchor: "top-right", width: 16 } });

  await tick();
  assert.match(output.text, /first overlay/u);
  assert.match(output.text, /second overlay/u);
  assert.equal(first.isFocused(), false);
  assert.equal(second.isFocused(), true);
  input.write("x");
  await tick();
  assert.deepEqual(keys, ["second:x"]);

  first.focus();
  assert.equal(first.isFocused(), true);
  assert.equal(second.isFocused(), false);
  input.write("1");
  assert.equal(await first.result, "first-result");
  assert.deepEqual(keys, ["second:x", "first:1"]);
  second.setHidden(true);
  assert.equal(second.isHidden(), true);
  second.close();
  assert.equal(await second.result, undefined);
  assert.equal(disposed, 2);
  controller.close();
});

test("overlay focus order, hiding, visibility, and unfocus restore input deterministically", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setEditorText("draft");
  const keys: string[] = [];
  const lower = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "lower" }], fill: true }] }),
    handleKey: (event) => { keys.push(`lower:${event.text ?? event.key}`); return true; },
  }), { overlayOptions: { row: 0, col: 0, width: 8 } });
  let upperVisible = true;
  const upper = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "upper" }], fill: true }] }),
    handleKey: (event) => { keys.push(`upper:${event.text ?? event.key}`); return true; },
  }), { overlayOptions: { row: 0, col: 0, width: 8, visible: () => upperVisible } });

  input.write("a");
  await tick();
  upperVisible = false;
  input.write("b");
  await tick();
  upperVisible = true;
  input.write("c");
  await tick();
  assert.deepEqual(keys, ["upper:a", "lower:b", "upper:c"]);

  upper.setHidden(true);
  assert.equal(upper.isFocused(), false);
  input.write("d");
  await tick();
  upper.setHidden(false);
  assert.equal(upper.isFocused(), true);
  input.write("e");
  await tick();
  upper.unfocus();
  input.write("f");
  await tick();
  lower.unfocus({ target: null });
  input.write("g");
  await tick();
  assert.deepEqual(keys, ["upper:a", "lower:b", "upper:c", "lower:d", "upper:e", "lower:f"]);

  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "draftg");
  upper.hide();
  lower.hide();
  assert.equal(await upper.result, undefined);
  assert.equal(await lower.result, undefined);
  upper.focus();
  assert.equal(upper.isFocused(), false);
  controller.close();
});

test("raw overlay focus follows visibility changes during rendering", async () => {
  const { input, controller } = fullController();
  controller.start();
  const keys: string[] = [];
  const lower = controller.showRawOverlay<void>({
    render: () => ["lower raw"],
    invalidate() {},
    handleInput: (data) => { keys.push(`lower:${data}`); },
  }, { row: 0, col: 0, width: 12 });
  let upperVisible = false;
  const upper = controller.showRawOverlay<void>({
    render: () => ["upper raw"],
    invalidate() {},
    handleInput: (data) => { keys.push(`upper:${data}`); },
  }, { row: 0, col: 0, width: 12, visible: () => upperVisible });
  await tick();

  assert.equal(upper.handle.isFocused(), false);
  assert.equal(lower.handle.isFocused(), true);
  input.write("a");
  upperVisible = true;
  controller.renderNow();
  assert.equal(upper.handle.isFocused(), true);
  input.write("b");
  upperVisible = false;
  controller.renderNow();
  assert.equal(upper.handle.isFocused(), false);
  assert.equal(lower.handle.isFocused(), true);
  input.write("c");
  upperVisible = true;
  controller.renderNow();
  assert.equal(upper.handle.isFocused(), true);
  input.write("d");
  assert.deepEqual(keys, ["lower:a", "upper:b", "lower:c", "upper:d"]);

  upper.close();
  lower.close();
  await Promise.all([upper.result, lower.result]);
  controller.close();
});

test("overlay focus raises visual order and dynamic sizing is resolved once with minWidth", async () => {
  const { output, controller } = fullController();
  controller.start();
  let optionCalls = 0;
  const widths: number[] = [];
  const lower = controller.showOverlay<void>(() => ({
    render: (context) => {
      widths.push(context.width);
      return { lines: [{ spans: [{ text: "LOWER_ONLY" }], fill: true }] };
    },
  }), {
    overlayOptions: () => {
      optionCalls += 1;
      return { row: 0, col: 0, width: 5, minWidth: 12, nonCapturing: true };
    },
  });
  const upper = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "UPPER_ONLY" }], fill: true }] }),
  }), { overlayOptions: { row: 0, col: 0, width: 12, nonCapturing: true } });
  await tick();
  assert.match(output.text, /UPPER_ONLY/u);
  assert.equal(optionCalls, 1);
  assert.deepEqual(widths, [12]);

  output.chunks.length = 0;
  lower.focus();
  await tick();
  assert.match(output.text, /LOWER_ONLY/u);
  assert.doesNotMatch(output.text, /UPPER_ONLY/u);
  assert.equal(optionCalls, 1);
  lower.close();
  upper.close();
  await Promise.all([lower.result, upper.result]);
  controller.close();
});

test("runtime overlay options reject unsafe dimensions before mounting", async () => {
  const { controller } = fullController();
  controller.start();
  await assert.rejects(controller.custom(() => ({ render: () => ({ lines: [] }) }), {
    overlay: true,
    overlayOptions: { width: "0%" },
  }), /width must be more than 0% to 100%/u);
  assert.throws(() => controller.showOverlay(() => ({ render: () => ({ lines: [] }) }), {
    overlayOptions: { minWidth: 0 },
  }), /minWidth must be a positive safe integer/u);
  assert.throws(() => controller.showOverlay(() => ({ render: () => ({ lines: [] }) }), {
    overlayOptions: { minWidth: JSON.parse('"50%"') },
  }), /minWidth must be a positive safe integer/u);
  controller.close();
});

test("custom tool renderers retain unchanged blocks and honor targeted invalidation", async (context) => {
  const { controller } = fullController();
  const generation = new AbortController();
  context.after(() => {
    generation.abort();
    controller.close();
  });
  let hasChecks = 0;
  let shellRenders = 0;
  let callRenders = 0;
  let resultRenders = 0;
  let label = "initial";
  const bridges = new Map<string, { invalidate(): void }>();
  controller.setToolRenderers({
    has: (name) => {
      hasChecks += 1;
      return name === "custom_cached";
    },
    renderShell: () => {
      shellRenders += 1;
      return "default";
    },
    renderCall: (_name, view, _renderContext, bridge) => {
      callRenders += 1;
      if (bridge !== undefined) bridges.set(view.callId, bridge);
      return { lines: [{ spans: [{ text: `${label} call ${view.callId}` }] }] };
    },
    renderResult: (_name, view) => {
      resultRenders += 1;
      return { lines: [{ spans: [{ text: `${label} result ${view.callId}` }] }] };
    },
  }, generation.signal);
  controller.start();
  let sequence = 0;
  for (let index = 0; index < 100; index += 1) {
    const callId = `cached-custom-${index}`;
    controller.render(envelope({
      type: "tool_requested",
      callId,
      name: "custom_cached",
      input: { index },
      index,
    }, ++sequence));
    controller.render(envelope({
      type: "tool_completed",
      callId,
      name: "custom_cached",
      index,
      isError: false,
      preview: "done",
      result: { type: "tool_result", callId, name: "custom_cached", content: "done", isError: false },
    }, ++sequence));
  }
  const liveCallId = "cached-custom-live";
  controller.render(envelope({
    type: "tool_requested",
    callId: liveCallId,
    name: "custom_cached",
    input: { live: true },
    index: 100,
  }, ++sequence));
  controller.render(envelope({
    type: "tool_started",
    callId: liveCallId,
    name: "custom_cached",
    input: { live: true },
    index: 100,
    recoveryMode: "never_repeat",
  }, ++sequence));
  await tick();
  controller.renderNow();

  hasChecks = 0;
  shellRenders = 0;
  callRenders = 0;
  resultRenders = 0;
  controller.renderNow();
  assert.deepEqual(
    { hasChecks, shellRenders, callRenders, resultRenders },
    { hasChecks: 101, shellRenders: 101, callRenders: 0, resultRenders: 0 },
  );

  controller.render(envelope({
    type: "tool_progress",
    callId: liveCallId,
    name: "custom_cached",
    index: 100,
    sequence: 0,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "live update",
      stdoutBytes: 11,
      stderrBytes: 0,
    },
  }, ++sequence));
  hasChecks = 0;
  shellRenders = 0;
  controller.renderNow();
  assert.deepEqual(
    { hasChecks, shellRenders, callRenders, resultRenders },
    { hasChecks: 101, shellRenders: 101, callRenders: 1, resultRenders: 0 },
  );

  hasChecks = 0;
  shellRenders = 0;
  callRenders = 0;
  resultRenders = 0;
  label = "invalidated";
  bridges.get("cached-custom-0")?.invalidate();
  controller.renderNow();
  assert.deepEqual(
    { hasChecks, shellRenders, callRenders, resultRenders },
    { hasChecks: 101, shellRenders: 101, callRenders: 1, resultRenders: 1 },
  );
});

test("custom tool renderers keep reused provider call IDs bound to chronological rows", async (context) => {
  const { output, controller } = fullController({ frameProjector: internalCreateRichTuiFrameProjector() });
  const generation = new AbortController();
  context.after(() => {
    generation.abort();
    controller.close();
  });
  output.resize(100, 40);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.setToolRenderers({
    has: (name) => name === "custom_reused",
    renderCall: (_name, view) => {
      const path = isRecordValue(view.input) && isStringValue(view.input.path)
        ? view.input.path
        : "missing";
      return { lines: [{ spans: [{ text: `custom call ${path}` }] }] };
    },
    renderResult: (_name, view) => ({
      lines: [{ spans: [{ text: `custom result ${view.result?.content ?? "missing"}` }] }],
    }),
  }, generation.signal);
  controller.start();
  const appendCall = (messageId: string, path: string, sequence: number): void => {
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: messageId,
        role: "assistant",
        content: [{ type: "tool_call", callId: "reused-custom-call", name: "custom_reused", arguments: { path } }],
        createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
      },
    }, sequence));
    controller.render(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, sequence + 1));
  };
  const appendResult = (messageId: string, content: string, sequence: number): void => {
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: messageId,
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "reused-custom-call",
          name: "custom_reused",
          content,
          isError: false,
        }],
        createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
      },
    }, sequence));
  };
  appendCall("custom-first-call", "first.ts", 1);
  appendResult("custom-first-result", "first output", 3);
  appendCall("custom-second-call", "second.ts", 4);
  appendResult("custom-second-result", "second output", 6);
  await tick();
  controller.renderNow();
  flush();

  const viewport = terminal.viewport().join("\n");
  assert.match(
    viewport,
    /custom call first\.ts[\s\S]*custom result first output[\s\S]*custom call second\.ts[\s\S]*custom result second output/u,
  );
  assert.equal(occurrences(viewport, "custom call first.ts"), 1);
  assert.equal(occurrences(viewport, "custom call second.ts"), 1);
});

test("custom tool renderer shell changes refresh retained call and result content", async (context) => {
  const { output, controller } = fullController({ frameProjector: internalCreateRichTuiFrameProjector() });
  const generation = new AbortController();
  context.after(() => {
    generation.abort();
    controller.close();
  });
  output.resize(100, 30);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  let shell: "default" | "self" = "default";
  let label = "before";
  let callRenders = 0;
  let resultRenders = 0;
  controller.setToolRenderers({
    has: (name) => name === "dynamic_shell",
    renderShell: () => shell,
    renderCall: (_name, view) => {
      callRenders += 1;
      return { lines: [{ spans: [{ text: `${label} ${shell} call ${view.callId}` }] }] };
    },
    renderResult: (_name, view) => {
      resultRenders += 1;
      return { lines: [{ spans: [{ text: `${label} ${shell} result ${view.callId}` }] }] };
    },
  }, generation.signal);
  controller.start();
  controller.render(envelope({
    type: "tool_requested",
    callId: "dynamic-shell-call",
    name: "dynamic_shell",
    input: { value: 1 },
    index: 0,
  }, 1));
  controller.render(envelope({
    type: "tool_completed",
    callId: "dynamic-shell-call",
    name: "dynamic_shell",
    index: 0,
    isError: false,
    preview: "native fallback",
    result: {
      type: "tool_result",
      callId: "dynamic-shell-call",
      name: "dynamic_shell",
      content: "done",
      isError: false,
    },
  }, 2));
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /before default (?:call|result) dynamic-shell-call/u);

  callRenders = 0;
  resultRenders = 0;
  shell = "self";
  label = "after";
  controller.renderNow();
  flush();
  assert.deepEqual({ callRenders, resultRenders }, { callRenders: 1, resultRenders: 1 });
  const viewport = terminal.viewport().join("\n");
  assert.match(viewport, /after self call dynamic-shell-call/u);
  assert.match(viewport, /after self result dynamic-shell-call/u);
  assert.doesNotMatch(viewport, /before default/u);
});

test("unregistered and empty tool renderer decisions stay retained without output bytes", async (context) => {
  const delegate = createFixtureFrameProjector();
  const revisions: number[] = [];
  const { controller } = fullController({
    frameProjector: (request) => {
      revisions.push(request.transcriptRevision ?? -1);
      return delegate(request);
    },
  });
  const generation = new AbortController();
  context.after(() => {
    generation.abort();
    controller.close();
  });
  let callRenders = 0;
  let resultRenders = 0;
  controller.setToolRenderers({
    has: (name) => name === "empty_custom",
    renderCall: () => {
      callRenders += 1;
      return undefined;
    },
    renderResult: () => {
      resultRenders += 1;
      return undefined;
    },
  }, generation.signal);
  controller.start();
  controller.render(envelope({
    type: "tool_requested",
    callId: "unregistered-fallback",
    name: "native_only",
    input: {},
    index: 0,
  }, 1));
  controller.render(envelope({
    type: "tool_requested",
    callId: "empty-custom",
    name: "empty_custom",
    input: {},
    index: 1,
  }, 2));
  controller.render(envelope({
    type: "tool_completed",
    callId: "empty-custom",
    name: "empty_custom",
    index: 1,
    isError: false,
    preview: "native empty fallback",
    result: { type: "tool_result", callId: "empty-custom", name: "empty_custom", content: "done", isError: false },
  }, 3));
  await tick();
  controller.renderNow();
  assert.ok(callRenders > 0);
  assert.ok(resultRenders > 0);

  const settledRevision = revisions.at(-1);
  callRenders = 0;
  resultRenders = 0;
  revisions.length = 0;
  controller.renderNow();
  controller.renderNow();
  assert.deepEqual({ callRenders, resultRenders }, { callRenders: 0, resultRenders: 0 });
  assert.ok(revisions.length > 0 && revisions.every((revision) => revision === settledRevision));
});

test("custom tool renderer budget keeps newest blocks stable and reconsiders invalidated omissions", async (context) => {
  const delegate = createFixtureFrameProjector();
  const revisions: number[] = [];
  const { output, controller } = fullController({
    frameProjector: (request) => {
      revisions.push(request.transcriptRevision ?? -1);
      return delegate(request);
    },
  });
  const generation = new AbortController();
  context.after(() => {
    generation.abort();
    controller.close();
  });
  output.resize(500, 30);
  const renderedCalls: string[] = [];
  const renderedResults: string[] = [];
  const bridges = new Map<string, { invalidate(): void }>();
  const compact = new Set<string>();
  const filler = "𐍈".repeat(440);
  const block = (callId: string, slot: string) => ({
    lines: Array.from({ length: compact.has(callId) ? 1 : 128 }, (_, line) => ({
      spans: [{ text: `${callId} ${slot} ${line} ${compact.has(callId) ? "small" : filler}` }],
    })),
  });
  controller.setToolRenderers({
    has: (name) => name === "budgeted",
    renderShell: () => "self",
    renderCall: (_name, view, _renderContext, bridge) => {
      renderedCalls.push(view.callId);
      if (bridge !== undefined) bridges.set(view.callId, bridge);
      return block(view.callId, "call");
    },
    renderResult: (_name, view) => {
      renderedResults.push(view.callId);
      return block(view.callId, "result");
    },
  }, generation.signal);
  controller.start();
  let sequence = 0;
  for (let index = 0; index < 20; index += 1) {
    const callId = `budgeted-${index}`;
    controller.render(envelope({
      type: "tool_requested",
      callId,
      name: "budgeted",
      input: { index },
      index,
    }, ++sequence));
    controller.render(envelope({
      type: "tool_completed",
      callId,
      name: "budgeted",
      index,
      isError: false,
      preview: `native ${callId}`,
      result: { type: "tool_result", callId, name: "budgeted", content: "done", isError: false },
    }, ++sequence));
  }
  await tick();
  controller.renderNow();
  assert.ok(
    renderedCalls.includes("budgeted-19"),
    `the newest custom block was not admitted first: ${JSON.stringify(renderedCalls)}`,
  );
  assert.equal(renderedCalls.includes("budgeted-0"), false, "an oldest block displaced newer custom output");

  const settledRevision = revisions.at(-1);
  renderedCalls.length = 0;
  renderedResults.length = 0;
  revisions.length = 0;
  controller.renderNow();
  controller.renderNow();
  assert.equal(renderedCalls.length, 0);
  assert.equal(renderedResults.length, 0);
  assert.ok(revisions.length > 0 && revisions.every((revision) => revision === settledRevision));

  const boundaryCallId = [...bridges.keys()].findLast((callId) => callId !== "budgeted-19");
  assert.notEqual(boundaryCallId, undefined);
  compact.add(boundaryCallId!);
  renderedCalls.length = 0;
  renderedResults.length = 0;
  bridges.get(boundaryCallId!)?.invalidate();
  controller.renderNow();
  assert.ok(renderedCalls.includes(boundaryCallId!), "an invalidated omitted call was not reconsidered");
  assert.ok(renderedResults.includes(boundaryCallId!), "an invalidated omitted result was not reconsidered");
});

test("full TUI owns generation-bound tool renderers and falls back after expiry or failure", async () => {
  const { output, controller } = fullController();
  controller.start();
  const v1 = new AbortController();
  let v1Calls = 0;
  let shellCalls = 0;
  let liveBridge: { showImages: boolean; invalidate(): void } | undefined;
  let liveProgress: unknown;
  let completedView: Parameters<RuntimeToolRendererBinding["renderResult"]>[1] | undefined;
  const reconciledCalls: string[][] = [];
  let rendererDisposals = 0;
  controller.setToolRenderers({
    has: (name) => name === "read",
    renderShell: () => { shellCalls += 1; return "self"; },
    renderCall: (_name, view, _context, bridge) => {
      v1Calls += 1;
      liveBridge = bridge;
      if (view.progress !== undefined) {
        liveProgress = view.progress;
        assert.equal(Object.isFrozen(view), true);
        assert.equal(Object.isFrozen(view.progress), true);
      }
      const path = isRecordValue(view.input) ? view.input.path : undefined;
      return { lines: [{ spans: [{ text: `V1 CALL ${String(path)}`, role: "accent" }] }] };
    },
    renderResult: (_name, view) => {
      if (view.isPartial !== true) completedView = view;
      return { lines: [{ spans: [{
        text: `V1 ${view.isPartial === true ? "PARTIAL" : "RESULT"} ${view.result?.content ?? ""}`,
        role: "success",
      }] }] };
    },
    reconcile: (callIds) => { reconciledCalls.push([...callIds]); },
    dispose: () => { rendererDisposals += 1; },
  }, v1.signal);
  controller.render(envelope({ type: "tool_requested", callId: "one", name: "read", input: { path: "one.ts" }, index: 0 }, 1));
  controller.render(envelope({ type: "tool_started", callId: "one", name: "read", input: {}, index: 0, recoveryMode: "repeatable" }, 2));
  controller.render(envelope({
    type: "tool_progress",
    callId: "one",
    name: "read",
    index: 0,
    sequence: 0,
    progress: { type: "result", content: "one running", isError: false, metadata: { phase: "running" } },
  }, 3));
  controller.render(envelope({
    type: "tool_progress",
    callId: "one",
    name: "read",
    index: 0,
    sequence: 1,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "line",
      stdoutBytes: 4,
      stderrBytes: 0,
      elapsedMs: 25,
    },
  }, 4));
  await tick();
  assert.match(output.text, /V1 CALL one\.ts/u);
  assert.match(output.text, /V1 PARTIAL one running/u);
  assert.ok(shellCalls > 0);
  assert.equal(liveBridge?.showImages, true);
  assert.equal(isFunctionValue(liveBridge?.invalidate), true);
  assert.deepEqual(liveProgress, {
    output: "line",
    stdout: "line",
    stderr: "",
    stdoutBytes: 4,
    stderrBytes: 0,
    elapsedMs: 25,
    truncated: false,
  });
  assert.ok(reconciledCalls.some((callIds) => callIds.includes("one")));
  output.chunks.length = 0;
  controller.render(envelope({
    type: "tool_completed",
    callId: "one",
    name: "read",
    index: 0,
    isError: false,
    preview: "one result",
    result: {
      type: "tool_result",
      callId: "one",
      name: "read",
      content: "one result",
      contentBlocks: [
        { type: "text", text: "before" },
        { type: "image", mediaType: "image/png", data: "private-image-bytes" },
        { type: "text", text: "after" },
      ],
      isError: false,
      status: "warning",
      summary: "review",
      nextActions: ["continue"],
      usage: JSON.parse('{"inputTokens":2,"raw":{"secret":"provider-raw"}}'),
      addedToolNames: ["follow_up"],
    },
  }, 5));
  await tick();
  assert.match(output.text, /V1 RESULT one result/u);
  assert.deepEqual(completedView?.result?.contentBlocks, [
    { type: "text", text: "before" },
    { type: "image", mediaType: "image/png", index: 1 },
    { type: "text", text: "after" },
  ]);
  assert.equal(completedView?.result?.status, "warning");
  assert.equal(completedView?.result?.summary, "review");
  assert.deepEqual(completedView?.result?.nextActions, ["continue"]);
  assert.deepEqual(completedView?.result?.usage, { inputTokens: 2 });
  assert.deepEqual(completedView?.result?.addedToolNames, ["follow_up"]);
  assert.equal(completedView?.argsComplete, true);
  assert.equal(completedView?.executionStarted, true);
  assert.doesNotMatch(JSON.stringify(completedView), /private-image-bytes|provider-raw/u);
  assert.equal(Object.isFrozen(completedView?.result), true);
  assert.equal(Object.isFrozen(completedView?.result?.contentBlocks), true);

  const callsBeforeAbort = v1Calls;
  v1.abort(new Error("refresh"));
  output.chunks.length = 0;
  controller.render(envelope({ type: "tool_requested", callId: "two", name: "read", input: { path: "two.ts" }, index: 1 }, 6));
  await tick();
  assert.equal(rendererDisposals, 1);
  assert.equal(v1Calls, callsBeforeAbort);
  assert.match(terminalWords(output.text), /\bread · queued .*two\.ts\b/u);
  assert.doesNotMatch(output.text, /Read|◇/u);
  assert.doesNotMatch(output.text, /V1 CALL two\.ts/u);

  const failed = new AbortController();
  const rendererFailures: Array<{ name: string; slot: string }> = [];
  controller.setToolRenderers({
    has: () => true,
    renderCall: () => { throw new Error("renderer failed"); },
    renderResult: () => undefined,
    reportError: (failure) => { rendererFailures.push({ name: failure.name, slot: failure.slot }); },
  }, failed.signal);
  output.chunks.length = 0;
  controller.render(envelope({ type: "tool_requested", callId: "three", name: "read", input: { path: "three.ts" }, index: 2 }, 7));
  await tick();
  assert.match(terminalWords(output.text), /\bread · queued .*three\.ts\b/u);
  assert.doesNotMatch(output.text, /Read|◇/u);
  assert.deepEqual(rendererFailures, [{ name: "read", slot: "call" }]);
  controller.renderNow();
  controller.renderNow();
  assert.deepEqual(rendererFailures, [{ name: "read", slot: "call" }]);
  controller.close();
});

test("tool renderer slot failures fall back independently and dispose once", async () => {
  const { output, controller } = fullController();
  const generation = new AbortController();
  const failures: Array<{ name: string; slot: string }> = [];
  const reconciled: string[][] = [];
  let disposals = 0;
  controller.start();
  controller.setToolRenderers({
    has: (name) => name === "probe",
    renderCall: (_name, view) => view.callId === "bad-call"
      ? JSON.parse('{"lines":"invalid"}')
      : { lines: [{ spans: [{ text: `CUSTOM CALL ${view.callId}` }] }] },
    renderResult: (_name, view) => view.callId === "bad-result"
      ? { lines: Array.from({ length: 129 }, () => ({ spans: [{ text: "oversized" }] })) }
      : { lines: [{ spans: [{ text: `CUSTOM RESULT ${view.callId}` }] }] },
    reconcile: (callIds) => { reconciled.push([...callIds]); },
    dispose: () => { disposals += 1; },
    reportError: (failure) => { failures.push({ name: failure.name, slot: failure.slot }); },
  }, generation.signal);

  controller.render(envelope({
    type: "tool_requested",
    callId: "bad-call",
    name: "probe",
    input: { path: "bad-call.txt" },
    index: 0,
  }, 1));
  controller.render(envelope({
    type: "tool_completed",
    callId: "bad-call",
    name: "probe",
    index: 0,
    isError: false,
    preview: "bad-call-native",
  }, 2));
  controller.render(envelope({
    type: "tool_requested",
    callId: "bad-result",
    name: "probe",
    input: { path: "bad-result.txt" },
    index: 1,
  }, 3));
  controller.render(envelope({
    type: "tool_completed",
    callId: "bad-result",
    name: "probe",
    index: 1,
    isError: false,
    preview: "bad-result-native",
  }, 4));
  await tick();

  const rendered = terminalWords(output.text);
  assert.match(rendered, /\bprobe · done .*bad-call\.txt CUSTOM RESULT bad-call\b/u);
  assert.match(rendered, /CUSTOM CALL bad-result/u);
  assert.match(rendered, /bad-result-native/u);
  assert.deepEqual(failures, [
    { name: "probe", slot: "call" },
    { name: "probe", slot: "result" },
  ]);
  assert.ok(reconciled.some((callIds) => callIds.includes("bad-call") && callIds.includes("bad-result")));

  controller.clearTranscript();
  await tick();
  assert.ok(reconciled.some((callIds) => callIds.length === 0));
  generation.abort(new Error("renderer generation ended"));
  await tick();
  assert.equal(disposals, 1);
  controller.close();
  assert.equal(disposals, 1);
});

test("tool renderer failure notices redact credential-shaped exception text", async () => {
  const { output, controller } = fullController();
  const generation = new AbortController();
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  controller.start();
  controller.setToolRenderers({
    has: () => true,
    renderCall() {
      throw new Error(secret);
    },
    renderResult: () => undefined,
  }, generation.signal);
  controller.render(envelope({
    type: "tool_requested",
    callId: "redacted",
    name: "read",
    input: { path: "redacted.ts" },
    index: 0,
  }, 1));
  await tick();

  assert.match(output.text, /Tool call renderer failed for read: \[REDACTED\]/u);
  assert.doesNotMatch(output.text, new RegExp(secret, "u"));
  controller.close();
});

test("full TUI owns generation-bound direct session renderers with safe fallback", async () => {
  const { output, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const rendered: string[] = [];
  const expansionStates: boolean[] = [];
  controller.setSessionRenderers({
    renderEntry: (entry, options) => {
      rendered.push(entry.customType);
      expansionStates.push(options.expanded);
      const count = isRecordValue(entry.data) ? entry.data.count : undefined;
      return textComponent(`CUSTOM ENTRY ${String(count)}`);
    },
    renderMessage: (message, options) => {
      rendered.push(message.customType);
      expansionStates.push(options.expanded);
      return textComponent(`CUSTOM MESSAGE ${message.customType}`);
    },
  }, generation.signal);
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() { throw new Error("inherited serializer must not run"); },
    });
    controller.renderSessionEntry({
      type: "custom",
      id: "entry-30",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "counter",
      data: { count: 3 },
    });
  } finally {
    if (original === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
    else Object.defineProperty(Object.prototype, "toJSON", original);
  }
  controller.renderSessionEntry({
    type: "custom_message",
    id: "message-31",
    parentId: "entry-30",
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "notice",
    content: "safe fallback",
    details: { renderer: true },
    display: true,
  });
  await tick();
  assert.match(output.text, /CUSTOM ENTRY 3/u);
  assert.match(output.text, /CUSTOM MESSAGE notice/u);
  assert.deepEqual(rendered, ["counter", "notice"]);
  assert.deepEqual(expansionStates, [false, false]);

  rendered.length = 0;
  expansionStates.length = 0;
  assert.equal(controller.toggleTool(), true);
  await tick();
  assert.deepEqual(rendered, ["counter", "notice"]);
  assert.deepEqual(expansionStates, [true, true]);

  generation.abort(new Error("extension generation refreshed"));
  output.chunks.length = 0;
  controller.clearTranscript();
  controller.renderSessionEntry({
    type: "custom_message",
    id: "message-32",
    parentId: null,
    timestamp: "2026-01-01T00:00:02.000Z",
    customType: "fallback",
    content: "SAFE FALLBACK",
    details: { secret: "must stay renderer-only" },
    display: true,
  });
  await tick();
  assert.match(terminalWords(output.text), /fallback SAFE FALLBACK/u);
  assert.doesNotMatch(output.text, /must stay renderer-only|CUSTOM MESSAGE/u);
  assert.throws(() => controller.renderSessionEntry(JSON.parse('{"type":"message"}')), /direct custom entry/u);
  controller.close();
});

test("full TUI replaces a large transcript in one redraw and renders only live extension session entries", async () => {
  const { output, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const renderedStates: string[] = [];
  const renderedMessages: string[] = [];
  controller.setSessionRenderers({
    renderEntry: (entry) => {
      renderedStates.push(entry.customType);
      return textComponent(`ENTRY ${entry.customType}`);
    },
    renderMessage: (message) => {
      renderedMessages.push(message.customType);
      return textComponent(`MESSAGE ${message.customType}`);
    },
  }, generation.signal);
  await tick();
  const renderNow = controller.renderNow.bind(controller);
  let redraws = 0;
  controller.renderNow = () => {
    redraws += 1;
    renderNow();
  };

  const events: TuiTranscriptItem[] = [{
    type: "custom" as const,
    id: "custom-pruned",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "pruned",
    data: { state: "old" },
  }];
  for (let sequence = 2; sequence <= 10_001; sequence += 1) {
    events.push(envelope({
      type: "warning",
      code: `history-${sequence}`,
      message: `Saved transcript event ${sequence}`,
    }, sequence));
  }
  events.push(
    {
      type: "custom_message" as const,
      id: "hidden-replay",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "hidden",
      content: "private",
      details: { private: true },
      display: false,
    },
    {
      type: "custom" as const,
      id: "custom-live",
      parentId: null,
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "live",
      data: { state: "current" },
    },
    {
      type: "custom_message" as const,
      id: "visible-replay",
      parentId: null,
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "visible",
      content: "safe fallback",
      details: { renderer: true },
      display: true,
    },
  );

  output.chunks.length = 0;
  controller.replaceTranscript(events, "resume/main");
  assert.equal(output.chunks.length, 0, "bulk replacement must defer terminal output to the scheduled redraw");
  assert.equal(redraws, 0);
  await tick();

  assert.equal(redraws, 1);
  assert.ok(output.chunks.length > 0);
  assert.deepEqual(renderedStates, ["live"]);
  assert.deepEqual(renderedMessages, ["visible"]);
  assert.match(output.text, /ENTRY live/u);
  assert.match(output.text, /MESSAGE visible/u);
  assert.doesNotMatch(output.text, /ENTRY pruned|MESSAGE hidden/u);
  controller.close();
});

test("native detail prewarming yields until after paint and cancels across resize and suspend", async (context) => {
  const { output, controller, toolDetailCache } = fullController();
  context.after(() => controller.close());
  controller.start();
  let sequence = 0;
  const renderCompleted = (callId: string, payload: string, index: number): { payload: string } => {
    const input = { payload };
    controller.render(envelope({
      type: "tool_requested",
      callId,
      name: "native_lifecycle_probe",
      input,
      index,
    }, ++sequence));
    controller.render(envelope({
      type: "tool_completed",
      callId,
      name: "native_lifecycle_probe",
      index,
      isError: false,
      preview: "",
      result: { type: "tool_result", callId, name: "native_lifecycle_probe", content: "", isError: false },
    }, ++sequence));
    return input;
  };
  const detail = (input: { payload: string }) => ({
    kind: "input" as const,
    label: "Input",
    value: JSON.stringify(input, null, 2),
  });

  const synchronous = renderCompleted("native-lifecycle-sync", `sync-${"s".repeat(700)}`, 0);
  const idle = renderCompleted("native-lifecycle-idle", `idle-${"i".repeat(700)}`, 1);
  controller.renderNow();
  assert.equal(
    internalPrewarmOhmNativeToolDetail(detail(synchronous), 80, "", toolDetailCache),
    true,
    "hidden details were warmed synchronously before the visible frame returned",
  );
  for (let turn = 0; turn < 3; turn += 1) await tick();
  assert.equal(internalPrewarmOhmNativeToolDetail(detail(idle), 80, "", toolDetailCache), false);

  const resized = renderCompleted("native-lifecycle-resize", `resize-${"r".repeat(700)}`, 2);
  controller.renderNow();
  output.resize(100, 30);
  for (let turn = 0; turn < 3; turn += 1) await tick();
  assert.equal(
    internalPrewarmOhmNativeToolDetail(detail(resized), 80, "", toolDetailCache),
    true,
    "the stale-width idle task survived resize cancellation",
  );
  assert.equal(internalPrewarmOhmNativeToolDetail(detail(resized), 100, "", toolDetailCache), false);

  if (process.platform !== "win32") {
    const suspended = renderCompleted("native-lifecycle-suspend", `suspend-${"u".repeat(700)}`, 3);
    controller.renderNow();
    controller.suspend(() => undefined);
    await tick();
    assert.equal(
      internalPrewarmOhmNativeToolDetail(detail(suspended), 100, "", toolDetailCache),
      true,
      "idle work continued after terminal suspension",
    );
  }

  const closing = fullController();
  context.after(() => closing.controller.close());
  closing.controller.start();
  const closingInput = { payload: `close-${"q".repeat(700)}` };
  closing.controller.render(envelope({
    type: "tool_requested",
    callId: "native-lifecycle-close",
    name: "native_lifecycle_probe",
    input: closingInput,
    index: 0,
  }, 1));
  closing.controller.render(envelope({
    type: "tool_completed",
    callId: "native-lifecycle-close",
    name: "native_lifecycle_probe",
    index: 0,
    isError: false,
    preview: "",
    result: { type: "tool_result", callId: "native-lifecycle-close", name: "native_lifecycle_probe", content: "", isError: false },
  }, 2));
  closing.controller.renderNow();
  closing.input.write("x");
  closing.controller.close();
  await tick();
  assert.equal(
    internalPrewarmOhmNativeToolDetail(detail(closingInput), 80, "", closing.toolDetailCache),
    true,
    "idle work continued after terminal input and close",
  );
});

test("native detail caches are controller-scoped and cleared with transcript lifecycle", () => {
  let projectorClears = 0;
  const frameProjector = Object.assign(createFixtureFrameProjector(), {
    [INTERNAL_TUI_FRAME_PROJECTOR_CLEAR]: () => { projectorClears += 1; },
  });
  const first = fullController({ frameProjector });
  const second = fullController();
  const detail = {
    kind: "output" as const,
    label: "Output",
    value: `controller-cache-lifecycle ${"x".repeat(180)}`,
  };

  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 80, "", first.toolDetailCache), true);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 80, "", first.toolDetailCache), false);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 80, "", second.toolDetailCache), true);

  first.controller.clearTranscript();
  assert.equal(projectorClears, 1);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 80, "", first.toolDetailCache), true);
  first.controller.close();
  assert.equal(projectorClears, 2);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 80, "", first.toolDetailCache), true);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 80, "", second.toolDetailCache), false);
  second.controller.close();
});

test("native detail prewarming survives dynamic Markdown and skips custom renderers and live tools", async (context) => {
  const controllers: TuiController[] = [];
  const generations: AbortController[] = [];
  context.after(() => {
    for (const generation of generations) generation.abort();
    for (const controller of controllers) controller.close();
  });
  const detail = (input: { payload: string }) => ({
    kind: "input" as const,
    label: "Input",
    value: JSON.stringify(input, null, 2),
  });
  const waitForIdleTurns = async (): Promise<void> => {
    for (let turn = 0; turn < 4; turn += 1) await tick();
  };

  const dynamic = fullController();
  controllers.push(dynamic.controller);
  const dynamicGeneration = new AbortController();
  generations.push(dynamicGeneration);
  dynamic.controller.setSessionRenderers({
    renderEntry: () => undefined,
    renderMessage: () => undefined,
    transformMarkdown: (markdown) => markdown,
  }, dynamicGeneration.signal);
  dynamic.controller.start();
  const dynamicInput = { payload: `dynamic-${"d".repeat(700)}` };
  dynamic.controller.render(envelope({
    type: "tool_requested",
    callId: "native-dynamic-skip",
    name: "native_dynamic_probe",
    input: dynamicInput,
    index: 0,
  }, 1));
  dynamic.controller.render(envelope({
    type: "tool_completed",
    callId: "native-dynamic-skip",
    name: "native_dynamic_probe",
    index: 0,
    isError: false,
    preview: "",
    result: { type: "tool_result", callId: "native-dynamic-skip", name: "native_dynamic_probe", content: "", isError: false },
  }, 2));
  await waitForIdleTurns();
  assert.equal(internalPrewarmOhmNativeToolDetail(detail(dynamicInput), 80, "", dynamic.toolDetailCache), false);

  const custom = fullController();
  controllers.push(custom.controller);
  const customGeneration = new AbortController();
  generations.push(customGeneration);
  custom.controller.setToolRenderers({
    has: (name) => name === "native_custom_probe",
    renderCall: (_name, view) => ({ lines: [{ spans: [{ text: `custom ${view.callId}` }] }] }),
    renderResult: () => undefined,
  }, customGeneration.signal);
  custom.controller.start();
  const customInput = { payload: `custom-${"c".repeat(700)}` };
  custom.controller.render(envelope({
    type: "tool_requested",
    callId: "native-custom-skip",
    name: "native_custom_probe",
    input: customInput,
    index: 0,
  }, 1));
  custom.controller.render(envelope({
    type: "tool_completed",
    callId: "native-custom-skip",
    name: "native_custom_probe",
    index: 0,
    isError: false,
    preview: "",
    result: { type: "tool_result", callId: "native-custom-skip", name: "native_custom_probe", content: "", isError: false },
  }, 2));
  const fallbackInput = { payload: `fallback-${"f".repeat(700)}` };
  custom.controller.render(envelope({
    type: "tool_requested",
    callId: "native-fallback-warm",
    name: "native_fallback_probe",
    input: fallbackInput,
    index: 1,
  }, 3));
  custom.controller.render(envelope({
    type: "tool_completed",
    callId: "native-fallback-warm",
    name: "native_fallback_probe",
    index: 1,
    isError: false,
    preview: "",
    result: { type: "tool_result", callId: "native-fallback-warm", name: "native_fallback_probe", content: "", isError: false },
  }, 4));
  await waitForIdleTurns();
  assert.equal(internalPrewarmOhmNativeToolDetail(detail(customInput), 80, "", custom.toolDetailCache), true);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail(fallbackInput), 80, "", custom.toolDetailCache), false);

  const live = fullController();
  controllers.push(live.controller);
  live.controller.start();
  const liveInput = { payload: `live-${"l".repeat(700)}` };
  live.controller.render(envelope({
    type: "tool_requested",
    callId: "native-live-skip",
    name: "native_live_probe",
    input: liveInput,
    index: 0,
  }, 1));
  live.controller.render(envelope({
    type: "tool_started",
    callId: "native-live-skip",
    name: "native_live_probe",
    input: liveInput,
    index: 0,
    recoveryMode: "never_repeat",
  }, 2));
  await waitForIdleTurns();
  assert.equal(internalPrewarmOhmNativeToolDetail(detail(liveInput), 80, "", live.toolDetailCache), true);
});

test("idle native detail prewarming covers the full retained tool history without evicting visible wraps", async (context) => {
  const { controller, toolDetailCache } = fullController();
  context.after(() => controller.close());
  controller.start();
  let sequence = 0;
  const inputs = Array.from({ length: 2_000 }, (_, index) => ({
    payload: `idle-prewarm-${index}-${"x".repeat(96)}`,
  }));
  for (const [index, input] of inputs.entries()) {
    const callId = `idle-prewarm-${index}`;
    const output = `idle-output-${index}-${"y".repeat(96)}`;
    controller.render(envelope({
      type: "tool_requested",
      callId,
      name: "native_hidden_probe",
      input,
      index,
    }, ++sequence));
    controller.render(envelope({
      type: "tool_completed",
      callId,
      name: "native_hidden_probe",
      index,
      isError: false,
      preview: output,
      result: { type: "tool_result", callId, name: "native_hidden_probe", content: output, isError: false },
    }, ++sequence));
  }
  await tick();
  for (let turn = 0; turn < 300; turn += 1) await tick();

  for (const input of [inputs[0]!, inputs.at(-1)!]) {
    assert.equal(internalPrewarmOhmNativeToolDetail({
      kind: "input",
      label: "Input",
      value: JSON.stringify(input, null, 2),
    }, 80, "", toolDetailCache), false, "the bounded idle pass did not reach both ends of the retained history");
  }
  for (const [index, output] of [
    [0, `idle-output-0-${"y".repeat(96)}`],
    [inputs.length - 1, `idle-output-${inputs.length - 1}-${"y".repeat(96)}`],
  ] as const) {
    assert.equal(internalPrewarmOhmNativeToolDetail({
      kind: "output",
      label: "Output",
      value: output,
      preview: true,
    }, 80, "", toolDetailCache), false, `visible detail ${index} was evicted while hidden history warmed`);
  }
});

test("first tool expansion and expanded history updates stay responsive", async () => {
  const { output, controller } = fullController();
  controller.start();
  let sequence = 0;
  const content = Array.from(
    { length: 300 },
    (_, index) => `write line ${index + 1} ${"x".repeat(48)}`,
  ).join("\n");
  for (let index = 0; index < 16; index += 1) {
    const callId = `cached-write-${index}`;
    controller.render(envelope({
      type: "tool_requested",
      callId,
      name: "write",
      input: { path: `cached-${index}.ts`, content },
      index,
    }, ++sequence));
    controller.render(envelope({ type: "tool_started", callId, name: "write", input: {}, index, recoveryMode: "never_repeat" }, ++sequence));
    controller.render(envelope({
      type: "tool_completed",
      callId,
      name: "write",
      index,
      isError: false,
      preview: "",
      result: { type: "tool_result", callId, name: "write", content: "", isError: false },
    }, ++sequence));
  }
  await tick();
  const firstToggleStartedAt = performance.now();
  assert.equal(controller.toggleTool(), true);
  controller.renderNow();
  const firstToggleElapsedMs = performance.now() - firstToggleStartedAt;
  const firstToggleBudgetMs = process.env.NODE_V8_COVERAGE === undefined ? 125 : 250;
  assert.ok(
    firstToggleElapsedMs < firstToggleBudgetMs,
    `first tool expansion took ${firstToggleElapsedMs.toFixed(1)}ms (limit ${firstToggleBudgetMs}ms)`,
  );

  const samples: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const startedAt = performance.now();
    controller.renderNow();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[3]! < 75, `expanded unchanged frame took ${samples[3]!.toFixed(1)}ms`);

  const collapseStartedAt = performance.now();
  assert.equal(controller.toggleTool(), true);
  controller.renderNow();
  const collapseElapsedMs = performance.now() - collapseStartedAt;
  const warmToggleBudgetMs = process.env.NODE_V8_COVERAGE === undefined ? 75 : 150;
  assert.ok(collapseElapsedMs < warmToggleBudgetMs, `tool collapse took ${collapseElapsedMs.toFixed(1)}ms`);

  const reexpandStartedAt = performance.now();
  assert.equal(controller.toggleTool(), true);
  controller.renderNow();
  const reexpandElapsedMs = performance.now() - reexpandStartedAt;
  assert.ok(reexpandElapsedMs < warmToggleBudgetMs, `warm tool re-expansion took ${reexpandElapsedMs.toFixed(1)}ms`);

  const liveCallId = "cached-live-shell";
  controller.render(envelope({
    type: "tool_requested",
    callId: liveCallId,
    name: "bash",
    input: { command: "stream output" },
    index: 16,
  }, ++sequence));
  controller.render(envelope({ type: "tool_started", callId: liveCallId, name: "bash", input: {}, index: 16, recoveryMode: "never_repeat" }, ++sequence));
  await tick();
  output.chunks.length = 0;
  const liveOutput = `${Array.from({ length: 1_000 }, (_, index) => `old-${index}`).join("\n")}\nlatest-live-sentinel`;
  controller.render(envelope({
    type: "tool_progress",
    callId: liveCallId,
    name: "bash",
    index: 16,
    sequence: 0,
    progress: {
      type: "output",
      stream: "stdout",
      delta: liveOutput,
      stdoutBytes: Buffer.byteLength(liveOutput),
      stderrBytes: 0,
      elapsedMs: 100,
    },
  }, ++sequence));
  const liveStartedAt = performance.now();
  controller.renderNow();
  const liveElapsedMs = performance.now() - liveStartedAt;
  assert.ok(liveElapsedMs < 75, `expanded live-update frame took ${liveElapsedMs.toFixed(1)}ms`);
  await tick();
  assert.match(output.text, /latest-live-sentinel/u);
  controller.close();
});

test("global detail toggles reuse unrelated long rich history", async () => {
  const { controller } = fullController({ frameProjector: internalCreateRichTuiFrameProjector() });
  const history: TuiTranscriptItem[] = Array.from({ length: 1_000 }, (_, index) => envelope({
    type: "message_appended" as const,
    message: {
      id: `toggle-cache-${index}`,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `retained response ${index} ${"x".repeat(900)}` }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, index + 1));
  const toolTail = Array.from({ length: 20 }, (_, index) =>
    `collapsed tool tail ${index + 1} ${"x".repeat(44)}`).join("\n");
  history.push(envelope({
    type: "tool_requested",
    callId: "toggle-cache-tool-tail",
    name: "read",
    input: { path: "toggle-cache-tail.txt" },
    index: 0,
  }, 1_001), envelope({
    type: "tool_completed",
    callId: "toggle-cache-tool-tail",
    name: "read",
    index: 0,
    isError: false,
    preview: toolTail,
    result: {
      type: "tool_result",
      callId: "toggle-cache-tool-tail",
      name: "read",
      content: toolTail,
      isError: false,
    },
  }, 1_002));
  controller.start();
  controller.replaceTranscript(history, "toggle-cache");
  await tick();
  controller.renderNow();
  assert.equal(controller.getToolOutputExpanded(), false);

  const detailsStartedAt = performance.now();
  assert.equal(controller.toggleTool(), true);
  controller.renderNow();
  const detailsElapsedMs = performance.now() - detailsStartedAt;
  assert.ok(detailsElapsedMs < 50, `unrelated Ctrl+O history took ${detailsElapsedMs.toFixed(1)}ms`);

  controller.replaceTranscript([...history, envelope({
    type: "message_appended",
    message: {
      id: "toggle-cache-reasoning",
      role: "assistant",
      content: [{ type: "thinking", thinking: "reasoning tail sentinel", visibility: "summary" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 1_003)], "toggle-cache-reasoning");
  await tick();
  controller.renderNow();
  const reasoningStartedAt = performance.now();
  assert.equal(controller.toggleReasoning(), true);
  controller.renderNow();
  const reasoningElapsedMs = performance.now() - reasoningStartedAt;
  assert.ok(reasoningElapsedMs < 75, `reasoning-tail Ctrl+T took ${reasoningElapsedMs.toFixed(1)}ms`);

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1_004));
  controller.render(envelope({
    type: "tool_requested",
    callId: "toggle-cache-live-tool",
    name: "bash",
    input: { command: "stream output" },
    index: 0,
  }, 1_005));
  controller.render(envelope({
    type: "tool_started",
    callId: "toggle-cache-live-tool",
    name: "bash",
    input: { command: "stream output" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 1_006));
  await tick();
  controller.renderNow();
  const progressStartedAt = performance.now();
  controller.render(envelope({
    type: "tool_progress",
    callId: "toggle-cache-live-tool",
    name: "bash",
    index: 0,
    sequence: 0,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "latest native history tail",
      stdoutBytes: Buffer.byteLength("latest native history tail"),
      stderrBytes: 0,
      elapsedMs: 10,
    },
  }, 1_007));
  controller.renderNow();
  const progressElapsedMs = performance.now() - progressStartedAt;
  assert.ok(progressElapsedMs < 75, `native long-history update took ${progressElapsedMs.toFixed(1)}ms`);
  controller.close();
});

test("near-limit transcript keeps active tool updates and wheel paging responsive", async (context) => {
  const { input, output, controller } = fullController();
  context.after(() => controller.close());
  output.resize(100, 30);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  const generation = new AbortController();
  controller.setSessionRenderers({
    renderEntry: () => undefined,
    renderMessage: () => undefined,
    transformMarkdown: (markdown) => markdown,
  }, generation.signal);
  await tick();
  const historyBody = `${"alpha beta gamma delta ".repeat(42)}\n${"second retained row ".repeat(25)}`;
  controller.replaceTranscript(Array.from({ length: 1_000 }, (_, index) => envelope({
    type: "message_appended",
    message: {
      id: `cached-history-${index}`,
      role: "assistant",
      content: [{ type: "text", text: `cached-history-${index} ${historyBody}` }],
      stopReason: "stop",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, index + 1)), "main");
  await tick();
  controller.renderNow();
  flush();

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1_001));
  controller.render(envelope({
    type: "tool_requested",
    callId: "cached-history-live-tool",
    name: "bash",
    input: { command: "stream output" },
    index: 0,
  }, 1_002));
  controller.render(envelope({
    type: "tool_started",
    callId: "cached-history-live-tool",
    name: "bash",
    input: { command: "stream output" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 1_003));
  await tick();

  const updateSamples: number[] = [];
  for (let sequence = 0; sequence < 3; sequence++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updateStartedAt = performance.now();
    controller.render(envelope({
      type: "tool_progress",
      callId: "cached-history-live-tool",
      name: "bash",
      index: 0,
      sequence,
      progress: {
        type: "output",
        stream: "stdout",
        delta: `cached-history-live-tail-${sequence}\n`,
        stdoutBytes: 27 * (sequence + 1),
        stderrBytes: 0,
        elapsedMs: 120 + sequence,
      },
    }, 1_004 + sequence));
    controller.renderNow();
    updateSamples.push(performance.now() - updateStartedAt);
  }
  const updateMedianMs = [...updateSamples].sort((left, right) => left - right)[1]!;
  // V8 coverage rewrites the hot render path; ordinary runs enforce the interactive budgets below.
  const coverageInstrumented = process.env.NODE_V8_COVERAGE !== undefined;
  const liveToolFrameBudgetMs = coverageInstrumented ? 200
    : process.env.CI === "true" && process.platform === "win32" ? 125
    : process.env.CI === "true" ? 100 : 75;
  assert.ok(updateMedianMs < liveToolFrameBudgetMs, `near-limit live tool median frame took ${updateMedianMs.toFixed(1)}ms`);
  flush();
  assert.match(terminal.viewport().join("\n"), /cached-history-live-tail-2/u);

  const wheelStartedAt = performance.now();
  input.write("\u001b[<64;10;8M".repeat(12));
  await tick();
  const wheelMs = performance.now() - wheelStartedAt;
  const wheelFrameBudgetMs = coverageInstrumented ? 200
    : process.env.CI === "true" ? 125 : 75;
  assert.ok(wheelMs < wheelFrameBudgetMs, `near-limit wheel frame took ${wheelMs.toFixed(1)}ms`);
  flush();
  assert.match(terminal.viewport().join("\n"), /cached-history-\d+/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /cached-history-live-tail-2/u);
});

test("expanded large edit completion shows its authoritative diff on the differential render path", async () => {
  const { output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  let sequence = 0;
  const callId = "large-edit-completion";
  const edits = Array.from({ length: 6 }, (_, index) => ({
    oldText: `old-${index}\n${"x".repeat(2_000)}`,
    newText: `new-${index}\n${"y".repeat(2_000)}`,
  }));
  controller.render(envelope({
    type: "tool_requested",
    callId,
    name: "edit",
    input: { path: "src/large-edit.ts", edits },
    index: 0,
  }, ++sequence));
  controller.render(envelope({
    type: "tool_started",
    callId,
    name: "edit",
    input: {},
    index: 0,
    recoveryMode: "never_repeat",
  }, ++sequence));
  await tick();
  assert.equal(controller.toggleTool(), true);
  await tick();
  controller.renderNow();
  flush();
  const redraws = controller.rawFullRedraws();
  const updateStart = output.chunks.length;
  const patch = [
    "--- a/src/large-edit.ts",
    "+++ b/src/large-edit.ts",
    "@@ -100 +100 @@",
    "-before-completion",
    "+large-edit-sentinel",
  ].join("\n");

  controller.render(envelope({
    type: "tool_completed",
    callId,
    name: "edit",
    index: 0,
    isError: false,
    preview: "Applied 6 replacements to src/large-edit.ts.",
    result: {
      type: "tool_result",
      callId,
      name: "edit",
      content: "Applied 6 replacements to src/large-edit.ts.",
      isError: false,
      metadata: { replacements: 6, diff: "", patch },
    },
  }, ++sequence));
  controller.renderNow();
  await tick();
  const update = Buffer.concat(output.chunks.slice(updateStart)).toString("utf8");
  flush();

  assert.equal(controller.rawFullRedraws(), redraws);
  assert.doesNotMatch(update, terminalPattern("\\u001b\\[2J", "u"));
  const viewport = terminal.viewport().join("\n");
  assert.match(
    terminalWords(viewport),
    /edit · done .*large-edit\.ts · 6 edits · 12 to 12 lines · 12,036 to 12,036 bytes/u,
  );
  assert.match(viewport, /--- a\/src\/large-edit\.ts[\s\S]*\+\+\+ b\/src\/large-edit\.ts/u);
  assert.match(viewport, /-before-completion[\s\S]*\+large-edit-sentinel/u);
  assert.match(viewport, /Applied 6 replacements/u);
  controller.close();
});

test("runtime presentation replacement clears stale UI and blocks input without losing the draft", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  const answer = controller.question("you> ");
  input.write("keep draft");
  controller.setExtensionStatus("old:status", "old status");
  controller.setExtensionWidget("old:widget", "old widget");
  controller.setCommandItems([{ id: "old-command", label: "/old-command", value: "/old-command" }]);
  controller.setInputBlocked("Refreshing keybindings, extensions, skills, prompts, themes, and context files...", "refresh");
  input.write(" ignored");
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.match(output.text, /Refreshing keybindings/u);
  assert.doesNotMatch(output.text, /refresh> /u);
  assert.equal(actions.at(-1)?.type, "cancel");

  controller.clearExtensionUi();
  controller.setCommandItems([{ id: "new-command", label: "/new-command", value: "/new-command" }]);
  controller.setInputBlocked();
  output.chunks.length = 0;
  controller.openPicker("command", "Commands");
  input.write("new-command");
  await tick();
  assert.match(output.text, /new-command/u);
  assert.doesNotMatch(output.text, /old-command|old status|old widget/u);
  input.write(Buffer.from([3]));
  input.write("\r");
  assert.equal(await answer, "keep draft");
  controller.close();
});

test("blocked operations keep the composer unlabeled", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setInputBlocked("Reading clipboard…", "clipboard");
  await tick();
  assert.match(output.text, /Reading clipboard…/u);
  assert.doesNotMatch(output.text, /(?:clipboard|refresh)> /u);
  controller.close();
});

test("settings picker cycles values, blocks overlapping saves, and closes without changing the draft", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setEditorText("keep this draft");
  let release!: () => void;
  const saving = new Promise<void>((resolve) => { release = resolve; });
  const changes: Array<{ id: string; previous: string; next: string }> = [];
  const settings = controller.chooseSettings([
    {
      id: "thinking",
      label: "Thinking",
      description: "Reasoning effort for the selected model",
      value: "medium",
      values: ["low", "medium", "high"],
    },
    {
      id: "theme",
      label: "Theme",
      description: "Terminal color theme",
      value: "dark",
      values: ["dark", "light"],
    },
  ], (item, next) => {
    changes.push({ id: item.id, previous: item.value, next });
    return changes.length === 1 ? saving : undefined;
  });
  await tick();
  assert.match(output.text, /Settings/u);
  assert.match(output.text, /Thinking/u);
  assert.match(output.text, /Reasoning effort/u);

  input.write("\u001b[C");
  await tick();
  assert.deepEqual(changes, [{ id: "thinking", previous: "medium", next: "high" }]);
  assert.match(output.text, /Saving Thinking/u);
  input.write("\u001b[C");
  await tick();
  assert.equal(changes.length, 1, "a pending settings write must serialize further changes");
  release();
  await tick();

  input.write("\u001b[D");
  await tick();
  assert.deepEqual(changes[1], { id: "thinking", previous: "high", next: "medium" });
  input.write(Buffer.from([27]));
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  await settings;
  assert.equal(controller.getEditorText(), "keep this draft");
  controller.close();
});

test("settings picker reports failed writes, restores values, and supports bounded navigation and search", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  let rejectSave!: (cause: Error) => void;
  const failedSave = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  let writes = 0;
  const settings = controller.chooseSettings([
    { id: "alpha", label: "Alpha", description: "First option", value: "one", values: ["one", "two"] },
    { id: "beta", label: "Beta", description: "Second option", value: "off", values: ["off", "on"] },
  ], () => {
    writes += 1;
    if (writes === 1) return failedSave;
    throw new Error("settings store is read-only");
  });
  input.write("\u001b[C");
  await tick();
  rejectSave(new Error("disk full"));
  await tick();
  assert.match(output.text, /Could not save Alpha: disk full/u);

  input.write("\u001b[C");
  await tick();
  assert.equal(writes, 2);
  assert.match(output.text, /settings store is read-only/u);
  input.write("\u001b[B\u001b[6~\u001b[5~\u001b[A");
  input.write("beta");
  input.write(Buffer.from([127]));
  input.write("\u001b[3~");
  input.write(Buffer.from([21]));
  await tick();
  assert.match(output.text, /Alpha/u);

  input.write(Buffer.from([3]));
  await settings;
  controller.close();
});

test("settings picker uses Space to apply only before a search query starts", async () => {
  const { input, controller } = fullController();
  controller.start();
  const changes: Array<{ previous: string; next: string }> = [];
  const settings = controller.chooseSettings([
    { id: "ui-mode", label: "UI mode", description: "Terminal presentation", value: "regular", values: ["regular", "fullscreen"] },
  ], (item, next) => { changes.push({ previous: item.value, next }); });

  input.write(" ");
  await tick();
  assert.deepEqual(changes, [{ previous: "regular", next: "fullscreen" }]);

  input.write("UI mode");
  await tick();
  assert.deepEqual(changes, [{ previous: "regular", next: "fullscreen" }]);
  input.write("\r");
  await tick();
  assert.deepEqual(changes, [
    { previous: "regular", next: "fullscreen" },
    { previous: "fullscreen", next: "regular" },
  ]);

  input.write(Buffer.from([3]));
  await settings;
  controller.close();
});

test("settings picker rejects unavailable, invalid, overlapping, and cancelled menus", async () => {
  const { input, controller } = fullController();
  controller.start();
  await assert.rejects(controller.chooseSettings([], () => undefined), /No settings are available/u);
  assert.throws(() => controller.chooseSettings([
    { id: "Bad Setting", label: "Bad", description: "bad id", value: "on", values: ["on"] },
  ], () => undefined), /Invalid setting definition/u);
  assert.throws(() => controller.chooseSettings([
    { id: "empty", label: "Empty", description: "no values", value: "", values: [] },
  ], () => undefined), /Invalid setting definition/u);
  assert.throws(() => controller.chooseSettings([
    { id: "missing", label: "Missing", description: "unknown current value", value: "other", values: ["known"] },
  ], () => undefined), /Invalid setting definition/u);

  controller.openPicker("command", "Commands");
  await assert.rejects(controller.chooseSettings([
    { id: "theme", label: "Theme", description: "colors", value: "dark", values: ["dark", "light"] },
  ], () => undefined), /Another terminal picker is active/u);
  input.write(Buffer.from([3]));
  const aborted = new AbortController();
  aborted.abort(new Error("settings request cancelled"));
  assert.throws(() => controller.chooseSettings([
    { id: "theme", label: "Theme", description: "colors", value: "dark", values: ["dark", "light"] },
  ], () => undefined, aborted.signal), /settings request cancelled/u);
  controller.close();
});

test("controller exposes pending attachments, recovered queue ownership, and runtime chrome setters", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.insertClipboardText("clipboard text");
  assert.equal(controller.getEditorText(), "clipboard text");
  const attachment = inputImage("pending image");
  controller.attachInputImage(attachment);
  assert.deepEqual(controller.takePendingInputImages(), [attachment]);
  assert.deepEqual(controller.takePendingInputImages(), []);

  const recovered = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
  controller.restoreQueuedMessages([{ mode: "follow_up", text: "restored", images: [recovered] }]);
  assert.deepEqual(controller.takePendingRecoveredImages(), [recovered]);
  assert.deepEqual(controller.takePendingRecoveredImages(), []);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "restored\n\nclipboard text");
  assert.equal(controller.takeSubmittedRecoveredQueueDraft(), true);
  assert.equal(controller.takeSubmittedRecoveredQueueDraft(), false);

  controller.setExtensionHeader("fixture", "header\nvalue");
  controller.setExtensionFooter("fixture", "footer\nvalue");
  await tick();
  assert.match(terminalWords(output.text), /header value/u);
  assert.match(terminalWords(output.text), /footer value/u);
  controller.setExtensionHeader("fixture");
  controller.setExtensionFooter("fixture", "");

  let interrupted = 0;
  controller.setInterruptHandler(() => { interrupted += 1; });
  input.write(Buffer.from([27]));
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(interrupted, 1);
  controller.setInterruptHandler(undefined);
  controller.setDoubleEscapeAction("none");
  controller.close();
});

test("extension text chrome is removed when its owning generation ends", async () => {
  const { output, controller } = fullController();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  controller.start();
  const generation = new AbortController();
  controller.setExtensionStatus("fixture:status", "OWNED STATUS", generation.signal);
  controller.setExtensionWidget("fixture:widget", "OWNED WIDGET", generation.signal);
  controller.setExtensionHeader("fixture:header", "OWNED HEADER", generation.signal);
  controller.setExtensionFooter("fixture:footer", "OWNED FOOTER", generation.signal);
  controller.setExtensionWorkingMessage("fixture", "OWNED WORK", generation.signal);
  controller.setExtensionWorkingVisible("fixture", true, generation.signal);
  controller.setKeyedTitle("fixture:title", "owned title", generation.signal);
  await tick();
  flush();
  const active = terminal.viewport().join("\n");
  assert.match(active, /OWNED STATUS/u);
  assert.match(active, /OWNED WIDGET/u);
  assert.match(active, /OWNED HEADER/u);
  assert.match(active, /OWNED FOOTER/u);
  assert.equal(controller.footerDataSnapshot().workingMessage, "OWNED WORK");
  assert.equal(controller.footerDataSnapshot().workingVisible, true);

  generation.abort(new Error("generation replaced"));
  await tick();
  flush();
  const released = terminal.viewport().join("\n");
  assert.doesNotMatch(released, /OWNED STATUS|OWNED WIDGET|OWNED HEADER|OWNED FOOTER|OWNED WORK/u);
  assert.equal(controller.footerDataSnapshot().workingMessage, undefined);
  assert.equal(controller.footerDataSnapshot().workingVisible, undefined);
  const titles = [...output.text.matchAll(terminalPattern("\\u001b\\]0;([^\\u0007]*)\\u0007", "gu"))];
  assert.equal(titles.at(-1)?.[1], "ohm");
  controller.close();
});

test("closing the controller releases generation-owned listeners and extension chrome", () => {
  const { controller } = fullController();
  const generation = new AbortController();
  controller.setExtensionStatus("fixture:status", "status", generation.signal);
  controller.setExtensionWidget("fixture:widget", "widget", generation.signal);
  controller.setExtensionHeader("fixture:header", "header", generation.signal);
  controller.setExtensionFooter("fixture:footer", "footer", generation.signal);
  controller.setExtensionWorkingMessage("fixture", "work", generation.signal);
  controller.setExtensionWorkingVisible("fixture", true, generation.signal);
  controller.setKeyedTitle("fixture:title", "title", generation.signal);
  controller.registerUnsafeTerminalInputHandler(() => undefined, generation.signal);
  controller.onThemeChange(() => undefined, generation.signal);

  assert.equal(getEventListeners(generation.signal, "abort").length, 9);
  assert.equal(controller.extensionStatusSnapshot().get("fixture:status"), "status");
  assert.equal(controller.footerDataSnapshot().workingMessage, "work");
  assert.equal(controller.footerDataSnapshot().workingVisible, true);
  controller.close();
  assert.equal(getEventListeners(generation.signal, "abort").length, 0);
  assert.equal(controller.extensionStatusSnapshot().size, 0);
  assert.equal(controller.footerDataSnapshot().workingMessage, undefined);
  assert.equal(controller.footerDataSnapshot().workingVisible, undefined);
});

test("Ctrl+O leaves completed reasoning unchanged while reasoning still toggles without duplication", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({ type: "reasoning_delta", text: "inspect the failure", part: 0, visibility: "summary" }, 3));
  controller.render(envelope({ type: "text_delta", text: "final answer", part: 0 }, 4));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "toggle-reasoning-message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect the failure", visibility: "summary" },
        { type: "text", text: "final answer" },
      ],
      stopReason: "stop",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 5));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 6));
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 7));
  await tick();
  flush();
  let buffer = terminal.buffer().join("\n");
  assert.equal(occurrences(buffer, "inspect the failure"), 1);
  assert.equal(occurrences(buffer, "Thinking"), 1);
  assert.equal(occurrences(buffer, "final answer"), 1);
  input.write(Buffer.from([15]));
  await tick();
  flush();
  buffer = terminal.buffer().join("\n");
  assert.equal(controller.getToolOutputExpanded(), true);
  assert.equal(occurrences(buffer, "inspect the failure"), 1);
  assert.equal(occurrences(buffer, "final answer"), 1);
  input.write(Buffer.from([15]));
  await tick();
  flush();
  buffer = terminal.buffer().join("\n");
  assert.equal(controller.getToolOutputExpanded(), false);
  assert.equal(occurrences(buffer, "inspect the failure"), 1);
  assert.equal(occurrences(buffer, "final answer"), 1);
  assert.equal(controller.toggleReasoning(), true);
  await tick();
  flush();
  buffer = terminal.buffer().join("\n");
  assert.equal(occurrences(buffer, "inspect the failure"), 0);
  assert.equal(occurrences(buffer, "Thinking"), 1);
  assert.equal(occurrences(buffer, "final answer"), 1);
  assert.equal(controller.toggleReasoning(), true);
  await tick();
  flush();
  buffer = terminal.buffer().join("\n");
  assert.equal(occurrences(buffer, "inspect the failure"), 1);
  assert.equal(occurrences(buffer, "Thinking"), 1);
  assert.equal(occurrences(buffer, "final answer"), 1);

  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "next-user-message",
      role: "user",
      content: [{ type: "text", text: "next question" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 8));
  await tick();
  controller.renderNow();
  flush();
  buffer = terminal.buffer().join("\n");
  assert.match(buffer, /Thinking/u);
  assert.equal(controller.toggleReasoning(), true);
  await tick();
  flush();
  buffer = terminal.buffer().join("\n");
  assert.equal(occurrences(buffer, "inspect the failure"), 0);

  const generation = new AbortController();
  controller.setAutocompleteProvider(async () => [
    { start: 0, end: 2, value: "first", label: "First", detail: "first choice" },
    { start: 0, end: 2, value: "second", label: "Second" },
  ], generation.signal);
  controller.setEditorText("go");
  input.write("\t");
  await tick();
  assert.match(output.text, /Completions/u);
  assert.match(output.text, /First/u);
  input.write("\u001b[B\r");
  await tick();
  assert.equal(controller.getEditorText(), "second");
  generation.abort(new Error("generation replaced"));
  controller.close();
});

test("Ctrl+T collapses and expands active reasoning without losing streamed or durable updates", async () => {
  const { input, output, controller } = fullController();
  controller.setActionHandler((action) => {
    if (action.type === "toggle_thinking_visibility") controller.toggleReasoning();
  });
  controller.start();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): string => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
    return terminal.viewport().join("\n");
  };
  flush();

  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({ type: "reasoning_started", part: 0, visibility: "summary" }, 3));
  controller.render(envelope({ type: "reasoning_delta", text: "live reasoning", part: 0, visibility: "summary" }, 4));
  await tick();
  assert.match(flush(), /live reasoning/u);

  input.write("\u0014");
  await tick();
  let viewport = flush();
  assert.doesNotMatch(viewport, /live reasoning/u);
  assert.equal(occurrences(viewport, "Thinking"), 1);

  controller.render(envelope({ type: "reasoning_delta", text: " continues", part: 0, visibility: "summary" }, 5));
  await tick();
  viewport = flush();
  assert.doesNotMatch(viewport, /live reasoning continues/u);
  assert.equal(occurrences(viewport, "Thinking"), 1);

  input.write("\u0014");
  await tick();
  viewport = flush();
  assert.equal(occurrences(viewport, "live reasoning continues"), 1);
  assert.equal(occurrences(viewport, "Thinking"), 1);

  controller.render(envelope({ type: "reasoning_delta", text: " safely", part: 0, visibility: "summary" }, 6));
  await tick();
  controller.renderNow();
  viewport = flush();
  assert.equal(occurrences(viewport, "live reasoning continues safely"), 1);

  input.write("\u0014");
  await tick();
  viewport = flush();
  assert.doesNotMatch(viewport, /live reasoning continues safely/u);
  assert.equal(occurrences(viewport, "Thinking"), 1);

  controller.render(envelope({
    type: "reasoning_completed",
    text: "live reasoning continues safely",
    part: 0,
    visibility: "summary",
  }, 7));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "live-toggle-reasoning",
      role: "assistant",
      content: [{ type: "thinking", thinking: "live reasoning continues safely", visibility: "summary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 8));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 9));
  controller.render(envelope({ type: "run_completed", finishReason: "stop" }, 10));
  await tick();
  viewport = flush();
  assert.doesNotMatch(viewport, /live reasoning continues safely/u);
  assert.equal(occurrences(viewport, "Thinking"), 1);

  input.write("\u0014");
  await tick();
  viewport = flush();
  assert.equal(occurrences(viewport, "live reasoning continues safely"), 1);
  assert.equal(occurrences(viewport, "Thinking"), 1);
  controller.close();
});

test("thinking visibility key delegates persistence to the interactive host", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  input.write("\u0014");
  await tick();
  assert.deepEqual(actions, [{ type: "toggle_thinking_visibility" }]);
  controller.close();
});

test("thinking visibility honors custom remaps while Atlas keeps contextual Ctrl+T", async () => {
  const { input, output, controller } = fullController({
    keybindings: new Keybindings({ "app.thinking.toggle": "alt+r" }),
  });
  let toggles = 0;
  controller.setActionHandler((action) => {
    if (action.type !== "toggle_thinking_visibility") return;
    toggles += 1;
    controller.toggleReasoning();
  });
  controller.start();
  controller.render(envelope({
    type: "reasoning_completed",
    text: "remapped completed reasoning",
    part: 0,
    visibility: "summary",
  }, 1));
  await tick();

  input.write(Buffer.from([20]));
  await tick();
  assert.equal(toggles, 0);

  input.write("\u001br");
  await tick();
  assert.equal(toggles, 1);

  controller.setInputBlocked("Waiting…", "busy");
  input.write("\u001br");
  await tick();
  assert.equal(toggles, 2);
  controller.setInputBlocked();

  const selection = controller.chooseSessionTree("Atlas", [
    {
      id: "atlas-user",
      label: "Atlas user",
      value: "atlas-user",
      tree: {
        eventId: "atlas-user",
        kind: "user",
        depth: 0,
        prefix: "├─ ",
        branches: [],
        paths: ["main"],
        active: true,
      },
    },
    {
      id: "atlas-tool",
      label: "Atlas tool",
      value: "atlas-tool",
      tree: {
        eventId: "atlas-tool",
        parentEventId: "atlas-user",
        kind: "tool",
        depth: 1,
        prefix: "└─ ",
        branches: ["main"],
        paths: ["main"],
        active: true,
      },
    },
  ]);
  input.write(Buffer.from([20]));
  await tick();
  assert.equal(toggles, 2);
  assert.match(terminalWords(output.text), /Filter: no-tools/u);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});
