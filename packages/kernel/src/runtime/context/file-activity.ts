import type { CanonicalMessage, ToolCallBlock } from "../core/types.js";
import { isJsonObject, type JsonValue } from "../core/json.js";
import { Check } from "typebox/value";
import { hasControlCharacters, STRING_VALUE } from "../../internal/value-schemas.js";
import { estimateTextTokens } from "./projection.js";

const FILE_ACTIVITY_MARKER = "\n\n[ohm-file-activity-v1]\n";
const MAX_PATHS_PER_KIND = 512;
const MAX_PATH_BYTES = 4_096;
const MAX_PATH_BYTES_PER_KIND = 64 * 1_024;

export interface CompactionFileActivity {
  readFiles: string[];
  modifiedFiles: string[];
}

function recordPath(values: string[], path: JsonValue | undefined): void {
	if (
		!Check(STRING_VALUE, path) || path === "" ||
		hasControlCharacters(path) ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    values.includes(path)
  ) return;
  const bytes = Buffer.byteLength(path, "utf8");
  let retainedBytes = values.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  while (values.length >= MAX_PATHS_PER_KIND || retainedBytes + bytes > MAX_PATH_BYTES_PER_KIND) {
    const removed = values.shift();
    if (removed === undefined) return;
    retainedBytes -= Buffer.byteLength(removed, "utf8");
  }
  values.push(path);
}

function mergeActivity(target: CompactionFileActivity, source: CompactionFileActivity): void {
  for (const path of source.readFiles) recordPath(target.readFiles, path);
  for (const path of source.modifiedFiles) recordPath(target.modifiedFiles, path);
}

function parsedActivity<T>(value: T): CompactionFileActivity | undefined {
  if (!isJsonObject(value)) return undefined;
  const input = value;
  if (!Array.isArray(input.readFiles) || !Array.isArray(input.modifiedFiles)) return undefined;
  const result: CompactionFileActivity = { readFiles: [], modifiedFiles: [] };
  for (const path of input.readFiles) recordPath(result.readFiles, path);
  for (const path of input.modifiedFiles) recordPath(result.modifiedFiles, path);
  return result;
}

export function parseCompactionFileActivity(text: string): CompactionFileActivity | undefined {
  const marker = text.lastIndexOf(FILE_ACTIVITY_MARKER);
  if (marker < 0) return undefined;
  try {
    return parsedActivity(JSON.parse(text.slice(marker + FILE_ACTIVITY_MARKER.length)));
  } catch {
    return undefined;
  }
}

export function stripCompactionFileActivity(text: string): string {
  const marker = text.lastIndexOf(FILE_ACTIVITY_MARKER);
  if (marker < 0 || parseCompactionFileActivity(text) === undefined) return text;
  return text.slice(0, marker).trimEnd();
}

function patchPaths(patch: JsonValue | undefined): string[] {
  if (!Check(STRING_VALUE, patch) || Buffer.byteLength(patch, "utf8") > 8 * 1024 * 1024) return [];
  const paths: string[] = [];
  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    const prefix = ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
      .find((candidate) => line.startsWith(candidate));
    if (prefix !== undefined) paths.push(line.slice(prefix.length));
  }
  return paths;
}

function recordSuccessfulCall(
  activity: CompactionFileActivity,
  call: ToolCallBlock,
): void {
  if (!isJsonObject(call.arguments)) return;
  const input = call.arguments;
  if (["read", "list", "search", "grep", "find", "ls"].includes(call.name)) {
    recordPath(activity.readFiles, input.path ?? ".");
  } else if (call.name === "write" || call.name === "edit") {
    recordPath(activity.modifiedFiles, input.path);
  } else if (call.name === "apply_patch") {
    for (const path of patchPaths(input.patch)) recordPath(activity.modifiedFiles, path);
  }
}

export function collectCompactionFileActivity(messages: readonly CanonicalMessage[]): CompactionFileActivity {
  const activity: CompactionFileActivity = { readFiles: [], modifiedFiles: [] };
  for (const message of messages) {
    if (message.purpose !== "compaction") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      const previous = parseCompactionFileActivity(block.text);
      if (previous !== undefined) mergeActivity(activity, previous);
    }
  }

  const calls = new Map<string, ToolCallBlock>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") calls.set(block.callId, block);
    }
  }
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.isError) continue;
      const call = calls.get(block.callId);
      if (call !== undefined && call.name === block.name) recordSuccessfulCall(activity, call);
    }
  }
  return activity;
}

export function renderCompactionFileActivity(
  activity: CompactionFileActivity,
  maxTokens: number,
): RenderedCompactionFileActivity {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new RangeError("File activity token budget must be non-negative");
  const selected: CompactionFileActivity = {
    readFiles: [...activity.readFiles],
    modifiedFiles: [...activity.modifiedFiles],
  };
  while (selected.readFiles.length > 0 || selected.modifiedFiles.length > 0) {
    const text = `${FILE_ACTIVITY_MARKER}${JSON.stringify(selected)}`;
    const estimatedTokens = estimateTextTokens(text);
    if (estimatedTokens <= maxTokens) return { text, activity: selected, estimatedTokens };
    if (selected.readFiles.length >= selected.modifiedFiles.length && selected.readFiles.length > 0) selected.readFiles.shift();
    else selected.modifiedFiles.shift();
  }
  return { text: "", activity: selected, estimatedTokens: 0 };
}

export interface RenderedCompactionFileActivity {
  text: string;
  activity: CompactionFileActivity;
  estimatedTokens: number;
}
