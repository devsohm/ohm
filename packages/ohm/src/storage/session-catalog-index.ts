import { optionalProperties } from "../core/optional-properties.js";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "../core/errors.js";
import type { JsonValue } from "../core/json.js";
import type {
  SessionFileIssue,
  SessionInfo,
  SessionListProgress,
  SessionScanResult,
} from "./types.js";

const SESSION_CATALOG_INDEX_VERSION = 1 as const;
const SESSION_CATALOG_INDEX_FILE = ".ohm-session-catalog-v1.json";
const SESSION_CATALOG_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const SESSION_CATALOG_INDEX_MAX_ENTRIES = 100_000;
const SESSION_CATALOG_INDEX_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const SESSION_CATALOG_INDEX_READ_NONBLOCK = constants.O_NONBLOCK ?? 0;
const SESSION_CATALOG_INDEX_READ_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SESSION_CATALOG_INDEX_WORKERS = 10;
const SESSION_CATALOG_INDEX_MEMO_SCOPES = 16;
const SESSION_CATALOG_INDEX_MEMO_MAX_BYTES = 64 * 1024 * 1024;
const PRIVATE_INDEX_FILE_MODE = 0o600;
const ERRNO_ERROR_VALUE = Type.Object({ code: Type.String() }, { additionalProperties: true });
const SESSION_FILE_FINGERPRINT_VALUE = Type.Object({
  birthtimeNs: Type.String(),
  ctimeNs: Type.String(),
  dev: Type.String(),
  ino: Type.String(),
  mode: Type.String(),
  mtimeNs: Type.String(),
  size: Type.String(),
}, { additionalProperties: false });
const STORED_SESSION_INFO_VALUE = Type.Object({
  allMessagesText: Type.String(),
  created: Type.String(),
  cwd: Type.String(),
  firstMessage: Type.String(),
  id: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
  modified: Type.String(),
  name: Type.Optional(Type.String()),
  parentPurpose: Type.Optional(Type.String()),
  parentSessionPath: Type.Optional(Type.String()),
  path: Type.String(),
}, { additionalProperties: false });
const STORED_SESSION_CATALOG_VALUE = Type.Union([
  Type.Object({ kind: Type.Literal("invalid"), error: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("session"), session: STORED_SESSION_INFO_VALUE }, { additionalProperties: false }),
]);
const STORED_SESSION_CATALOG_ENTRY_VALUE = Type.Object({
  fingerprint: SESSION_FILE_FINGERPRINT_VALUE,
  path: Type.String(),
  value: STORED_SESSION_CATALOG_VALUE,
}, { additionalProperties: false });
const STORED_SESSION_CATALOG_SNAPSHOT_VALUE = Type.Object({
  entries: Type.Array(STORED_SESSION_CATALOG_ENTRY_VALUE, { maxItems: SESSION_CATALOG_INDEX_MAX_ENTRIES }),
  scope: Type.String(),
  version: Type.Literal(SESSION_CATALOG_INDEX_VERSION),
}, { additionalProperties: false });

interface SessionFileFingerprint {
  birthtimeNs: string;
  ctimeNs: string;
  dev: string;
  ino: string;
  mode: string;
  mtimeNs: string;
  size: string;
}

interface StoredSessionInfo {
  allMessagesText: string;
  created: string;
  cwd: string;
  firstMessage: string;
  id: string;
  messageCount: number;
  modified: string;
  name?: string;
  parentPurpose?: string;
  parentSessionPath?: string;
  path: string;
}

type StoredSessionCatalogValue =
  | { kind: "invalid"; error: string }
  | { kind: "session"; session: StoredSessionInfo };

interface StoredSessionCatalogEntry {
  fingerprint: SessionFileFingerprint;
  path: string;
  value: StoredSessionCatalogValue;
}

interface StoredSessionCatalogSnapshot {
  entries: StoredSessionCatalogEntry[];
  scope: string;
  version: typeof SESSION_CATALOG_INDEX_VERSION;
}

interface SerializedSessionCatalogSnapshot {
  raw: string;
  snapshot: StoredSessionCatalogSnapshot;
}

interface SessionCatalogSnapshotMemo {
  bytes: number;
  fingerprint: SessionFileFingerprint;
  snapshot: StoredSessionCatalogSnapshot;
}

const snapshotMemo = new Map<string, SessionCatalogSnapshotMemo>();
let snapshotMemoBytes = 0;

function parseSnapshot(value: string, scope: string): StoredSessionCatalogSnapshot | undefined {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !Value.Check(STORED_SESSION_CATALOG_SNAPSHOT_VALUE, parsed)
    || parsed.scope !== scope
  ) return undefined;
  const paths = new Set<string>();
  const entries: StoredSessionCatalogEntry[] = [];
  for (const candidate of parsed.entries) {
    if (
      paths.has(candidate.path)
      || candidate.value.kind === "session" && (
        candidate.value.session.path !== candidate.path
        || Number.isNaN(Date.parse(candidate.value.session.created))
        || Number.isNaN(Date.parse(candidate.value.session.modified))
      )
    ) return undefined;
    paths.add(candidate.path);
    entries.push(candidate);
  }
  return { version: SESSION_CATALOG_INDEX_VERSION, scope, entries };
}

function indexPath(scope: string): string {
  return join(scope, SESSION_CATALOG_INDEX_FILE);
}

function errorCode<ErrorType>(error: ErrorType): string | undefined {
  return Value.Check(ERRNO_ERROR_VALUE, error) ? error.code : undefined;
}

function isMissing<ErrorType>(error: ErrorType): boolean {
  return errorCode(error) === "ENOENT";
}

function fingerprintFromStats(details: BigIntStats): SessionFileFingerprint {
  return {
    birthtimeNs: details.birthtimeNs.toString(),
    ctimeNs: details.ctimeNs.toString(),
    dev: details.dev.toString(),
    ino: details.ino.toString(),
    mode: details.mode.toString(),
    mtimeNs: details.mtimeNs.toString(),
    size: details.size.toString(),
  };
}

function deleteMemoizedSnapshot(scope: string): void {
  const current = snapshotMemo.get(scope);
  if (current !== undefined) snapshotMemoBytes -= current.bytes;
  snapshotMemo.delete(scope);
}

function memoizeSnapshot(scope: string, memo: SessionCatalogSnapshotMemo): void {
  deleteMemoizedSnapshot(scope);
  if (memo.bytes > SESSION_CATALOG_INDEX_MEMO_MAX_BYTES) return;
  snapshotMemo.set(scope, memo);
  snapshotMemoBytes += memo.bytes;
  while (
    snapshotMemo.size > SESSION_CATALOG_INDEX_MEMO_SCOPES
    || snapshotMemoBytes > SESSION_CATALOG_INDEX_MEMO_MAX_BYTES
  ) {
    const oldest = snapshotMemo.keys().next();
    if (oldest.done) break;
    deleteMemoizedSnapshot(oldest.value);
  }
}

async function readSnapshot(scope: string): Promise<StoredSessionCatalogSnapshot | undefined> {
  let handle;
  try {
    handle = await open(
      indexPath(scope),
      constants.O_RDONLY | SESSION_CATALOG_INDEX_READ_NONBLOCK | SESSION_CATALOG_INDEX_READ_NOFOLLOW,
    );
    const details = await handle.stat({ bigint: true });
    if (!details.isFile() || details.size > BigInt(SESSION_CATALOG_INDEX_MAX_BYTES)) {
      deleteMemoizedSnapshot(scope);
      return undefined;
    }
    if (process.platform !== "win32" && (details.mode & 0o077n) !== 0n) {
      deleteMemoizedSnapshot(scope);
      return undefined;
    }
    const initialFingerprint = fingerprintFromStats(details);
    const memo = snapshotMemo.get(scope);
    if (memo !== undefined && sameFingerprint(initialFingerprint, memo.fingerprint)) {
      memoizeSnapshot(scope, memo);
      return memo.snapshot;
    }
    deleteMemoizedSnapshot(scope);
    const buffer = Buffer.alloc(Number(details.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const read = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const overflow = Buffer.alloc(1);
    if ((await handle.read(overflow, 0, 1, null)).bytesRead !== 0) return undefined;
    const finalFingerprint = fingerprintFromStats(await handle.stat({ bigint: true }));
    if (!sameFingerprint(initialFingerprint, finalFingerprint)) return undefined;
    const raw = buffer.subarray(0, offset).toString("utf8");
    const snapshot = parseSnapshot(raw, scope);
    if (snapshot === undefined) return undefined;
    memoizeSnapshot(scope, { bytes: offset, snapshot, fingerprint: finalFingerprint });
    return snapshot;
  } catch (error) {
    deleteMemoizedSnapshot(scope);
    if (isMissing(error)) return undefined;
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const tolerated = new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"]);
    if (!tolerated.has(errorCode(error) ?? "")) throw error;
  }
}

function sameContentIdentity(left: SessionFileFingerprint, right: SessionFileFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size;
}

async function writeSnapshot(scope: string, serialized: SerializedSessionCatalogSnapshot): Promise<void> {
  const path = indexPath(scope);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  deleteMemoizedSnapshot(scope);
  try {
    const handle = await open(temporary, "wx", PRIVATE_INDEX_FILE_MODE);
    let temporaryFingerprint: SessionFileFingerprint;
    try {
      await handle.writeFile(serialized.raw, "utf8");
      await handle.sync();
      temporaryFingerprint = fingerprintFromStats(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, PRIVATE_INDEX_FILE_MODE);
    await syncDirectory(scope);
    let finalHandle;
    try {
      finalHandle = await open(
        path,
        constants.O_RDONLY | SESSION_CATALOG_INDEX_READ_NONBLOCK | SESSION_CATALOG_INDEX_READ_NOFOLLOW,
      );
      const details = await finalHandle.stat({ bigint: true });
      const finalFingerprint = fingerprintFromStats(details);
      if (
        details.isFile()
        && details.size <= BigInt(SESSION_CATALOG_INDEX_MAX_BYTES)
        && (process.platform === "win32" || (details.mode & 0o077n) === 0n)
        && sameContentIdentity(temporaryFingerprint, finalFingerprint)
      ) {
        memoizeSnapshot(scope, {
          bytes: Buffer.byteLength(serialized.raw, "utf8"),
          snapshot: serialized.snapshot,
          fingerprint: finalFingerprint,
        });
      }
    } catch {
      // A valid index write does not depend on the disposable in-process memo.
    } finally {
      await finalHandle?.close().catch(() => undefined);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function fingerprint(path: string): Promise<SessionFileFingerprint | undefined> {
  try {
    const details = await lstat(path, { bigint: true });
    return fingerprintFromStats(details);
  } catch {
    return undefined;
  }
}

function sameFingerprint(left: SessionFileFingerprint | undefined, right: SessionFileFingerprint | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.birthtimeNs === right.birthtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size;
}

function storedValue(value: SessionInfo | SessionFileIssue): StoredSessionCatalogValue | undefined {
  if ("error" in value) return undefined;
  const strings = [
    value.path,
    value.id,
    value.cwd,
    value.firstMessage,
    value.allMessagesText,
    value.name ?? "",
    value.parentPurpose ?? "",
    value.parentSessionPath ?? "",
  ];
  if (
    strings.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0)
      > SESSION_CATALOG_INDEX_MAX_ENTRY_BYTES
  ) return undefined;
  return {
    kind: "session",
    session: {
      path: value.path,
      id: value.id,
      cwd: value.cwd,
      created: value.created.toISOString(),
      modified: value.modified.toISOString(),
      messageCount: value.messageCount,
      firstMessage: value.firstMessage,
      allMessagesText: value.allMessagesText,
      ...optionalProperties(value.name === undefined ? undefined : { name: value.name }),
      ...optionalProperties(value.parentPurpose === undefined ? undefined : { parentPurpose: value.parentPurpose }),
      ...optionalProperties(value.parentSessionPath === undefined ? undefined : { parentSessionPath: value.parentSessionPath }),
    },
  };
}

function restoredValue(path: string, value: StoredSessionCatalogValue): SessionInfo | SessionFileIssue {
  if (value.kind === "invalid") return { path, error: value.error };
  return {
    ...value.session,
    created: new Date(value.session.created),
    modified: new Date(value.session.modified),
  };
}

function serializeSnapshot(
  scope: string,
  entries: readonly StoredSessionCatalogEntry[],
): SerializedSessionCatalogSnapshot {
  const prefix = `{"version":${SESSION_CATALOG_INDEX_VERSION},"scope":${JSON.stringify(scope)},"entries":[`;
  const suffix = "]}\n";
  const selectedEntries: StoredSessionCatalogEntry[] = [];
  const encodedEntries: string[] = [];
  let bytes = Buffer.byteLength(prefix + suffix, "utf8");
  for (const entry of entries.slice(0, SESSION_CATALOG_INDEX_MAX_ENTRIES)) {
    const encoded = JSON.stringify(entry);
    const addedBytes = Buffer.byteLength(encoded, "utf8") + (encodedEntries.length === 0 ? 0 : 1);
    if (bytes + addedBytes > SESSION_CATALOG_INDEX_MAX_BYTES) continue;
    selectedEntries.push(entry);
    encodedEntries.push(encoded);
    bytes += addedBytes;
  }
  return {
    raw: `${prefix}${encodedEntries.join(",")}${suffix}`,
    snapshot: { version: SESSION_CATALOG_INDEX_VERSION, scope, entries: selectedEntries },
  };
}

function errorText<ErrorType>(error: ErrorType): string {
  return errorMessage(error);
}

/** @internal Loads unchanged session projections from a disposable, journal-validated snapshot. */
export async function loadIndexedSessionInfos(
  scope: string,
  files: readonly string[],
  load: (path: string) => Promise<SessionInfo>,
  progress?: SessionListProgress,
): Promise<SessionScanResult> {
  const persisted = await readSnapshot(scope);
  if (files.length === 0 && persisted === undefined) return { sessions: [], invalid: [] };
  const cached = new Map(persisted?.entries.map((entry) => [entry.path, entry]));
  const results: Array<SessionInfo | SessionFileIssue | undefined> = Array.from({ length: files.length });
  const nextEntries: Array<StoredSessionCatalogEntry | undefined> = Array.from({ length: files.length });
  let loaded = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SESSION_CATALOG_INDEX_WORKERS, files.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const path = files[index];
      if (path === undefined) return;
      const before = await fingerprint(path);
      const retained = cached.get(path);
      if (
        retained !== undefined
        && retained.value.kind === "session"
        && sameFingerprint(before, retained.fingerprint)
      ) {
        results[index] = restoredValue(path, retained.value);
        nextEntries[index] = retained;
      } else {
        let result: SessionInfo | SessionFileIssue;
        try {
          result = await load(path);
        } catch (error) {
          result = { path, error: errorText(error) };
        }
        results[index] = result;
        const after = await fingerprint(path);
        const value = storedValue(result);
        if (after !== undefined && value !== undefined && sameFingerprint(before, after)) {
          nextEntries[index] = { path, fingerprint: after, value };
        }
      }
      loaded += 1;
      progress?.(loaded, files.length);
    }
  });
  await Promise.all(workers);

  const entries = nextEntries.filter((entry): entry is StoredSessionCatalogEntry => entry !== undefined);
  const unchanged = persisted !== undefined
    && entries.length === persisted.entries.length
    && entries.every((entry, index) => entry === persisted.entries[index]);
  if (!unchanged) {
    const serialized = serializeSnapshot(scope, entries);
    await writeSnapshot(scope, serialized).catch(() => undefined);
  }
  return {
    sessions: results.filter((result): result is SessionInfo => result !== undefined && !("error" in result)),
    invalid: results.filter((result): result is SessionFileIssue => result !== undefined && "error" in result),
  };
}
