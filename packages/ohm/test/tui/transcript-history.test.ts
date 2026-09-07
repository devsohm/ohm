import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventEnvelope } from "../../src/core/events.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import { pluginSessionManager } from "../../src/plugins/session-contract.js";
import { bindInteractiveSessionPresentation } from "../../src/interactive/session-presentation.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { TuiController } from "../../src/tui/controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR, type InternalTuiControllerOptions } from "../../src/tui/frame-projector.js";
import { renderTranscriptFrame } from "../../src/tui/layout.js";
import { projectOhmTuiToolEntry } from "../../src/tui/native-renderer/tool-entry.js";
import { createTheme } from "../../src/tui/theme.js";
import type { TuiTranscriptHistory } from "../../src/tui/transcript-history.js";
import type { TuiViewState } from "../../src/tui/types.js";
import { createFixtureFrameProjector, envelope, FakeInput, FakeOutput, tick } from "./helpers.js";

function append(storage: SessionManager, index: number, text = `message ${index}`): string {
  return storage.appendMessage({ id: `message-${index}`, role: "user", content: [{ type: "text", text }],
    createdAt: "2026-09-05T00:00:00.000Z" });
}

function fixture(storage: SessionManager, maximumEntries = 20) {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(80, 16);
  let view: TuiViewState | undefined;
  const projector = createFixtureFrameProjector();
  const options: InternalTuiControllerOptions = {
    input, output, environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false, limits: { maxTranscriptEntries: maximumEntries },
    [INTERNAL_TUI_FRAME_PROJECTOR](request) { view = request.view; return projector(request); },
  };
  const controller = new TuiController(options);
  const listeners = new Set<(event: EventEnvelope) => void>();
  const unbind = bindInteractiveSessionPresentation({
    sessionId: storage.getSessionId(), nativeSessionManager: storage,
    sessionManager: pluginSessionManager(storage),
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribe() { return () => {}; },
  }, controller);
  controller.renderNow();
  return {
    controller, input, output,
    view() { assert.ok(view); return view; },
    async key(value: string) {
      input.write(value);
      for (let iteration = 0; iteration < 100; iteration += 1) {
        await tick(); controller.renderNow();
        if (!view?.notice?.startsWith("Loading history") && view?.transcriptSearch?.status !== "Searching journal…") break;
      }
    },
    emit(event: EventEnvelope) { for (const listener of listeners) listener(event); },
    close() { unbind(); controller.close(); },
  };
}

test("restored history pages beyond the retained viewport and returns to the live draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohm-history-tui-"));
  try {
    const original = SessionManager.create(root, join(root, "sessions"));
    for (let index = 0; index < 80; index += 1) append(original, index);
    original.closeV4Store();
    const storage = SessionManager.open(original.getSessionFile()!);
    const tui = fixture(storage);
    try {
      assert.equal(tui.view().transcript[0]?.id, "message-60");
      tui.controller.setEditorText("preserved draft");
      await tui.key("\u001b[1;5H");
      assert.equal(tui.view().transcript[0]?.id, "message-0");
      assert.ok(tui.view().transcript.length <= 20);
      for (let index = 0; index < 8; index += 1) await tui.key("\u001b[6~");
      assert.ok(tui.view().transcript.some((entry) => Number(entry.id.split("-")[1]) >= 10));
      await tui.key("\u001b[1;5F");
      assert.equal(tui.view().transcript.at(-1)?.id, "message-79");
      assert.equal(tui.controller.getEditorText(), "preserved draft");
    } finally { tui.close(); storage.closeV4Store(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unanswered historical calls never claim queued work and live events replace their recorded state", async () => {
  for (const paged of [false, true]) {
    const storage = SessionManager.inMemory("/tmp/ohm-history-state");
    const call = storage.appendMessage({ id: "recorded-call", role: "assistant", content: [
      { type: "tool_call", callId: "call-edit", name: "edit", arguments: { path: "range.mjs", edits: [] } },
    ], stopReason: "tool_calls", createdAt: "2026-09-05T00:00:00.000Z" });
    storage.appendMessage({ id: "recorded-result", role: "tool", content: [
      { type: "tool_result", callId: "call-edit", name: "edit", content: "done", isError: false },
    ], createdAt: "2026-09-05T00:00:01.000Z" });
    storage.branch(call);
    if (paged) for (let index = 0; index < 40; index += 1) append(storage, index);
    const leaf = storage.getLeafId();
    const tui = fixture(storage);
    try {
      tui.controller.setEditorText("preserved draft");
      if (paged) await tui.key("\u001b[1;5H");
      const entry = tui.view().transcript.find((item) => item.callId === "call-edit");
      assert.ok(entry);
      assert.equal(projectOhmTuiToolEntry(entry)?.state, "history · result not shown");
      for (const columns of [24, 80]) {
        const text = renderTranscriptFrame([entry], columns, createTheme("mono", { color: false, unicode: false })).text;
        assert.match(text.replaceAll(/\s|\|/gu, ""), /history/u);
        assert.doesNotMatch(text, /queued|running|failed|done/u);
      }
      tui.emit(envelope({ type: "tool_requested", callId: "call-edit", name: "edit", input: { path: "range.mjs" }, index: 0 }, 90));
      tui.controller.renderNow();
      if (paged) {
        assert.equal(projectOhmTuiToolEntry(entry)?.state, "history · result not shown");
        await tui.key("\u001b[1;5F");
      }
      const selected = () => {
        const tool = tui.view().transcript.find((item) => item.callId === "call-edit");
        assert.ok(tool);
        return projectOhmTuiToolEntry(tool);
      };
      assert.equal(selected()?.state, "queued");
      tui.emit(envelope({ type: "tool_started", callId: "call-edit", name: "edit", input: {}, index: 0, recoveryMode: "repeatable" }, 91));
      tui.controller.renderNow();
      assert.equal(selected()?.state, "running");
      tui.emit(envelope({ type: "tool_completed", callId: "call-edit", name: "edit", index: 0, isError: false, preview: "done" }, 92));
      tui.controller.renderNow();
      assert.equal(selected()?.state, "done");
      assert.equal(storage.getLeafId(), leaf);
      assert.equal(tui.controller.getEditorText(), "preserved draft");
    } finally { tui.close(); }
  }
});

test("page-up and prompt jumps fetch older journal pages while streamed messages remain live", async () => {
  const storage = SessionManager.inMemory("/tmp/ohm-history-stream");
  for (let index = 0; index < 60; index += 1) append(storage, index);
  const tui = fixture(storage);
  try {
    for (let index = 0; index < 20 && tui.view().transcript[0]?.id === "message-40"; index += 1) {
      await tui.key("\u001b[5~");
    }
    assert.equal(tui.view().transcript[0]?.id, "message-30");
    const message: CanonicalMessage = { id: "streamed-message", role: "assistant",
      content: [{ type: "text", text: "live answer arrives" }], createdAt: "2026-09-05T00:01:00.000Z" };
    storage.appendMessage(message);
    tui.emit(envelope({ type: "message_appended", message }, 99));
    tui.controller.renderNow();
    assert.equal(tui.view().transcript[0]?.id, "message-30");
    for (let index = 0; index < 15 && tui.view().transcript[0]?.id === "message-30"; index += 1) {
      await tui.key("\u001b[1;6A");
    }
    assert.equal(tui.view().transcript[0]?.id, "message-20");
    tui.output.resize(64, 20); await tick(); tui.controller.renderNow();
    assert.equal(tui.view().transcript[0]?.id, "message-20");
    await tui.key("\u001b[1;5F");
    assert.equal(tui.view().transcript.at(-1)?.id, "streamed-message");
  } finally { tui.close(); }
});

test("journal search reaches abandoned branches and moves both directions without switching the session", async () => {
  const storage = SessionManager.inMemory("/tmp/ohm-history-search");
  const root = append(storage, 0, "needle first");
  append(storage, 1, "needle abandoned");
  storage.branch(root);
  for (let index = 2; index < 50; index += 1) append(storage, index);
  const leaf = storage.getLeafId();
  const tui = fixture(storage);
  try {
    await tui.key("\u001b[102;6uneedle\r");
    assert.equal(tui.view().transcript.at(-1)?.id, "message-1");
    assert.equal(storage.getLeafId(), leaf);
    assert.equal(tui.view().transcriptSearch?.status, "Journal match");
    await tui.key("\r");
    assert.equal(tui.view().transcript.at(-1)?.id, "message-0");
    await tui.key("\u001b[13;2u");
    assert.equal(tui.view().transcript.at(-1)?.id, "message-1");
    await tui.key("\u001b");
    await tui.key("\u001b[1;5F");
    assert.equal(tui.view().transcript.at(-1)?.id, "message-49");
    assert.equal(storage.getLeafId(), leaf);
  } finally { tui.close(); }
});

test("history replacement cancels stale requests and never overwrites a new host", async () => {
  const storage = SessionManager.inMemory("/tmp/ohm-history-cancel");
  append(storage, 0);
  const tui = fixture(storage);
  let pendingSignal: AbortSignal | undefined;
  let resolvePage: ((value: Awaited<ReturnType<TuiTranscriptHistory["page"]>>) => void) | undefined;
  tui.controller.setTranscriptHistory({
    page(_request, signal) { pendingSignal = signal; return new Promise((resolve) => { resolvePage = resolve; }); },
    async search() { return { matches: [], hasMore: false }; },
  });
  try {
    tui.input.write("\u001b[1;5H"); await tick();
    assert.ok(pendingSignal);
    tui.controller.setTranscriptHistory(undefined);
    assert.equal(pendingSignal.aborted, true);
    resolvePage?.({ items: [envelope({ type: "message_appended", message: {
      id: "stale", role: "user", content: [{ type: "text", text: "stale" }], createdAt: "2026-09-05T00:00:00.000Z",
    } })], hasMoreBefore: false, hasMoreAfter: false });
    await tick(); tui.controller.renderNow();
    assert.equal(tui.view().transcript.at(-1)?.id, "message-0");
  } finally { tui.close(); }
});

test("tool jumps cross pages and retain ordinary tool and custom-entry renderers", async () => {
  const storage = SessionManager.inMemory("/tmp/ohm-history-tools");
  for (let index = 0; index < 80; index += 1) {
    append(storage, index);
    if (index === 25 || index === 50) {
      storage.appendMessage({ id: `call-message-${index}`, role: "assistant", content: [
        { type: "tool_call", callId: `call-${index}`, name: "history_tool", arguments: { index } },
      ], stopReason: "tool_calls", createdAt: "2026-09-05T00:00:00.000Z" });
      storage.appendMessage({ id: `result-message-${index}`, role: "tool", content: [
        { type: "tool_result", callId: `call-${index}`, name: "history_tool", content: `result ${index}`, isError: false },
      ], createdAt: "2026-09-05T00:00:00.000Z" });
      storage.appendCustomEntry("history_custom", { index });
    }
  }
  const tui = fixture(storage);
  const generation = new AbortController();
  const calls: string[] = [];
  const entries: string[] = [];
  tui.controller.setToolRenderers({
    has: (name) => name === "history_tool",
    renderCall: (_name, view) => { calls.push(view.callId); return undefined; },
    renderResult: () => undefined,
  }, generation.signal);
  tui.controller.setSessionRenderers({
    renderEntry(entry) { entries.push(entry.customType); return { render: () => ["custom history"], invalidate() {} }; },
    renderMessage: () => undefined,
  }, generation.signal);
  try {
    await tui.key("\u001b[5;3~");
    assert.ok(tui.view().transcript.some((entry) => entry.callId === "call-50"));
    await tui.key("\u001b[5;3~");
    assert.ok(tui.view().transcript.some((entry) => entry.callId === "call-25"));
    await tui.key("\u001b[6;3~");
    assert.ok(tui.view().transcript.some((entry) => entry.callId === "call-50"));
    assert.ok(calls.includes("call-25") && calls.includes("call-50"));
    assert.ok(entries.includes("history_custom"));
    await tui.key("\u000f");
    assert.equal(tui.view().transcript.find((entry) => entry.callId === "call-50")?.expanded, true);
  } finally { generation.abort(); tui.close(); }
});

test("large histories remain paged and oversized search matches are shown as bounded excerpts", async () => {
  const storage = SessionManager.inMemory("/tmp/ohm-history-large");
  append(storage, 0, `${"x".repeat(2 * 1024 * 1024)} hidden-needle ${"y".repeat(100_000)}`);
  for (let index = 1; index < 2_600; index += 1) append(storage, index);
  const tui = fixture(storage, 2_000);
  try {
    assert.ok(tui.view().transcript.length <= 2_000);
    await tui.key("\u001b[102;6uhidden-needle\r");
    const entry = tui.view().transcript.find((entry) => entry.id === "message-0");
    assert.ok(entry);
    assert.match(entry.text, /hidden-needle/u);
    assert.match(entry.text, /History excerpt/u);
    assert.ok(Buffer.byteLength(entry.text) < 70 * 1024);
    assert.ok(tui.view().transcript.length <= 500);
    await tui.key("\u001b");
    await tui.key("\u001b[1;5F");
    assert.equal(tui.view().transcript.at(-1)?.id, "message-2599");
  } finally { tui.close(); }
});
