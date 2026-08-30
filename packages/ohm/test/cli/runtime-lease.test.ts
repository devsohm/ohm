import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireRuntimeLease } from "../../src/bin/runtime-lease.js";

function marker(installRoot: string) {
  return {
    product: "ohm",
    schemaVersion: 2,
    installationId: "a".repeat(32),
    installRoot,
    version: "0.1.0",
    launcherPath: join(installRoot, "bin", "ohm"),
    launcherSha256: "b".repeat(64),
    commandLink: join(installRoot, "bin", "ohm"),
    commandSha256: "b".repeat(64),
  };
}

test("installed runtimes hold and release a process lease", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-lease-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, ".installation.json"), JSON.stringify(marker(installRoot)));
  const previousRoot = process.env.OHM_INSTALL_DIR;
  const previousPid = process.env.OHM_LIFECYCLE_CALLER_PID;
  const previousLease = process.env.OHM_LIFECYCLE_CALLER_LEASE;
  process.env.OHM_INSTALL_DIR = installRoot;
  delete process.env.OHM_LIFECYCLE_CALLER_PID;
  delete process.env.OHM_LIFECYCLE_CALLER_LEASE;
  context.after(() => {
    if (previousRoot === undefined) delete process.env.OHM_INSTALL_DIR;
    else process.env.OHM_INSTALL_DIR = previousRoot;
    if (previousPid === undefined) delete process.env.OHM_LIFECYCLE_CALLER_PID;
    else process.env.OHM_LIFECYCLE_CALLER_PID = previousPid;
    if (previousLease === undefined) delete process.env.OHM_LIFECYCLE_CALLER_LEASE;
    else process.env.OHM_LIFECYCLE_CALLER_LEASE = previousLease;
  });

  const lease = await acquireRuntimeLease();
  assert.ok(lease);
  const entries = await readdir(join(installRoot, ".runtime-leases"));
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  const record = JSON.parse(await readFile(join(installRoot, ".runtime-leases", entry), "utf8"));
  assert.equal(record.pid, process.pid);
  assert.equal(record.lease, process.env.OHM_LIFECYCLE_CALLER_LEASE);
  await lease.release();
  assert.deepEqual(await readdir(join(installRoot, ".runtime-leases")), []);
  assert.equal(process.env.OHM_LIFECYCLE_CALLER_PID, undefined);
  assert.equal(process.env.OHM_LIFECYCLE_CALLER_LEASE, undefined);
});

test("standalone runtimes hold a process lease without a source installation marker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-standalone-runtime-lease-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  await mkdir(installRoot, { recursive: true });
  const previousRoot = process.env.OHM_INSTALL_DIR;
  const previousDistribution = process.env.OHM_DISTRIBUTION;
  const previousPid = process.env.OHM_LIFECYCLE_CALLER_PID;
  const previousLease = process.env.OHM_LIFECYCLE_CALLER_LEASE;
  process.env.OHM_INSTALL_DIR = installRoot;
  process.env.OHM_DISTRIBUTION = "standalone";
  delete process.env.OHM_LIFECYCLE_CALLER_PID;
  delete process.env.OHM_LIFECYCLE_CALLER_LEASE;
  context.after(() => {
    if (previousRoot === undefined) delete process.env.OHM_INSTALL_DIR;
    else process.env.OHM_INSTALL_DIR = previousRoot;
    if (previousDistribution === undefined) delete process.env.OHM_DISTRIBUTION;
    else process.env.OHM_DISTRIBUTION = previousDistribution;
    if (previousPid === undefined) delete process.env.OHM_LIFECYCLE_CALLER_PID;
    else process.env.OHM_LIFECYCLE_CALLER_PID = previousPid;
    if (previousLease === undefined) delete process.env.OHM_LIFECYCLE_CALLER_LEASE;
    else process.env.OHM_LIFECYCLE_CALLER_LEASE = previousLease;
  });

  const lease = await acquireRuntimeLease();
  assert.ok(lease);
  const entries = await readdir(join(installRoot, ".runtime-leases"));
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  const record = JSON.parse(await readFile(join(installRoot, ".runtime-leases", entry), "utf8"));
  assert.equal(record.pid, process.pid);
  assert.match(record.installationId, /^[a-f0-9]{32}$/u);
  assert.equal(record.lease, process.env.OHM_LIFECYCLE_CALLER_LEASE);
  await lease.release();
  await assert.rejects(readdir(join(installRoot, ".runtime-leases")), { code: "ENOENT" });
});

test("installed runtimes do not start during lifecycle mutation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-lock-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, ".installation.json"), JSON.stringify(marker(installRoot)));
  await writeFile(`${installRoot}.lifecycle.lock`, "active\n");
  const previousRoot = process.env.OHM_INSTALL_DIR;
  process.env.OHM_INSTALL_DIR = installRoot;
  context.after(() => {
    if (previousRoot === undefined) delete process.env.OHM_INSTALL_DIR;
    else process.env.OHM_INSTALL_DIR = previousRoot;
  });

  await assert.rejects(acquireRuntimeLease(), /operation is in progress/u);
});
