import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

import { Type } from "typebox";
import { Check } from "typebox/value";

export const MAX_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const MAX_TASK_BYTES = 16 * 1024;
export const MAX_RESULT_BYTES = 16 * 1024;
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const CHILD_TIMEOUT_MS = 60_000;

const READ_BYTES = 16 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_EVENTS = 8_192;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RECORD_VALUE = Type.Record(Type.String(), Type.Unknown());
const STRING_VALUE = Type.String();
const require = createRequire(import.meta.url);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value, maximum, marker = "\n… output truncated") {
  const source = Buffer.from(value, "utf8");
  if (source.byteLength <= maximum) return value;
  const suffix = Buffer.from(marker, "utf8");
  const limit = Math.max(0, maximum - suffix.byteLength);
  let end = limit;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return `${source.subarray(0, end).toString("utf8")}${suffix.toString("utf8")}`;
}

function replaceDiagnosticControls(value) {
  return [...value].map((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f)
      ? "?"
      : character;
  }).join("");
}

function safeDiagnostic(value) {
  return truncateUtf8(replaceDiagnosticControls(String(value)), 2_048, "…");
}

function assistantText(message) {
  if (!Check(RECORD_VALUE, message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((block) => Check(RECORD_VALUE, block) && block.type === "text" && Check(STRING_VALUE, block.text))
    .map((block) => block.text)
    .join("");
  return text === "" ? undefined : truncateUtf8(text, MAX_RESULT_BYTES);
}

export class NdjsonCollector {
  constructor({
    maxBytes = MAX_STDOUT_BYTES,
    maxLineBytes = MAX_LINE_BYTES,
    maxEvents = MAX_EVENTS,
    onProgress,
  } = {}) {
    this.maxBytes = maxBytes;
    this.maxLineBytes = maxLineBytes;
    this.maxEvents = maxEvents;
    this.onProgress = onProgress;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.buffer = "";
    this.bytes = 0;
    this.events = 0;
    this.text = undefined;
    this.stopReason = undefined;
    this.errorMessage = undefined;
    this.toolCalls = 0;
  }

  push(chunk) {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) throw new Error(`Child JSON output exceeded ${this.maxBytes} bytes`);
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.#consume(false);
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.#consume(true);
    if (this.text === undefined) throw new Error("Child JSON stream ended without an assistant result");
    if (this.stopReason === "error" || this.stopReason === "aborted") {
      throw new Error(this.errorMessage ?? `Child request ${this.stopReason}`);
    }
    return Object.freeze({ text: this.text, events: this.events, toolCalls: this.toolCalls });
  }

  #consume(final) {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.#line(line);
    }
    if (byteLength(this.buffer) > this.maxLineBytes) throw new Error(`Child JSON line exceeded ${this.maxLineBytes} bytes`);
    if (final && this.buffer.trim() !== "") {
      const line = this.buffer;
      this.buffer = "";
      this.#line(line);
    }
  }

  #line(line) {
    if (line.trim() === "") return;
    if (byteLength(line) > this.maxLineBytes) throw new Error(`Child JSON line exceeded ${this.maxLineBytes} bytes`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Child emitted malformed JSON output");
    }
    if (!Check(RECORD_VALUE, event) || !Check(STRING_VALUE, event.type)) {
      throw new Error("Child emitted an invalid JSON event");
    }
    this.events += 1;
    if (this.events > this.maxEvents) throw new Error(`Child emitted more than ${this.maxEvents} JSON events`);

    if (event.type === "message_update" || event.type === "message_end" || event.type === "turn_end") {
      const text = assistantText(event.message);
      if (text !== undefined) {
        this.text = text;
        this.onProgress?.({ phase: event.type === "message_update" ? "writing" : "finishing", text });
      }
      if (event.message?.role === "assistant") {
        this.stopReason = event.message.stopReason;
        this.errorMessage = Check(STRING_VALUE, event.message.errorMessage) ? safeDiagnostic(event.message.errorMessage) : undefined;
      }
      return;
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      for (let index = event.messages.length - 1; index >= 0; index -= 1) {
        const message = event.messages[index];
        const text = assistantText(message);
        if (text === undefined) continue;
        this.text = text;
        this.stopReason = message.stopReason;
        this.errorMessage = Check(STRING_VALUE, message.errorMessage) ? safeDiagnostic(message.errorMessage) : undefined;
        break;
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      this.toolCalls += 1;
      this.onProgress?.({ phase: "tool", tool: Check(STRING_VALUE, event.toolName) ? event.toolName : "tool" });
    }
  }
}

export function currentCliPrefix({
  argv = process.argv,
  execArgv = process.execArgv,
  execPath = process.execPath,
  resolvePackage = () => require.resolve("ohm/package.json"),
} = {}) {
  const entry = argv[1];
  if (Check(STRING_VALUE, entry) && entry !== "") {
    const file = basename(entry);
    if (file === "ohm" || /^ohm\.(?:[cm]?[jt]s)$/u.test(file)) {
      return entry.endsWith(".ts") ? [execPath, ...execArgv, resolve(entry)] : [execPath, resolve(entry)];
    }
  }
  try {
    return [execPath, resolve(dirname(resolvePackage()), "dist/bin/ohm.js")];
  } catch {
    throw new Error("Specialist delegation requires an installed ohm CLI host");
  }
}

export function validateTask(task) {
  if (!Check(STRING_VALUE, task) || task.trim() === "" || byteLength(task) > MAX_TASK_BYTES || task.includes("\0")) {
    throw new Error(`Specialist tasks must be non-empty and at most ${MAX_TASK_BYTES} UTF-8 bytes without NUL`);
  }
  return task;
}

export function buildChildArgv({ cliPrefix, cwd, task, profile, fallbackModel, fallbackThinking }) {
  if (!Array.isArray(cliPrefix) || cliPrefix.length === 0 || cliPrefix.some((entry) => !Check(STRING_VALUE, entry) || entry === "")) {
    throw new Error("Child CLI prefix must be a non-empty argv array");
  }
  if (!Check(STRING_VALUE, task) || task.trim() === "" || byteLength(task) > MAX_TASK_BYTES * 4 || task.includes("\0")) {
    throw new Error("Child task is empty, contains NUL, or is too large");
  }
  const model = profile.model ?? fallbackModel;
  if (!Check(STRING_VALUE, model) || model === "") throw new Error(`Profile ${profile.name} requires an active model`);
  const thinking = profile.thinking ?? fallbackThinking;
  if (!THINKING_LEVELS.has(thinking)) throw new Error(`Profile ${profile.name} has no valid thinking level`);
  const system = [
    `You are the ${profile.name} specialist.`,
    "Complete only the delegated task. Do not delegate work to another agent.",
    profile.instructions,
  ].join("\n\n");
  const argv = [
    ...cliPrefix,
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--workspace", resolve(cwd),
    "--model", model,
    "--thinking", thinking,
    "--max-steps", "8",
    "--max-output-tokens", "2048",
    "--append-system-prompt", system,
  ];
  if (profile.tools.length === 0) argv.push("--no-tools");
  else argv.push("--tools", profile.tools.join(","));
  argv.push("--", task);
  return argv;
}

async function collectStream(processes, id, stream, maximum, signal) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const page = await processes.read(id, stream, { maxBytes: READ_BYTES, signal });
    total += page.data.byteLength;
    if (total > maximum) throw new Error(`Child ${stream} exceeded ${maximum} bytes`);
    chunks.push(Buffer.from(page.data));
    if (page.eof) return Buffer.concat(chunks).toString("utf8");
  }
}

async function consumeStdout(processes, id, collector, signal) {
  for (;;) {
    const page = await processes.read(id, "stdout", { maxBytes: READ_BYTES, signal });
    if (page.data.byteLength > 0) collector.push(page.data);
    if (page.eof) return collector.finish();
  }
}

export async function runChildAgent({ processes, cliPrefix, cwd, task, profile, fallbackModel, fallbackThinking, signal, onProgress }) {
  signal?.throwIfAborted();
  const argv = buildChildArgv({ cliPrefix, cwd, task, profile, fallbackModel, fallbackThinking });
  let lastProgress = 0;
  const collector = new NdjsonCollector({
    onProgress(progress) {
      const now = Date.now();
      if (progress.phase === "writing" && now - lastProgress < 100) return;
      lastProgress = now;
      onProgress?.(progress);
    },
  });
  const id = processes.spawn({
    argv,
    cwd: resolve(cwd),
    inheritEnv: true,
    timeoutMs: CHILD_TIMEOUT_MS,
    signal,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    captureLimitBytes: MAX_STDERR_BYTES,
  });
  try {
    const [parsed, stderr, result] = await Promise.all([
      consumeStdout(processes, id, collector, signal),
      collectStream(processes, id, "stderr", MAX_STDERR_BYTES, signal),
      processes.wait(id, { signal }),
    ]);
    if (result.state !== "succeeded" || result.exitCode !== 0) {
      const diagnostic = safeDiagnostic(stderr.trim() || result.error || `state ${result.state}`);
      throw new Error(`Specialist ${profile.name} failed: ${diagnostic}`);
    }
    signal?.throwIfAborted();
    return Object.freeze({
      profile: profile.name,
      text: parsed.text,
      events: parsed.events,
      toolCalls: parsed.toolCalls,
      durationMs: result.durationMs,
    });
  } catch (error) {
    await processes.cancel(id).catch(() => undefined);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    throw error;
  }
}

export async function mapConcurrent(values, maximum, operation, signal) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_CONCURRENCY) {
    throw new Error(`Concurrency must be from 1 through ${MAX_CONCURRENCY}`);
  }
  if (values.length > MAX_TASKS) throw new Error(`At most ${MAX_TASKS} tasks may run`);
  const cancellation = new AbortController();
  const combined = signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal]);
  const output = Array.from({ length: values.length });
  let cursor = 0;
  let failure;
  const worker = async () => {
    for (;;) {
      combined.throwIfAborted();
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        output[index] = await operation(values[index], index, combined);
      } catch (error) {
        if (failure === undefined) failure = error;
        cancellation.abort(error);
        return;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(maximum, values.length) }, worker));
  if (failure !== undefined) throw failure;
  signal?.throwIfAborted();
  return output;
}

export function chainedTask(task, previous) {
  if (previous === undefined) return task;
  const prior = truncateUtf8(previous, MAX_RESULT_BYTES);
  const composed = task.includes("{previous}")
    ? task.replaceAll("{previous}", prior)
    : `Previous specialist report:\n${prior}\n\nCurrent task:\n${task}`;
  if (byteLength(composed) > MAX_TASK_BYTES * 4) throw new Error("Chained task exceeds the composed task limit");
  return composed;
}
