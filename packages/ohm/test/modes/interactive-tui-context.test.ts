import assert from "node:assert/strict";
import test from "node:test";

import {
  createInteractiveTuiContext,
  type InteractiveTuiSession,
} from "../../src/modes/interactive-tui-context.js";
import { TuiController } from "../../src/tui/controller.js";
import { createInteractiveDirectUiContext } from "../../src/tui/direct-ui.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "../../src/tui/frame-projector.js";
import type { ReadonlyFooterDataProvider } from "../../src/tui/footer-data.js";
import { OHM_VERSION } from "../../src/version.js";
import { createFixtureFrameProjector, FakeInput, FakeOutput } from "../tui/helpers.js";

interface StatisticsProbeSession extends InteractiveTuiSession {
  getSessionStats(): { usage: Record<string, never> };
}

test("interactive host context clears unavailable session and model values from footer snapshots", (context) => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
  });
  controller.start();
  const generation = new AbortController();
  context.after(() => {
    generation.abort();
    controller.close();
  });

  let selectedModel: InteractiveTuiSession["nativeModel"] = {
    provider: "fixture-provider",
    id: "fixture-model",
    info: { contextTokens: 32_768 },
  };
  const session: InteractiveTuiSession = {
    sessionId: "fixture-thread",
    get nativeModel() { return selectedModel; },
    thinkingLevel: "high",
    supportsThinking: () => true,
    isSubscription: () => true,
    autoCompactionEnabled: true,
    getContextUsage: () => undefined,
  };
  let footerData: ReadonlyFooterDataProvider | undefined;
  const ui = createInteractiveDirectUiContext(
    controller,
    "footer-context-test",
    "/workspace",
    generation.signal,
  );

  controller.setContext(createInteractiveTuiContext(session, "/workspace", "named session", false));
  ui.setFooter((_tui, _theme, data) => {
    footerData = data;
    return { render: () => ["fixture footer"], invalidate() {} };
  });
  assert.deepEqual(footerData?.getSnapshot(), {
    workspace: "/workspace",
    sessionName: "named session",
    releaseVersion: OHM_VERSION,
    active: false,
    status: "idle",
    provider: "fixture-provider",
    model: "fixture-model",
    thinking: "high",
    thinkingSupported: true,
    subscription: true,
    contextTokens: 0,
    contextWindowTokens: 32_768,
    autoCompaction: true,
  });

  selectedModel = undefined;
  controller.setContext(createInteractiveTuiContext(session, "/workspace", undefined, false));
  const cleared = footerData?.getSnapshot();
  assert.ok(cleared);
  for (const field of [
    "sessionName",
    "provider",
    "model",
    "contextWindowTokens",
    "thinkingSupported",
    "subscription",
  ] as const) {
    assert.equal(Object.hasOwn(cleared, field), false, `${field} remained stale`);
  }
});

test("streaming context refreshes preserve live usage without rescanning session statistics", () => {
  let statsReads = 0;
  let contextReads = 0;
  const session: StatisticsProbeSession = {
    sessionId: "streaming-context",
    nativeModel: undefined,
    thinkingLevel: "off",
    supportsThinking: () => false,
    isSubscription: () => false,
    autoCompactionEnabled: true,
    getSessionStats() {
      statsReads += 1;
      return { usage: {} };
    },
    getContextUsage() {
      contextReads += 1;
      return {
        tokens: 321,
        contextWindow: 1_000,
        percent: 32.1,
        source: "provider" as const,
        autoCompactionThresholdPercent: 85,
      };
    },
  };

  const streaming = createInteractiveTuiContext(
    session,
    "/workspace",
    undefined,
    true,
    { includeContextUsage: false },
  );
  assert.equal(statsReads, 0);
  assert.equal(contextReads, 0);
  assert.equal(Object.hasOwn(streaming, "contextTokens"), false);
  assert.equal(streaming.active, true);

  const durable = createInteractiveTuiContext(session, "/workspace", undefined, false);
  assert.equal(statsReads, 0);
  assert.equal(contextReads, 1);
  assert.equal(durable.contextTokens, 321);
  assert.equal(durable.contextSource, "provider");
  assert.equal(durable.autoCompactionThresholdPercent, 85);
});

test("command-only activity is not labelled as model generation", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
  });
  const session: InteractiveTuiSession = {
    sessionId: "command-only-context",
    nativeModel: undefined,
    thinkingLevel: "off",
    supportsThinking: () => false,
    isSubscription: () => false,
    autoCompactionEnabled: true,
    getContextUsage: () => undefined,
  };

  controller.start();
  controller.setContext(createInteractiveTuiContext(
    session,
    "/workspace",
    undefined,
    true,
    { operationOnly: true },
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.match(output.text, /Working/u);
  assert.doesNotMatch(output.text, /Generating response/u);
  controller.close();
});
