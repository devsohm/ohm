import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { OHM_VERSION } from "../../src/version.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, offset: number, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!read().slice(offset).includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function waitForOutputChange(read: () => string, offset: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (read().length === offset) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for terminal redraw:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("built CLI full viewport renders commands, closes settings, and restores the terminal", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-command-output-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const command = [
    process.execPath,
    resolve("dist/bin/ohm.js"),
    "chat",
    "--workspace",
    workspace,
    "--offline",
    "--no-browser",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-session",
  ].map(shellQuote).join(" ");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OHM_HOME: agentDirectory,
    OHM_SYNC_UPDATE: "0",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    FORCE_COLOR: "3",
  };
  delete environment.NO_COLOR;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const read = () => rendered;

  await waitForOutput(read, 0, `ohm ${OHM_VERSION} · ready`);

  const helpOffset = read().length;
  child.stdin.write("/help\r");
  await waitForOutput(read, helpOffset, "/quit");
  const helpOutput = read().slice(helpOffset);
  assert.match(helpOutput, /Interactive commands:/u);
  assert.match(helpOutput, /\/settings/u);
  assert.match(helpOutput, /\/resources/u);
  assert.match(helpOutput, /\/quit/u);
  assert.doesNotMatch(helpOutput, /Usage: ohm/u);

  const resourcesOffset = read().length;
  child.stdin.write("/resources\r");
  await waitForOutput(read, resourcesOffset, "Project packages (0)");
  const resourcesOutput = read().slice(resourcesOffset);
  assert.match(resourcesOutput, /Loaded resources/u);
  assert.match(resourcesOutput, /Extensions \(0\)/u);
  assert.match(resourcesOutput, /Commands \(0\)/u);
  assert.match(resourcesOutput, /Prompts \(0\)/u);
  assert.match(resourcesOutput, /Skills \(0\)/u);
  assert.match(resourcesOutput, /Themes \(0\)/u);
  assert.match(resourcesOutput, /Instruction files \(0\)/u);
  assert.match(resourcesOutput, /Project packages \(0\)/u);

  const settingsOffset = read().length;
  child.stdin.write("/settings\r");
  await waitForOutput(read, settingsOffset, "Esc close");
  const settingsOutput = read().slice(settingsOffset);
  assert.match(settingsOutput, /Settings/u);
  const closeOffset = read().length;
  child.stdin.write("\u001b");
  await waitForOutputChange(read, closeOffset);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));

  const exitCode = new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chat did not exit:\n${read().slice(-16 * 1024)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  child.stdin.write("/exit\r");
  assert.equal(await exitCode, 0, read());
  assert.equal(read().includes("\u001b[?1049h"), true);
  assert.equal(read().includes("\u001b[?1049l"), true);
});
