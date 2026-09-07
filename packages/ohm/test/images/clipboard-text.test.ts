import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  copyToNativeClipboard,
  readClipboardText,
} from "../../src/images/clipboard-text.js";
import type { ClipboardCommandSpec } from "../../src/images/clipboard.js";
import { copyToClipboard } from "../../src/images/helpers.js";

test("clipboard text uses the detected native reader with bounded argv execution", async () => {
  const calls: ClipboardCommandSpec[] = [];
  const result = await readClipboardText({
    platform: "linux",
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    runner: async (spec) => {
      calls.push(spec);
      return {
        ok: true,
        stdout: Buffer.from("clipboard text"),
        exitCode: 0,
        timedOut: false,
        outputLimited: false,
        aborted: false,
      };
    },
  });
  assert.deepEqual(result, { text: "clipboard text", backend: "wayland" });
  assert.equal(calls[0]?.command, "wl-paste");
  assert.deepEqual(calls[0]?.args, ["--no-newline", "--type", "text/plain;charset=utf-8"]);
});

test("native clipboard copy writes exact text and rejects oversized payloads", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-clipboard-text-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const command = join(root, "wl-copy");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
const chunks = [];
for await (const chunk of createReadStream("", { fd: 0, autoClose: false })) chunks.push(chunk);
writeFileSync(process.env.HOME + "/copied.txt", Buffer.concat(chunks));
`);
  await chmod(command, 0o700);
  const backend = await copyToNativeClipboard("exact\nclipboard", {
    platform: "linux",
    environment: { PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, WAYLAND_DISPLAY: "wayland-0" },
  });
  assert.equal(backend, "wayland");
  assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "exact\nclipboard");
  await assert.rejects(copyToNativeClipboard("x".repeat(100 * 1024 + 1)), /100 KiB/u);
});

test("public clipboard helper honors the supplied environment", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-clipboard-environment-"));
  const ambient = join(root, "ambient");
  const selected = join(root, "selected");
  const output = join(root, "copied.txt");
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  context.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of [ambient, selected]) {
    await mkdir(directory);
    const command = join(directory, "pbcopy");
    await writeFile(command, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(output)}, process.env.HOME + "\\n" + text);
`);
    await chmod(command, 0o700);
  }
  process.env.PATH = ambient;
  process.env.HOME = ambient;
  const options = {
    platform: "darwin" as const,
    environment: { PATH: selected, HOME: selected },
  };
  assert.equal(await copyToNativeClipboard("control", options), "macos");
  assert.equal(await readFile(output, "utf8"), `${selected}\ncontrol`);
  await rm(output);
  const terminalWrites: string[] = [];
  const stdout = context.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    terminalWrites.push(Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await copyToClipboard("fixture clipboard", options);
  } finally {
    stdout.mock.restore();
  }
  assert.deepEqual(terminalWrites, []);
  assert.equal(await readFile(output, "utf8"), `${selected}\nfixture clipboard`);
});

test("native clipboard writer terminates its live helper when stdin fails", async (context) => {
  const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const closed = once(child, "close");
  const originalSpawn = childProcess.spawn;
  context.after(async () => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (!child.killed) child.kill("SIGKILL");
    await closed;
  });
  context.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  const copying = copyToNativeClipboard("fixture clipboard", { platform: "darwin", environment: {} });
  child.stdin.destroy(new Error("synthetic clipboard pipe failure"));
  assert.equal(await copying, undefined);
  assert.equal(child.killed, true, "failed stdin must not leave a live clipboard helper after clearing its timeout");
  await closed;
});
