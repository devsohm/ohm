import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { STRING_VALUE } from "../core/value-schemas.js";

export interface SessionHistoryIndexCommit {
  sequence: number;
  changes: Array<
    | { type: "node"; id: string; parentId: string | null; isModel: boolean; isThinking: boolean }
    | { type: "label"; nodeId: string; label: string | null; timestamp: string }
  >;
}

const NODE = Type.Object({
  id: Type.String(), parentId: Type.Union([Type.String(), Type.Null()]),
  ordinal: Type.Integer({ minimum: 0 }), depth: Type.Integer({ minimum: 0 }),
  nearestModelId: Type.Union([Type.String(), Type.Null()]),
  nearestThinkingId: Type.Union([Type.String(), Type.Null()]),
  label: Type.Union([Type.String(), Type.Null()]),
  labelTimestamp: Type.Union([Type.String(), Type.Null()]),
});

export type SessionHistoryIndexNode = Static<typeof NODE>;

// JSON preserves lone UTF-16 surrogates and NULs accepted by the journal;
// binding those JavaScript strings directly as SQLite TEXT is not lossless.
function sqlString(value: string | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function decodedString(value: string): string {
  const decoded = JSON.parse(value);
  if (!Value.Check(STRING_VALUE, decoded)) throw new Error("Invalid history index string");
  return decoded;
}

function decodedIdentity(row: Record<string, SQLOutputValue>): string {
  if (!Value.Check(STRING_VALUE, row.id)) throw new Error("Invalid history index identity");
  return decodedString(row.id);
}

function decodedNode(row: Record<string, SQLOutputValue>): SessionHistoryIndexNode {
  if (!Value.Check(NODE, row)) throw new Error("Invalid history index metadata");
  return {
    ...row,
    id: decodedString(row.id),
    parentId: row.parentId === null ? null : decodedString(row.parentId),
    nearestModelId: row.nearestModelId === null ? null : decodedString(row.nearestModelId),
    nearestThinkingId: row.nearestThinkingId === null ? null : decodedString(row.nearestThinkingId),
    label: row.label === null ? null : decodedString(row.label),
    labelTimestamp: row.labelTimestamp === null ? null : decodedString(row.labelTimestamp),
  };
}

export interface SessionHistoryIndexPageOptions {
  direction: "newest" | "oldest" | "before" | "after";
  cursor?: string;
  limit: number;
}

const COLUMNS = `id, parent_id AS parentId, ordinal, depth,
  nearest_model_id AS nearestModelId, nearest_thinking_id AS nearestThinkingId,
  label, label_timestamp AS labelTimestamp`;
const LINEAGE = `WITH RECURSIVE lineage(id, parent_id, depth, ordinal) AS (
  SELECT id, parent_id, depth, ordinal FROM temp.ohm_session_history_nodes WHERE id = ?
  UNION ALL
  SELECT parent.id, parent.parent_id, parent.depth, parent.ordinal
  FROM temp.ohm_session_history_nodes parent JOIN lineage ON parent.id = lineage.parent_id
  WHERE lineage.depth > ?
)`;

/** Connection-owned metadata derived only from validated commits; no journal payloads or persistent schema. */
export class SqliteSessionHistoryIndex {
  readonly #db: DatabaseSync;
  readonly #node: StatementSync;
  readonly #nodes: StatementSync;
  readonly #insertRoot: StatementSync;
  readonly #insertChild: StatementSync;
  readonly #label: StatementSync;
  readonly #history: StatementSync;
  readonly #ancestor: StatementSync;
  readonly #active: StatementSync;
  readonly #pathNode: StatementSync;
  readonly #pathInsert: StatementSync;
  readonly #pathBuild: StatementSync;
  readonly #pathRange: StatementSync;
  readonly #pathActive: StatementSync;
  #ordinal = 0;
  #sequence = 0;
  #anyThinking = false;
  #pathTip: string | undefined;

  constructor(db: DatabaseSync) {
    this.#db = db;
    // The sole connection owner may replace an index after a failed catch-up.
    db.exec(`DROP TABLE IF EXISTS temp.ohm_session_history_path;
      DROP TABLE IF EXISTS temp.ohm_session_history_nodes;
      CREATE TEMP TABLE ohm_session_history_nodes (
      id TEXT PRIMARY KEY NOT NULL, parent_id TEXT,
      ordinal INTEGER NOT NULL UNIQUE, depth INTEGER NOT NULL CHECK (depth >= 0),
      nearest_model_id TEXT, nearest_thinking_id TEXT, label TEXT, label_timestamp TEXT
    ); CREATE TEMP TABLE ohm_session_history_path (
      depth INTEGER PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE
    )`);
    this.#node = db.prepare(`SELECT ${COLUMNS} FROM temp.ohm_session_history_nodes WHERE id = ?`);
    this.#nodes = db.prepare(`SELECT ${COLUMNS} FROM temp.ohm_session_history_nodes
      WHERE ordinal >= ? ORDER BY ordinal LIMIT ?`);
    this.#insertRoot = db.prepare(`INSERT INTO temp.ohm_session_history_nodes
      (id, parent_id, ordinal, depth, nearest_model_id, nearest_thinking_id) VALUES (?, NULL, ?, 0, ?, ?)`);
    this.#insertChild = db.prepare(`INSERT INTO temp.ohm_session_history_nodes
      (id, parent_id, ordinal, depth, nearest_model_id, nearest_thinking_id)
      SELECT ?, id, ?, depth + 1, COALESCE(?, nearest_model_id), COALESCE(?, nearest_thinking_id)
      FROM temp.ohm_session_history_nodes WHERE id = ?`);
    this.#label = db.prepare(`UPDATE temp.ohm_session_history_nodes SET label = ?, label_timestamp = ? WHERE id = ?`);
    this.#history = db.prepare(`${LINEAGE} SELECT id FROM lineage WHERE depth <= ? ORDER BY depth LIMIT ?`);
    this.#ancestor = db.prepare(`${LINEAGE} SELECT 1 AS found FROM lineage WHERE id = ?`);
    this.#active = db.prepare(`WITH RECURSIVE lineage(id, parent_id, ordinal) AS (
      SELECT id, parent_id, ordinal FROM temp.ohm_session_history_nodes WHERE id = ?
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.ordinal
      FROM temp.ohm_session_history_nodes parent JOIN lineage ON parent.id = lineage.parent_id
      WHERE lineage.ordinal >= ?
    ) SELECT id FROM lineage WHERE ordinal >= ? AND ordinal < ? ORDER BY ordinal`);
    this.#pathNode = db.prepare("SELECT ordinal FROM temp.ohm_session_history_path WHERE depth = ?");
    this.#pathInsert = db.prepare(`INSERT INTO temp.ohm_session_history_path (depth, ordinal)
      SELECT depth, ordinal FROM temp.ohm_session_history_nodes WHERE id = ?`);
    this.#pathBuild = db.prepare(`${LINEAGE} INSERT INTO temp.ohm_session_history_path (depth, ordinal)
      SELECT depth, ordinal FROM lineage`);
    this.#pathRange = db.prepare(`SELECT node.id FROM temp.ohm_session_history_path path
      JOIN temp.ohm_session_history_nodes node ON node.ordinal = path.ordinal
      WHERE path.depth >= ? AND path.depth < ? ORDER BY path.depth LIMIT ?`);
    this.#pathActive = db.prepare(`SELECT node.id FROM temp.ohm_session_history_nodes node
      WHERE node.ordinal >= ? AND node.ordinal < ? AND EXISTS (
        SELECT 1 FROM temp.ohm_session_history_path path WHERE path.ordinal = node.ordinal AND path.depth <= ?
      ) ORDER BY node.ordinal`);
  }

  update(commits: Iterable<SessionHistoryIndexCommit>): void {
    const ordinal = this.#ordinal;
    const sequence = this.#sequence;
    const anyThinking = this.#anyThinking;
    const pathTip = this.#pathTip;
    this.#db.exec("SAVEPOINT ohm_history_index_update");
    try {
      for (const commit of commits) {
        if (commit.sequence !== this.#sequence + 1) throw new Error("History index commits must be contiguous");
        for (const change of commit.changes) {
          if (change.type === "label") {
            const result = this.#label.run(sqlString(change.label), change.label === null ? null : sqlString(change.timestamp), sqlString(change.nodeId));
            if (result.changes !== 1) throw new Error(`Entry ${change.nodeId} not found`);
            continue;
          }
          const id = sqlString(change.id);
          const parentId = sqlString(change.parentId);
          const modelId = change.isModel ? id : null;
          const thinkingId = change.isThinking ? id : null;
          const result = parentId === null
            ? this.#insertRoot.run(id, this.#ordinal, modelId, thinkingId)
            : this.#insertChild.run(id, this.#ordinal, modelId, thinkingId, parentId);
          if (result.changes !== 1) throw new Error(`Entry ${change.parentId} not found`);
          if (change.parentId === this.#pathTip) {
            this.#pathInsert.run(id);
            this.#pathTip = change.id;
          }
          this.#ordinal += 1;
          if (change.isThinking) this.#anyThinking = true;
        }
        this.#sequence = commit.sequence;
      }
      this.#db.exec("RELEASE ohm_history_index_update");
    } catch (error) {
      this.#ordinal = ordinal;
      this.#sequence = sequence;
      this.#anyThinking = anyThinking;
      this.#pathTip = pathTip;
      try { this.#db.exec("ROLLBACK TO ohm_history_index_update; RELEASE ohm_history_index_update"); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "History index update and rollback failed"); }
      throw error;
    }
  }

  getNode(id: string): SessionHistoryIndexNode | undefined {
    const row = this.#node.get(sqlString(id));
    if (row === undefined) return undefined;
    return decodedNode(row);
  }

  getNodesPage(offset: number, count: number): SessionHistoryIndexNode[] {
    return this.#nodes.all(offset, count).map(decodedNode);
  }

  hasThinkingChange(): boolean { return this.#anyThinking; }

  #ensurePath(head: SessionHistoryIndexNode): void {
    // An extended path can serve an earlier head only when its exact ordinal
    // occupies that depth. Equal-depth siblings are never interchangeable.
    if (this.#pathTip === head.id || (this.#pathTip !== undefined && this.#pathNode.get(head.depth)?.ordinal === head.ordinal)) return;
    this.#pathTip = undefined;
    this.#db.exec("DELETE FROM temp.ohm_session_history_path");
    this.#pathBuild.run(sqlString(head.id), 0);
    // A failed build remains invalid and is cleared by the next attempt.
    this.#pathTip = head.id;
  }

  getHistoryRange(from: string | null, offset: number, count: number) {
    const head = from === null ? undefined : this.getNode(from);
    if (from !== null && head === undefined) throw new Error(`Entry ${from} not found`);
    const total = head === undefined ? 0 : head.depth + 1;
    if (head === undefined || count === 0 || offset >= total) return { ids: [], total };
    this.#ensurePath(head);
    return { ids: this.#pathRange.all(offset, Math.min(total, offset + count), count).map(decodedIdentity), total };
  }

  getHistoryPage(from: string | null, options: SessionHistoryIndexPageOptions) {
    const head = from === null ? undefined : this.getNode(from);
    if (from !== null && head === undefined) throw new Error(`Entry ${from} not found`);
    const total = head === undefined ? 0 : head.depth + 1;
    let start = options.direction === "oldest" ? 0 : Math.max(0, total - options.limit);
    let end = total - 1;
    let anchor = from;
    let usePath = options.direction === "oldest";
    if (options.direction === "before" || options.direction === "after") {
      const cursor = options.cursor === undefined ? undefined : this.getNode(options.cursor);
      if (cursor === undefined || head === undefined) {
        throw new Error(`History cursor ${options.cursor} is not on the selected lineage`);
      }
      const nearHead = head.depth - cursor.depth <= options.limit;
      if (!nearHead) this.#ensurePath(head);
      const belongs = nearHead
        ? this.#ancestor.get(sqlString(from), cursor.depth, sqlString(cursor.id))?.found === 1
        : this.#pathNode.get(cursor.depth)?.ordinal === cursor.ordinal;
      if (!belongs) {
        throw new Error(`History cursor ${options.cursor} is not on the selected lineage`);
      }
      if (options.direction === "before") {
        start = Math.max(0, cursor.depth - options.limit);
        end = cursor.depth - 1;
        anchor = cursor.parentId;
      } else {
        start = cursor.depth + 1;
        usePath = !nearHead;
      }
    }
    end = Math.min(end, start + options.limit - 1);
    if (end < start) return { ids: [], offset: start, total };
    const ids = usePath ? this.getHistoryRange(from, start, options.limit).ids
      : this.#history.all(sqlString(anchor), start, end, options.limit).map(decodedIdentity);
    return { ids, offset: start, total };
  }

  getActiveIds(offset: number, count: number, head: string | null): string[] {
    if (head === null || count === 0) return [];
    const selected = this.getNode(head);
    if (selected === undefined) throw new Error(`Entry ${head} not found`);
    if (selected.ordinal - offset < count) {
      return this.#active.all(sqlString(head), offset, offset, offset + count).map(decodedIdentity);
    }
    this.#ensurePath(selected);
    return this.#pathActive.all(offset, offset + count, selected.depth).map(decodedIdentity);
  }
}
