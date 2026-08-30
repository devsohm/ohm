export const MAX_OHM_TRANSCRIPT_LAYOUT_ITEMS = 2_000;

export type OhmTranscriptLayoutEpoch = string | number;

/** One stable render unit. Related entries may share a chunk. */
export interface OhmTranscriptChunk<Value> {
  readonly key: string;
  readonly itemKeys: readonly string[];
  readonly entryIds: readonly string[];
  readonly fingerprint: string;
  readonly value: Value;
  readonly isUserPrompt?: boolean;
}

export interface OhmTranscriptLocalRange {
  readonly entryIds: readonly string[];
  readonly start: number;
  readonly end: number;
}

export interface OhmTranscriptChunkRender {
  readonly rows: readonly string[];
  readonly entryRanges?: readonly OhmTranscriptLocalRange[];
  readonly promptRows?: readonly number[];
}

export interface OhmTranscriptRenderContext<Value> {
  readonly width: number;
  readonly epoch: OhmTranscriptLayoutEpoch;
  readonly index: number;
  readonly previous: OhmTranscriptChunk<Value> | undefined;
  readonly next: OhmTranscriptChunk<Value> | undefined;
}

export type OhmTranscriptChunkRenderer<Value> = (
  chunk: OhmTranscriptChunk<Value>,
  context: OhmTranscriptRenderContext<Value>,
) => OhmTranscriptChunkRender;

export interface OhmTranscriptLayoutOptions {
  /** Use when a chunk paints a separator or grouping marker for its successor. */
  readonly invalidatePreviousOnChange?: boolean;
  /** Empty rows inserted between rendered, non-empty chunks. */
  readonly interChunkGapRows?: number;
}

export interface OhmTranscriptChunkLayout {
  readonly key: string;
  readonly itemKeys: readonly string[];
  readonly entryIds: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly rows: number;
}

export interface OhmTranscriptWindow {
  readonly rows: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly totalRows: number;
  readonly chunkKeys: readonly string[];
}

export interface OhmTranscriptAnchor {
  readonly entryId: string;
  readonly rowWithinEntry: number;
  readonly screenRow: number;
}

export interface OhmTranscriptGlobalRange {
  readonly entryIds: readonly string[];
  readonly start: number;
  readonly end: number;
}

export interface OhmTranscriptReconcileResult {
  readonly retainedChunks: number;
  readonly renderedChunks: number;
  readonly totalChunks: number;
  readonly totalItems: number;
  readonly totalRows: number;
  readonly totalBytes: number;
}

type CachedRange = OhmTranscriptGlobalRange;

interface CachedChunk {
  readonly key: string;
  readonly itemKeys: readonly string[];
  readonly entryIds: readonly string[];
  readonly fingerprint: string;
  readonly rows: readonly string[];
  readonly bytes: number;
  readonly ranges: readonly OhmTranscriptLocalRange[];
  readonly promptRows: readonly number[];
  start: number;
  end: number;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function chunkMatches<Value>(cached: CachedChunk, source: OhmTranscriptChunk<Value>): boolean {
  return cached.key === source.key
    && cached.fingerprint === source.fingerprint
    && sameStrings(cached.itemKeys, source.itemKeys)
    && sameStrings(cached.entryIds, source.entryIds);
}

function validateKey(value: string, label: string): void {
  if (value === "") throw new TypeError(`${label} must not be empty`);
}

function validateChunks<Value>(chunks: readonly OhmTranscriptChunk<Value>[]): number {
  const chunkKeys = new Set<string>();
  const itemKeys = new Set<string>();
  let itemCount = 0;
  for (const chunk of chunks) {
    validateKey(chunk.key, "Transcript chunk key");
    if (chunkKeys.has(chunk.key)) throw new TypeError(`Duplicate transcript chunk key: ${chunk.key}`);
    chunkKeys.add(chunk.key);
    if (chunk.itemKeys.length === 0) throw new TypeError(`Transcript chunk ${chunk.key} has no item keys`);
    if (chunk.entryIds.length === 0) throw new TypeError(`Transcript chunk ${chunk.key} has no entry IDs`);
    for (const itemKey of chunk.itemKeys) {
      validateKey(itemKey, "Transcript item key");
      if (itemKeys.has(itemKey)) throw new TypeError(`Duplicate transcript item key: ${itemKey}`);
      itemKeys.add(itemKey);
      itemCount += 1;
    }
    for (const entryId of chunk.entryIds) validateKey(entryId, "Transcript entry ID");
  }
  if (itemCount > MAX_OHM_TRANSCRIPT_LAYOUT_ITEMS) {
    throw new RangeError(`Transcript layout exceeds ${MAX_OHM_TRANSCRIPT_LAYOUT_ITEMS} items`);
  }
  return itemCount;
}

function validateLocalRow(value: number, maximum: number, label: string, allowEnd: boolean): void {
  const upper = allowEnd ? maximum : maximum - 1;
  if (!Number.isSafeInteger(value) || value < 0 || value > upper) {
    throw new RangeError(`${label} is outside the rendered chunk`);
  }
}

function normalizeRender<Value>(
  chunk: OhmTranscriptChunk<Value>,
  rendered: OhmTranscriptChunkRender,
): Pick<CachedChunk, "rows" | "bytes" | "ranges" | "promptRows"> {
  const rows = [...rendered.rows];
  if (rows.some((row) => row.includes("\n") || row.includes("\r"))) {
    throw new TypeError("Transcript renderer rows must not contain line breaks");
  }
  const ranges = rendered.entryRanges === undefined
    ? rows.length === 0 ? [] : [{ entryIds: [...chunk.entryIds], start: 0, end: rows.length }]
    : rendered.entryRanges.map((range) => {
        if (range.entryIds.length === 0) throw new TypeError("Transcript entry range has no entry IDs");
        validateLocalRow(range.start, rows.length, "Transcript entry range start", true);
        validateLocalRow(range.end, rows.length, "Transcript entry range end", true);
        if (range.end <= range.start) throw new RangeError("Transcript entry range must contain at least one row");
        return { entryIds: [...range.entryIds], start: range.start, end: range.end };
      });
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      throw new RangeError("Transcript entry ranges must be ordered and non-overlapping");
    }
  }
  const selectedPromptRows = rendered.promptRows
    ?? (chunk.isUserPrompt === true && rows.length > 0 ? [0] : []);
  const promptRows = [...new Set(selectedPromptRows)].sort((left, right) => left - right);
  for (const row of promptRows) validateLocalRow(row, rows.length, "Transcript prompt row", false);
  return {
    rows,
    bytes: rows.reduce((total, row) => total + Buffer.byteLength(row, "utf8"), 0),
    ranges,
    promptRows,
  };
}

function addSafeMetric(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError(`${label} exceeds safe integer bounds`);
  return total;
}

function firstChunkEndingAfter(chunks: readonly CachedChunk[], row: number): number {
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (chunks[middle]!.end <= row) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstRangeEndingAfter(ranges: readonly CachedRange[], row: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle]!.end <= row) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Retains exact rendered rows and exposes only the selected transcript window. */
export class OhmTranscriptLayout<Value> {
  readonly #renderChunk: OhmTranscriptChunkRenderer<Value>;
  readonly #invalidatePreviousOnChange: boolean;
  readonly #interChunkGapRows: number;
  #chunks: CachedChunk[] = [];
  #ranges: CachedRange[] = [];
  #rangeByEntryId = new Map<string, CachedRange>();
  #promptRows: number[] = [];
  #width: number | undefined;
  #epoch: OhmTranscriptLayoutEpoch | undefined;
  #itemCount = 0;
  #totalRows = 0;
  #totalBytes = 0;

  constructor(
    renderChunk: OhmTranscriptChunkRenderer<Value>,
    options: OhmTranscriptLayoutOptions = {},
  ) {
    this.#renderChunk = renderChunk;
    this.#invalidatePreviousOnChange = options.invalidatePreviousOnChange === true;
    this.#interChunkGapRows = options.interChunkGapRows ?? 0;
    if (!Number.isSafeInteger(this.#interChunkGapRows) || this.#interChunkGapRows < 0) {
      throw new RangeError("Transcript inter-chunk gap must be a non-negative safe integer");
    }
  }

  get itemCount(): number {
    return this.#itemCount;
  }

  get totalRows(): number {
    return this.#totalRows;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get ranges(): readonly OhmTranscriptGlobalRange[] {
    return this.#ranges;
  }

  get promptRows(): readonly number[] {
    return this.#promptRows;
  }

  get chunks(): readonly OhmTranscriptChunkLayout[] {
    return this.#chunks.map((chunk) => ({
      key: chunk.key,
      itemKeys: chunk.itemKeys,
      entryIds: chunk.entryIds,
      start: chunk.start,
      end: chunk.end,
      rows: chunk.rows.length,
    }));
  }

  reconcile(
    chunks: readonly OhmTranscriptChunk<Value>[],
    width: number,
    epoch: OhmTranscriptLayoutEpoch,
  ): OhmTranscriptReconcileResult {
    if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("Transcript layout width must be positive");
    const itemCount = validateChunks(chunks);
    const sameEnvironment = this.#width === width && Object.is(this.#epoch, epoch);
    let sourceOffset = 0;
    let retainedChunks = 0;
    if (sameEnvironment) {
      if (
        chunks.length > 0
        && (this.#chunks[0] === undefined || !chunkMatches(this.#chunks[0], chunks[0]!))
      ) {
        const first = chunks[0]!;
        const shifted = this.#chunks.findIndex((cached) => chunkMatches(cached, first));
        sourceOffset = shifted < 0 ? 0 : shifted;
      }
      const common = Math.min(this.#chunks.length, chunks.length);
      while (
        retainedChunks < common
        && sourceOffset + retainedChunks < this.#chunks.length
        && chunkMatches(this.#chunks[sourceOffset + retainedChunks]!, chunks[retainedChunks]!)
      ) {
        retainedChunks += 1;
      }
      const followingChanged = retainedChunks < chunks.length
        || sourceOffset + retainedChunks < this.#chunks.length;
      if (followingChanged && this.#invalidatePreviousOnChange && retainedChunks > 0) {
        retainedChunks -= 1;
      }
    }

    const nextChunks = this.#chunks.slice(sourceOffset, sourceOffset + retainedChunks);
    for (let index = retainedChunks; index < chunks.length; index += 1) {
      const source = chunks[index]!;
      const normalized = normalizeRender(source, this.#renderChunk(source, {
        width,
        epoch,
        index,
        previous: chunks[index - 1],
        next: chunks[index + 1],
      }));
      nextChunks.push({
        key: source.key,
        itemKeys: [...source.itemKeys],
        entryIds: [...source.entryIds],
        fingerprint: source.fingerprint,
        ...normalized,
        start: 0,
        end: 0,
      });
    }

    let row = 0;
    let contentBytes = 0;
    let hasNonEmptyChunk = false;
    const ranges: CachedRange[] = [];
    const rangeByEntryId = new Map<string, CachedRange>();
    const promptRows: number[] = [];
    for (const chunk of nextChunks) {
      if (chunk.rows.length > 0 && hasNonEmptyChunk) {
        row = addSafeMetric(row, this.#interChunkGapRows, "Transcript row count");
      }
      chunk.start = row;
      row = addSafeMetric(row, chunk.rows.length, "Transcript row count");
      chunk.end = row;
      contentBytes = addSafeMetric(contentBytes, chunk.bytes, "Transcript byte count");
      for (const local of chunk.ranges) {
        const range = {
          entryIds: local.entryIds,
          start: chunk.start + local.start,
          end: chunk.start + local.end,
        };
        ranges.push(range);
        for (const entryId of range.entryIds) {
          if (!rangeByEntryId.has(entryId)) rangeByEntryId.set(entryId, range);
        }
      }
      promptRows.push(...chunk.promptRows.map((promptRow) => chunk.start + promptRow));
      if (chunk.rows.length > 0) hasNonEmptyChunk = true;
    }
    const totalBytes = row === 0
      ? 0
      : addSafeMetric(contentBytes, row - 1, "Transcript byte count");

    this.#chunks = nextChunks;
    this.#ranges = ranges.sort((left, right) => left.start - right.start);
    this.#rangeByEntryId = rangeByEntryId;
    this.#promptRows = promptRows;
    this.#width = width;
    this.#epoch = epoch;
    this.#itemCount = itemCount;
    this.#totalRows = row;
    this.#totalBytes = totalBytes;
    return {
      retainedChunks,
      renderedChunks: chunks.length - retainedChunks,
      totalChunks: chunks.length,
      totalItems: itemCount,
      totalRows: row,
      totalBytes,
    };
  }

  window(start: number, height: number): OhmTranscriptWindow {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(height)) {
      throw new RangeError("Transcript window geometry must use safe integers");
    }
    const selectedStart = Math.min(this.#totalRows, Math.max(0, start));
    const selectedHeight = Math.max(0, height);
    const selectedEnd = Math.min(this.#totalRows, selectedStart + selectedHeight);
    const rows: string[] = [];
    const chunkKeys: string[] = [];
    for (
      let index = firstChunkEndingAfter(this.#chunks, selectedStart);
      index < this.#chunks.length;
      index += 1
    ) {
      const chunk = this.#chunks[index]!;
      if (chunk.rows.length === 0) continue;
      const gapStart = chunk.start === 0
        ? 0
        : chunk.start - this.#interChunkGapRows;
      if (gapStart >= selectedEnd) break;
      const selectedGapStart = Math.max(selectedStart, gapStart);
      const selectedGapEnd = Math.min(selectedEnd, chunk.start);
      if (selectedGapEnd > selectedGapStart) {
        rows.push(...Array.from({ length: selectedGapEnd - selectedGapStart }, () => ""));
      }
      const localStart = Math.max(0, selectedStart - chunk.start);
      const localEnd = Math.min(chunk.rows.length, selectedEnd - chunk.start);
      if (localEnd <= localStart) continue;
      chunkKeys.push(chunk.key);
      rows.push(...chunk.rows.slice(localStart, localEnd));
    }
    return {
      rows,
      start: selectedStart,
      end: selectedStart + rows.length,
      totalRows: this.#totalRows,
      chunkKeys,
    };
  }

  anchorAt(viewportStart: number, screenRow = 0): OhmTranscriptAnchor | undefined {
    if (
      !Number.isSafeInteger(viewportStart)
      || viewportStart < 0
      || !Number.isSafeInteger(screenRow)
      || screenRow < 0
      || !Number.isSafeInteger(viewportStart + screenRow)
    ) {
      throw new RangeError("Transcript anchor geometry must use non-negative safe integers");
    }
    const target = viewportStart + screenRow;
    const selected = this.#ranges[firstRangeEndingAfter(this.#ranges, target)];
    const entryId = selected?.entryIds[0];
    if (selected === undefined || entryId === undefined) return undefined;
    return {
      entryId,
      rowWithinEntry: Math.max(0, target - selected.start),
      screenRow: screenRow + Math.max(0, selected.start - target),
    };
  }

  resolveAnchorRow(anchor: OhmTranscriptAnchor): number | undefined {
    if (!Number.isSafeInteger(anchor.rowWithinEntry) || anchor.rowWithinEntry < 0) {
      throw new RangeError("Transcript anchor row must be a non-negative safe integer");
    }
    const range = this.#rangeByEntryId.get(anchor.entryId);
    if (range === undefined || range.end <= range.start) return undefined;
    return range.start + Math.min(Math.max(0, anchor.rowWithinEntry), range.end - range.start - 1);
  }

  viewportStartForAnchor(anchor: OhmTranscriptAnchor): number | undefined {
    if (!Number.isSafeInteger(anchor.screenRow) || anchor.screenRow < 0) {
      throw new RangeError("Transcript anchor screen row must be a non-negative safe integer");
    }
    const row = this.resolveAnchorRow(anchor);
    return row === undefined ? undefined : Math.max(0, row - anchor.screenRow);
  }

  clear(): void {
    this.#chunks = [];
    this.#ranges = [];
    this.#rangeByEntryId.clear();
    this.#promptRows = [];
    this.#width = undefined;
    this.#epoch = undefined;
    this.#itemCount = 0;
    this.#totalRows = 0;
    this.#totalBytes = 0;
  }
}
