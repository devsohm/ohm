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

function fullController() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const options: InternalTuiControllerOptions = {
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    [INTERNAL_TUI_FRAME_PROJECTOR]: projectRichTuiFrame,
  };
  const controller = new TuiController(options);
  controller.start();
  return { controller, input, output };
}

function viewport(output: FakeOutput): string {
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  return stripAnsi(terminal.viewport().join("\n"));
}

async function escape(input: FakeInput): Promise<void> {
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

test("extension UI routes replace only their exact predecessor and preserve the composer", async () => {
  const { controller, input, output } = fullController();
  controller.notify("ordinary transcript");
  controller.setEditorText("draft remains editable");
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  let firstDisposed = 0;
  let firstClosed = 0;
  let secondClosed = 0;
  let captureEscape = true;
  let capturedEscapes = 0;

  const first = controller.openExtensionUiRoute("extension-a", "first", "First route", () => ({
    render: () => ({ lines: [{ spans: [{ text: "FIRST_BODY" }] }] }),
    dispose: () => { firstDisposed += 1; },
  }), firstGeneration.signal, () => { firstClosed += 1; });
  controller.renderNow();
  let frame = viewport(output);
  assert.match(frame, /First route · Esc back/u);
  assert.match(frame, /FIRST_BODY/u);
  assert.match(frame, /draft remains editable/u);
  assert.doesNotMatch(frame, /ordinary transcript/u);

  controller.openExtensionUiRoute("extension-b", "second", "Second\u001b[2J\nroute", () => ({
    render: () => ({ lines: [{ spans: [{ text: "SECOND_BODY" }] }] }),
    handleKey: (event) => {
      if (event.key !== "escape") return false;
      capturedEscapes += 1;
      return captureEscape;
    },
  }), secondGeneration.signal, () => { secondClosed += 1; });
  assert.equal(firstDisposed, 1);
  assert.equal(firstClosed, 1);

  first.close();
  firstGeneration.abort(new Error("stale generation"));
  controller.renderNow();
  frame = viewport(output);
  assert.match(frame, /SECOND_BODY/u, "a stale handle and generation cannot close the replacement");
  assert.match(frame, /Second route/u);
  assert.doesNotMatch(frame, /\[2J/u);

  await escape(input);
  controller.renderNow();
  assert.equal(capturedEscapes, 1);
  assert.match(viewport(output), /SECOND_BODY/u, "the child receives Escape before host back handling");

  captureEscape = false;
  await escape(input);
  controller.renderNow();
  frame = viewport(output);
  assert.equal(capturedEscapes, 2);
  assert.equal(secondClosed, 1);
  assert.doesNotMatch(frame, /SECOND_BODY/u);
  assert.match(frame, /ordinary transcript/u);
  assert.match(frame, /draft remains editable/u);

  secondGeneration.abort(new Error("test complete"));
  controller.close();
});

test("extension UI route factory and render failures warn and restore the normal view", async () => {
  const { controller, output } = fullController();
  controller.notify("normal transcript restored");

  assert.throws(() => controller.openExtensionUiRoute(
    "broken-extension",
    "factory-failure",
    "Broken factory",
    () => { throw new Error("factory exploded"); },
    new AbortController().signal,
  ), /factory exploded/u);
  controller.renderNow();
  let frame = viewport(output);
  assert.match(frame, /normal transcript restored/u);
  assert.match(frame, /Extension UI route factory-failure failed: factory exploded/u);

  let closed = 0;
  const generation = new AbortController();
  controller.openExtensionUiRoute(
    "broken-extension",
    "render-failure",
    "Broken render",
    () => ({ render: () => { throw new Error("render exploded"); } }),
    generation.signal,
    () => { closed += 1; },
  );
  controller.renderNow();
  await tick();
  controller.renderNow();
  frame = viewport(output);
  assert.equal(closed, 1);
  assert.match(frame, /normal transcript restored/u);
  assert.match(frame, /Extension UI route render-failure failed: render exploded/u);
  assert.doesNotMatch(frame, /Broken render · Esc back/u);

  generation.abort(new Error("test complete"));
  controller.close();
});

test("extension UI routes close when their generation ends", async () => {
  const { controller, output } = fullController();
  controller.notify("generation fallback");
  const generation = new AbortController();
  let disposed = 0;
  let closed = 0;
  controller.openExtensionUiRoute("extension", "temporary", "Temporary", () => ({
    render: () => ({ lines: [{ spans: [{ text: "TEMPORARY_ROUTE" }] }] }),
    dispose: () => { disposed += 1; },
  }), generation.signal, () => { closed += 1; });
  controller.renderNow();
  assert.match(viewport(output), /TEMPORARY_ROUTE/u);

  generation.abort(new Error("extension refreshed"));
  await tick();
  controller.renderNow();
  const frame = viewport(output);
  assert.equal(disposed, 1);
  assert.equal(closed, 1);
  assert.doesNotMatch(frame, /TEMPORARY_ROUTE/u);
  assert.match(frame, /generation fallback/u);
  controller.close();
});

test("extension UI route construction rejects reentrant navigation without orphaning a mount", () => {
  const { controller, output } = fullController();
  controller.notify("normal transcript");
  const generation = new AbortController();
  let reentrantFactoryCalls = 0;

  const first = controller.openExtensionUiRoute("extension", "first", "First", () => {
    assert.throws(
      () => controller.openExtensionUiRoute("extension", "second", "Second", () => {
        reentrantFactoryCalls += 1;
        return { render: () => ({ lines: [{ spans: [{ text: "SECOND_BODY" }] }] }) };
      }, generation.signal),
      /navigation is already in progress/u,
    );
    return { render: () => ({ lines: [{ spans: [{ text: "FIRST_BODY" }] }] }) };
  }, generation.signal);

  controller.renderNow();
  assert.equal(reentrantFactoryCalls, 0);
  assert.match(viewport(output), /FIRST_BODY/u);
  assert.doesNotMatch(viewport(output), /SECOND_BODY/u);
  first.close();
  controller.renderNow();
  assert.match(viewport(output), /normal transcript/u);

  generation.abort(new Error("test complete"));
  controller.close();
});

test("extension UI route construction blocks raw and structured full-screen mounts", async () => {
  const { controller, output } = fullController();
  const generation = new AbortController();
  let rawFactoryCalls = 0;
  let structuredFactoryCalls = 0;
  let rawAttempt: Promise<void | undefined> | undefined;
  let structuredAttempt: Promise<void | undefined> | undefined;

  controller.openExtensionUiRoute("extension", "route", "Route", () => {
    rawAttempt = controller.customRaw<void>(() => {
      rawFactoryCalls += 1;
      return new Text("RAW_SURFACE", 1, 0);
    });
    structuredAttempt = controller.custom<void>(() => {
      structuredFactoryCalls += 1;
      return { render: () => ({ lines: [{ spans: [{ text: "CUSTOM_SURFACE" }] }] }) };
    });
    return { render: () => ({ lines: [{ spans: [{ text: "ROUTE_BODY" }] }] }) };
  }, generation.signal);

  assert.ok(rawAttempt);
  assert.ok(structuredAttempt);
  await assert.rejects(rawAttempt, /Another terminal interaction is active/u);
  await assert.rejects(structuredAttempt, /Another terminal interaction is active/u);
  controller.renderNow();
  const frame = viewport(output);
  assert.equal(rawFactoryCalls, 0);
  assert.equal(structuredFactoryCalls, 0);
  assert.match(frame, /ROUTE_BODY/u);
  assert.doesNotMatch(frame, /RAW_SURFACE|CUSTOM_SURFACE/u);

  generation.abort(new Error("test complete"));
  controller.close();
});

test("extension UI route construction rolls back when a modal interaction opens", () => {
  const { controller, output } = fullController();
  controller.notify("normal transcript");
  const generation = new AbortController();
  let overlayHandle: ReturnType<TuiController["showOverlay"]> | undefined;

  assert.throws(
    () => controller.openExtensionUiRoute("extension", "route", "Route", () => {
      overlayHandle = controller.showOverlay<void>(() => ({
        render: () => ({ lines: [{ spans: [{ text: "MODAL_BODY" }] }] }),
      }), undefined, generation.signal);
      return { render: () => ({ lines: [{ spans: [{ text: "ROUTE_BODY" }] }] }) };
    }, generation.signal),
    /Another terminal interaction is active/u,
  );
  controller.renderNow();
  assert.ok(overlayHandle);
  assert.match(viewport(output), /MODAL_BODY/u);
  assert.doesNotMatch(viewport(output), /ROUTE_BODY|Route · Esc back/u);

  overlayHandle.close();
  controller.renderNow();
  assert.match(viewport(output), /normal transcript/u);
  generation.abort(new Error("test complete"));
  controller.close();
});

test("active extension UI routes reject host pickers and questions", async () => {
  const { controller, output } = fullController();
  const generation = new AbortController();
  controller.openExtensionUiRoute("extension", "route", "Route", () => ({
    render: () => ({ lines: [{ spans: [{ text: "ROUTE_BODY" }] }] }),
  }), generation.signal);

  await assert.rejects(
    controller.choose("Choose", [{ label: "One", value: 1 }]),
    /active extension UI route/u,
  );
  await assert.rejects(controller.question("Question"), /active extension UI route/u);
  controller.renderNow();
  assert.match(viewport(output), /ROUTE_BODY/u);

  generation.abort(new Error("test complete"));
  controller.close();
});

test("extension UI routes reject an active raw full-screen surface", async () => {
  const { controller, output } = fullController();
  const rawGeneration = new AbortController();
  const rawResult = controller.customRaw<void>(
    () => new Text("RAW_SURFACE", 1, 0),
    undefined,
    rawGeneration.signal,
  );
  controller.renderNow();
  assert.match(viewport(output), /RAW_SURFACE/u);

  assert.throws(
    () => controller.openExtensionUiRoute(
      "extension",
      "hidden-route",
      "Hidden route",
      () => ({ render: () => ({ lines: [{ spans: [{ text: "ROUTE_BODY" }] }] }) }),
      new AbortController().signal,
    ),
    /Another terminal interaction is active/u,
  );
  controller.renderNow();
  assert.match(viewport(output), /RAW_SURFACE/u);
  assert.doesNotMatch(viewport(output), /ROUTE_BODY/u);

  rawGeneration.abort(new Error("test complete"));
  await rawResult;
  controller.close();
});
