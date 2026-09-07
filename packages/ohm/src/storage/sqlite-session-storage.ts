import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, toNamespacedPath } from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { Value } from "typebox/value";
import { parseSessionV4Header, SESSION_V4_MAX_RECORD_BYTES, type SessionV4Commit, type SessionV4Header, type SessionV4Json } from "@ohm/kernel/session-v4";
import type { SessionStorage } from "./session-storage.js";
import { acquireSessionWriterLeaseSync, type SessionWriterLease } from "./session-writer-lease.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import { optionalProperties } from "../core/optional-properties.js";
import { SqliteSessionHistoryIndex } from "./session-history-index.js";
import { SqliteSessionStateRecords } from "./session-state-records.js";

const APPLICATION_ID = 0x4f484d34;

type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

interface SqliteSessionStorage extends SessionStorage {
  /** Atomically copies validated records into a privately staged import. */
  appendBatch(commits: readonly SessionV4Commit[]): void;
}

function matchesCreatedFile(path: string, expected: FileIdentity): boolean {
  const current = lstatSync(path, { bigint: true });
  return current.isFile() && current.dev === expected.dev && current.ino === expected.ino;
}

function openDatabase(path: string, readOnly: boolean): SqliteDatabase {
  // SAFETY: this fixed built-in specifier is described by the installed Node types.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(toNamespacedPath(path), { readOnly, timeout: 5000 });
}

function validateDatabase(db: SqliteDatabase): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID
    || db.prepare("PRAGMA user_version").get()?.user_version !== 1) {
    throw new Error("Not a supported SQLite session database");
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const directory = openSync(path, constants.O_RDONLY);
  try { fsyncSync(directory); }
  catch (error) {
    if (!(error instanceof Error && "code" in error
      && ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(String(error.code)))) throw error;
  } finally { closeSync(directory); }
}

/** @internal Flush the live WAL before moving only the main database file. */
export function checkpointSqliteSessionForMove(path: string, lease: SessionWriterLease): void {
  if (resolve(lease.path) !== resolve(path)) throw new Error("Session checkpoint requires ownership of the selected file");
  lease.bindToFile();
  const db = openDatabase(path, false);
  try {
    validateDatabase(db);
    db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;");
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0) throw new Error("Session has an active database reader; retry deletion after it closes");
  } finally { db.close(); }
}

/** @internal Identify the durable format without reading arbitrary payload bytes. */
export function isSqliteSessionFile(path: string, followSymlinks = true): boolean {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (followSymlinks ? 0 : constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Session path is not a regular file: ${path}`);
    const signature = Buffer.alloc(16);
    return readSync(fd, signature, 0, signature.length, 0) === signature.length
      && signature.toString("ascii") === "SQLite format 3\0";
  } finally { closeSync(fd); }
}

/** @internal The persistent journal store. The runtime never selects another durable backend. */
export class SqliteSessionStorageBackend {
  readonly #directory: string;

  constructor(directory: string) { this.#directory = resolve(directory); }

  pathFor(sessionId: string): string { return join(this.#directory, `${encodeURIComponent(sessionId)}.sqlite`); }

  create(header: SessionV4Header, target = this.pathFor(header.sessionId)): SqliteSessionStorage {
    const checked = parseSessionV4Header(structuredClone(header));
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const path = resolve(target);
    if (dirname(path) !== this.#directory) throw new Error("Session creation must stay in its directory");
    const lease = acquireSessionWriterLeaseSync(path);
    let created: FileIdentity | undefined;
    try {
      const fd = openSync(path, "wx", 0o600);
      try { created = fstatSync(fd, { bigint: true }); }
      finally { closeSync(fd); }
      lease.bindToFile();
      return this.#handle(path, false, lease, checked);
    } catch (error) {
      try {
        if (created !== undefined && matchesCreatedFile(path, created)) unlinkSync(path);
      } catch (cleanup) { throw new AggregateError([error, cleanup], "SQLite session creation and cleanup failed"); }
      finally { lease.release(); }
      throw error;
    }
  }

  /** Publish a closed, fully validated import without overwriting an existing identity. */
  publish(stagingPath: string, sessionId: string): SessionStorage {
    const source = this.#existing(stagingPath);
    const target = this.pathFor(sessionId);
    const identity = lstatSync(source);
    const lease = acquireSessionWriterLeaseSync(target);
    let linked = false;
    let sourceRemoved = false;
    try {
      linkSync(source, target);
      linked = true;
      syncDirectory(this.#directory);
      unlinkSync(source);
      sourceRemoved = true;
      syncDirectory(this.#directory);
      lease.bindToFile();
      return this.#handle(target, false, lease);
    } catch (error) {
      const failures = [error];
      try {
        if (linked) {
          const current = lstatSync(target);
          if (current.dev === identity.dev && current.ino === identity.ino) {
            // Restore the staged name before removing our only published copy.
            // A failed restore leaves the target available for recovery.
            if (sourceRemoved) linkSync(target, source);
            unlinkSync(target);
          }
        }
      } catch (cleanup) { failures.push(cleanup); }
      lease.release();
      if (failures.length > 1) throw new AggregateError(failures, "SQLite import publication and cleanup failed");
      throw error;
    }
  }

  open(location: string, options: { readOnly?: boolean } = {}): SessionStorage {
    const path = this.#existing(location);
    const readOnly = options.readOnly === true;
    const lease = readOnly ? undefined : acquireSessionWriterLeaseSync(path);
    try {
      lease?.bindToFile();
      return this.#handle(path, readOnly, lease);
    } catch (error) { lease?.release(); throw error; }
  }

  remove(location: string, expected: FileIdentity): void {
    const path = resolve(location);
    if (dirname(path) !== this.#directory) throw new Error("Session cleanup must stay in its directory");
    const lease = acquireSessionWriterLeaseSync(path);
    try {
      if (!matchesCreatedFile(path, expected)) return;
      lease.bindToFile();
      // Reopening even read-only can create WAL sidecars. The closed candidate's
      // identity is sufficient; sidecar names alone do not establish ownership.
      unlinkSync(path);
    } finally { lease.release(); }
  }

  #existing(location: string): string {
    const path = isAbsolute(location) ? resolve(location) : join(this.#directory, `${encodeURIComponent(location)}.sqlite`);
    if (dirname(path) !== this.#directory && dirname(path) !== realpathSync(this.#directory)) throw new Error("SQLite session must stay in its backend directory");
    const canonical = realpathSync(path);
    const details = lstatSync(canonical);
    if (!details.isFile()) throw new Error("SQLite session must be a regular file");
    if (details.nlink > 1) throw new Error("SQLite session has multiple hard links; use a copy or export instead");
    return canonical;
  }

  #handle(path: string, readOnly: boolean, lease?: SessionWriterLease, header?: SessionV4Header): SqliteSessionStorage {
    const db = openDatabase(path, readOnly);
    try {
      if (header !== undefined) {
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;
          CREATE TABLE session_header (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL);
          CREATE TABLE session_commits (sequence INTEGER PRIMARY KEY, commit_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL);`);
        db.prepare("INSERT INTO session_header (id, record) VALUES (1, ?)").run(JSON.stringify(header));
      }
      validateDatabase(db);
      const row = db.prepare("SELECT CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record END AS record FROM session_header WHERE id = 1").get(SESSION_V4_MAX_RECORD_BYTES);
      if (!Value.Check(STRING_VALUE, row?.record)) throw new Error("SQLite session header is missing");
      const loadedHeader = parseSessionV4Header(JSON.parse(row.record));
      if (!readOnly) {
        if (process.platform !== "win32") chmodSync(path, 0o600);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      }
      let closed = false;
      let records: SqliteSessionStateRecords | undefined;
      const appendBatch = (commits: readonly SessionV4Commit[]): void => {
        if (closed) throw new Error("SQLite session is closed");
        if (readOnly) throw new Error("SQLite session is read-only");
        if (!lstatSync(path).isFile()) throw new Error("Session database path changed; close before moving its database and WAL");
        lease?.bindToFile();
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_commits").get();
          let sequence = current?.sequence;
          const insert = db.prepare("INSERT INTO session_commits (sequence, commit_id, record) VALUES (?, ?, ?)");
          for (const commit of commits) {
            if (sequence !== commit.sequence - 1) throw new Error("SQLite session sequence conflict");
            insert.run(commit.sequence, commit.commitId, JSON.stringify(commit));
            sequence = commit.sequence;
          }
          db.exec("COMMIT");
        } catch (error) {
          try { if (db.isTransaction) db.exec("ROLLBACK"); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "SQLite session append and rollback failed"); }
          throw error;
        }
        // A concurrent move can occur during COMMIT. Do not acknowledge it as a stable write.
        if (!lstatSync(path).isFile()) throw new Error("Session database path changed; close before moving its database and WAL");
        lease?.bindToFile();
      };
      return {
        path, readOnly,
        appendBatch,
        ...optionalProperties(readOnly ? undefined : {
          createStateRecords() {
            if (closed) throw new Error("SQLite session is closed");
            if (records !== undefined) throw new Error("SQLite session records already have an owner");
            records = new SqliteSessionStateRecords(db);
            return records;
          },
          createHistoryIndex() {
            if (closed) throw new Error("SQLite session is closed");
            return new SqliteSessionHistoryIndex(db);
          },
        }),
        read() {
          if (closed) throw new Error("SQLite session is closed");
          // A read transaction fences the record stream, including a live writer's WAL.
          return {
            header: structuredClone(loadedHeader),
            commits: (function* () {
              db.exec("BEGIN");
              let complete = false;
              try {
                for (const record of db.prepare("SELECT CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record END AS record FROM session_commits ORDER BY sequence").iterate(SESSION_V4_MAX_RECORD_BYTES)) {
                  if (!Value.Check(STRING_VALUE, record.record)) throw new Error("SQLite session record is invalid");
                  const decoded: SessionV4Json = JSON.parse(record.record);
                  yield decoded;
                }
                complete = true;
              } finally {
                // Successful replay keeps only the private TEMP derivations built
                // by its reducer. Invalid or interrupted replay discards them.
                // SQLite may already have rolled back a failed transaction.
                if (complete) db.exec("COMMIT");
                else if (db.isTransaction) db.exec("ROLLBACK");
              }
            })(),
          };
        },
        append(commit) { appendBatch([commit]); },
        close() {
          if (closed) return;
          closed = true;
          records?.close();
          try { db.close(); }
          finally { lease?.release(); }
        },
      };
    } catch (error) { db.close(); throw error; }
  }
}
