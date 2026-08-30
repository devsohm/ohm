import { createHash, randomBytes } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Check } from "typebox/value";

import { errorCode } from "../core/errors.js";
import { isJsonObject, isJsonValue } from "../core/json.js";
import { NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";

const MARKER = ".installation.json";
const LEASE_DIRECTORY = ".runtime-leases";
const MAX_MARKER_BYTES = 16 * 1024;
const STANDALONE_RUNTIME_NAME = /^ohm-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-(?:linux|darwin|win32)-(?:x64|arm64)$/u;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH" && errorCode(error) !== "ERR_OUT_OF_RANGE";
  }
}

async function lifecycleInProgress(path: string, installRoot: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) return true;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isJsonObject(value)) return true;
    const keys = Object.keys(value).sort();
    const expectedKeys = ["schemaVersion", "pid", "token", "createdAt", "installRoot"].sort();
    if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
      || value.schemaVersion !== 1
      || !Check(NUMBER_VALUE, value.pid) || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !Check(STRING_VALUE, value.token) || !/^[a-f0-9]{32}$/u.test(value.token)
      || !Check(NUMBER_VALUE, value.createdAt) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !Check(STRING_VALUE, value.installRoot) || resolve(value.installRoot) !== installRoot) return true;
    return processExists(value.pid);
  } catch {
    return true;
  }
}

interface InstalledMarker {
  product: "ohm";
  schemaVersion: 2;
  installationId: string;
  installRoot: string;
  version: string;
  launcherPath: string;
  launcherSha256: string;
  commandLink: string;
  commandSha256: string;
}

export function standaloneRuntimeInstallationId(installRoot: string): string {
  const canonical = resolve(installRoot);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256")
    .update("ohm-standalone-installation-v1\0")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
}

function standaloneInstallRoot(): string | undefined {
  const configured = process.env.OHM_INSTALL_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const runtimeRoot = resolve(dirname(process.execPath), "..");
  if (
    basename(dirname(runtimeRoot)) !== "runtime" ||
    !STANDALONE_RUNTIME_NAME.test(basename(runtimeRoot))
  ) return undefined;
  return resolve(runtimeRoot, "../..");
}

async function installedMarker(installRoot: string): Promise<InstalledMarker | undefined> {
  const path = join(installRoot, MARKER);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) {
    throw new Error(`Installed ohm marker is unsafe: ${path}`);
  }
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!isJsonValue(value) || !isJsonObject(value)) {
    throw new Error(`Installed ohm marker is invalid: ${path}`);
  }
  if (value.product !== "ohm" || value.schemaVersion !== 2) return undefined;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "product",
    "schemaVersion",
    "installationId",
    "installRoot",
    "version",
    "launcherPath",
    "launcherSha256",
    "commandLink",
    "commandSha256",
  ].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
    || !Check(STRING_VALUE, value.installationId) || !/^[a-f0-9]{32}$/u.test(value.installationId)
    || !Check(STRING_VALUE, value.installRoot) || resolve(value.installRoot) !== installRoot
    || !Check(STRING_VALUE, value.version) || value.version === ""
    || !Check(STRING_VALUE, value.launcherPath) || value.launcherPath === ""
    || !Check(STRING_VALUE, value.launcherSha256) || !/^[a-f0-9]{64}$/u.test(value.launcherSha256)
    || !Check(STRING_VALUE, value.commandLink) || value.commandLink === ""
    || !Check(STRING_VALUE, value.commandSha256) || !/^[a-f0-9]{64}$/u.test(value.commandSha256)) {
    throw new Error(`Installed ohm marker is invalid: ${path}`);
  }
  return {
    product: "ohm",
    schemaVersion: 2,
    installationId: value.installationId,
    installRoot: value.installRoot,
    version: value.version,
    launcherPath: value.launcherPath,
    launcherSha256: value.launcherSha256,
    commandLink: value.commandLink,
    commandSha256: value.commandSha256,
  };
}

export interface RuntimeLease {
  release(): Promise<void>;
}

export async function acquireRuntimeLease(): Promise<RuntimeLease | undefined> {
  const standalone = process.env.OHM_DISTRIBUTION === "standalone";
  const configuredRoot = process.env.OHM_INSTALL_DIR;
  const installRoot = standalone
    ? standaloneInstallRoot()
    : configuredRoot === undefined || configuredRoot === "" ? undefined : resolve(configuredRoot);
  if (installRoot === undefined) return undefined;
  const marker = standalone
    ? { installationId: standaloneRuntimeInstallationId(installRoot) }
    : await installedMarker(installRoot);
  if (marker === undefined) return undefined;
  const lockPath = `${installRoot}.lifecycle.lock`;
  if (await lifecycleInProgress(lockPath, installRoot)) {
    throw new Error("An ohm install, update, or uninstall operation is in progress");
  }

  const directory = join(installRoot, LEASE_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Runtime lease path is unsafe: ${directory}`);
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const lease = randomBytes(16).toString("hex");
  const path = join(directory, `${lease}.json`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      lease,
      createdAt: Date.now(),
      installationId: marker.installationId,
    })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (await lifecycleInProgress(lockPath, installRoot)) {
    await rm(path, { force: true });
    if (standalone) await rmdir(directory).catch(() => undefined);
    throw new Error("An ohm install, update, or uninstall operation is in progress");
  }

  const previousPid = process.env.OHM_LIFECYCLE_CALLER_PID;
  const previousLease = process.env.OHM_LIFECYCLE_CALLER_LEASE;
  const previousInstallRoot = process.env.OHM_INSTALL_DIR;
  if (standalone && (previousInstallRoot === undefined || previousInstallRoot === "")) {
    process.env.OHM_INSTALL_DIR = installRoot;
  }
  process.env.OHM_LIFECYCLE_CALLER_PID = String(process.pid);
  process.env.OHM_LIFECYCLE_CALLER_LEASE = lease;
  let released = false;
  const cleanupSync = (): void => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
    if (standalone) {
      try {
        rmdirSync(directory);
      } catch {}
    }
  };
  process.once("exit", cleanupSync);

  return {
    async release(): Promise<void> {
      if (!released) {
        released = true;
        process.off("exit", cleanupSync);
        await rm(path, { force: true });
        if (standalone) await rmdir(directory).catch(() => undefined);
      }
      if (previousPid === undefined) delete process.env.OHM_LIFECYCLE_CALLER_PID;
      else process.env.OHM_LIFECYCLE_CALLER_PID = previousPid;
      if (previousLease === undefined) delete process.env.OHM_LIFECYCLE_CALLER_LEASE;
      else process.env.OHM_LIFECYCLE_CALLER_LEASE = previousLease;
      if (previousInstallRoot === undefined) delete process.env.OHM_INSTALL_DIR;
      else process.env.OHM_INSTALL_DIR = previousInstallRoot;
    },
  };
}
