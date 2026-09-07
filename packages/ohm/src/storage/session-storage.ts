import { isDeepStrictEqual } from "node:util";
import {
  SESSION_V4_MAX_COMMIT_COUNT,
  SESSION_V4_MAX_FILE_BYTES,
  SESSION_V4_MAX_RECORD_BYTES,
  applySessionV4CommitOwned,
  createSessionV4State,
  createSessionV4ReducerState,
  parseSessionV4CommitDraft,
  parseSessionV4Header,
  validateSessionV4CommitTransition,
  type SessionV4Commit,
  type SessionV4CommitDraft,
  type SessionV4Header,
  type SessionV4Json,
  type SessionV4ReducerState,
  type SessionV4State,
} from "@ohm/kernel/session-v4";
import type { SessionHistoryIndexCommit, SqliteSessionHistoryIndex } from "./session-history-index.js";
import type { SqliteSessionStateRecords } from "./session-state-records.js";
import type { SessionEntryProjectionMetadata } from "./session-entry-projection.js";

export interface SessionStorageSnapshot {
  header: SessionV4Header;
  /** Untrusted committed records in ascending sequence order. Incomplete writes must not appear. */
  commits: Iterable<SessionV4Commit | SessionV4Json>;
}

/** @internal Synchronous durable append boundary. A successful append must survive close/reopen.
 * Implementations must reject overlapping writers and atomically persist each complete
 * record. A thrown append has an uncertain outcome; the manager faults until reopened.
 * Storage never receives mutable runtime state; replay parses and detaches its snapshots.
 */
export interface SessionStorage {
  readonly path: string;
  readonly readOnly: boolean;
  read(): SessionStorageSnapshot;
  append(commit: SessionV4Commit): void;
  /** Owned SQLite connections may build disposable metadata from validated commits. */
  createHistoryIndex?(): SqliteSessionHistoryIndex;
  /** Private payload backing; it receives only parser-owned reducer records. */
  createStateRecords?(): SqliteSessionStateRecords;
  close(): void;
}


/** @internal Validates external journals and keeps the reducer exclusively host-owned. */
export class SessionStorageJournal {
  readonly path: string;
  readonly readOnly: boolean;
  readonly #storage: SessionStorage;
  readonly #state: SessionV4ReducerState;
  readonly #memoryState: SessionV4State | undefined;
  readonly #records: SqliteSessionStateRecords | undefined;
  #bytes: number;
  #closed = false;
  #faulted = false;
  #fault: unknown;
  #history: {
    index: SqliteSessionHistoryIndex;
    sequence: number;
    commits: IterableIterator<SessionV4Commit>;
  } | undefined;

  constructor(storage: SessionStorage) {
    this.#storage = storage;
    this.path = storage.path;
    this.readOnly = storage.readOnly;
    try {
      const snapshot = storage.read();
      const header = parseSessionV4Header(snapshot.header);
      this.#records = storage.createStateRecords?.();
      this.#memoryState = this.#records === undefined ? createSessionV4State(header) : undefined;
      this.#state = this.#memoryState ?? createSessionV4ReducerState(header, this.#records!.collections);
      this.#bytes = Buffer.byteLength(JSON.stringify(header), "utf8") + 1;
      if (this.#bytes - 1 > SESSION_V4_MAX_RECORD_BYTES) throw new Error("Session storage header exceeds its byte limit");
      const accepted = this.#memoryState?.commits.values();
      for (const record of snapshot.commits) {
        if (!applySessionV4CommitOwned(this.#state, record)) throw new Error("Storage contains a duplicate commit");
        let bytes: number;
        if (this.#records !== undefined) bytes = this.#records.replayCommitBytes(this.#state.sequence);
        else {
          // Only count the parser-owned value, never revisit the untrusted input.
          const commit = accepted?.next().value;
          if (commit === undefined) throw new Error("Storage replay did not retain its accepted commit");
          bytes = this.#recordBytes(commit);
        }
        this.#checkLimits(bytes, this.#state.sequence);
        this.#bytes += bytes;
      }
    } catch (error) {
      try { storage.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Session storage load and cleanup failed"); }
      throw error;
    }
  }

  get bytes(): number { return this.#bytes; }

  inspectState<T>(inspect: (state: SessionV4ReducerState) => T): T {
    if (this.#closed) throw new Error("Session storage is closed");
    this.#records?.assertHealthy();
    return inspect(this.#state);
  }

  getEntryProjectionMetadataPage(offset: number, limit: number): SessionEntryProjectionMetadata[] | undefined {
    return this.inspectState(() => this.#records?.getEntryProjectionMetadataPage(offset, limit));
  }

  /** Transfers an exclusively owned, connection-free read-only replay to its snapshot. */
  detachReadOnlyState(): SessionV4State {
    if (!this.readOnly || this.#memoryState === undefined) throw new Error("Only read-only replay may detach its state");
    const state = this.#memoryState;
    this.close();
    return state;
  }

  /** Builds only owner-local metadata; payloads continue to come from validated state. */
  getHistoryIndex(create = true): SqliteSessionHistoryIndex | undefined {
    if (this.#closed) throw new Error("Session storage is closed");
    this.#records?.assertHealthy();
    if (this.#storage.createHistoryIndex === undefined) return undefined;
    if (!create && this.#history === undefined) return undefined;
    const history = this.#history ?? {
      index: this.#storage.createHistoryIndex(),
      sequence: 0,
      commits: this.#state.commits.values(),
    };
    try {
      if (history.sequence !== this.#state.sequence) {
        history.index.update(this.#historyUpdates(history, this.#state.sequence));
        history.sequence = this.#state.sequence;
      }
      this.#history = history;
      return history.index;
    } catch (error) {
      // The iterator may have advanced. Rebuild the disposable index on the next
      // read; index failure never changes an already-acknowledged journal append.
      this.#history = undefined;
      throw error;
    }
  }

  *#historyUpdates(
    history: { sequence: number; commits: IterableIterator<SessionV4Commit> },
    through: number,
  ): Generator<SessionHistoryIndexCommit> {
    // Do not exhaust the live Map iterator: later accepted commits must remain
    // visible without rescanning or retaining a second pending-commit queue.
    for (let sequence = history.sequence + 1; sequence <= through; sequence += 1) {
      const commit = history.commits.next().value;
      if (commit === undefined || commit.sequence !== sequence) throw new Error("History index lost its validated commit position");
      const changes: SessionHistoryIndexCommit["changes"] = [];
      for (const change of commit.changes) {
        if (change.type === "conversation_node") {
          changes.push({ type: "node", id: change.node.id, parentId: change.node.parentId,
            isModel: change.node.nodeType === "model_change", isThinking: change.node.nodeType === "thinking_change" });
        } else if (change.type === "node_label") {
          changes.push({ type: "label", nodeId: change.nodeId, label: change.label, timestamp: commit.committedAt });
        }
      }
      yield { sequence, changes };
    }
  }

  append(input: SessionV4CommitDraft): SessionV4Commit {
    if (this.#closed) throw new Error("Session storage is closed");
    if (this.readOnly) throw new Error("Session storage is read-only");
    if (this.#faulted) throw new Error("Session storage is faulted; reopen before writing", { cause: this.#fault });
    const draft = parseSessionV4CommitDraft(structuredClone(input));
    const existing = this.#state.commits.get(draft.commitId);
    if (existing !== undefined) {
      if (existing.committedAt === draft.committedAt && isDeepStrictEqual(existing.changes, draft.changes)) return structuredClone(existing);
      throw new Error("Session commit identity is already used with different content");
    }
    const commit: SessionV4Commit = { record: "commit", sequence: this.#state.sequence + 1, ...draft };
    const bytes = this.#recordBytes(commit);
    this.#checkLimits(bytes, commit.sequence);
    validateSessionV4CommitTransition(this.#state, commit);
    try {
      this.#storage.append(structuredClone(commit));
      if (!applySessionV4CommitOwned(this.#state, commit)) throw new Error("Durable commit was already applied");
    } catch (error) {
      this.#faulted = true;
      this.#fault = error;
      throw error;
    }
    this.#bytes += bytes;
    return structuredClone(commit);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#history = undefined;
    this.#storage.close();
  }

  #recordBytes(commit: SessionV4Commit): number { return Buffer.byteLength(JSON.stringify(commit), "utf8") + 1; }

  #checkLimits(bytes: number, sequence: number): void {
    if (bytes - 1 > SESSION_V4_MAX_RECORD_BYTES) throw new Error("Session storage record exceeds its byte limit");
    if (this.#bytes + bytes > SESSION_V4_MAX_FILE_BYTES) throw new Error("Session storage exceeds its logical byte limit");
    if (sequence > SESSION_V4_MAX_COMMIT_COUNT) throw new Error("Session storage exceeds its commit limit");
  }
}
