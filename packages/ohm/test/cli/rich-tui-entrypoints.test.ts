import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runPackageCommand,
  runPackageConfigCommand,
} from "../../src/cli/extensions-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";
import { selectStartupSession } from "../../src/cli/session-picker.js";
import type { SessionInfo } from "../../src/storage/types.js";
import { TuiController } from "../../src/tui/index.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput } from "../tui/helpers.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the terminal entrypoint");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function replaceProcessTty() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout");
  assert.ok(stdin);
  assert.ok(stdout);
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  return {
    input,
    output,
    restore() {
      Object.defineProperty(process, "stdin", stdin);
      Object.defineProperty(process, "stdout", stdout);
    },
  };
}

function session(): SessionInfo {
  return {
    path: "/tmp/rich-startup-session.jsonl",
    id: "rich-startup-session",
    cwd: "/tmp/workspace",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-02T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "resume this task",
    allMessagesText: "resume this task",
  };
}

test("the default startup session picker uses the rich overlay with one input owner", async () => {
  const tty = replaceProcessTty();
  const selection = selectStartupSession(async () => [session()], async () => [session()]);
  try {
    await waitFor(() => stripAnsi(tty.output.text).includes("Resume Session"));
    const rendered = stripAnsi(tty.output.text);
    assert.match(rendered, /Resume Session\s+1\/1/u);
    assert.match(rendered, /workspace · all · threaded · path off/u);
    assert.match(rendered, /─ Ask ohm /u);
    assert.equal(tty.input.listenerCount("data"), 1);

    tty.input.end();
    assert.equal(await selection, undefined);
    assert.equal(tty.input.listenerCount("data"), 0);
    assert.deepEqual(tty.input.rawChanges, [true, false]);
  } finally {
    if (!tty.input.destroyed) tty.input.end();
    tty.restore();
  }
});

test("the startup selector still accepts an injected TuiController", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectStartupSession(async () => [session()], async () => [session()], {
    createTerminal: (onAction) => new TuiController({
      input,
      output,
      environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      handleSignals: false,
      onAction,
    }),
  });

  await waitFor(() => input.listenerCount("data") === 1);
  assert.equal(input.listenerCount("data"), 1);
  input.end();
  assert.equal(await selection, undefined);
  assert.equal(input.listenerCount("data"), 0);
  assert.deepEqual(input.rawChanges, [true, false]);
});

test("the public TuiController defaults to the updated rich projector", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });

  controller.start();
  try {
    const rendered = stripAnsi(output.text);
    assert.match(rendered, /─ Ask ohm /u);
    assert.doesNotMatch(rendered, /you> /u);
    assert.equal(input.listenerCount("data"), 1);
  } finally {
    controller.close();
  }
});

test("TTY package resource settings use the rich overlay with one input owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohm-rich-package-config-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  await mkdir(workspace);
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "rich-package-config",
    version: "1.0.0",
    ohm: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\n");

  const previousAgentDir = process.env.OHM_HOME;
  process.env.OHM_HOME = agentDir;
  const tty = replaceProcessTty();
  let config: Promise<void> | undefined;
  try {
    await runPackageCommand(parseManagementArguments([
      "install", packageRoot, "--workspace", workspace, "--json",
    ]));
    tty.output.chunks.length = 0;

    config = runPackageConfigCommand(parseManagementArguments([
      "config", "--workspace", workspace,
    ]));
    await waitFor(() => stripAnsi(tty.output.text).includes("Settings"));
    const rendered = stripAnsi(tty.output.text);
    assert.match(rendered, /Settings\s+1\/2/u);
    assert.match(rendered, /Done\s+Close settings/u);
    assert.match(rendered, /rich-package-config|\.\.\/package/u);
    assert.match(rendered, /extensions · extensions\/index\.mjs/u);
    assert.match(rendered, /─ Ask ohm /u);
    assert.equal(tty.input.listenerCount("data"), 1);

    tty.input.write(Buffer.from([3]));
    await config;
    assert.equal(tty.input.listenerCount("data"), 0);
    assert.deepEqual(tty.input.rawChanges, [true, false]);
  } finally {
    if (tty.input.listenerCount("data") > 0) tty.input.write(Buffer.from([3]));
    await config?.catch(() => undefined);
    tty.restore();
    if (previousAgentDir === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
