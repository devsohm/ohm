import { optionalProperty } from "./internal/optional-properties.js";
import {
  ExecutionError,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  toError,
} from "./harness/types.js";
import { truncateTail, type TruncationResult } from "./text-limits.js";

const CAPTURE_BYTES = 50 * 1024;
const CAPTURE_LINES = 2_000;
const SPOOL_BACKLOG_BYTES = 8 * 1024 * 1024;
const SPOOL_BACKLOG_CHUNKS = 4_096;

export interface ShellCaptureProgress {
  output: string;
  truncated: boolean;
  truncation: TruncationResult;
  fullOutputPath?: string;
  lastLineBytes: number;
}

export interface ShellCapture extends ShellCaptureProgress {
  cancelled: boolean;
  executionError?: ExecutionError;
  exitCode?: number;
}

export interface ShellCaptureOptions extends ShellExecOptions {
  onChunk?: (chunk: string, progress: () => ShellCaptureProgress) => void;
  returnExecutionErrors?: boolean;
}

function countLastLineBytes(value: string): number {
  const newline = value.lastIndexOf("\n");
  return Buffer.byteLength(newline < 0 ? value : value.slice(newline + 1), "utf8");
}

export async function executeShellWithCapture(
  env: ExecutionEnv,
  command: string,
  options: ShellCaptureOptions = {},
): Promise<Result<ShellCapture, ExecutionError>> {
  const pending: string[] = [];
  const controller = new AbortController();
  let settled = false;
  let fullOutputPath: string | undefined;
  let tail = "";
  let pendingSurrogate = "";
  let totalBytes = 0;
  let newlines = 0;
  let firstLineBytes = 0;
  let firstLineEnded = false;
  let lastLineBytes = 0;
  let pendingBytes = 0;
  let spilling = false;
  let spoolTask: Promise<void> | undefined;
  let spoolError: ExecutionError | undefined;
  let outputLimit = false;
  let current = truncateTail("", { maxBytes: CAPTURE_BYTES, maxLines: CAPTURE_LINES });
  const progress = (): ShellCaptureProgress => ({
    output: current.content,
    truncated: current.truncated,
    truncation: current,
    ...optionalProperty("fullOutputPath", fullOutputPath),
    lastLineBytes,
  });
  const startSpool = (): void => {
    if (spoolTask !== undefined || spoolError !== undefined) return;
    spoolTask = (async () => {
      if (fullOutputPath === undefined) {
        const temporary = await env.createTempFile({ prefix: "ohm-shell-", suffix: ".log" });
        if (!temporary.ok) throw temporary.error;
        fullOutputPath = temporary.value.path;
        const first = pending.shift()!;
        const written = await env.writeFile(fullOutputPath, first);
        if (!written.ok) throw written.error;
        pendingBytes -= Buffer.byteLength(first, "utf8");
      }
      while (pending.length > 0) {
        const chunk = pending.shift()!;
        const written = await env.appendFile(fullOutputPath, chunk);
        if (!written.ok) throw written.error;
        pendingBytes -= Buffer.byteLength(chunk, "utf8");
      }
    })().catch((error) => {
      spoolError = new ExecutionError("unknown", toError(error).message);
      pending.length = 0;
      pendingBytes = 0;
      controller.abort(spoolError);
    }).finally(() => {
      spoolTask = undefined;
      if (pending.length > 0) startSpool();
    });
  };
  const capture = (chunk: string, alreadyAccepted = false): boolean => {
    if (spoolError !== undefined || (outputLimit && !alreadyAccepted)) return false;
    if (chunk === "") return true;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const retainedBytes = spilling ? pendingBytes : totalBytes;
    if (retainedBytes + chunkBytes > SPOOL_BACKLOG_BYTES || pending.length >= SPOOL_BACKLOG_CHUNKS) {
      outputLimit = true;
      controller.abort(new ExecutionError("output_limit", "Shell output capture backlog exceeded its limit"));
      return false;
    }
    const combined = tail + chunk;
    totalBytes += chunkBytes;
    const firstNewline = chunk.indexOf("\n");
    if (!firstLineEnded) {
      firstLineBytes += Buffer.byteLength(firstNewline < 0 ? chunk : chunk.slice(0, firstNewline), "utf8");
      firstLineEnded = firstNewline >= 0;
    }
    for (let index = firstNewline; index >= 0; index = chunk.indexOf("\n", index + 1)) newlines += 1;
    lastLineBytes = firstNewline < 0 ? lastLineBytes + chunkBytes : countLastLineBytes(chunk);
    const totalLines = newlines + (chunk.endsWith("\n") ? 0 : 1);
    const bytes = Buffer.from(combined, "utf8");
    let start = Math.max(0, bytes.length - CAPTURE_BYTES - 8);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    tail = start === 0 ? combined : bytes.toString("utf8", start);
    const lineTruncated = totalLines > CAPTURE_LINES;
    const selected = truncateTail(lineTruncated && tail.endsWith("\n") ? tail.slice(0, -1) : tail, {
      maxBytes: CAPTURE_BYTES, maxLines: CAPTURE_LINES,
    });
    current = {
      ...selected,
      totalBytes,
      totalLines,
      truncated: lineTruncated || totalBytes > CAPTURE_BYTES,
      truncatedBy: selected.truncatedBy === "bytes" ? "bytes" : lineTruncated ? "lines" : null,
      firstLineExceedsLimit: firstLineBytes > CAPTURE_BYTES,
    };
    if (spilling || current.truncated) {
      const queued = spilling ? chunk : combined;
      spilling = true;
      pending.push(queued);
      pendingBytes += Buffer.byteLength(queued, "utf8");
      startSpool();
    }
    return true;
  };
  const receive = (chunk: string): void => {
    if (settled || spoolError !== undefined || outputLimit) return;
    const joined = pendingSurrogate + chunk;
    const last = joined.charCodeAt(joined.length - 1);
    const incomplete = last >= 0xd800 && last <= 0xdbff;
    // Preserve a surrogate pair split across custom execution callbacks before UTF-8 spooling.
    if (capture(incomplete ? joined.slice(0, -1) : joined)) {
      pendingSurrogate = incomplete ? joined.slice(-1) : "";
      options.onChunk?.(chunk, progress);
    }
  };
  const executionOptions: ShellExecOptions = {
    onStdout: receive,
    onStderr: receive,
    ...optionalProperty("cwd", options.cwd),
    ...optionalProperty("env", options.env),
    ...optionalProperty("timeout", options.timeout),
    abortSignal: options.abortSignal === undefined ? controller.signal : AbortSignal.any([options.abortSignal, controller.signal]),
  };

  let result: Awaited<ReturnType<ExecutionEnv["exec"]>>;
  try {
    result = await env.exec(command, executionOptions);
  } catch (error) {
    result = { ok: false, error: new ExecutionError("unknown", toError(error).message) };
  }
  settled = true;
  while (spoolTask !== undefined) await spoolTask;
  if (pendingSurrogate !== "") {
    capture(pendingSurrogate, true);
    pendingSurrogate = "";
    while (spoolTask !== undefined) await spoolTask;
  }
  if (spoolError !== undefined) return { ok: false, error: spoolError };
  if (outputLimit) {
    result = { ok: false, error: new ExecutionError("output_limit",
      `Shell output capture exceeded its ${SPOOL_BACKLOG_BYTES}-byte or ${SPOOL_BACKLOG_CHUNKS}-chunk backlog limit; further output was not captured`,
      { capturedBytes: totalBytes, ...optionalProperty("fullOutputPath", fullOutputPath) },
    ) };
  }
  if (current.truncated) options.onChunk?.("", progress);

  if (!result.ok && result.error.code !== "aborted" && options.returnExecutionErrors !== true) return result;
  return {
    ok: true,
    value: {
      ...progress(),
      cancelled: !result.ok && result.error.code === "aborted",
      ...(result.ok ? { exitCode: result.value.exitCode } : { executionError: result.error }),
    },
  };
}
