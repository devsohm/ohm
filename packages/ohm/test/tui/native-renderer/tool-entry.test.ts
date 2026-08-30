import assert from "node:assert/strict";
import test from "node:test";

import { cellWidth, stripAnsi } from "@ohm/terminal";

import {
  normalizeOhmTuiSnapshot,
  projectOhmNativeFrame,
  projectOhmTuiToolEntry,
  type OhmTuiSnapshot,
  type OhmTuiToolEntry,
} from "../../../src/tui/native-renderer/index.js";
import { createTheme } from "../../../src/tui/theme.js";
import type { TranscriptEntry } from "../../../src/tui/types.js";

function tool(
  name: string,
  input: NonNullable<NonNullable<TranscriptEntry["toolData"]>["input"]>,
  options: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id: `tool:${name}`,
    kind: "tool",
    title: name,
    text: "",
    status: "completed",
    toolData: {
      argsComplete: true,
      executionStarted: true,
      input,
    },
    ...options,
  };
}

function projected(entry: TranscriptEntry): OhmTuiToolEntry {
  const selected = projectOhmTuiToolEntry(entry);
  assert.ok(selected);
  return selected;
}

test("projects every built-in into a compact semantic native headline", () => {
  const fixtures = [
    [tool("read", { path: "src/a.ts", offset: 5, limit: 8 }), "src/a.ts · lines 5-12"],
    [tool("bash", { command: "npm test", timeout: 30 }), "$ npm test · timeout 30s"],
    [tool("edit", { path: "src/a.ts", edits: [] }, { summary: "src/a.ts · 2 edits" }), "src/a.ts · 2 edits"],
    [tool("write", { path: "src/new.ts", content: "export {};" }, { summary: "src/new.ts · 1 line · 10 bytes" }), "src/new.ts · 1 line · 10 bytes"],
    [tool("grep", { pattern: "TODO", path: "src", glob: "*.ts", ignoreCase: true, context: 2, limit: 30 }), "“TODO” · in src · glob *.ts · ignore case · context 2 · limit 30"],
    [tool("find", { pattern: "**/*.test.ts", path: "test", limit: 40 }), "**/*.test.ts · in test · limit 40"],
    [tool("ls", { path: "packages", limit: 12 }), "packages · limit 12"],
    [tool("apply_patch", { patch: "*** Begin Patch" }, { summary: "2 files" }), "2 files"],
  ] as const;

  for (const [entry, headline] of fixtures) {
    const selected = projected(entry);
    assert.equal(selected.headline, headline, entry.title ?? "tool");
    assert.equal(selected.state, "done", entry.title ?? "tool");
    assert.equal(selected.status, "completed", entry.title ?? "tool");
  }
});

test("retains progress, elapsed time, terminal failures, mutation source, diff, errors, and truncation", () => {
  const running = projected(tool("bash", { command: "npm test" }, {
    status: "running",
    toolData: {
      argsComplete: true,
      executionStarted: true,
      input: { command: "npm test" },
      progress: {
        output: "checking\n",
        stdout: "checking\n",
        stderr: "warning\n",
        stdoutBytes: 9,
        stderrBytes: 8,
        elapsedMs: 1_250,
        truncated: true,
      },
    },
  }));
  assert.equal(running.state, "running · 1.3s · truncated");
  assert.deepEqual(running.details?.slice(0, 2).map((detail) => [detail.label, detail.kind, detail.preview, detail.tail]), [
    ["stdout · 9 bytes", "progress", true, true],
    ["stderr · 8 bytes", "error", true, true],
  ]);
  assert.equal(running.details?.at(-1)?.value, "Output was truncated");

  const failed = projected(tool("bash", { command: "false" }, {
    status: "failed",
    text: "command failed",
    toolData: {
      argsComplete: true,
      executionStarted: true,
      input: { command: "false" },
      result: {
        content: "command failed",
        isError: true,
        metadata: { exitCode: 7, durationMs: 80 },
      },
    },
  }));
  assert.equal(failed.state, "failed · exit 7 · 80ms");
  assert.equal(failed.status, "error");
  assert.equal(failed.details?.find((detail) => detail.kind === "error")?.value, "command failed");

  const timedOut = projected(tool("bash", { command: "sleep 10" }, {
    status: "failed",
    toolData: {
      input: { command: "sleep 10" },
      result: { content: "timeout", isError: true, metadata: { timedOut: true } },
    },
  }));
  assert.equal(timedOut.state, "timed out");

  const uncertain = projected(tool("write", { path: "a.ts" }, {
    status: "in_doubt",
    text: "completion was not durably observed",
    toolData: {
      input: { path: "a.ts" },
      result: { content: "completion was not durably observed", isError: true },
    },
  }));
  assert.equal(uncertain.status, "in_doubt");
  assert.equal(uncertain.state, "outcome unknown");

  const write = projected(tool("write", { path: "new.ts", content: "one\ntwo" }, {
    inputPreview: "+ one\n+ two",
  }));
  assert.equal(write.details?.[0]?.kind, "source");
  assert.equal(write.details?.[0]?.value, "+ one\n+ two");

  const edit = projected(tool("edit", { path: "a.ts" }, {
    inputPreview: "- old\n+ new",
    toolData: {
      input: { path: "a.ts" },
      result: { content: "updated", isError: false, metadata: { diff: "- old\n+ new" } },
    },
  }));
  assert.equal(edit.details?.[0]?.kind, "diff");
  assert.equal(edit.details?.[0]?.value, "- old\n+ new");
});

test("generic and extension tools retain bounded structured input and result metadata", () => {
  const entry = projected(tool("extension.deploy", { region: "ca", replicas: 2 }, {
    expanded: true,
    toolData: {
      argsComplete: true,
      executionStarted: true,
      input: { region: "ca", replicas: 2 },
      result: {
        content: "deployed",
        isError: false,
        summary: "release ready",
        nextActions: ["verify"],
        addedToolNames: ["extension.rollback"],
        metadata: { deploymentId: "d-1" },
      },
    },
  }));
  assert.equal(entry.expanded, true);
  assert.match(entry.details?.find((detail) => detail.label === "Input")?.value ?? "", /"replicas": 2/u);
  assert.equal(entry.details?.find((detail) => detail.label === "Output")?.value, "deployed");
  assert.equal(entry.details?.find((detail) => detail.label === "Result")?.value, "release ready");
  assert.equal(entry.details?.find((detail) => detail.label === "Next")?.value, "verify");
  assert.match(entry.details?.find((detail) => detail.label === "Metadata")?.value ?? "", /deploymentId/u);
});

function snapshot(entries: readonly OhmTuiToolEntry[]): OhmTuiSnapshot {
  return {
    transcript: entries,
    queuedMessages: [],
    composer: { value: "", label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
}

test("native cards omit the left rail, keep Ctrl+O final, and obey per-call expansion", () => {
  const base = projected(tool("read", { path: "src/a.ts", offset: 1, limit: 2 }, {
    text: "first\nsecond",
    toolData: {
      input: { path: "src/a.ts", offset: 1, limit: 2 },
      result: { content: "first\nsecond", isError: false, metadata: { shownLines: 2 } },
    },
  }));
  const collapsed = stripAnsi(projectOhmNativeFrame({ snapshot: snapshot([base]), columns: 48 }).text);
  assert.match(collapsed, /✓ read · done\n  ↳ src\/a\.ts · lines 1-2/u);
  assert.match(collapsed, /↳ Output\n    first\n    second\n  … Ctrl\+O details/u);
  assert.ok(collapsed.split("\n").every((line) => !line.startsWith("│")));

  const expanded = stripAnsi(projectOhmNativeFrame({
    snapshot: snapshot([{ ...base, expanded: true }]),
    columns: 48,
    toolDetailsExpanded: false,
  }).text);
  assert.match(expanded, /↳ Metadata[\s\S]*shownLines[\s\S]*… Ctrl\+O collapse/u);

  const perCallCollapsed = stripAnsi(projectOhmNativeFrame({
    snapshot: snapshot([{ ...base, expanded: false }]),
    columns: 48,
    toolDetailsExpanded: true,
  }).text);
  assert.doesNotMatch(perCallCollapsed, /Metadata/u);
  assert.match(perCallCollapsed, /Ctrl\+O details/u);
});

test("native cards show the expansion hint only when expansion changes visible content", () => {
  const shortPreview: OhmTuiToolEntry = {
    id: "short",
    kind: "tool",
    name: "read",
    status: "completed",
    details: [{ kind: "output", label: "Output", value: "one\ntwo", preview: true }],
  };
  const shortCollapsed = stripAnsi(projectOhmNativeFrame({
    snapshot: snapshot([shortPreview]),
    columns: 40,
  }).text);
  const shortExpanded = stripAnsi(projectOhmNativeFrame({
    snapshot: snapshot([{ ...shortPreview, expanded: true }]),
    columns: 40,
  }).text);
  assert.doesNotMatch(shortCollapsed, /Ctrl\+O/u);
  assert.doesNotMatch(shortExpanded, /Ctrl\+O/u);

  const longPreview = stripAnsi(projectOhmNativeFrame({
    snapshot: snapshot([{
      ...shortPreview,
      id: "long",
      details: [{
        kind: "output",
        label: "Output",
        value: Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"),
        preview: true,
      }],
    }]),
    columns: 40,
  }).text);
  assert.match(longPreview, /Ctrl\+O details/u);

  const hiddenDetail = stripAnsi(projectOhmNativeFrame({
    snapshot: snapshot([{
      ...shortPreview,
      id: "hidden",
      details: [
        ...shortPreview.details!,
        { kind: "metadata", label: "Metadata", value: "hidden" },
      ],
    }]),
    columns: 40,
  }).text);
  assert.match(hiddenDetail, /Ctrl\+O details/u);
});

test("native cards stay width-bounded and honor no-color ASCII presentation", () => {
  const entry = projected(tool("bash", { command: "printf 'wide output'" }, {
    status: "running",
    toolData: {
      input: { command: "printf 'wide output'" },
      progress: {
        output: "界".repeat(100),
        stdout: "界".repeat(100),
        stderr: "",
        stdoutBytes: 300,
        stderrBytes: 0,
        truncated: true,
      },
    },
  }));
  const frame = projectOhmNativeFrame({
    snapshot: snapshot([entry]),
    columns: 18,
    theme: createTheme("signal", { color: false, unicode: false }),
    unicode: false,
  }).text;
  assert.equal(frame, stripAnsi(frame));
  assert.doesNotMatch(frame, /[✓×●○↳…│]/u);
  assert.match(frame, /> \$ printf/u);
  assert.match(frame, /\. Ctrl\+O details/u);
  for (const line of frame.split("\n")) assert.ok(cellWidth(line) <= 18, line);
});

test("normalization sanitizes and bounds every native semantic field", () => {
  const selected = normalizeOhmTuiSnapshot(snapshot([{
    id: "tool",
    kind: "tool",
    name: "read\u001b[31m",
    status: "completed",
    headline: "safe\u001b]2;owned\u0007 path",
    state: "done\nnow",
    expanded: true,
    truncated: true,
    details: Array.from({ length: 40 }, (_, index) => ({
      kind: "output" as const,
      label: `Output ${index}\u001b[31m`,
      value: `value ${index}\u001b]2;owned\u0007`,
      preview: true,
    })),
  }])).transcript[0];
  assert.equal(selected?.kind, "tool");
  assert.equal(selected.name, "read");
  assert.equal(selected.headline, "safe path");
  assert.equal(selected.state, "done now");
  assert.equal(selected.details?.length, 32);
  assert.equal(selected.details?.[0]?.label, "Output 0");
  assert.equal(selected.details?.[0]?.value, "value 0");
  assert.equal(selected.expanded, true);
  assert.equal(selected.truncated, true);
});
