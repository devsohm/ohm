import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import { TuiController } from "../../src/tui/controller.js";
import { FakeInput, FakeOutput, envelope } from "../tui/helpers.js";
import { FocusedVirtualTerminal } from "../tui/virtual-terminal.js";

test("interactive mode creates the rich controller and preserves an injected terminal", { concurrency: false }, async () => {
  const previousForceColor = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = "3";
  delete process.env.NO_COLOR;
  const { InteractiveMode } = await import("../../src/modes/interactive-mode.js");
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;

  // SAFETY: this construction test exercises only the listed runtime surface before stopping the mode.
  const runtime = {
    session: { settingsManager: SettingsManager.inMemory() },
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
  } as AgentSessionRuntime;
  const controllers: TuiController[] = [];
  const originalActionHandler = TuiController.prototype.setActionHandler;
  TuiController.prototype.setActionHandler = function captureController(handler) {
    controllers.push(this);
    originalActionHandler.call(this, handler);
  };

  try {
    const input = new FakeInput();
    const output = new FakeOutput();
    const mode = new InteractiveMode(runtime, {
      terminalOptions: {
        input,
        output,
        mode: "full",
        environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        handleSignals: false,
      },
    });
    const created = controllers.at(-1);
    assert.ok(created);
    created.start();
    created.render(envelope({
      type: "message_appended",
      message: {
        id: "interactive-rich-user",
        role: "user",
        content: [{ type: "text", text: "interactive short state" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 1));
    created.renderNow();
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
    assert.match(terminal.viewport().join("\n"), /─ Ask ohm /u);
    assert.equal(getEventListeners(input, "data").length, 1);
    mode.stop();
    assert.equal(getEventListeners(input, "data").length, 0);
    assert.deepEqual(input.rawChanges, [true, false]);

    const injected = new TuiController({
      input: new FakeInput(),
      output: new FakeOutput(),
      mode: "accessible",
      handleSignals: false,
    });
    const injectedMode = new InteractiveMode(runtime, { terminal: injected });
    assert.equal(controllers.at(-1), injected);
    injectedMode.stop();
  } finally {
    TuiController.prototype.setActionHandler = originalActionHandler;
  }
});
