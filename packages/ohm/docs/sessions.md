# Sessions and context

Every saved ohm session uses one SQLite database containing the append-only V4
journal. CLI, TUI, print, JSON, RPC, serve and SDK share this storage path; there
is no optional durable-backend selector. The journal is the durable agent run
history, often called a trajectory, separate from metadata-only operational telemetry.

JSONL remains the portable import/export format. Existing JSONL sessions are
discoverable and readable without modification. Explicitly resuming one validates
its complete committed history, creates a SQLite copy, and leaves the original
bytes untouched. Startup and listing do not migrate sessions. A subsequent resume
reuses that SQLite copy only if its header and committed prefix match the original;
a conflicting same-ID copy is rejected, never overwritten. Listing hides a legacy
source only after proving its history survives in the SQLite copy. Divergent
copies remain visible with a diagnostic.

```ts
import { SessionManager } from "ohm/storage";

const manager = SessionManager.create(process.cwd(), "/private/app/sessions");
const file = manager.getSessionFile();
manager.closeV4Store();
const reopened = SessionManager.open(file!);
reopened.closeV4Store();
```

Pass a manager to `createAgentSession({ sessionManager: manager })`, or use the SDK
default to create a saved session. `SessionManager.inMemory(cwd)` is for no-save
sessions, ephemeral embedding and tests. `cloneInMemory()` produces an isolated
volatile snapshot, never another writer to the saved source. New sessions and
forks remain in memory when the owning runtime is no-save.

`SessionManager.open(path, undefined, undefined, { readOnly: true })` captures an
immutable snapshot alongside a writer, without creating a session database or
modifying its records. SQLite may create or rebuild `-wal` and `-shm` coordination
sidecars during read-only inspection; read-only does not promise an unchanged
directory. Readers use normal WAL coordination so committed concurrent writes
remain visible when a new snapshot opens. Runtime `importFromJsonl` validates a transfer file and preserves its
exact header, commit identities, recovery state and opaque provider data. It
publishes only a successfully copied candidate; cancellation removes that candidate,
not the source. Duplicate identities are rejected rather than renamed or overwritten.
Saved owners keep validated historical payloads in connection-private,
file-backed SQLite temporary tables. Decoded records have fixed caches totaling
8 MiB of serialized weight and 128 records across nodes, commits, operations,
checkpoints, queue entries and tool effects. Oversized records are read
transiently without entering the cache. This is not an exact JavaScript heap
limit: identity/ancestry metadata still grows with history, and requested
context, full snapshots and exports allocate their output. Memory sessions and
detached read-only snapshots keep plain in-memory Maps. Node's built-in
`node:sqlite` is required for saved sessions.

Every open still parses and validates the entire committed journal before use.
Temporary records come only from that validated reducer, never from unchecked
journal rows on a cache miss. They are discarded on close and rebuilt on reopen.
An uncertain temporary-record failure faults the owner until reopened. The
temporary backing adds disk use and replay work; it does not shrink the durable
journal or guarantee faster startup. Model context is still materialized in
memory.

`getHistoryPage({ from, before, after, edge: "oldest", limit, maxBytes })` retrieves
bounded chronological lineage pages; cursor options and `edge` are alternatives.
`from` fixes the lineage tip, otherwise the current tip is used. A single entry
larger than the byte budget is returned alone so paging always progresses; hosts
must retain their rendering/output limits. Saved-session owners lazily derive a
temporary SQLite metadata index from validated commits when deeper navigation,
tree pages, ordinals or search need it. Initial model/thinking restoration and
newest pages do not build the index; they use metadata-only and bounded ancestor
walks. Once built, selection and history can reuse the index and one indexed
lineage. The index catches up after accepted appends
and is discarded with its owning connection. It is not another durable store,
does not duplicate message payloads, and does not skip journal validation.
Its first build still costs work proportional to history, and switching to a
different branch can rebuild the temporary lineage. Memory sessions and detached
read-only snapshots retain their connection-free in-memory navigation path.
`searchHistory(text, { from, before,
after, limit, signal })` searches visible durable text with cancellation and stable
entry cursors. Without `from`, search includes all branches. It does not search
hidden provider state or private plugin metadata. Saved-session searches read
bounded metadata batches without copying every history ID into JavaScript.
Each scan fixes its starting history range, excludes later appends, and rejects
if the manager replaces its session owner during a yield. A no-match search still
examines all eligible visible payloads. Paging and the decoded-record cache
bound ordinary presentation batches and cached payloads, not all runtime state
or the time required for a full search.

![ohm journal branches and compaction boundary](assets/session-tree.svg)

## Session commands

Interactive commands:

```text
/new                 start a new session
/resume [--all|SESSION]
                     select or open a saved session
/fork                branch before a selected user message and restore its text
/clone               copy the current journal leaf into an independent session
/atlas               explore the active journal's lineage tree
/name NAME           set the session name
/session             show the active file, model, usage, cost, and cache waste
/compact [FOCUS]     summarize older context
/recover             attempt safe recovery of an interrupted run
/recover abandon ID  continue without repeating one blocked tool effect
/export [FILE]       export the active session
```

Related startup options include `--continue`, `--resume`, `--session`,
`--session-id`, `--fork`, `--session-dir`, and `--no-session`.

A session reference can be an exact ID, an unambiguous ID prefix, an exact
name, or an explicit `.sqlite` or legacy `.jsonl` path. Ambiguous references fail.

Session Atlas is the active journal's lineage tree. It shows the selected path
and alternate branches without mixing in unrelated saved sessions. Selecting a
journal point can check it out, check it out after summarizing the path being
left, or create a linked branch. Selecting the active head also offers an
independent optionally named snapshot. Atlas opens without interrupting a live
response and settles that response only when the user chooses a state-changing
action. `/resume` exclusively owns saved-session discovery and switching.

Session catalogs are scoped to the launch workspace unless `--all` is
selected. Opening a session owned by another workspace requires confirmation
and copies it into a session for the current workspace.

Deleting a session from the picker first asks the operating system to recycle
the file. ohm uses `gio trash` on Linux, Finder on macOS, and the Recycle
Bin through Windows PowerShell. If recycling fails, ohm deletes the file
permanently and reports which action completed.
Before moving a SQLite file, ohm checkpoints its committed WAL while retaining
writer ownership. If an active database reader prevents that checkpoint,
deletion fails without moving or removing the session; close the reader and retry.

`/new` does not copy facts from unrelated sessions. Cross-session memory is an
plugin concern and must be visible to the user.

A worker or delegated agent launched through a plugin-owned managed process
is not a branch or child of the current journal. The parent records only the
ordinary plugin tool call and result. The plugin owns any external
session files, correlation metadata, retention, and cleanup it chooses to add.

## Storage layout

The default session root is:

```text
~/.ohm/sessions/
```

Sessions are grouped by canonical workspace. `OHM_HOME` changes the ohm
home. `--session-dir` selects another directory for one invocation.

On POSIX systems, managed session roots and writer-lock directories use mode
`0700`; session journals, lock owner records, and new JSONL or HTML exports use
mode `0600`. On Windows, the current account's filesystem ACLs provide the
access boundary because POSIX mode bits do not apply.

Each database has an immutable header row and a sequence-ordered commit table.
JSONL transfers encode the same records as lines. The first record is the strict V4 header:

```json
{"record":"session","version":4,"sessionId":"...","createdAt":"...","workspace":"/work/project","cwd":"/work/project"}
```

Later records are ordered commits. A commit can atomically add conversation
nodes, select the active head, accept or finish a run, update a durable queue,
write a checkpoint, or move a tool effect through its recovery lifecycle.

A journal is bounded to 256 MiB of logical serialized records, each record to 16 MiB, and its
conversation tree to 100,000 nodes. A write that would cross a limit is
rejected before the journal changes. These are storage safety limits;
compaction bounds model context but intentionally does not erase the durable
transcript. Start a new session before an exceptionally long journal reaches a
limit.

Conversation node `parentId` links form a tree. A `null` parent starts a root.
Multiple children create branches. The `main` head selects the active
ancestry. Nodes are immutable; selecting another branch changes the head
instead of rewriting history.

## Resume and discovery

`SessionManager.list(cwd)` scans the canonical directory for one workspace.
`SessionManager.listAll()` scans all workspace directories under the configured
session root.

`SessionManager.openSnapshot(path, cwdOverride?)` opens a detached
`ReadonlySessionManager` capture without acquiring the journal's writer slot.
It can inspect a session while its owning host continues writing, but it does
not observe commits made after the snapshot opened. Open a new snapshot for a
fresh view. Mutator methods are absent from the returned public type, and
runtime commit attempts still fail closed if a caller bypasses that type.

Native `SessionManager` instances and their read-only snapshots expose
`getPersistedSelection()` for model/thinking restoration without projecting
message payloads. Its `model` and `thinkingLevel` match `buildSessionContext()`
on the active lineage, including selections before compaction; absent selections
produce `null` and `"off"`. `hasPersistedThinking` reports a thinking entry anywhere
in the journal, preserving restoration defaults when switching branches. The
returned model object is detached. This query reads validated metadata, reusing
an existing owned index when available; it does not eliminate journal replay or
make model context disk-backed.
The plugin session-manager facade remains unchanged; this method belongs to
the native storage API used by hosts.

Listing:

- reads no more than ten files at once;
- stats every candidate, including a live SQLite WAL, but reparses only new or changed journals;
- reuses names, previews, searchable text, timestamps, and message counts from
  a private versioned catalog snapshot;
- uses a stable path tie-breaker when activity times match;
- rejects a missing pagination cursor instead of restarting silently.

The catalog snapshot is rebuildable metadata, not a second source of truth. It
lives beside the journals as `.ohm-session-catalog-v1.json`, uses private
permissions, is replaced atomically, and is discarded and rebuilt when its
version, shape, permissions, or file fingerprints do not match. Deleting or
corrupting it cannot alter a session journal.

`--continue` opens the most recently modified session in the current
workspace. `--resume` opens the interactive selector. `--all` expands their
search scope.

`ohm sessions doctor` reports invalid journals. It does not rewrite damaged
committed records.

## Crash and writer behavior

SQLite commits are atomic transactions using WAL and full synchronization. Only
one product writer may own a session database. Read-only snapshots include
committed WAL records without claiming the writer slot. Close the owning session
before copying or moving a database manually; a live database may depend on its
adjacent WAL file.
A live rename or replacement is unsupported. The writer checks its original
file identity before and after committing and faults instead of acknowledging
further writes through a moved path. If a live main file was moved accidentally,
keep its original WAL with it and restore the original path before closing the
owner. Do not delete either file or treat the moved main file alone as a complete
backup. Explicit symlink paths resolve to the canonical file and share its writer
lease; directory discovery does not follow symlink entries.

For legacy JSONL input, only a complete JSON object followed by LF is committed.

- A trailing unterminated fragment is ignored during read.
- Explicit resume excludes that fragment from the SQLite copy and preserves the original file.
- Invalid LF-terminated data fails with a line diagnostic.
- Resume rejects a legacy source owned by another live writer.

The writer validates each state transition, writes and synchronizes the commit,
then publishes it to live readers. A crash cannot publish state that was not
made durable.

An interrupted tool effect follows its stored recovery policy. ohm does not
blindly repeat an external side effect. An unresolved in-doubt effect blocks
new work until it is reconciled or explicitly resolved.

Interactive, print, JSON, and serve modes attempt safe recovery when they open a
session with an interrupted run. Safe repeatable work can run again. A tool
with a reconciliation handler can check external state. Any remaining
uncertain effect stays blocked. Reopening after a crash never treats the
interruption itself as permission to abandon an effect.

An intentional Escape cancellation in the same interactive process has a
narrower rule. After cancellation settles, the next submitted prompt records
each still-unsettled effect as abandoned and then continues without replaying
it. This is a non-replay decision only: it does not claim that an external
action succeeded or failed, undo an action, or repeat one. If cancellation or
recovery cannot settle, the prompt is not sent and the session remains blocked
for explicit recovery.

In interactive mode, typing `/recover` authorizes a complete automatic recovery
pass: ohm first repeats or reconciles only effects whose stored policy permits
it, then records every effect still blocked as abandoned without replay.
`/recover abandon EFFECT_ID` keeps the narrower one-effect form. Both record a
non-replay decision only; neither claims that the external action succeeded or
failed. Recovery itself does not start a model turn. On the next prompt, the
model receives the abandoned call as an error tool result that explicitly says
the external outcome is unknown, may already have completed, and must be
inspected before any retry.

RPC hosts can use `get_recovery_status` and `recover_interrupted_run`. SDK
hosts can read `session.suspendedRun` and call
`session.recoverInterruptedRun()`. Embedding exposes those members on its
narrow session facade. Serve keeps a blocked session registered and exposes
the same explicit decision through its authenticated
`/v1/sessions/:id/recovery` resource. These APIs let a host provide a verified
`succeeded`, `failed`, or `abandoned` resolution for a blocked effect.

## Context reconstruction

The V4 reducer rebuilds the selected head, nodes, run state, queues,
checkpoints, and tool effects. `SessionManager` then projects the active
conversation:

1. follow `parentId` from the selected head;
2. apply the latest reachable model, thinking, and tool selections;
3. start compacted context at the retained boundary;
4. keep valid user, assistant, tool-call, and tool-result order;
5. include plugin context and omit plugin state.

Provider conversion happens after canonical context exists. Provider
continuation state is reused only across a compatible provider, protocol,
model, and tool-definition boundary.

## Prompt-cache diagnostics

Prompt caching and provider continuation are separate optimizations. A cache
miss can increase cost or latency, but it does not mean context was lost.

When `showCacheMissNotices` is enabled, ohm compares each measured assistant
request with the preceding measured request. It reports a notice when at least
20,000 prior-prompt tokens were not cache-read, or when the estimated added
cost reaches about $0.10. This is an upper-bound estimate for that request, not
proof of billing. Differences below 1,024 tokens are ignored, and later
requests can recover normal cache reuse.

Missing cache telemetry ends the comparison chain. Compaction and branch
summaries reset it because they intentionally change the prompt prefix. A
provider or model route change also starts a new comparison epoch. When the
runtime has content-free structural fingerprints, changes to the API,
instructions, tool definitions, session, or other cache-affinity inputs start
a new epoch instead of being counted as avoidable waste.

Cache retention is provider-specific. ohm does not assume a universal idle
expiry. An adapter can supply a known retention window or mark idle expiry as
possible; otherwise elapsed time alone is not labeled as an expiry. Explicit
zero cache counters are measured values. An unavailable counter remains
unknown, and a zero cache-write counter does not prove that caching failed. Use
later provider-reported cache reads to confirm reuse.

Callers that use `observeCacheRequest()` directly can supply an opaque
`cacheBoundary` or build one with `cacheBoundaryFingerprint()`. Boundary parts
must be non-secret stable identifiers or hashes. Do not pass credentials or
credential-bearing URLs. Endpoint, account, transport-generation, and exact
retention identities are included only when the selected adapter exposes a
safe value.

`/session` reports message, tool, usage, and cost totals for the complete
journal, including non-active branches and summary requests. Cache-waste
estimates follow the active branch because only that prompt sequence is
comparable. Its `prompt` token label is uncached input plus cache reads and
cache writes, the same denominator used for cache-hit percentages elsewhere.
The prompt-cache line preserves an explicit reported zero and says `not
reported` when neither cache counter is available. If only some requests or
components report cache telemetry, its numbers are sums of the reported
counters rather than an estimate for the missing values. The whole-journal
cache-hit percentage appears only when every usage-bearing main or summary
request reports input, cache-read, and cache-write counters and their combined
prompt denominator is nonzero. Tool-attributed usage is excluded from that
percentage. Otherwise `/session` labels the rate unavailable instead of
treating missing counters as zero.

## Compaction and branches

Compaction shortens provider context without deleting history. Its node stores
the summary and retained node IDs. Product projection also exposes the first
retained entry, tokens before compaction, normalized usage, details, and hook
provenance when present.

Context begins with the summary, continues from the retained boundary, and
then includes later reachable nodes. An Atlas checkout can summarize the path
being left before selecting another head.

See [Context compaction](compaction.md) and
[Session JSONL format](session-jsonl.md).

## Plugin state

Trusted plugins can store:

- `extension_state`, for durable data that does not enter model context;
- `extension_context`, for plugin-authored model context.

Product-facing plugin APIs project these as typed session entries.
Registrations remain generation-bound, so `/refresh` does not duplicate or
rewrite durable data. Do not retain a callback-scoped session view after
refresh or session replacement.

## Export and privacy

`exportToJsonl()` writes a valid, settled V4 journal for the selected branch.
It keeps conversation ancestry and selection state but does not carry an active
operation, pending queue, checkpoint, or tool-effect recovery state.

HTML export creates a self-contained transcript viewer. An ordinary HTML
export of a durable session embeds the exact source journal. A redacted export
regenerates a settled V4 journal with known secrets removed.

Exports may contain prompts, model output, tool arguments and results, local
paths, images, and plugin content. Inspect a redacted copy before sharing.

See [Session export](session-export.md).
