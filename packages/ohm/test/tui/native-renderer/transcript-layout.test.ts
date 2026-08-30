import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_OHM_TRANSCRIPT_LAYOUT_ITEMS,
  OhmTranscriptLayout,
  type OhmTranscriptChunk,
} from "../../../src/tui/native-renderer/transcript-layout.js";

interface Item {
  readonly id: string;
  readonly text: string;
  readonly rows?: number;
}

function chunk(item: Item, options: { prompt?: boolean; fingerprint?: string } = {}): OhmTranscriptChunk<Item> {
  const value: OhmTranscriptChunk<Item> = {
    key: `chunk:${item.id}`,
    itemKeys: [`item:${item.id}`],
    entryIds: [item.id],
    fingerprint: options.fingerprint ?? item.text,
    value: item,
  };
  return options.prompt === true ? { ...value, isUserPrompt: true } : value;
}

test("extracts only visible rows from a bounded 2,000-item transcript", () => {
  let renders = 0;
  const layout = new OhmTranscriptLayout<Item>((source) => {
    renders += 1;
    return { rows: [`${source.value.text}:0`, `${source.value.text}:1`] };
  });
  const entries = Array.from(
    { length: MAX_OHM_TRANSCRIPT_LAYOUT_ITEMS },
    (_, index) => chunk({ id: String(index), text: `row-${index}` }),
  );

  const result = layout.reconcile(entries, 80, 0);
  const visible = layout.window(3_987, 7);

  assert.equal(renders, 2_000);
  assert.equal(result.totalRows, 4_000);
  assert.deepEqual(visible.rows, [
    "row-1993:1",
    "row-1994:0",
    "row-1994:1",
    "row-1995:0",
    "row-1995:1",
    "row-1996:0",
    "row-1996:1",
  ]);
  assert.deepEqual(visible.chunkKeys, [
    "chunk:1993",
    "chunk:1994",
    "chunk:1995",
    "chunk:1996",
  ]);
  assert.equal(visible.totalRows, 4_000);
  assert.throws(
    () => layout.reconcile([...entries, chunk({ id: "overflow", text: "overflow" })], 80, 0),
    /exceeds 2000 items/u,
  );
});

test("repeated live-tail updates do not rerender the unchanged prefix", () => {
  const counts = new Map<string, number>();
  const layout = new OhmTranscriptLayout<Item>((source) => {
    counts.set(source.key, (counts.get(source.key) ?? 0) + 1);
    return { rows: [source.value.text] };
  });
  let entries = Array.from({ length: 100 }, (_, index) =>
    chunk({ id: String(index), text: `stable-${index}` }));
  layout.reconcile(entries, 100, "theme:0");

  for (let revision = 1; revision <= 20; revision += 1) {
    entries = [
      ...entries.slice(0, -1),
      chunk({ id: "99", text: `stream-${revision}` }),
    ];
    const result = layout.reconcile(entries, 100, "theme:0");
    assert.equal(result.retainedChunks, 99);
    assert.equal(result.renderedChunks, 1);
  }

  assert.equal(counts.get("chunk:0"), 1);
  assert.equal(counts.get("chunk:98"), 1);
  assert.equal(counts.get("chunk:99"), 21);
  assert.deepEqual(layout.window(99, 1).rows, ["stream-20"]);
});

test("width and options epoch changes invalidate every cached row", () => {
  const calls: string[] = [];
  const layout = new OhmTranscriptLayout<Item>((source, context) => {
    calls.push(`${source.key}:${context.width}:${context.epoch}`);
    return { rows: [`${source.value.text}@${context.width}/${context.epoch}`] };
  });
  const entries = [chunk({ id: "a", text: "A" }), chunk({ id: "b", text: "B" })];

  assert.equal(layout.reconcile(entries, 80, 0).renderedChunks, 2);
  assert.equal(layout.reconcile(entries.map((entry) => ({ ...entry })), 80, 0).renderedChunks, 0);
  assert.equal(layout.reconcile(entries, 81, 0).renderedChunks, 2);
  assert.equal(layout.reconcile(entries, 81, 1).renderedChunks, 2);
  assert.equal(calls.length, 6);
  assert.deepEqual(layout.window(0, 2).rows, ["A@81/1", "B@81/1"]);
});

test("head truncation rebuilds cumulative starts without retaining stale rows", () => {
  const renders = new Map<string, number>();
  const layout = new OhmTranscriptLayout<Item>((source) => ({
    rows: (() => {
      renders.set(source.key, (renders.get(source.key) ?? 0) + 1);
      return Array.from({ length: source.value.rows ?? 1 }, (_, index) => `${source.value.text}:${index}`);
    })(),
  }));
  layout.reconcile([
    chunk({ id: "a", text: "A", rows: 2 }),
    chunk({ id: "b", text: "B" }),
    chunk({ id: "c", text: "C", rows: 2 }),
  ], 80, 0);

  const result = layout.reconcile([
    chunk({ id: "b", text: "B" }),
    chunk({ id: "c", text: "C", rows: 2 }),
    chunk({ id: "d", text: "D" }),
  ], 80, 0);

  assert.equal(result.retainedChunks, 2);
  assert.equal(result.renderedChunks, 1);
  assert.equal(result.totalItems, 3);
  assert.equal(result.totalRows, 4);
  assert.deepEqual(layout.chunks.map(({ key, start, end }) => ({ key, start, end })), [
    { key: "chunk:b", start: 0, end: 1 },
    { key: "chunk:c", start: 1, end: 3 },
    { key: "chunk:d", start: 3, end: 4 },
  ]);
  assert.deepEqual(layout.window(0, 10).rows, ["B:0", "C:0", "C:1", "D:0"]);
  assert.equal(renders.get("chunk:b"), 1);
  assert.equal(renders.get("chunk:c"), 1);
  assert.equal(renders.get("chunk:d"), 1);
  assert.equal(layout.resolveAnchorRow({ entryId: "a", rowWithinEntry: 0, screenRow: 0 }), undefined);
});

test("emits gaps only between non-empty chunks without assigning them to entries or prompts", () => {
  const layout = new OhmTranscriptLayout<Item>((source) => ({
    rows: Array.from({ length: source.value.rows ?? 1 }, (_, index) => `${source.value.text}:${index}`),
  }), { interChunkGapRows: 1 });
  layout.reconcile([
    chunk({ id: "empty-head", text: "head", rows: 0 }, { prompt: true }),
    chunk({ id: "a", text: "A", rows: 2 }, { prompt: true }),
    chunk({ id: "empty-middle", text: "middle", rows: 0 }, { prompt: true }),
    chunk({ id: "b", text: "B" }, { prompt: true }),
    chunk({ id: "empty-tail", text: "tail", rows: 0 }, { prompt: true }),
  ], 80, 0);

  assert.deepEqual(layout.chunks.map(({ key, start, end }) => ({ key, start, end })), [
    { key: "chunk:empty-head", start: 0, end: 0 },
    { key: "chunk:a", start: 0, end: 2 },
    { key: "chunk:empty-middle", start: 2, end: 2 },
    { key: "chunk:b", start: 3, end: 4 },
    { key: "chunk:empty-tail", start: 4, end: 4 },
  ]);
  assert.deepEqual(layout.ranges, [
    { entryIds: ["a"], start: 0, end: 2 },
    { entryIds: ["b"], start: 3, end: 4 },
  ]);
  assert.deepEqual(layout.promptRows, [0, 3]);
  assert.deepEqual(layout.window(1, 3), {
    rows: ["A:1", "", "B:0"],
    start: 1,
    end: 4,
    totalRows: 4,
    chunkKeys: ["chunk:a", "chunk:b"],
  });
  assert.deepEqual(layout.window(2, 1), {
    rows: [""],
    start: 2,
    end: 3,
    totalRows: 4,
    chunkKeys: [],
  });

  const anchor = layout.anchorAt(2);
  assert.deepEqual(anchor, { entryId: "b", rowWithinEntry: 0, screenRow: 1 });
  assert.equal(anchor === undefined ? undefined : layout.viewportStartForAnchor(anchor), 2);
  assert.equal(layout.totalBytes, Buffer.byteLength("A:0\nA:1\n\nB:0", "utf8"));
});

test("retains exact byte totals and removes a leading gap after head eviction", () => {
  const renders = new Map<string, number>();
  const layout = new OhmTranscriptLayout<Item>((source) => {
    renders.set(source.key, (renders.get(source.key) ?? 0) + 1);
    return { rows: source.value.rows === 0 ? [] : [source.value.text] };
  }, { interChunkGapRows: 1 });
  const empty = chunk({ id: "empty", text: "ignored", rows: 0 });
  const b = chunk({ id: "b", text: "BB" });
  const c = chunk({ id: "c", text: "C" });

  const initial = layout.reconcile([
    chunk({ id: "a", text: "é" }),
    empty,
    b,
    c,
  ], 80, 0);
  assert.equal(initial.totalBytes, Buffer.byteLength("é\n\nBB\n\nC", "utf8"));
  assert.equal(layout.totalBytes, initial.totalBytes);

  const evicted = layout.reconcile([empty, b, c], 80, 0);
  assert.equal(evicted.retainedChunks, 3);
  assert.equal(evicted.renderedChunks, 0);
  assert.equal(evicted.totalRows, 3);
  assert.equal(evicted.totalBytes, Buffer.byteLength("BB\n\nC", "utf8"));
  assert.equal(layout.totalBytes, evicted.totalBytes);
  assert.deepEqual(layout.window(0, 3).rows, ["BB", "", "C"]);
  assert.deepEqual([...renders.values()], [1, 1, 1, 1]);
});

test("indexes default and renderer-selected user prompt rows", () => {
  const layout = new OhmTranscriptLayout<Item>((source) => {
    const rows = ["header", source.value.text, "body"];
    return source.value.id === "custom" ? { rows, promptRows: [1, 1] } : { rows };
  });
  layout.reconcile([
    chunk({ id: "first", text: "first" }),
    chunk({ id: "default", text: "default" }, { prompt: true }),
    chunk({ id: "custom", text: "custom" }, { prompt: true }),
  ], 80, 0);

  assert.deepEqual(layout.promptRows, [3, 7]);
});

test("entry anchors preserve their row and screen position across earlier layout changes", () => {
  const layout = new OhmTranscriptLayout<Item>((source) => ({
    rows: Array.from({ length: source.value.rows ?? 1 }, (_, index) => `${source.value.text}:${index}`),
  }));
  layout.reconcile([
    chunk({ id: "a", text: "A", rows: 2 }),
    chunk({ id: "b", text: "B", rows: 3 }),
    chunk({ id: "c", text: "C" }),
  ], 80, 0);
  const anchor = layout.anchorAt(1, 2);
  assert.deepEqual(anchor, { entryId: "b", rowWithinEntry: 1, screenRow: 2 });

  layout.reconcile([
    chunk({ id: "a", text: "A-wide", rows: 5 }),
    chunk({ id: "b", text: "B", rows: 3 }),
    chunk({ id: "c", text: "C" }),
  ], 80, 0);

  assert.equal(anchor === undefined ? undefined : layout.resolveAnchorRow(anchor), 6);
  assert.equal(anchor === undefined ? undefined : layout.viewportStartForAnchor(anchor), 4);
  assert.deepEqual(layout.window(4, 4).rows, ["A-wide:4", "B:0", "B:1", "B:2"]);
});

test("optionally invalidates only one previous chunk when a following boundary changes", () => {
  const counts = new Map<string, number>();
  const layout = new OhmTranscriptLayout<Item>((source) => {
    counts.set(source.key, (counts.get(source.key) ?? 0) + 1);
    return { rows: [source.value.text] };
  }, { invalidatePreviousOnChange: true });
  const initial = [
    chunk({ id: "a", text: "A" }),
    chunk({ id: "b", text: "B" }),
    chunk({ id: "c", text: "C" }),
  ];
  layout.reconcile(initial, 80, 0);

  const result = layout.reconcile([
    initial[0]!,
    initial[1]!,
    chunk({ id: "c", text: "changed" }),
  ], 80, 0);

  assert.equal(result.retainedChunks, 1);
  assert.equal(result.renderedChunks, 2);
  assert.equal(counts.get("chunk:a"), 1);
  assert.equal(counts.get("chunk:b"), 2);
  assert.equal(counts.get("chunk:c"), 2);
});
