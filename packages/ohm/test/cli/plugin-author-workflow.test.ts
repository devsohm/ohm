import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { initPluginPackage, preparePluginPreview, testPluginPackage, validatePluginPackage } from "../../src/cli/plugin-author.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ohm-author-workflow-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

test("author init copies one tested starter without installation or overwriting existing paths", async (t) => {
  const root = await temporary(t);
  const target = join(root, "My Plugin");
  const result = await initPluginPackage(target);
  assert.equal(result.name, "my-plugin");
  assert.deepEqual(result.files.sort(), ["README.md", "checks/runtime.test.mjs", "package.json", "src/index.ts", "tsconfig.json"]);
  assert.equal((await validatePluginPackage(target)).package.name, "my-plugin");
  assert.match(await readFile(join(target, "package.json"), "utf8"), /"private": true/u);
  assert.match(result.nextActions[0] ?? "", /starter README.*release package graph/u);
  await assert.rejects(access(join(target, "node_modules")));
  const before = await readFile(join(target, "src/index.ts"));
  await assert.rejects(initPluginPackage(target), /EEXIST/u);
  assert.deepEqual(await readFile(join(target, "src/index.ts")), before);
  const link = join(root, "linked");
  await symlink(target, link, "dir");
  await assert.rejects(initPluginPackage(link), /EEXIST/u);
  assert.deepEqual(await readFile(join(target, "src/index.ts")), before);
});

test("author init honors cancellation without creating a directory", async (t) => {
  const root = await temporary(t);
  await assert.rejects(initPluginPackage(join(root, "cancelled"), AbortSignal.abort(new Error("cancel init"))), /cancel init/u);
  assert.deepEqual(await readdir(root), []);
});

test("author test runs only the explicitly selected test script and reports its failure", async (t) => {
  const root = await temporary(t);
  const node = JSON.stringify(process.execPath);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "author-behavior", type: "module",
    scripts: { pretest: `${node} prepost.mjs`, test: `${node} test.mjs`, posttest: `${node} prepost.mjs` },
  }));
  await writeFile(join(root, "prepost.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync("unexpected", "ran");');
  await writeFile(join(root, "test.mjs"), 'console.log("behavior passed");');
  const passed = await testPluginPackage(root);
  assert.equal(passed.status, "success");
  assert.equal(passed.exitCode, 0);
  assert.match(passed.stdout, /behavior passed/u);
  await assert.rejects(access(join(root, "unexpected")));
  await writeFile(join(root, "test.mjs"), 'console.error("behavior failed"); process.exitCode = 7;');
  const failed = await testPluginPackage(root);
  assert.equal(failed.status, "error");
  assert.equal(failed.exitCode, 7);
  assert.match(failed.stderr, /behavior failed/u);
});

test("author test requires a declared test instead of npm's implicit fallback", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "author-no-test" }));
  await assert.rejects(testPluginPackage(root), /explicit scripts.test/u);
});

test("author test retains bounded output without turning a passing test into a false failure", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "author-output", scripts: { test: `${JSON.stringify(process.execPath)} test.mjs` } }));
  await writeFile(join(root, "test.mjs"), 'process.stdout.write("x".repeat(2 * 1024 * 1024));');
  const result = await testPluginPackage(root);
  assert.equal(result.status, "success");
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 1024 * 1024);
});

test("author test cancels a running package process", async (t) => {
  const root = await temporary(t);
  const signal = new AbortController();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "author-cancel", scripts: { test: `${JSON.stringify(process.execPath)} test.mjs` } }));
  await writeFile(join(root, "test.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync("started", "yes"); setInterval(() => {}, 1000);');
  const running = testPluginPackage(root, signal.signal);
  const rejected = assert.rejects(running, /cancel tests/u);
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { await access(join(root, "started")); break; }
      catch { if (Date.now() >= deadline) throw new Error("Test process did not start"); }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    signal.abort(new Error("cancel tests"));
  }
  await rejected;
});

test("preview describes the real host invocation without activating extension code", async (t) => {
  const root = await temporary(t);
  const pkg = join(root, "extension");
  await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "preview-probe", type: "module", ohm: { extensions: ["index.mjs"] } }));
  await writeFile(join(pkg, "index.mjs"), 'throw new Error("preview description must not execute me");');
  const preview = await preparePluginPreview(pkg, root);
  assert.deepEqual(preview.argv, ["--workspace", root, "--no-session", "--no-plugins", "--offline", "--plugin", pkg]);
  assert.equal(preview.packageId, "preview-probe");
  assert.equal(preview.nextActions.some((line) => line.includes("/refresh")), true);
  assert.deepEqual(await readdir(root), ["extension"]);
});

test("author preview JSON dispatch never activates unrelated configured extensions and preserves trust flags", async (t) => {
  const root = await temporary(t);
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  const pkg = join(root, "package");
  const marker = join(root, "unexpected-activation");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(workspace);
  await mkdir(pkg);
  const forbidden = `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "activated"); throw new Error("must not activate");`;
  await writeFile(join(agent, "extensions", "unrelated.mjs"), forbidden);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "preview-json-probe", type: "module", ohm: { extensions: ["index.mjs"] } }));
  await writeFile(join(pkg, "index.mjs"), forbidden);
  const child = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/ohm.ts"), "plugins", "preview", pkg,
    "--workspace", workspace, "--json", "--no-approve",
  ], { cwd: resolve("."), env: { ...process.env, OHM_HOME: agent }, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.doesNotThrow(() => JSON.parse(child.stdout));
  assert.match(child.stdout, /"packageId":"preview-json-probe"/u);
  assert.match(child.stdout, /"--no-approve"/u);
  await assert.rejects(access(marker));
  assert.deepEqual(await readdir(workspace), []);
});
