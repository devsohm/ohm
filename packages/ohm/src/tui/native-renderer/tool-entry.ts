import {
  isBooleanValue,
  isNumberValue,
  isRecordValue,
  isStringValue,
  type RuntimeRecord,
} from "../value-guards.js";
import { optionalProperties } from "../../core/optional-properties.js";
import type { TranscriptEntry } from "../types.js";
import type {
  OhmTuiToolDetail,
  OhmTuiToolEntry,
  OhmTuiToolStatus,
} from "./types.js";

const BUILT_IN_TOOLS = new Set([
  "read",
  "bash",
  "shell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "apply_patch",
]);

function record<Value>(value: Value): RuntimeRecord | undefined {
  return isRecordValue(value) ? value : undefined;
}

function stringValue(source: RuntimeRecord | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (isStringValue(value) && value.trim() !== "") return value;
  }
  return undefined;
}

function numberValue(source: RuntimeRecord | undefined, key: string): number | undefined {
  const value = source?.[key];
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined;
}

function booleanValue(source: RuntimeRecord | undefined, key: string): boolean | undefined {
  const value = source?.[key];
  return isBooleanValue(value) ? value : undefined;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s*\n\s*/gu, " ").trim();
}

function serialized<Value>(value: Value): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function durationText(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function lineRange(input: RuntimeRecord | undefined): string | undefined {
  const offset = numberValue(input, "offset");
  const limit = numberValue(input, "limit");
  if (offset === undefined && limit === undefined) return undefined;
  const first = Math.max(1, Math.trunc(offset ?? 1));
  return limit === undefined
    ? `from line ${first}`
    : `lines ${first}-${first + Math.max(1, Math.trunc(limit)) - 1}`;
}

function limited(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `limit ${Math.max(0, Math.trunc(value))}`;
}

function semanticHeadline(
  name: string,
  input: RuntimeRecord | undefined,
  summary: string | undefined,
): string | undefined {
  const path = stringValue(input, "path", "file_path", "filePath", "file", "directory");
  if (name === "bash" || name === "shell") {
    const command = stringValue(input, "command", "cmd") ?? summary;
    const timeout = numberValue(input, "timeout");
    return [command === undefined ? undefined : `$ ${oneLine(command)}`, timeout === undefined ? undefined : `timeout ${timeout}s`]
      .filter((value): value is string => value !== undefined)
      .join(" · ") || undefined;
  }
  if (name === "read") {
    return [path ?? summary, lineRange(input)].filter((value): value is string => value !== undefined).join(" · ") || undefined;
  }
  if (name === "grep") {
    const pattern = stringValue(input, "pattern", "query");
    const glob = stringValue(input, "glob");
    const context = numberValue(input, "context");
    return [
      pattern === undefined ? summary : `“${oneLine(pattern)}”`,
      path === undefined ? undefined : `in ${oneLine(path)}`,
      glob === undefined ? undefined : `glob ${oneLine(glob)}`,
      booleanValue(input, "literal") === true ? "literal" : undefined,
      booleanValue(input, "ignoreCase") === true ? "ignore case" : undefined,
      context === undefined ? undefined : `context ${Math.max(0, Math.trunc(context))}`,
      limited(numberValue(input, "limit")),
    ].filter((value): value is string => value !== undefined).join(" · ") || undefined;
  }
  if (name === "find") {
    const pattern = stringValue(input, "pattern", "query") ?? summary;
    return [
      pattern === undefined ? undefined : oneLine(pattern),
      path === undefined ? undefined : `in ${oneLine(path)}`,
      limited(numberValue(input, "limit")),
    ].filter((value): value is string => value !== undefined).join(" · ") || undefined;
  }
  if (name === "ls") {
    return [path ?? summary ?? ".", limited(numberValue(input, "limit"))]
      .filter((value): value is string => value !== undefined).join(" · ");
  }
  if (name === "edit" || name === "write") return summary ?? path;
  if (name === "apply_patch") return summary ?? path ?? "patch";
  return summary;
}

function statusValue(status: TranscriptEntry["status"]): OhmTuiToolStatus {
  if (status === "failed") return "error";
  if (status === "in_doubt") return "in_doubt";
  return status ?? "pending";
}

function lifecycleState(
  entry: TranscriptEntry,
  metadata: RuntimeRecord | undefined,
  truncated: boolean,
): string {
  const elapsed = durationText(entry.status === "running"
    ? entry.toolData?.progress?.elapsedMs
    : numberValue(metadata, "durationMs"));
  const values: string[] = [];
  if (entry.status === "completed") values.push("done");
  else if (entry.status === "failed") {
    if (booleanValue(metadata, "timedOut") === true) values.push("timed out");
    else if (booleanValue(metadata, "cancelled") === true) values.push("aborted");
    else {
      values.push("failed");
      const signal = stringValue(metadata, "signal");
      const exitCode = numberValue(metadata, "exitCode");
      if (signal !== undefined) values.push(`signal ${oneLine(signal)}`);
      else if (exitCode !== undefined) values.push(`exit ${Math.trunc(exitCode)}`);
    }
  } else if (entry.status === "in_doubt") values.push("outcome unknown");
  else if (entry.status === "running") values.push("running");
  else if (entry.toolData?.argsComplete === false) values.push("receiving input");
  else values.push("queued");
  if (elapsed !== undefined) values.push(elapsed);
  if (truncated) values.push("truncated");
  return values.join(" · ");
}

/** Projects the bounded runtime lifecycle into ohm's native tool-card shape. */
export function projectOhmTuiToolEntry(entry: TranscriptEntry): OhmTuiToolEntry | undefined {
  if (entry.kind !== "tool") return undefined;
  const name = oneLine(entry.title ?? "tool") || "tool";
  const input = record(entry.toolData?.input);
  const result = entry.toolData?.result ?? entry.toolData?.partialResult;
  const metadata = record(result?.metadata);
  const progress = entry.toolData?.progress;
  const truncated = result?.truncated === true
    || progress?.truncated === true
    || booleanValue(metadata, "truncated") === true;
  const details: OhmTuiToolDetail[] = [];
  const append = (
    kind: OhmTuiToolDetail["kind"],
    label: string,
    value: string | undefined,
    options: Pick<OhmTuiToolDetail, "preview" | "tail"> = {},
  ): void => {
    if (value === undefined || value === "") return;
    details.push({ kind, label, value, ...options });
  };

  const inputPreview = entry.inputPreview;
  const resultDiff = stringValue(metadata, "diff", "patch");
  if (resultDiff !== undefined) append("diff", "Diff", resultDiff);
  else if (inputPreview !== undefined) {
    if (name === "write") append("source", "Source", inputPreview);
    else if (name === "edit" || name === "apply_patch") append("diff", "Diff", inputPreview);
    else if (input === undefined) append("input", "Input", inputPreview);
  }

  if (input !== undefined && !BUILT_IN_TOOLS.has(name)) append("input", "Input", serialized(input));
  if (name === "write" && inputPreview === undefined) append("source", "Source", stringValue(input, "content"));
  if ((name === "edit" || name === "apply_patch") && inputPreview === undefined && resultDiff === undefined) {
    append("input", "Input", serialized(input));
  }

  if (progress !== undefined) {
    if (progress.stdout !== "" && progress.stderr !== "") {
      append("progress", `stdout · ${progress.stdoutBytes.toLocaleString("en-US")} bytes`, progress.stdout, { preview: true, tail: true });
      append("error", `stderr · ${progress.stderrBytes.toLocaleString("en-US")} bytes`, progress.stderr, { preview: true, tail: true });
    } else {
      append("progress", "Progress", progress.output ?? (progress.stdout || progress.stderr), { preview: true, tail: true });
    }
  }

  const output = result?.content ?? (progress === undefined ? entry.text : undefined);
  const outputError = result?.isError === true || entry.status === "failed" || entry.status === "in_doubt";
  append(outputError ? "error" : entry.status === "running" ? "progress" : "output", outputError ? "Error" : "Output", output, {
    preview: true,
    tail: name === "bash" || name === "shell" || entry.status === "running",
  });
  if (result?.summary !== undefined && result.summary !== output) append("output", "Result", result.summary, { preview: true });
  const nextActions = result?.nextActions;
  const addedToolNames = result?.addedToolNames;
  if ((nextActions?.length ?? 0) > 0) append("metadata", "Next", nextActions!.join("\n"));
  if ((addedToolNames?.length ?? 0) > 0) append("metadata", "Added tools", addedToolNames!.join(", "));
  if (result?.usage !== undefined) append("metadata", "Usage", serialized(result.usage));
  if (metadata !== undefined) append("metadata", "Metadata", serialized(metadata));
  const fullOutputPath = stringValue(metadata, "fullOutputPath");
  if (fullOutputPath !== undefined) append("metadata", "Full output", fullOutputPath);
  if (truncated && fullOutputPath === undefined) append("metadata", "Limit", "Output was truncated");

  const headline = semanticHeadline(name, input, entry.summary);
  return {
    id: entry.id,
    kind: "tool",
    name,
    status: statusValue(entry.status),
    ...optionalProperties(headline === undefined ? undefined : { headline }),
    state: lifecycleState(entry, metadata, truncated),
    ...optionalProperties(entry.summary === undefined ? undefined : { summary: entry.summary }),
    ...optionalProperties(details.length === 0 ? undefined : { details }),
    ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
    ...optionalProperties(truncated ? { truncated: true } : undefined),
  };
}
