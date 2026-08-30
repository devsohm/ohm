import assert from "node:assert/strict";
import test from "node:test";

import {
  createInteractiveDirectUiFacade,
  createOwnedInteractiveDirectUiContext,
} from "../../src/tui/direct-ui.js";
import type { ExtensionUIRouteHost } from "../../src/extensions/capabilities/ui-routes.js";
import { TuiController } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  type InternalTuiControllerOptions,
} from "../../src/tui/frame-projector.js";
import { projectRichTuiFrame } from "../../src/tui/rich-frame-projector.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { isRecordValue } from "../../src/tui/value-guards.js";
import { FakeInput, FakeOutput, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

function fullController() {
  const output = new FakeOutput();
  const options: InternalTuiControllerOptions = {
    input: new FakeInput(),
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
    [INTERNAL_TUI_FRAME_PROJECTOR]: projectRichTuiFrame,
  };
  const controller = new TuiController(options);
  controller.start();
  return { controller, output };
}

function viewport(output: FakeOutput): string {
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  return stripAnsi(terminal.viewport().join("\n"));
}

test("rich direct UI routes are named, data-safe, and stable across callback facades", async () => {
  const { controller, output } = fullController();
  controller.notify("normal session view");
  const generation = new AbortController();
  const base = createOwnedInteractiveDirectUiContext(
    controller,
    "extension-a",
    process.cwd(),
    generation.signal,
  );
  const firstCallback = new AbortController();
  const firstUi = createInteractiveDirectUiFacade(base, firstCallback.signal);
  let observedHost: ExtensionUIRouteHost | undefined;
  let disposed = 0;

  const stale = firstUi.routes.register("inspector", {
    title: "Old inspector",
    render: () => ({ render: () => ({ lines: [{ spans: [{ text: "OLD_ROUTE" }] }] }) }),
  });
  const registration = firstUi.routes.register("inspector", {
    title: "Inspector",
    render: (host) => {
      observedHost = host;
      return {
        render: () => ({ lines: [{ spans: [{ text: `ROUTE_${String(host.data)}` }] }] }),
        dispose: () => { disposed += 1; },
      };
    },
  });
  assert.equal(stale.disposed, true);
  stale.dispose();
  assert.deepEqual(firstUi.routes.list(), [{ name: "inspector", title: "Inspector" }]);

  firstCallback.abort(new Error("callback completed"));
  const secondCallback = new AbortController();
  const secondUi = createInteractiveDirectUiFacade(base, secondCallback.signal);
  const input = { nested: { value: "detached" } };
  const handle = secondUi.routes.open("inspector", { data: input });
  input.nested.value = "mutated";
  controller.renderNow();

  assert.equal(secondUi.capabilities?.routes, true);
  assert.ok(observedHost);
  assert.equal(observedHost?.name, "inspector");
  assert.deepEqual(observedHost?.data, { nested: { value: "detached" } });
  assert.equal(Object.isFrozen(observedHost?.data), true);
  assert.ok(isRecordValue(observedHost.data));
  assert.ok(isRecordValue(observedHost.data.nested));
  assert.equal(Object.isFrozen(observedHost.data.nested), true);
  assert.deepEqual(secondUi.routes.current(), {
    name: "inspector",
    title: "Inspector",
    data: { nested: { value: "detached" } },
  });
  assert.equal(Object.isFrozen(secondUi.routes.current()), true);
  assert.match(viewport(output), /Inspector · Esc back/u);
  assert.match(viewport(output), /ROUTE_\[object Object\]/u);
  assert.doesNotMatch(viewport(output), /normal session view/u);

  handle.close();
  controller.renderNow();
  assert.equal(secondUi.routes.current(), undefined);
  assert.equal(disposed, 1);
  assert.match(viewport(output), /normal session view/u);

  registration.open();
  generation.abort(new Error("extension refreshed"));
  await tick();
  controller.renderNow();
  assert.equal(registration.disposed, true);
  assert.equal(disposed, 2);
  assert.doesNotMatch(viewport(output), /ROUTE_/u);
  secondCallback.abort(new Error("test complete"));
  controller.close();
});

test("line and accessibility direct UI contexts declare routes unavailable", () => {
  for (const mode of ["line", "accessible"] as const) {
    const controller = new TuiController({
      input: new FakeInput(),
      output: new FakeOutput(),
      mode,
      environment: { TERM: "dumb", NO_COLOR: "1" },
      handleSignals: false,
    });
    const generation = new AbortController();
    const ui = createOwnedInteractiveDirectUiContext(
      controller,
      `extension-${mode}`,
      process.cwd(),
      generation.signal,
    );
    assert.equal(ui.capabilities?.routes, false, mode);
    assert.deepEqual(ui.routes.list(), [], mode);
    assert.equal(ui.routes.current(), undefined, mode);
    assert.doesNotThrow(() => ui.routes.close(), mode);
    assert.throws(
      () => ui.routes.register("inspector", {
        title: "Inspector",
        render: () => ({ render: () => ({ lines: [] }) }),
      }),
      /full rich TUI/u,
      mode,
    );
    generation.abort(new Error("test complete"));
    controller.close();
  }
});
