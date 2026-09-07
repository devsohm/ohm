import { optionalProperties } from "../core/optional-properties.js";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  loadDirectPlugins,
  type RuntimePluginHost,
} from "../plugins/runtime.js";
import {
  DefaultPackageManager,
  type DeclaredResourceMetadata,
  type ResolvedPaths,
  type ResolvedResource,
} from "../core/package-manager.js";
import { SettingsManager } from "../core/settings-manager.js";
import { DefaultResourceLoader } from "../core/resource-loader.js";
import { getPluginRuntimeHost } from "../plugins/compat.js";
import { parsePluginGalleryIndex, type PluginGalleryIndex } from "../plugins/gallery.js";
import { runProcess, resolveExecutable } from "../process/runner.js";
import { sha256 } from "../tools/hash.js";
import { readFileSnapshotBounded } from "../tools/paths.js";
import { bundledAuthoringResources } from "../prompts/resources.js";

const MAX_FILES = 4096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const STRING_VALUE = Type.String();
const RECORD_VALUE = Type.Record(Type.String(), Type.Unknown());
const ERROR_CODE_VALUE = Type.Object({ code: Type.Optional(STRING_VALUE) }, { additionalProperties: true });
const PACKED_SIZE_VALUE = Type.Integer({ minimum: 0, maximum: MAX_TOTAL_BYTES });
const PACKED_FILE_SIZE_VALUE = Type.Integer({ minimum: 0, maximum: MAX_FILE_BYTES });

export interface PluginAuthorFile {
  path: string;
  size: number;
  sha256?: string;
}

export interface PluginAuthorValidation {
  package: {
    id: string;
    name: string;
    version?: string;
    description?: string;
    hostVersionRange?: string;
    enabled: boolean;
    contributions: {
      skillRoots: number;
      prompts: number;
      commands: number;
      themes: number;
      runtime: number;
    };
  };
  compatibility: "compatible";
  integrity: { status: "verified" | "not-declared"; declaredFiles: number };
  diagnostics: [];
}

export interface PluginAuthorPackedInspection {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: PluginAuthorFile[];
}

export interface PluginAuthorSmokeResult {
  packageId: string;
  runtimeEntries: number;
  toolCount: number;
  commandCount: number;
  providerCount: number;
  disposed: true;
}

export interface PluginAuthorRefreshResult extends PluginAuthorSmokeResult {
  refreshed: true;
  warnings: string[];
}

export interface PluginAuthorCheck {
  name: "validate" | "inspect" | "smoke" | "refresh" | "packed";
  status: "success" | "error";
  summary: string;
  detail?: unknown;
}

export interface PluginAuthorReport {
  status: "success" | "error";
  summary: string;
  nextActions: string[];
  artifacts: string[];
  checks: PluginAuthorCheck[];
}

interface NpmPackRecord {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string; size: number }>;
}

interface NpmEnvironment {
  [key: string]: string;
  HOME: string;
  USERPROFILE: string;
}

function errno<ErrorValue>(error: ErrorValue): string | undefined {
  return Value.Check(ERROR_CODE_VALUE, error) ? error.code : undefined;
}

function inside(root: string, target: string): boolean {
  const selected = relative(root, target);
  return selected === "" || (!selected.startsWith(`..${sep}`) && selected !== ".." && !isAbsolute(selected));
}

async function localPackageDirectory(source: string): Promise<string> {
  const selected = resolve(source);
  const information = await lstat(selected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Plugin author commands require a real local package directory");
  }
  return await realpath(selected);
}

async function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || information.size > maximumBytes) {
    throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`);
  }
  const loaded = await readFileSnapshotBounded(path, maximumBytes);
  if (loaded.truncated || loaded.totalBytes !== loaded.data.byteLength) {
    throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`);
  }
  return loaded.data;
}

interface DirectAuthorPackage {
  root: string;
  dataRoot: string;
  id: string;
  name: string;
  version?: string;
  description?: string;
  hostVersionRange?: string;
  resolved: ResolvedPaths;
}

async function withDirectPackage<T>(source: string, operation: (input: DirectAuthorPackage) => Promise<T>): Promise<T> {
  const root = await localPackageDirectory(source);
  const packageJsonPath = join(root, "package.json");
  const manifest = Value.Parse(RECORD_VALUE, JSON.parse((await readBoundedRegularFile(
    packageJsonPath,
    MAX_MANIFEST_BYTES,
    "Plugin package package.json",
  )).toString("utf8")));
  const name = manifest["name"];
  const version = manifest["version"];
  const description = manifest["description"];
  if (!Value.Check(STRING_VALUE, name) || name.trim() === "" || name.includes("\0")) {
    throw new Error("Plugin package package.json must declare a non-empty name");
  }
  for (const [label, value] of [["version", version], ["description", description]] as const) {
    if (value !== undefined && !Value.Check(STRING_VALUE, value)) {
      throw new Error(`Plugin package ${label} must be a string`);
    }
  }
  const peerDependencies = manifest["peerDependencies"];
  const engines = manifest["engines"];
  const peerOhm = Value.Check(RECORD_VALUE, peerDependencies) ? peerDependencies["ohm"] : undefined;
  const engineOhm = Value.Check(RECORD_VALUE, engines) ? engines["ohm"] : undefined;
  const temporary = await mkdtemp(join(tmpdir(), "ohm-author-"));
  try {
    const settings = SettingsManager.inMemory();
    const manager = new DefaultPackageManager({ cwd: root, agentDir: temporary, settingsManager: settings });
    const resolved = await manager.resolvePluginSources([root], { temporary: true });
    if (resolved.extensions.length + resolved.skills.length + resolved.prompts.length + resolved.themes.length === 0) {
      throw new Error("Plugin package does not contribute code, skills, prompts, or themes");
    }
    const id = name.toLowerCase().replace(/^@/u, "").replaceAll("/", ".")
      .replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z]+/u, "").slice(0, 80) || "package";
    return await operation({
      root,
      dataRoot: join(temporary, "extension-data"),
      id,
      name,
      ...optionalProperties(Value.Check(STRING_VALUE, version) ? { version } : undefined),
      ...optionalProperties(Value.Check(STRING_VALUE, description) ? { description } : undefined),
      ...(Value.Check(STRING_VALUE, peerOhm)
        ? { hostVersionRange: peerOhm }
        : Value.Check(STRING_VALUE, engineOhm)
          ? { hostVersionRange: engineOhm }
          : {}),
      resolved,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function activePathCount(resources: readonly ResolvedResource[]): number {
  return resources.filter((entry) => entry.enabled).length;
}

function activeDeclaredCount(
  resources: readonly ResolvedResource[],
  kind: DeclaredResourceMetadata["kind"],
): number {
  let count = 0;
  for (const resource of resources) {
    if (!resource.enabled) continue;
    const declared = resource.metadata.declaredResources;
    if (declared === undefined || declared.length === 0) {
      if (kind !== "command") count += 1;
      continue;
    }
    const disabled = new Set(resource.metadata.disabledDeclaredResources ?? []);
    count += declared.filter((entry) =>
      entry.kind === kind && !disabled.has(`${entry.kind}:${entry.name}`)).length;
  }
  return count;
}

export async function validatePluginPackage(source: string): Promise<PluginAuthorValidation> {
  return await withDirectPackage(source, async (pkg) => {
    const runtime = activePathCount(pkg.resolved.extensions);
    return {
      package: {
        id: pkg.id,
        name: pkg.name,
        ...optionalProperties(pkg.version === undefined ? undefined : { version: pkg.version }),
        ...optionalProperties(pkg.description === undefined ? undefined : { description: pkg.description }),
        ...optionalProperties(pkg.hostVersionRange === undefined ? undefined : { hostVersionRange: pkg.hostVersionRange }),
        enabled: [pkg.resolved.extensions, pkg.resolved.skills, pkg.resolved.prompts, pkg.resolved.themes]
          .some((resources) => resources.some((entry) => entry.enabled)),
        contributions: {
          skillRoots: activePathCount(pkg.resolved.skills),
          prompts: activeDeclaredCount(pkg.resolved.prompts, "prompt"),
          commands: activeDeclaredCount(pkg.resolved.prompts, "command"),
          themes: activeDeclaredCount(pkg.resolved.themes, "theme"),
          runtime,
        },
      },
      compatibility: "compatible",
      integrity: { status: "not-declared", declaredFiles: 0 },
      diagnostics: [],
    };
  });
}

async function inspectFiles(root: string): Promise<PluginAuthorFile[]> {
  const files: PluginAuthorFile[] = [];
  let totalBytes = 0;
  const visit = async (relativePath: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Package file inspection exceeded 64 directory levels");
    const directory = await opendir(relativePath === "" ? root : join(root, ...relativePath.split("/")));
    try {
      const entries: Array<{ name: string; directory: boolean; file: boolean }> = [];
      for await (const entry of directory) entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const child = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        if (child === "node_modules" || child.startsWith("node_modules/")) continue;
        const absolute = join(root, ...child.split("/"));
        const information = await lstat(absolute);
        if (information.isSymbolicLink()) throw new Error(`Package file is a symbolic link: ${child}`);
        if (entry.directory && information.isDirectory()) await visit(child, depth + 1);
        else if (entry.file && information.isFile()) {
          if (information.size > MAX_FILE_BYTES) throw new Error(`Package file exceeds ${MAX_FILE_BYTES} bytes: ${child}`);
          const bytes = await readBoundedRegularFile(absolute, MAX_FILE_BYTES, `Package file ${child}`);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Package files exceed ${MAX_TOTAL_BYTES} bytes`);
          files.push({ path: child, size: bytes.length, sha256: sha256(bytes) });
          if (files.length > MAX_FILES) throw new Error(`Package contains more than ${MAX_FILES} files`);
        } else throw new Error(`Package path is not a regular file or directory: ${child}`);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };
  await visit("", 0);
  return files;
}

async function hasPackageJson(root: string): Promise<boolean> {
  try {
    return (await lstat(join(root, "package.json"))).isFile();
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

function npmEnvironment(home: string): NpmEnvironment {
  const environment: NpmEnvironment = {
    HOME: home,
    USERPROFILE: home,
    LANG: "C",
    LC_ALL: "C",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_package_lock: "false",
    npm_config_update_notifier: "false",
    npm_config_progress: "false",
    npm_config_loglevel: "warn",
    npm_config_userconfig: join(home, "npmrc"),
    npm_config_globalconfig: join(home, "npmrc-global"),
    npm_config_cache: join(home, "npm-cache"),
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "TMPDIR", "TMP", "TEMP"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function isNpmCli(candidate: string | undefined): Promise<boolean> {
  if (candidate === undefined || !isAbsolute(candidate) || basename(candidate).toLowerCase() !== "npm-cli.js") {
    return false;
  }
  const binDirectory = dirname(candidate);
  if (basename(binDirectory).toLowerCase() !== "bin") return false;
  try {
    if (!(await lstat(candidate)).isFile()) return false;
    const manifest = Value.Parse(RECORD_VALUE, JSON.parse((await readBoundedRegularFile(
      join(dirname(binDirectory), "package.json"),
      MAX_MANIFEST_BYTES,
      "npm package.json",
    )).toString("utf8")));
    const bin = manifest["bin"];
    return manifest["name"] === "npm"
      && Value.Check(RECORD_VALUE, bin)
      && bin["npm"] === "bin/npm-cli.js";
  } catch {
    return false;
  }
}

async function npmArgv(): Promise<[string, ...string[]]> {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.platform === "win32"
      ? (process.env.PATH ?? "")
          .split(";")
          .map((entry) => entry.replace(/^"|"$/gu, ""))
          .filter(isAbsolute)
          .map((entry) => join(entry, "node_modules", "npm", "bin", "npm-cli.js"))
      : [resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]),
  ].filter((candidate): candidate is string => candidate !== undefined && isAbsolute(candidate));
  for (const candidate of npmCliCandidates) {
    if (await isNpmCli(candidate)) return [process.execPath, candidate];
  }
  if (process.platform === "win32") {
    throw new Error("npm pack requires npm-cli.js installed with Node.js on Windows");
  }
  const executable = await resolveExecutable("npm");
  if (executable === undefined) throw new Error("npm pack requires npm on PATH");
  return [executable];
}

function validPackPath<ValueType>(value: ValueType, label: string): string {
  if (!Value.Check(STRING_VALUE, value) || value === "" || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value === "." || value === ".." || value.startsWith("../") || value.includes("/../")) {
    throw new Error(`${label} escapes the archive`);
  }
  return value;
}

function parseNpmPackOutput(value: Buffer): NpmPackRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch (error) {
    throw new Error("npm pack returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Value.Check(RECORD_VALUE, parsed[0])) {
    throw new Error("npm pack returned an unexpected result");
  }
  const input = parsed[0];
  const name = input["name"];
  const version = input["version"];
  const filename = input["filename"];
  if (!Value.Check(STRING_VALUE, name) || !Value.Check(STRING_VALUE, version) || !Value.Check(STRING_VALUE, filename)) {
    throw new Error("npm pack omitted package identity");
  }
  const size = input["size"];
  const unpackedSize = input["unpackedSize"];
  const inputFiles = input["files"];
  if (
    !Value.Check(PACKED_SIZE_VALUE, size)
    || !Value.Check(PACKED_SIZE_VALUE, unpackedSize)
    || !Array.isArray(inputFiles)
  ) {
    throw new Error("npm pack omitted bounded file metadata");
  }
  const files = inputFiles.map((entry, index) => {
    if (!Value.Check(RECORD_VALUE, entry)) throw new Error(`npm pack files[${index}] is invalid`);
    const fileSize = entry["size"];
    if (!Value.Check(PACKED_FILE_SIZE_VALUE, fileSize)) {
      throw new Error(`npm pack files[${index}].size is invalid`);
    }
    return { path: validPackPath(entry["path"], `npm pack files[${index}].path`), size: fileSize };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (files.length > MAX_FILES) throw new Error(`npm pack selected more than ${MAX_FILES} files`);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) throw new Error(`npm pack files exceed ${MAX_TOTAL_BYTES} bytes`);
  return {
    name,
    version,
    filename: validPackPath(filename, "npm pack filename"),
    size,
    unpackedSize,
    files,
  };
}

function boundedCommandError(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
      ? "?"
      : character;
  }).join("");
  return sanitized.trim().slice(-4096);
}

async function runNpmPack(sourceRoot: string, destination: string, dryRun: boolean, signal?: AbortSignal): Promise<NpmPackRecord> {
  signal?.throwIfAborted();
  if (!(await hasPackageJson(sourceRoot))) throw new Error("npm pack inspection requires a package.json");
  const home = await mkdtemp(join(tmpdir(), "ohm-npm-pack-"));
  try {
    await writeFile(join(home, "npmrc"), "", { mode: 0o600, flag: "wx" });
    await writeFile(join(home, "npmrc-global"), "", { mode: 0o600, flag: "wx" });
    const argv = await npmArgv();
    const result = await runProcess({
      argv: [argv[0], ...argv.slice(1), "pack", "--json", "--ignore-scripts=true", "--pack-destination", destination, ...(dryRun ? ["--dry-run"] : []), "."],
      cwd: sourceRoot,
      env: npmEnvironment(home),
      inheritEnv: false,
      timeoutMs: COMMAND_TIMEOUT_MS,
      outputLimitBytes: MAX_COMMAND_OUTPUT,
    }, signal ?? new AbortController().signal);
    signal?.throwIfAborted();
    if (result.timedOut) throw new Error(`npm pack timed out after ${COMMAND_TIMEOUT_MS}ms`);
    if (result.exitCode !== 0) {
      const detail = boundedCommandError(result.stderr.toString("utf8"));
      throw new Error(`npm pack failed with exit ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`);
    }
    return parseNpmPackOutput(result.stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function inspectPluginPackage(source: string, signal?: AbortSignal): Promise<{
  validation: PluginAuthorValidation;
  fileSet: "npm-pack" | "direct-source";
  files: PluginAuthorFile[];
  packed?: Omit<PluginAuthorPackedInspection, "files">;
}> {
  const sourceRoot = await localPackageDirectory(source);
  const validation = await validatePluginPackage(sourceRoot);
  const temporary = await mkdtemp(join(tmpdir(), "ohm-pack-dry-run-"));
  try {
    const packed = await runNpmPack(sourceRoot, temporary, true, signal);
    return {
      validation,
      fileSet: "npm-pack",
      files: packed.files,
      packed: {
        name: packed.name,
        version: packed.version,
        filename: packed.filename,
        size: packed.size,
        unpackedSize: packed.unpackedSize,
      },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function packPluginPackage(source: string, destination: string, signal?: AbortSignal): Promise<{
  artifact: string;
  sha256: string;
  packed: PluginAuthorPackedInspection;
}> {
  const sourceRoot = await localPackageDirectory(source);
  await validatePluginPackage(sourceRoot);
  const destinationRoot = resolve(destination);
  await mkdir(destinationRoot, { recursive: true });
  const canonicalDestination = await realpath(destinationRoot);
  const temporary = await mkdtemp(join(tmpdir(), "ohm-pack-publish-"));
  let publicationDirectory: string | undefined;
  let result: {
    artifact: string;
    sha256: string;
    packed: PluginAuthorPackedInspection;
  } | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    const packed = await runNpmPack(sourceRoot, temporary, false, signal);
    if (basename(packed.filename) !== packed.filename) throw new Error("npm pack artifact filename is invalid");
    const stagedArtifact = join(temporary, packed.filename);
    const canonicalStagedArtifact = await realpath(stagedArtifact);
    if (!inside(temporary, canonicalStagedArtifact)) throw new Error("npm pack artifact escaped the private staging directory");
    const information = await lstat(stagedArtifact);
    if (!information.isFile() || information.isSymbolicLink() || information.size !== packed.size || information.size > MAX_TOTAL_BYTES) {
      throw new Error("npm pack artifact is missing or too large");
    }
    const bytes = await readBoundedRegularFile(stagedArtifact, MAX_TOTAL_BYTES, "npm pack artifact");
    const artifact = join(canonicalDestination, packed.filename);
    publicationDirectory = await mkdtemp(join(canonicalDestination, ".ohm-pack-publish-"));
    const publicationArtifact = join(publicationDirectory, packed.filename);
    const handle = await open(publicationArtifact, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const publicationInformation = await lstat(publicationArtifact);
    if (!publicationInformation.isFile() || publicationInformation.isSymbolicLink() || publicationInformation.size !== bytes.byteLength) {
      throw new Error("npm pack artifact publication failed");
    }
    try {
      await link(publicationArtifact, artifact);
    } catch (error) {
      if (errno(error) === "EEXIST") throw new Error(`npm pack artifact already exists: ${artifact}`, { cause: error });
      throw error;
    }
    result = { artifact, sha256: sha256(bytes), packed: { ...packed, files: packed.files } };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  for (const directory of [publicationDirectory, temporary]) {
    if (directory === undefined) continue;
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      try {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Cleanup must not mask the operation error or turn a committed artifact into a false failure.
      }
    }
  }
  if (operationFailed) throw operationError;
  if (result === undefined) throw new Error("npm pack did not produce an artifact");
  return result;
}

function runtimeCounts(host: RuntimePluginHost, runtimeEntries: number): Omit<PluginAuthorSmokeResult, "packageId" | "disposed"> {
  return {
    runtimeEntries,
    toolCount: host.tools().length,
    commandCount: host.commands().length,
    providerCount: host.directProviderRegistrations().length,
  };
}

function assertRuntimeDiagnostics(host: RuntimePluginHost): void {
  const diagnostics = host.diagnostics();
  if (diagnostics.length > 0) throw new Error(`Runtime activation reported: ${diagnostics.map((entry) => entry.message).join("; ")}`);
}

async function checkAuthorResources(pkg: DirectAuthorPackage, generations: 1 | 2, signal?: AbortSignal): Promise<void> {
  const loader = new DefaultResourceLoader({
    cwd: dirname(pkg.dataRoot),
    agentDir: dirname(pkg.dataRoot),
    settingsManager: SettingsManager.inMemory({ packages: [pkg.root] }),
    noPluginCode: true,
    noContextFiles: true,
    offline: true,
  });
  try {
    for (let generation = 0; generation < generations; generation += 1) {
      await loader.refresh({ ...optionalProperties(signal === undefined ? undefined : { signal }) });
      const skills = loader.getSkills();
      const prompts = loader.getPrompts();
      const themes = loader.getThemes();
      const diagnostics = [...skills.diagnostics, ...prompts.diagnostics, ...themes.diagnostics];
      if (diagnostics.length > 0) {
        throw new Error(`Resource loading reported: ${diagnostics.map((entry) => entry.message).join("; ")}`);
      }
      if (activePathCount(pkg.resolved.extensions) + skills.skills.length + prompts.prompts.length + themes.themes.length === 0) {
        throw new Error(`Package ${pkg.id} has no enabled contributions to test`);
      }
    }
  } finally {
    await getPluginRuntimeHost(loader.getPlugins().runtime)?.close();
  }
}

export async function smokePluginPackage(source: string, signal?: AbortSignal): Promise<PluginAuthorSmokeResult> {
  return await withDirectPackage(source, async (pkg) => {
    const runtimePaths = pkg.resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
    await checkAuthorResources(pkg, 1, signal);
    const host = await loadDirectPlugins(runtimePaths, {
      workspace: pkg.root,
      dataRoot: pkg.dataRoot,
      activationFailure: "throw",
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    const counts = runtimeCounts(host, runtimePaths.length);
    try {
      assertRuntimeDiagnostics(host);
    } finally {
      await host.close();
    }
    return { packageId: pkg.id, ...counts, disposed: true };
  });
}

export async function refreshPluginPackage(source: string, signal?: AbortSignal): Promise<PluginAuthorRefreshResult> {
  return await withDirectPackage(source, async (pkg) => {
    const runtimePaths = pkg.resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
    await checkAuthorResources(pkg, 2, signal);
    const active = await loadDirectPlugins(runtimePaths, {
      workspace: pkg.root,
      dataRoot: pkg.dataRoot,
      activationFailure: "throw",
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    let candidate: RuntimePluginHost | undefined;
    try {
      assertRuntimeDiagnostics(active);
      candidate = await loadDirectPlugins(runtimePaths, {
        workspace: pkg.root,
        dataRoot: pkg.dataRoot,
        activationFailure: "throw",
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      });
      assertRuntimeDiagnostics(candidate);
      const counts = runtimeCounts(candidate, runtimePaths.length);
      await active.close();
      await candidate.close();
      return { packageId: pkg.id, ...counts, disposed: true, refreshed: true, warnings: [] };
    } finally {
      await active.close().catch(() => undefined);
      await candidate?.close().catch(() => undefined);
    }
  });
}

async function check<Detail>(name: PluginAuthorCheck["name"], operation: () => Promise<Detail>, signal?: AbortSignal): Promise<PluginAuthorCheck> {
  signal?.throwIfAborted();
  try {
    const detail = await operation();
    signal?.throwIfAborted();
    return { name, status: "success", summary: `${name} passed`, detail };
  } catch (error) {
    signal?.throwIfAborted();
    return { name, status: "error", summary: error instanceof Error ? error.message : String(error) };
  }
}

export async function reportPluginPackage(source: string, signal?: AbortSignal): Promise<PluginAuthorReport> {
  const checks: PluginAuthorCheck[] = [];
  checks.push(await check("validate", async () => await validatePluginPackage(source), signal));
  checks.push(await check("inspect", async () => await inspectPluginPackage(source, signal), signal));
  checks.push(await check("smoke", async () => await smokePluginPackage(source, signal), signal));
  checks.push(await check("refresh", async () => await refreshPluginPackage(source, signal), signal));
  const failed = checks.filter((entry) => entry.status === "error");
  return failed.length === 0
    ? {
        status: "success",
        summary: "Plugin package passed validation, packed-file inspection, resource loading, activation/disposal, and refresh checks.",
        nextActions: ["Review the exact archive, then publish an immutable version and gallery record."],
        artifacts: [],
        checks,
      }
    : {
        status: "error",
        summary: `${failed.length} plugin author check${failed.length === 1 ? "" : "s"} failed.`,
        nextActions: failed.map((entry) => `Fix ${entry.name}: ${entry.summary}`),
        artifacts: [],
        checks,
      };
}

/** Exercise the installable archive using temporary package state and cached dependencies. */
export async function verifyPluginPackage(source: string, signal?: AbortSignal): Promise<PluginAuthorReport> {
  signal?.throwIfAborted();
  const report = await reportPluginPackage(source, signal);
  signal?.throwIfAborted();
  if (report.status === "error") return report;
  const packedCheck = await check("packed", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ohm-author-verify-"));
    try {
      const sourceResources = await withDirectPackage(source, async (pkg) =>
        [pkg.resolved.extensions, pkg.resolved.skills, pkg.resolved.prompts, pkg.resolved.themes]
        .flatMap((resources) => resources.filter((entry) => entry.enabled)
          .map((entry) => relative(pkg.root, entry.path).split(sep).join("/"))));
      const artifact = await packPluginPackage(source, join(temporary, "artifacts"), signal);
      signal?.throwIfAborted();
      const packedFiles = new Set(artifact.packed.files.map((entry) => entry.path));
      const omitted = sourceResources.filter((path) => !packedFiles.has(path));
      if (omitted.length > 0) throw new Error(`Packed archive omits enabled source resources: ${omitted.join(", ")}`);
      const settings = SettingsManager.inMemory();
      const manager = new DefaultPackageManager({
        cwd: temporary,
        agentDir: join(temporary, "agent"),
        settingsManager: settings,
        offline: true,
      });
      const installedSource = `npm:${pathToFileURL(artifact.artifact).href}`;
      await manager.installAndPersist(installedSource, {
        allowScripts: false,
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      });
      try {
        const installed = manager.getInstalledPath(installedSource, "user");
        if (installed === undefined) throw new Error("Packed plugin has no installed package directory");
        const smoke = await smokePluginPackage(installed, signal);
        signal?.throwIfAborted();
        const refresh = await refreshPluginPackage(installed, signal);
        return { sha256: artifact.sha256, files: artifact.packed.files, smoke, refresh };
      } finally {
        await manager.removeAndPersist(installedSource);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, signal);
  signal?.throwIfAborted();
  report.checks.push(packedCheck);
  report.status = packedCheck.status;
  report.summary = packedCheck.status === "success"
    ? "Source and packed installation passed validation, resource loading, activation, disposal, and generation replacement."
    : "The packed installation failed verification.";
  report.nextActions = packedCheck.status === "success"
    ? ["Run the package's behavior tests, then edit and use /refresh in a trusted test workspace."]
    : [`Fix packed: ${packedCheck.summary}`];
  return report;
}

/** Copy the shipped, tested factory starter without installing dependencies or overwriting files. */
export async function initPluginPackage(destination: string, signal?: AbortSignal): Promise<{
  directory: string;
  name: string;
  files: string[];
  nextActions: string[];
}> {
  signal?.throwIfAborted();
  const requested = resolve(destination);
  const parent = await realpath(dirname(requested));
  const directory = join(parent, basename(requested));
  const name = basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "");
  if (name === "" || name.length > 214) throw new Error("Choose a directory name that can be used as an npm package name");
  const starter = join(bundledAuthoringResources().examplesRoot, "starter");
  const files = await inspectFiles(starter);
  signal?.throwIfAborted();
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      let content = await readBoundedRegularFile(join(starter, file.path), MAX_FILE_BYTES, `Starter ${file.path}`);
      if (file.path === "package.json") {
        const manifest = Value.Parse(RECORD_VALUE, JSON.parse(content.toString("utf8")));
        content = Buffer.from(`${JSON.stringify({ ...manifest, name, private: true }, null, 2)}\n`);
      }
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
    }
    return {
      directory, name, files: files.map((file) => file.path),
      nextActions: [
        "Review the starter README and install the release package graph with its development dependencies in the new directory.",
        "Run ohm plugins test PACKAGE, then ohm plugins preview PACKAGE.",
        "Edit the factory and use /refresh in the preview. Before sharing, run ohm plugins verify PACKAGE.",
      ],
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Runs only the explicitly requested package test script, with bounded output and cancellation. */
export async function testPluginPackage(source: string, signal?: AbortSignal): Promise<{
  status: "success" | "error";
  directory: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}> {
  signal?.throwIfAborted();
  const directory = await localPackageDirectory(source);
  const manifest = Value.Parse(RECORD_VALUE, JSON.parse((await readBoundedRegularFile(
    join(directory, "package.json"), MAX_MANIFEST_BYTES, "Plugin package package.json",
  )).toString("utf8")));
  const scripts = manifest["scripts"];
  if (!Value.Check(RECORD_VALUE, scripts) || !Value.Check(STRING_VALUE, scripts["test"]) || scripts["test"].trim() === "") {
    throw new Error("Plugin package must declare an explicit scripts.test command");
  }
  const result = await runProcess({
    argv: [...await npmArgv(), "--ignore-scripts", "--offline", "run", "test"],
    cwd: directory,
    env: { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
    timeoutMs: COMMAND_TIMEOUT_MS,
    outputLimitBytes: MAX_COMMAND_OUTPUT,
  }, signal ?? new AbortController().signal);
  signal?.throwIfAborted();
  return {
    status: result.exitCode === 0 && !result.timedOut ? "success" : "error",
    directory, exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"),
    truncated: result.stdoutBytes > result.stdout.byteLength || result.stderrBytes > result.stderr.byteLength,
    timedOut: result.timedOut,
  };
}

/** Describe a normal interactive invocation; the caller transfers control after closing its command scope. */
export async function preparePluginPreview(source: string, workspace = process.cwd(), signal?: AbortSignal): Promise<{
  packageId: string;
  directory: string;
  argv: string[];
  nextActions: string[];
}> {
  signal?.throwIfAborted();
  const directory = await localPackageDirectory(source);
  const validation = await validatePluginPackage(directory);
  const project = await realpath(resolve(workspace));
  signal?.throwIfAborted();
  return {
    packageId: validation.package.id, directory,
    argv: ["--workspace", project, "--no-session", "--no-plugins", "--offline", "--plugin", directory],
    nextActions: [
      "Use /actions for portable UI actions, and invoke the package's commands directly.",
      "Edit source files, then use /refresh to replace the active generation; close with /exit to dispose it.",
      "This is the normal trusted-code host, not a sandbox. Offline disables automatic discovery, not plugin or model network access.",
    ],
  };
}

export async function loadPluginGalleryIndex(path: string): Promise<PluginGalleryIndex> {
  const selected = resolve(path);
  const information = await lstat(selected);
  if (!information.isFile() || information.isSymbolicLink() || information.size > 4 * 1024 * 1024) {
    throw new Error("Gallery index must be a real JSON file no larger than 4 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse((await readBoundedRegularFile(selected, 4 * 1024 * 1024, "Gallery index")).toString("utf8"));
  } catch (error) {
    throw new Error("Gallery index is not valid JSON", { cause: error });
  }
  return parsePluginGalleryIndex(value);
}
