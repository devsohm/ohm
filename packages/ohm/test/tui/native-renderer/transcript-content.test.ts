import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeUiBlock } from "../../../src/tui/components.js";
import { projectOhmTuiTranscriptContent } from "../../../src/tui/native-renderer/transcript-content.js";
import type { TerminalImageResolution } from "../../../src/tui/terminal-image.js";
import { createTheme } from "../../../src/tui/theme.js";
import type { TranscriptEntry } from "../../../src/tui/types.js";
import { cellWidth, stripAnsi } from "../../../src/tui/unicode.js";

function text(projection: ReturnType<typeof projectOhmTuiTranscriptContent>): string {
  return projection.block.lines.map((line) => stripAnsi(line)).join("\n");
}

function block(value: string): RuntimeUiBlock {
  return { lines: [{ spans: [{ text: value }] }] };
}

test("projects Markdown headings, fenced code, and diffs through the host theme", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const projected = projectOhmTuiTranscriptContent([{
    id: "assistant",
    kind: "assistant",
    text: "## Result\n```diff\n-old\n+new\n@@ context\n```\nDone",
  }], { columns: 80, theme });
  const rendered = projected.block.lines.join("\n");

  assert.ok(rendered.includes(theme.codes.title));
  assert.ok(rendered.includes(theme.codes.error));
  assert.ok(rendered.includes(theme.codes.success));
  assert.ok(rendered.includes(theme.codes.accent));
  assert.match(text(projected), /Result[\s\S]*-old[\s\S]*\+new[\s\S]*Done/u);
  assert.ok(projected.block.lines.every((line) => cellWidth(stripAnsi(line)) <= 80));
});

test("uses pre-resolved extension tool and session blocks", () => {
  const entries: TranscriptEntry[] = [{
    id: "tool",
    kind: "tool",
    callId: "call",
    title: "fixture",
    status: "completed",
    text: "built-in result",
  }, {
    id: "session",
    kind: "status",
    text: "fallback",
    extension: { type: "message", customType: "owner.extension/message" },
  }];
  const projected = projectOhmTuiTranscriptContent(entries, {
    columns: 48,
    theme: createTheme("mono", { color: false, unicode: false }),
    toolRenderBlocks: new Map([["call", {
      call: block("EXTENSION CALL"),
      result: block("EXTENSION RESULT"),
    }]]),
    sessionRenderBlocks: new Map([["session", block("EXTENSION SESSION")]]),
  });
  const rendered = text(projected);

  assert.match(rendered, /EXTENSION CALL[\s\S]*EXTENSION RESULT[\s\S]*EXTENSION SESSION/u);
  assert.doesNotMatch(rendered, /built-in result|owner\.extension|fallback/u);
});

test("keeps startup and retained cards on their bounded native presentations", () => {
  const entries: TranscriptEntry[] = [{
    id: "startup",
    kind: "startup",
    compactText: "startup compact",
    text: "startup detail",
    expanded: false,
  }, {
    id: "skill",
    kind: "status",
    title: "Skill",
    summary: "inspect",
    text: "skill detail",
    card: "skill",
    expandable: true,
    expanded: false,
  }, {
    id: "compaction",
    kind: "status",
    title: "Context compacted",
    compactText: "2,048 tokens before",
    summary: "summary metadata",
    text: "compaction detail",
    status: "completed",
    card: "compaction",
    expandable: true,
    expanded: false,
  }, {
    id: "branch",
    kind: "status",
    title: "Branch summary",
    compactText: "alternate path",
    text: "branch detail",
    card: "branch_summary",
    expandable: true,
    expanded: false,
  }];
  const projected = projectOhmTuiTranscriptContent(entries, {
    columns: 64,
    theme: createTheme("mono", { color: false, unicode: true }),
    expandKeyHint: "Ctrl+O",
  });
  const rendered = text(projected);

  assert.match(rendered, /startup compact/u);
  assert.match(rendered, /\[skill\][\s\S]*inspect/u);
  assert.match(rendered, /Context compacted[\s\S]*2,048 tokens before/u);
  assert.match(rendered, /Branch summary[\s\S]*alternate path/u);
  assert.doesNotMatch(rendered, /startup detail|skill detail|compaction detail|branch detail/u);
  assert.ok(projected.block.lines.length <= 34);
});

test("applies hidden-reasoning labels and isolated Markdown transforms", () => {
  const calls: Array<[string, string]> = [];
  const entries: TranscriptEntry[] = [{ id: "user", kind: "user", text: "question" }, {
    id: "reasoning",
    kind: "reasoning",
    text: "private summary",
    expanded: true,
  }, {
    id: "assistant",
    kind: "assistant",
    text: "answer",
  }];
  const visible = projectOhmTuiTranscriptContent(entries, {
    columns: 48,
    theme: createTheme("mono", { color: false, unicode: true }),
    transformMarkdown(markdown, context) {
      calls.push([context.messageType, markdown]);
      return `${context.messageType}:${markdown}`;
    },
  });
  const visibleText = text(visible);

  assert.match(visibleText, /user:question/u);
  assert.match(visibleText, /assistant-thinking:private summary/u);
  assert.match(visibleText, /assistant:answer/u);
  assert.deepEqual(calls, [
    ["user", "question"],
    ["assistant-thinking", "private summary"],
    ["assistant", "answer"],
  ]);

  const hidden = projectOhmTuiTranscriptContent(entries, {
    columns: 48,
    theme: createTheme("mono", { color: false, unicode: true }),
    hideReasoningBlock: true,
    hiddenReasoningLabel: "Working through the task",
  });
  const hiddenText = text(hidden);

  assert.match(hiddenText, /question/u);
  assert.match(hiddenText, /Working through the task/u);
  assert.doesNotMatch(hiddenText, /private summary/u);
  assert.match(hiddenText, /answer/u);

  const fallback = projectOhmTuiTranscriptContent([entries[2]!], {
    columns: 48,
    theme: createTheme("mono", { color: false, unicode: false }),
    transformMarkdown() {
      throw new Error("display transform failed");
    },
  });
  assert.match(text(fallback), /answer/u);
});

test("returns relative image placements while keeping payloads out of text", () => {
  const imageData = Buffer.from("not emitted in text").toString("base64");
  const entries: TranscriptEntry[] = [{
    id: "preview",
    kind: "assistant",
    text: "image follows",
    images: [{
      key: "preview:image:0",
      block: { type: "image", mediaType: "image/png", data: imageData },
    }],
  }, {
    id: "fallback",
    kind: "assistant",
    text: "fallback follows",
    images: [{
      key: "fallback:image:0",
      block: { type: "image", mediaType: "image/jpeg", data: imageData },
    }],
  }];
  const resolveImage = (image: (typeof entries)[number]["images"] extends readonly (infer Value)[] | undefined ? Value : never): TerminalImageResolution => {
    if (image.key !== "preview:image:0") return { fallback: "[Image: preview unavailable]" };
    return {
      fallback: "[Image: image/png 20x10]",
      image: {
        key: image.key,
        fingerprint: "fixture-fingerprint",
        imageId: 7,
        mediaType: "image/png",
        data: imageData,
        bytes: 19,
        widthPx: 20,
        heightPx: 10,
        columns: 4,
        rows: 2,
      },
    };
  };
  const projected = projectOhmTuiTranscriptContent(entries, {
    columns: 40,
    theme: createTheme("mono", { color: false, unicode: true }),
    resolveImage,
  });
  const rendered = text(projected);

  assert.equal(projected.images.length, 1);
  assert.deepEqual(projected.images[0] && {
    key: projected.images[0].key,
    row: projected.images[0].row,
    column: projected.images[0].column,
    columns: projected.images[0].columns,
    rows: projected.images[0].rows,
  }, { key: "preview:image:0", row: 3, column: 0, columns: 4, rows: 2 });
  assert.match(rendered, /\[Image: image\/png 20x10\]/u);
  assert.match(rendered, /\[Image: preview unavailable\]/u);
  assert.equal(rendered.includes(imageData), false);
});
