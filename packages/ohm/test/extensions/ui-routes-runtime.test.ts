import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadDirectExtensions,
  type RuntimeDirectUiContext,
  type RuntimeExtensionMode,
} from "../../src/extensions/runtime.js";
import { createOwnedInteractiveDirectUiContext } from "../../src/tui/direct-ui.js";
import { TuiController } from "../../src/tui/controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  type InternalTuiControllerOptions,
} from "../../src/tui/frame-projector.js";
import { projectRichTuiFrame } from "../../src/tui/rich-frame-projector.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, tick } from "../tui/helpers.js";
import { FocusedVirtualTerminal } from "../tui/virtual-terminal.js";

interface Observation {
  readonly mode: RuntimeExtensionMode;
  readonly capability: boolean | undefined;
  readonly error: string | undefined;
  readonly current: string | undefined;
}

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

test("runtime UI routes negotiate only the actual full TUI across every host mode", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-ui-routes-runtime-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const observations: Observation[] = [];
  const { controller, output } = fullController();
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "ui-routes",
      factory(api) {
        api.on("session_start", (_event, runtime) => {
          let error: string | undefined;
          try {
            runtime.ui.routes.register("mode-screen", {
              title: "Mode screen",
              render: (route) => ({
                render: () => ({
                  lines: [{ spans: [{ text: `route from ${runtime.mode}: ${String(route.data)}` }] }],
                }),
              }),
            }).open({ data: runtime.mode });
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          observations.push({
            mode: runtime.mode,
            capability: runtime.ui.capabilities?.routes,
            error,
            current: runtime.ui.routes.current()?.name,
          });
        });
      },
    }],
  });
  let directContext: RuntimeDirectUiContext | undefined;
  host.setDirectUiHandler((_extensionId, _signal, ownerKey, generationSignal) =>
    directContext ??= createOwnedInteractiveDirectUiContext(
      controller,
      ownerKey,
      workspace,
      generationSignal,
    ));

  try {
    for (const mode of ["print", "json", "rpc", "serve", "sdk"] as const) {
      host.setHostContext({ mode });
      await host.dispatch("session_start", {});
    }
    assert.deepEqual(observations, (["print", "json", "rpc", "serve", "sdk"] as const).map((mode) => ({
      mode,
      capability: false,
      error: "Extension UI routes require the full rich TUI",
      current: undefined,
    })));

    host.setHostContext({ mode: "tui" });
    await host.dispatch("session_start", {});
    assert.deepEqual(observations.at(-1), {
      mode: "tui",
      capability: true,
      error: undefined,
      current: "mode-screen",
    });
    controller.renderNow();
    assert.match(viewport(output), /Mode screen · Esc back/u);
    assert.match(viewport(output), /route from tui: tui/u);

    await host.close();
    await tick();
    controller.renderNow();
    assert.doesNotMatch(viewport(output), /route from tui/u, "generation shutdown removes the active route");
  } finally {
    await host.close();
    controller.close();
  }
});
