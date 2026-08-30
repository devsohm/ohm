import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import activate from "../extensions/index.mjs";
import { discoverProfiles, parseProfile } from "../extensions/profiles.mjs";
import {
  NdjsonCollector,
  buildChildArgv,
  chainedTask,
  currentCliPrefix,
  mapConcurrent,
  runChildAgent,
  validateTask,
} from "../extensions/runner.mjs";

function profile(name, description, instructions, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${instructions}\n`;
}

test("profile parsing is strict and bounded", () => {
  const selected = parseProfile(profile(
    "reviewer",
    "Review one task",
    "Find concrete defects.",
    "model: openai/test-model\nthinking: high\ntools: read, grep\n",
  ), "reviewer.md", "user");
  assert.deepEqual(selected, {
    name: "reviewer",
    description: "Review one task",
    instructions: "Find concrete defects.",
    tools: ["read", "grep"],
    model: "openai/test-model",
    thinking: "high",
    scope: "user",
  });
  assert.throws(() => parseProfile(profile("other", "Mismatch", "No."), "reviewer.md"), /must match/u);
  assert.throws(() => parseProfile(profile("reviewer", "Review", "No.", "unknown: value\n"), "reviewer.md"), /unsupported/u);
  assert.throws(() => parseProfile(profile("reviewer", "Review", "No.", "tools: read, read\n"), "reviewer.md"), /duplicate/u);
});

test("workspace profiles are ignored unless trusted and override only when trusted", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-specialist-profiles-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const builtinRoot = join(canonicalRoot, "builtin");
  const userRoot = join(canonicalRoot, "user");
  const workspaceRoot = join(canonicalRoot, "workspace");
  await Promise.all([mkdir(builtinRoot), mkdir(userRoot), mkdir(workspaceRoot)]);
  await Promise.all([
    writeFile(join(builtinRoot, "investigator.md"), profile("investigator", "Built in", "Builtin instructions.")),
    writeFile(join(userRoot, "investigator.md"), profile("investigator", "User", "User instructions.")),
    writeFile(join(workspaceRoot, "investigator.md"), profile("investigator", "Workspace", "Workspace instructions.")),
    writeFile(join(workspaceRoot, "reviewer.md"), profile("reviewer", "Workspace review", "Review instructions.")),
  ]);

  const untrusted = await discoverProfiles({ builtinRoot, userRoot, workspaceRoot, projectTrusted: false });
  assert.deepEqual(untrusted.map(({ name, scope }) => [name, scope]), [["investigator", "user"]]);
  const trusted = await discoverProfiles({ builtinRoot, userRoot, workspaceRoot, projectTrusted: true });
  assert.deepEqual(trusted.map(({ name, scope }) => [name, scope]), [
    ["investigator", "workspace"],
    ["reviewer", "workspace"],
  ]);

  await writeFile(join(workspaceRoot, "broken.md"), "not a profile");
  await assert.rejects(discoverProfiles({ builtinRoot, userRoot, workspaceRoot, projectTrusted: true }), /frontmatter/u);
  await assert.doesNotReject(discoverProfiles({ builtinRoot, userRoot, workspaceRoot, projectTrusted: false }));
});

test("child argv is shell-free, isolated, and carries profile controls", () => {
  const argv = buildChildArgv({
    cliPrefix: ["/usr/bin/node", "/opt/ohm.js"],
    cwd: "/workspace",
    task: "Inspect the parser",
    profile: {
      name: "reviewer",
      instructions: "Review carefully.",
      tools: ["read", "grep"],
      model: "openai/profile-model",
      thinking: "xhigh",
    },
    fallbackModel: "openai/fallback",
    fallbackThinking: "low",
  });
  assert.deepEqual(argv.slice(0, 6), ["/usr/bin/node", "/opt/ohm.js", "--mode", "json", "--no-session", "--no-extensions"]);
  assert.ok(argv.includes("--no-context-files"));
  assert.ok(argv.includes("--no-approve"));
  assert.equal(argv[argv.indexOf("--model") + 1], "openai/profile-model");
  assert.equal(argv[argv.indexOf("--thinking") + 1], "xhigh");
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep");
  assert.equal(argv.at(-1), "Inspect the parser");
  assert.match(argv[argv.indexOf("--append-system-prompt") + 1], /Review carefully/u);
  assert.throws(() => currentCliPrefix({
    argv: ["node", "/opt/host.js"],
    execPath: "/usr/bin/node",
    resolvePackage() { throw new Error("missing"); },
  }), /CLI host/u);
  assert.deepEqual(currentCliPrefix({
    argv: ["node", "/opt/host.js"],
    execPath: "/usr/bin/node",
    resolvePackage: () => "/opt/ohm/package.json",
  }), ["/usr/bin/node", resolve("/opt/ohm/dist/bin/ohm.js")]);
  assert.throws(() => validateTask("😀".repeat(5_000)), /16384/u);
});

test("NDJSON parsing handles chunk boundaries and reports bounded progress", () => {
  const progress = [];
  const collector = new NdjsonCollector({ onProgress: (event) => progress.push(event) });
  const records = [
    { type: "session", id: "one" },
    { type: "tool_execution_start", toolName: "read" },
    { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: "stop" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const bytes = Buffer.from(records);
  collector.push(bytes.subarray(0, 11));
  collector.push(bytes.subarray(11, 79));
  collector.push(bytes.subarray(79));
  assert.deepEqual(collector.finish(), { text: "complete", events: 4, toolCalls: 1 });
  assert.equal(progress.some((entry) => entry.phase === "tool" && entry.tool === "read"), true);
  assert.equal(progress.some((entry) => entry.phase === "writing" && entry.text === "partial"), true);
});

test("NDJSON parsing fails closed on malformed and oversized output", () => {
  const malformed = new NdjsonCollector();
  assert.throws(() => malformed.push(Buffer.from("not-json\n")), /malformed/u);
  const oversized = new NdjsonCollector({ maxBytes: 10 });
  assert.throws(() => oversized.push(Buffer.alloc(11, 0x61)), /exceeded/u);
  const missing = new NdjsonCollector();
  missing.push(Buffer.from('{"type":"session"}\n'));
  assert.throws(() => missing.finish(), /without an assistant result/u);
});

test("parallel scheduler preserves order and never exceeds four workers", async () => {
  let active = 0;
  let peak = 0;
  const values = Array.from({ length: 8 }, (_, index) => index);
  const output = await mapConcurrent(values, 4, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolveValue) => setTimeout(resolveValue, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(output, values.map((value) => value * 2));
  await assert.rejects(mapConcurrent(Array.from({ length: 9 }), 4, async () => undefined), /At most 8/u);
});

test("chain composition substitutes the bounded previous report", () => {
  assert.equal(chainedTask("Check {previous} now", "first result"), "Check first result now");
  assert.match(chainedTask("Check again", "first result"), /Previous specialist report:\nfirst result/u);
});

test("the direct extension stays headless across every host mode", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-specialist-modes-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const userData = join(root, "user-data");
  const workspaceData = join(root, "workspace-data");
  await Promise.all([mkdir(userData), mkdir(workspaceData)]);
  const canonicalRoot = await realpath(root);
  const registrations = [];
  const spawned = [];
  let nextId = 0;
  const processes = {
    spawn(spec) { spawned.push(spec); nextId += 1; return `child-${nextId}`; },
    async read(_id, stream) {
      if (stream === "stderr") return { data: new Uint8Array(), eof: true };
      const event = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "mode-safe report" }], stopReason: "stop" },
      }) + "\n";
      return { data: Buffer.from(event), eof: true };
    },
    async wait(id) {
      return {
        id,
        state: "succeeded",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 1,
        stdoutBytes: 1,
        stderrBytes: 0,
        stdoutRetainedBytes: 0,
        stderrRetainedBytes: 0,
        outputTruncated: false,
        exitCode: 0,
        signal: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    },
    async cancel() { throw new Error("successful children are not cancelled"); },
  };
  activate({ registerTool(registration) { registrations.push(registration); }, processes });
  assert.deepEqual(registrations.map(({ name }) => name), ["example_list_specialists", "example_delegate_specialists"]);
  const delegate = registrations.find(({ name }) => name === "example_delegate_specialists");
  const forbiddenUi = new Proxy({}, { get() { throw new Error("headless tool accessed UI"); } });
  for (const mode of ["tui", "print", "json", "rpc", "serve", "sdk"]) {
    const result = await delegate.execute("call", {
      mode: "single",
      tasks: [{ profile: "reviewer", task: `Check ${mode}` }],
    }, undefined, undefined, {
      mode,
      hasUI: false,
      ui: forbiddenUi,
      cwd: root,
      paths: { userData, workspaceData },
      isProjectTrusted: () => false,
      model: { provider: "openai", id: "test-model" },
      thinkingLevel: "high",
    });
    assert.match(result.content[0].text, /mode-safe report/u);
  }
  assert.equal(spawned.length, 6);
  for (const spec of spawned) {
    assert.ok(spec.argv.includes("--no-extensions"));
    assert.ok(spec.argv.includes("--no-session"));
    assert.equal(spec.cwd, canonicalRoot);
  }
});

test("parent cancellation reaches the managed child and requests tree cleanup", async () => {
  let cancellationCalls = 0;
  let spawned;
  const terminalResult = {
    id: "child-1",
    state: "cancelled",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutRetainedBytes: 0,
    stderrRetainedBytes: 0,
    outputTruncated: false,
    exitCode: null,
    signal: "SIGTERM",
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  };
  const aborted = (signal) => new Promise((resolveValue, rejectValue) => {
    const reject = () => rejectValue(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) reject();
    else signal.addEventListener("abort", reject, { once: true });
  });
  const processes = {
    spawn(spec) { spawned = spec; return "child-1"; },
    read(_id, _stream, options) { return aborted(options.signal); },
    wait(_id, options) { return aborted(options.signal); },
    async cancel() { cancellationCalls += 1; return terminalResult; },
  };
  const controller = new AbortController();
  const operation = runChildAgent({
    processes,
    cliPrefix: ["/usr/bin/node", "/opt/ohm.js"],
    cwd: "/workspace",
    task: "Wait",
    profile: { name: "reviewer", instructions: "Review.", tools: [] },
    fallbackModel: "openai/test",
    fallbackThinking: "high",
    signal: controller.signal,
  });
  controller.abort(new Error("stop now"));
  await assert.rejects(operation, /stop now/u);
  assert.equal(spawned.signal, controller.signal);
  assert.equal(spawned.timeoutMs, 60_000);
  assert.equal(spawned.stdout, "pipe");
  assert.equal(spawned.stderr, "pipe");
  assert.equal(cancellationCalls, 1);
});
