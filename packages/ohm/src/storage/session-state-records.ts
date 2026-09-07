import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Value } from "typebox/value";
import type {
  SessionV4NodeMetadata,
  SessionV4RecordCollection,
  SessionV4RecordCollections,
} from "@ohm/kernel/session-v4";
import { STRING_VALUE } from "../core/value-schemas.js";
import { projectedSessionEntryCount, type SessionEntryProjectionMetadata } from "./session-entry-projection.js";

const MIB = 1024 * 1024;

/** Private, replace-only records. Metadata grows with identities; decoded payloads do not. */
class SqliteRecords<RecordValue, Metadata> implements SessionV4RecordCollection<RecordValue, Metadata> {
  readonly #kind: string;
  readonly #read: StatementSync;
  readonly #write: StatementSync;
  readonly #remove: StatementSync;
  readonly #guard: <Result>(action: () => Result) => Result;
  readonly #metadataOf: (value: RecordValue, bytes: number) => Metadata;
  readonly #metadata = new Map<string, Metadata>();
  readonly #cache = new Map<string, { value: RecordValue; bytes: number }>();
  readonly #maxCacheBytes: number;
  readonly #maxCacheRecords: number;
  #cacheBytes = 0;

  constructor(kind: string, statements: { read: StatementSync; write: StatementSync; remove: StatementSync },
    guard: <Result>(action: () => Result) => Result, metadataOf: (value: RecordValue, bytes: number) => Metadata,
    maxCacheBytes: number, maxCacheRecords: number) {
    this.#kind = kind;
    this.#read = statements.read;
    this.#write = statements.write;
    this.#remove = statements.remove;
    this.#guard = guard;
    this.#metadataOf = metadataOf;
    this.#maxCacheBytes = maxCacheBytes;
    this.#maxCacheRecords = maxCacheRecords;
  }

  get size(): number { return this.#guard(() => this.#metadata.size); }
  has(id: string): boolean { return this.#guard(() => this.#metadata.has(id)); }
  getMetadata(id: string): Metadata | undefined { return this.#guard(() => this.#metadata.get(id)); }
  keys(): IterableIterator<string> { return this.#guard(() => this.#metadata.keys()); }

  *metadataEntries(): IterableIterator<[string, Metadata]> {
    for (const [id, metadata] of this.#metadata) yield this.#guard(() => [id, metadata]);
  }

  get(id: string): RecordValue | undefined {
    return this.#guard(() => {
      if (!this.#metadata.has(id)) return undefined;
      const cached = this.#cache.get(id);
      if (cached !== undefined) {
        this.#cache.delete(id);
        this.#cache.set(id, cached);
        return cached.value;
      }
      const row = this.#read.get(this.#kind, JSON.stringify(id));
      if (!Value.Check(STRING_VALUE, row?.record)) throw new Error("Validated session record is missing");
      // Only this owner writes this connection-private table, from accepted reducer
      // records. No main-journal row or arbitrary backend bytes cross this decoder.
      const value: RecordValue = JSON.parse(row.record);
      this.#remember(id, value, Buffer.byteLength(row.record, "utf8"));
      return value;
    });
  }

  set(id: string, value: RecordValue): void {
    this.#guard(() => {
      const record = JSON.stringify(value);
      const bytes = Buffer.byteLength(record, "utf8");
      const metadata = this.#metadataOf(value, bytes);
      this.#write.run(this.#kind, JSON.stringify(id), record);
      this.#metadata.set(id, metadata);
      this.#remember(id, value, bytes);
    });
  }

  delete(id: string): boolean {
    return this.#guard(() => {
      if (!this.#metadata.has(id)) return false;
      this.#remove.run(this.#kind, JSON.stringify(id));
      this.#forget(id);
      return this.#metadata.delete(id);
    });
  }

  *values(): IterableIterator<RecordValue> {
    for (const id of this.keys()) {
      const value = this.get(id);
      if (value !== undefined) yield value;
    }
  }

  *entries(): IterableIterator<[string, RecordValue]> {
    for (const id of this.keys()) {
      const value = this.get(id);
      if (value !== undefined) yield [id, value];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, RecordValue]> { return this.entries(); }

  clear(): void {
    this.#cache.clear();
    this.#metadata.clear();
    this.#cacheBytes = 0;
  }

  #forget(id: string): void {
    const old = this.#cache.get(id);
    if (old === undefined) return;
    this.#cacheBytes -= old.bytes;
    this.#cache.delete(id);
  }

  #remember(id: string, value: RecordValue, bytes: number): void {
    this.#forget(id);
    if (bytes > this.#maxCacheBytes) return;
    this.#cache.set(id, { value, bytes });
    this.#cacheBytes += bytes;
    while (this.#cacheBytes > this.#maxCacheBytes || this.#cache.size > this.#maxCacheRecords) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
  }
}

/** One SQLite owner's disposable payload backing; never a public backend selector. */
export class SqliteSessionStateRecords {
  readonly collections: SessionV4RecordCollections;
  readonly #clear: Array<() => void> = [];
  readonly #nodeMetadata: () => IterableIterator<[string, SessionV4NodeMetadata & SessionEntryProjectionMetadata]>;
  #closed = false;
  #faulted = false;
  #fault: unknown;
  #lastCommitSequence = 0;
  #lastCommitBytes = 0;

  constructor(db: DatabaseSync) {
    if (db.prepare("PRAGMA compile_options").all().some((row) => row.compile_options === "TEMP_STORE=3")) {
      throw new Error("SQLite must support file-backed temporary session records");
    }
    db.exec("PRAGMA temp_store = FILE; PRAGMA temp.cache_size = -2048; PRAGMA temp.cache_spill = ON;");
    if (db.prepare("PRAGMA temp_store").get()?.temp_store !== 1) {
      throw new Error("SQLite temporary session records must be file-backed");
    }
    db.exec(`CREATE TABLE temp.ohm_session_state_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;`);
    const statements = {
      read: db.prepare("SELECT record FROM temp.ohm_session_state_records WHERE kind = ? AND id = ?"),
      write: db.prepare(`INSERT INTO temp.ohm_session_state_records (kind, id, record) VALUES (?, ?, ?)
        ON CONFLICT (kind, id) DO UPDATE SET record = excluded.record`),
      remove: db.prepare("DELETE FROM temp.ohm_session_state_records WHERE kind = ? AND id = ?"),
    };
    const create = <R, M>(kind: string, metadataOf: (value: R, bytes: number) => M, bytes: number, count: number) => {
      const records = new SqliteRecords(kind, statements, (action) => this.#guard(action), metadataOf, bytes, count);
      this.#clear.push(() => records.clear());
      return records;
    };
    // Fixed partitions total 8 MiB serialized weight / 128 decoded records.
    // Oversized records are transient reads and are never admitted to these caches.
    const nodes = create("nodes", (node: Parameters<SessionV4RecordCollections["nodes"]["set"]>[1]) => {
      const metadata: SessionV4NodeMetadata & SessionEntryProjectionMetadata = {
        id: node.id, parentId: node.parentId, nodeType: node.nodeType,
        projectedEntryCount: projectedSessionEntryCount(node),
      };
      if (node.operationId !== undefined) metadata.operationId = node.operationId;
      if (node.nodeType === "message") metadata.role = node.role;
      return metadata;
    }, 2 * MIB, 32);
    this.#nodeMetadata = () => nodes.metadataEntries();
    this.collections = {
      nodes,
      commits: create("commits", (commit: Parameters<SessionV4RecordCollections["commits"]["set"]>[1], bytes) => {
        this.#lastCommitSequence = commit.sequence;
        this.#lastCommitBytes = bytes;
        return { commitId: commit.commitId, sequence: commit.sequence, committedAt: commit.committedAt };
      }, 2 * MIB, 32),
      operations: create("operations", (operation: Parameters<SessionV4RecordCollections["operations"]["set"]>[1]) => ({
        id: operation.id, branchId: operation.branchId, promptNodeId: operation.promptNodeId,
        sourceHeadId: operation.sourceHeadId, status: operation.status,
        acceptedAt: operation.acceptedAt, finishedAt: operation.finishedAt,
      }), MIB, 16),
      checkpoints: create("checkpoints", (checkpoint: Parameters<SessionV4RecordCollections["checkpoints"]["set"]>[1]) => ({
        id: checkpoint.id, operationId: checkpoint.operationId, createdAt: checkpoint.createdAt,
      }), MIB, 16),
      queue: create("queue", (entry: Parameters<SessionV4RecordCollections["queue"]["set"]>[1]) => ({
        id: entry.id, branchId: entry.branchId, targetNodeId: entry.targetNodeId,
        operationId: entry.operationId, status: entry.status,
      }), MIB, 16),
      toolEffects: create("toolEffects", (effect: Parameters<SessionV4RecordCollections["toolEffects"]["set"]>[1]) => ({
        id: effect.id, operationId: effect.operationId, toolName: effect.toolName,
        status: effect.status, preparedAt: effect.preparedAt, lastDispatchedAt: effect.lastDispatchedAt,
        recoveryStartedAt: effect.recoveryStartedAt, finishedAt: effect.finishedAt,
      }), MIB, 16),
    };
  }

  close(): void {
    this.#closed = true;
    for (const clear of this.#clear) clear();
  }

  assertHealthy(): void { this.#guard(() => undefined); }

  /** Normalized ordinal bounds; scanning existing metadata never decodes payloads. */
  getEntryProjectionMetadataPage(offset: number, limit: number): SessionEntryProjectionMetadata[] {
    return this.#guard(() => {
      const entries: SessionEntryProjectionMetadata[] = [];
      let ordinal = 0;
      for (const [, metadata] of this.#nodeMetadata()) {
        if (ordinal >= offset + limit) break;
        if (ordinal >= offset) entries.push({
          id: metadata.id, parentId: metadata.parentId, projectedEntryCount: metadata.projectedEntryCount,
        });
        ordinal += 1;
      }
      return entries;
    });
  }

  /** Used immediately after accepted replay, never after tentative transition validation. */
  replayCommitBytes(sequence: number): number {
    return this.#guard(() => {
      if (sequence !== this.#lastCommitSequence) throw new Error("Session replay lost its accepted commit byte count");
      return this.#lastCommitBytes + 1;
    });
  }

  #guard<Result>(action: () => Result): Result {
    if (this.#closed) throw new Error("Session records are closed");
    if (this.#faulted) throw new Error("Session records are faulted; reopen before use", { cause: this.#fault });
    try { return action(); }
    catch (error) {
      this.#faulted = true;
      this.#fault = error;
      for (const clear of this.#clear) clear();
      throw error;
    }
  }
}
