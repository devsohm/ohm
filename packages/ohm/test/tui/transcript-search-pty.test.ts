import { terminalPattern } from "../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("a real PTY opens, navigates, and closes rendered transcript search with enhanced keys", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-transcript-search-pty-"));
  const markerPath = join(root, "markers.log");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("../fixtures/tui-transcript-search.ts", import.meta.url));
  const command = [
    "stty cols 64 rows 18",
    `TERM=xterm-256color NO_COLOR=1 ${[
      process.execPath,
      "--import",
      "tsx",
      fixture,
    ].map(shellQuote).join(" ")}`,
  ].join("; ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    env: { ...process.env, OHM_TRANSCRIPT_SEARCH_PTY_MARKERS: markerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const markers = async (): Promise<string[]> => {
    if (!existsSync(markerPath)) return [];
    return (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
  };
  const waitForMarker = async (expected: string): Promise<void> => await waitFor(
    async () => (await markers()).includes(expected),
    `missing ${expected} marker:\n${rendered}`,
  );

  await waitForMarker("ready");
  child.stdin.write("\u001b[102;6uneedle");
  await waitForMarker("search:needle:3");
  const before = (await markers()).filter((marker) => marker.startsWith("selected:"));
  child.stdin.write(Buffer.from([7]));
  await waitFor(
    async () => (await markers()).filter((marker) => marker.startsWith("selected:")).length > before.length,
    `search selection did not navigate:\n${rendered}`,
  );
  child.stdin.write("\u001b");
  await waitForMarker("closed");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`transcript-search PTY fixture did not exit:\n${rendered}`));
    }, 10_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, /\? needle\s+[1-3]\/3/u);
  assert.match(rendered, /transcript-search-pty-complete/u);
  assert.equal(rendered.match(terminalPattern("\\u001b\\[\\?1049h", "gu"))?.length, 1, rendered);
  assert.equal(rendered.match(terminalPattern("\\u001b\\[\\?1049l", "gu"))?.length, 1, rendered);
  assert.doesNotMatch(rendered, /\^G/u);
});
