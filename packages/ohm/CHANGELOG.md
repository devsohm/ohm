# Changelog

## Unreleased

### Breaking

- Live session databases with multiple hard links are rejected, including
  read-only opens. Use canonical paths or symlinks to access one session, and
  supported copy/export operations for independent sessions. This preserves
  single-writer ownership across data directories.

### Fixed

- Compaction attributes repeated tool-call IDs to their own occurrences, keeps
  valid call/result pairs, and includes opaque signatures in retained-byte limits.
- Plugin refresh keeps a published generation when retired cleanup fails.
  Trust-resolution failures close unpublished hosts; self-removing listeners no
  longer skip later hooks. Editor and presentation cleanup releases every owner
  even when a callback throws.
- Git plugin installs check out the default branch, tags, and commit IDs.
  Failed publication restores the previous checkout or preserves its recoverable
  backup if restoration also fails.
- Provider replacement cannot publish a retired catalog. Caller-owned model
  collections do not acquire ignored credential storage. OAuth cancellation
  settles manual input waits and respects explicit device denial or expiry.
- Standalone provider history preserves opaque reasoning and signatures only
  for the matching model. Grammar tools retain their declared argument property,
  Unicode fragments, result type, and forced-choice wire format.
- Configured bearer-only Gemini requests reach the SDK transport without sending
  a fabricated API key. Disabling Kimi session caching also removes its body key.
- HTTP and binary-stream cleanup releases response ownership without waiting on
  uncooperative cancellation. Redirects apply the target protocol's proxy policy.
- Autocomplete preserves command and prose prefixes, cancels stale work after
  cursor movement, and keeps fragmented grapheme insertion intact. Pasted mouse
  sequences remain text; unmatched Markdown delimiters avoid repeated scans.
- Process input closure drains accepted writes. Shared abort signals retain one
  listener, and shell capture bounds pending output without splitting Unicode.
- Skill discovery bounds deep directory walks; truncated instruction reads avoid
  repeated decoding. Image resizing stops encoding once a preferred output fits.
- Public clipboard copying shares native helper cleanup and honors its supplied
  environment while preserving the bounded terminal fallback.
- Tree navigation honors cancellation before committing a branch change.
  Cancelled recovery leaves uncertain effects unresolved; late reconciliation
  results cannot overwrite subsequent manual resolution.
- Public context entry IDs remain consistent with history pages and branches.
  Compatibility context projection and deferred model selection avoid repeated
  history scans.
- Plugin fork/navigation, labels, lifecycle entry references and RPC fork
  selections resolve projected entry IDs without confusing them with colliding
  journal IDs. Compaction events identify their committed entries and public
  retained boundaries. Malformed optional custom message metadata remains
  readable as raw stored content.
- Plugin registration validates callbacks before publication. Cancelled facet
  setup releases returned cleanup exactly once, and cleanup failures remain
  visible even when a plugin throws `undefined`.
- Individual facet disposal aborts pending setup and shares cleanup completion.
  Worker activation survives registration removal, synchronous tool cleanup has
  one owner, and throwing renderer disposal does not leak its replacement.
  Already-aborted callback waits still observe rejected work.
- SDK startup rejects when a plugin requests shutdown. Session replacement works
  without plugins and restores the selected session's workspace consistently.
- Installed and embedded RPC hosts process startup dialog responses and settle
  dialogs on input closure. Clean EOF gives queued UI output a bounded drain
  before closing the bridge. Both JSON hosts share compact, bounded output with
  consistent header and plugin-error ordering.
- Proxy fetch composition no longer recursively re-enters newer wrappers.
  Authenticated requests preserve caller cancellation, and failed response hooks
  release response bodies without masking the original error.
- Standalone HTTP JSON reads release reader locks, honor cancellation and reject
  oversized successful bodies without awaiting uncooperative stream cleanup.
- Streaming line readers retain transport failures and release their readers on
  early return. Fragmented lines avoid rescanning retained text, and split CRLF
  delimiters do not count against content limits. WebSocket receive limits cover
  pending binary decoding, and closed streams discard late decoding results.
  Cloud/OAuth body reads honor timeout and cancellation even with
  custom fetch streams. Concurrent lazy stream reads share one source iterator.
- Typed RPC client methods reject negative server responses consistently,
  including prompt submission and settings changes.
- Writes to missing files serialize across symlinked parent paths, including
  while an earlier write creates the target.
- HTML tool rendering distinguishes repeated provider call IDs across turns and
  branches without changing the embedded journal or renderer call IDs.
- Ordinary terminal input and Alt text avoid repeated whole-suffix traversal
  while preserving grapheme and control framing. Restarted terminals discard
  prior partial input and release input ownership after an output-write failure.
  Late custom components leave theme tracking, and abort callback failures stop
  loader timers.
- Session writer locks canonicalize symlinks across profiles. Staged imports
  synchronize publication and alias removal, with recoverable rollback on failure.
- Standalone terminal rendering places the hardware cursor at the editor marker
  without corrupting subsequent redraws, scrolling, or shutdown output.

## [0.2.0] - 2026-09-06

### Breaking

- Plugin CLI commands and flags now use only `plugins`, `--plugin`, and
  `--no-plugin-code`. Removed the older extension command and flag aliases;
  `--no-plugins` still disables automatic discovery of every plugin resource.
  Existing configuration and session readers are unchanged. See the
  [0.2 migration steps](docs/releasing.md#migrating-to-02).
- Plugin source imports now use `ohm/plugins`, with `PluginAPI`, `PluginFactory`,
  and the corresponding `Plugin*` contracts. Removed the `ohm/extensions`
  compatibility subpath and duplicate authoring aliases. SDK results use
  `pluginsResult`; resource loaders expose `getPlugins()` and plugin runners
  expose `getPluginPaths()`. Existing saved
  sessions, plugin data directories, and historical configuration inputs keep
  their original identities. See the [0.2 migration steps](docs/releasing.md#migrating-to-02).
- Saved sessions now use one SQLite database per session. JSONL remains a
  readable transfer format. Explicitly resuming a legacy JSONL session creates
  a validated SQLite copy without modifying its source; read-only discovery
  never migrates data. Consumers must not parse `sessionFile` as text: use
  `SessionManager.openSnapshot()` or the JSONL export API instead. See the
  [0.2 migration steps](docs/releasing.md#migrating-to-02).
- JSON and RPC streaming updates carry incremental deltas instead of repeating
  the entire partial message. SDK subscribers retain full in-memory snapshots.
- Removed the host-owned `childSessions` service and `ExtensionChildSession*`
  types. Plugins own delegation using the public SDK, RPC client, or managed
  processes. Generic background jobs remain available; existing saved sessions
  are not deleted.

### Changed

- Plugin discovery shares supported source formats and index precedence across
  package, direct-runtime, and public loaders. Public discovery checks canonical
  `plugins` directories before legacy `extensions` directories in each scope.
- User messages again use padded, theme-owned cards with light text and a grey
  default background, without a speaker label. Lowercase `ohm` labels use a
  contrasting information color, while thinking blocks omit the duplicate
  assistant label and keep their own heading.
- The terminal status ribbon distinguishes model, thinking, activity, context,
  cache, tokens and cost through semantic theme colors and readable labels.
  Narrow and no-color terminals retain compact text and custom footer ownership.
- Session selection restoration reads model/thinking metadata without projecting
  message history. SQLite replay validates each record once and avoids deep
  cloning private snapshot history. Saved owners retain validated payloads in
  private temporary tables with a bounded decoded-record cache; full snapshots,
  exports and model context still materialize their requested data. Replay
  reuses the exact accepted commit byte count instead of serializing it twice.
  Newest-history pages walk only the requested tail plus one ancestor.
- `createServeSessionRuntime()` provides the shared HTTP adapter for hosts of
  an existing session. A public-import, offline example demonstrates discovery,
  actions, cancellation and committed-history recovery.
- `ohm plugins` is the canonical install, inspect, and authoring workflow.
  `ohm/plugins` exposes the same runtime contracts with `PluginAPI` and related
  authoring names. One `plugins` configuration list loads executable
  `entrypoints`, skills, prompts, and themes through the existing runtime.
  Help, shell completion, defaults, and author examples use this single workflow.
- The terminal uses labeled conversation turns, compact tool rows, and a
  single-boundary composer. Custom plugin UI remains available. Transcript
  history navigation and search load bounded presentation pages.
- Core guidance distinguishes read-only requests from implementation, preserves
  task scope, and requires evidence for completion claims. Built-in tools share
  one parameter-schema source with clearer pagination, replacement, timeout,
  and output-limit descriptions. Optional task prompts and review examples show
  scoped requests without requiring another runtime abstraction.

### Fixed

- Independent tool operations no longer wait behind unrelated resource
  conflicts. Conflicting operations keep their order, and cancellation settles
  all started effects before releasing batch ownership. Exact edits avoid
  Unicode-normalization work; paged reads avoid splitting the entire file into
  line objects.
- Legacy JSONL conversion batches durable writes only inside its private staged
  database, then validates the complete journal before publishing it. Ordinary
  session appends retain their per-commit durability.
- Long conversation hooks use bounded per-message validation and one aggregate
  byte budget instead of exhausting one small-object budget across all messages.
  Source-mode plugins reuse host module identities while their own code and
  relative helpers still refresh with each generation.
- Plugin filters honor empty selections and explicit include patterns, including
  single-file plugins. The resource selector preserves canonical filters when
  toggling contributions. Malformed manifests fail instead of loading nearby
  code; duplicate package paths activate only once. Configuration writes update
  the schema metadata without rewriting files during read-only discovery.
- Auto-discovered package entrypoints honor existing disable filters. Local
  plugin commands can run without selecting a model; explicit model selection
  and commands that request a model turn still validate their requirements.
- Context hooks and SDK preparation retain message ownership through filtering,
  reordering, and edits without borrowing another message's provider state.
  Temporary context identities do not enter saved messages or ordinary history.
- SQLite replay preserves the original failure when the database has already
  rolled back automatically, while successful replay still requires a commit.
- Historical tool calls without a displayed result no longer appear queued or
  running. Active host questions show that input is required, while custom
  plugin activity indicators retain their ownership.
- Plugin starter instructions install the complete released package graph.
  Author inspection and verification reuse package resolution instead of
  carrying an unreachable fallback or resolving the same input twice.
- Plugin-enabled model calls normalize tool schemas across the public provider
  boundary, so internal TypeBox metadata does not reject valid tool definitions.
- CLI plugin tools use the session-owned context while an active run advances
  the journal, avoiding false stale-branch errors during tool execution.
- Transcript loading and tool expansion no longer construct editor/status rows
  that were immediately discarded for every history item.
- Inspection tracks the final accepted plugin system-prompt replacement,
  including its size and owner, without exposing instruction text.
  It also identifies configured authorization gates and recognized terminal
  reasons without predicting permissions or exposing stored error bodies.
- HTTP plugin refresh retains live run and presentation subscriptions. Clients
  can fence reconnect cursors with the stream identity to detect reopened sessions.
- Standalone tool replacement preserves executable and rendering metadata
  without requiring a plugin host. Manual compaction releases its busy
  state before completion listeners run.
- Corrected real-terminal header validation and composer cursor width, and
  rejected malformed model-configuration comments instead of silently repairing
  invalid JSON tokens.
- Selected custom tools remain in the system prompt when their optional prompt
  snippet is absent. Plugin-author refresh checks now report candidate disposal
  failures instead of returning a successful cleanup result.
- Reused SDK tool definitions execute with the receiving session's workspace,
  runner, and thread identity. Standalone callbacks keep their explicit source
  binding; plugin-owned callbacks retain their original generation guard.
- HTTP clients can recover committed history after an event replay gap or
  reopening a saved session through bounded, snapshot-checked entry pages.
  Display responses omit opaque provider continuation fields and redact secrets
  without modifying stored session data.

## [0.1.1] - 2026-09-02

### Added

- Added bounded durable jobs and host-owned child sessions with persisted
  identity, private V4 journals, lifecycle control, and explicit restart
  reattachment while keeping orchestration policy extension-owned.
- Added opt-in generation-owned facets for worker, session, presentation, and
  rich-TUI roles, with typed bounded wire services and named replicated JSON
  state. Portable presentations expose retained snapshots and validated actions
  across supported host adapters.
- Expanded the public terminal authoring surface with safe math rendering and
  parser access, richer scroll/list/settings controls, stable image identity,
  terminal-sequence helpers, capability overrides, and main-screen renderer
  handoff without introducing a second extension system.

### Fixed

- Managed npm packages now retain their complete runtime dependency closure,
  activate prepared copies before commit, and recover interrupted atomic swaps
  without discarding the previous installation.
- Reduced rich-TUI stalls during tool updates and `Ctrl+O` expansion with
  bounded renderer and transcript caches plus idle detail prewarming. Cache-hit
  status now omits compaction activity instead of presenting a misleading rate.
- Hardened durable jobs, child sessions, replicated state, portable
  presentations, wire services, and their malformed-input tests with explicit
  boundary contracts while preserving their public protocols and limits.

## [0.1.0] - 2026-08-31

### Added

- Exact session model scopes are available through `--models`,
  `/scoped-models`, `enabledModels`, `modelThinkingLevels`, direct session
  methods, and callback-scoped extension snapshots. Model cycling respects the
  active scope, scopes survive runtime replacement without rewriting global
  configuration, and interactive `/fork` and `/clone` expose existing journal
  branch operations.
- RPC includes `cycle_model` and `clear_queue`, with matching typed-client
  methods. `/import` can request a path when one is not supplied, and cancelling
  session or fork selection exits quietly.
- The rich TUI uses one retained alternate-screen renderer with bounded
  transcript search, Mermaid code-block rendering, automatic or persistent
  scrollbars, configurable copy-on-selection, and an opt-in structured pointer
  contract for extension components. Tool lifecycle panels use subtle neutral
  backgrounds, while failures remain background-free with explicit error text
  and glyphs.
- Direct extensions can observe outer blocking UI prompt spans, inspect
  `scopedModels`, and declare subscription-backed OAuth. Named OAuth refresh
  callbacks receive the requesting operation's cancellation signal.
- Callback model registries expose one-shot authenticated `complete()` through
  the active host model runtime. Calls inherit callback and generation
  cancellation without entering the agent loop or recursively emitting
  provider lifecycle hooks.
- Trusted extensions can publish generation-owned same-process services by
  exact reference while keeping the shared event bus JSON-safe. Callback
  contexts also expose Promise-returning message delivery bound to the exact
  live session that created the callback, so background results cannot silently
  follow a later session rebind.
- The executable extension capability matrix is compile-time exhaustive across
  factory, callback, command, and UI members as well as all six host modes.
- `SessionManager.openSnapshot()` is a supported writer-lease-free,
  point-in-time reader and now returns the mutation-free
  `ReadonlySessionManager` contract.
- Tool lifecycle events expose arguments once at execution start; progress and
  completion retain only call identity and their phase-specific result fields
  across direct extensions, SDK events, JSON, and RPC.
- Direct prompt admission is FIFO, signal-aware, and bounded by operation count
  plus detached text, model, tool-filter, and image input. Replacement close
  cancels active and queued preflights. Durable `nextTurn` messages use the same
  aggregate run-message limits plus a 12 MiB custom-metadata ceiling before
  commit and during restore, including undelivered leased work.
- RPC history paging reuses one invalidation-aware context snapshot and clones
  only the selected page. RPC extension UI now bounds unanswered dialogs,
  retained status/widget owners, and backpressured presentation records while
  coalescing keyed state to its newest queued value.
- Automatic skill discovery is limited to ohm-owned roots. Neutral `.agents`,
  Claude, and Codex skill roots remain available only through explicit
  configuration, command-line paths, or the public opt-in helper API.
- Session Atlas presents only the active journal's bounded lineage tree, with
  filtering, folding, labels, checkout, summarized checkout, linked branches,
  and named snapshots. Saved-session discovery and switching remain in
  `/resume`.
- The optional specialist-delegation extension demonstrates named profiles,
  bounded parallel child processes, JSON event streaming, cancellation, result
  composition, and presentation through ordinary tools and managed processes.
  Core has no subagent scheduler, handles, events, journal type, or UI semantics.
- Session discovery uses a private, versioned, rebuildable catalog snapshot so
  repeated pages and searches stat journals but parse only new or changed
  files; journals remain the sole source of truth.
- The optional MCP stdio extension owns protocol, transport, discovery,
  allowlisting, credentials, catalog replacement, and server lifecycle while
  publishing selected definitions through ordinary tool registrations. It
  covers pagination, `tools.list_changed`, cancellation, malformed frames,
  process failure, and refresh cleanup without an MCP-aware core registry.
- The full rich TUI accepts deterministic, keyed plain-text extension
  contributions at four stable session slots around the editor. Registration,
  updates, replacement, disposal, ordering, line count, byte size, and aggregate
  retention are bounded; line, RPC, serve, SDK, and other headless surfaces
  report the capability unavailable instead of pretending to render it.
- The full rich TUI also supports generation-owned named extension routes for
  bounded dashboard and specialist screens while the host retains composer,
  status, focus, navigation chrome, and terminal ownership.
- Durable custom entries and messages written by path-loaded extensions retain
  their owning generation's source identity, plus package provenance when it is
  known, without changing the V4 journal node vocabulary.
- Plugin registrations return one callable, idempotent disposal handle with
  exact-registration ownership and automatic generation teardown.
- RPC extension UI distinguishes cursor-relative `paste_editor_text` from
  whole-draft `set_editor_text` requests.
- Plugin UI contexts expose a frozen per-host capability map so packages can
  negotiate dialogs, editor controls, terminal components, overlays, and other
  presentation surfaces without probing no-op fallbacks.
- The extension examples have an outcome-oriented catalog, a typed and locally
  tested starter, and a tool-rendering example that composes the real built-in
  Read tool.
- Fullscreen transcript layout indexes cached entry chunks before materializing
  only the visible row window, and an unchanged same-session refresh preserves
  its projected transcript and scroll anchor.
- Long-session appends project only their newly committed canonical entry, and
  idle/recovery checks use bounded recovery metadata instead of cloning the
  complete durable session state.
- Rich session-picker searches coalesce short typing bursts while line and
  accessibility interaction remains immediate. Plugin authoring guidance
  asks the user to run `/refresh` after ordinary resource changes.
- Plugin tool schemas accept valid TypeBox optional and readonly metadata.
- RPC extension paste requests remain cursor-relative without claiming that the
  bridge can read client-owned editor state.

- Kimi Code is a first-class provider with its current four maintained coding
  models, membership API-key authentication, device account login, schema
  normalization, session affinity, and visible streamed reasoning.
- Native account login is available for ChatGPT/Codex, Anthropic, GitHub
  Copilot, Kimi Code, xAI, and OpenRouter. Login discovery is aligned across
  TUI, print, JSON, RPC, serve, SDK, and embedding hosts, and the public models
  API can represent provider-account credential acquisition directly.
- The reasoning control contract is limited to provider-accepted levels through
  `max`. Standalone Bedrock transports preserve signed and redacted
  continuation state while exposing only provider-approved reasoning summaries.

- Interactive, print, JSON, RPC, loopback serve, SDK, and embedding hosts share
  one agent runtime and one generation-owned extension harness.
- V4 session journals preserve operations, queued steer and follow-up messages,
  tool effects, branches, checkpoints, compaction state, and crash recovery.
  Active-run submissions appear immediately and reconcile once with their
  durable queue records.
- The terminal provides one rich viewport for streaming text, public reasoning,
  the seven built-in tools, extension surfaces, compaction receipts, and a
  compact status dock. Scroll anchors and gutter backgrounds keep filled rows
  aligned, and transient run notices do not displace durable transcript rows.
  The hardware cursor is visible by default, with explicit setting and
  environment opt-outs. Thinking is visible by default, and `Ctrl+T` toggles
  active or completed visible reasoning while the active header remains visible. A successful
  transcript selection copy clears its highlight and shows a short-lived popup;
  a failed copy keeps the selection visible and reports a warning. Up/Down navigation wraps through
  slash commands, and model or reasoning changes made during a response apply
  atomically to the next accepted operation, including a queued follow-up,
  without relabeling the request already in flight. Overlapping model choices
  are generation-owned so only the latest selection can publish, persist, or
  notify. Built-in slash commands respond during an active turn: run-safe
  commands execute directly,
  while session-changing commands cancel and recover the exact local operation
  before executing. Atlas navigation cancels only after a target is selected,
  and sessions blocked by an uncertain tool effect still open or resume before
  configured model selection so explicit recovery remains reachable. The
  bare `/recover` retries safe recovery before abandoning any remaining blocked
  effects without replay; it does not start a model turn, and the next prompt
  carries an explicit unknown-outcome warning. Print and JSON replacement
  sessions recover before their next prompt, while public SDK factories preserve
  the interrupted model and thinking selection and defer a differing request
  until explicit recovery succeeds.
- Running Write cards offer `Ctrl+O` when earlier bounded source is retained
  and expand immediately to their retained head and tail. Running Edit cards
  remain header-only while collapsed and expose only complete bounded
  replacement previews when expanded. Completed Write cards show the first
  three retained source rows and offer `Ctrl+O` when additional bounded source
  is available. Read, Bash, Grep, Find, ls, Edit, extension, startup, skill,
  summary, and Markdown views apply honest retained-detail bounds before
  terminal wrapping. Collapsed tool cards keep one expansion affordance as
  their final detail row.
- Buffered provider streams yield by event count and elapsed processing time,
  while 16-millisecond frame-start pacing and retained native Markdown/tool
  prefix layout keep long-session rendering, scrolling, steering, queue
  visibility, and turn cancellation responsive. Active work has a bounded
  animated phase row; completed tool headers color only their success tick.
- Output-aware compaction preserves recent complete turns and tool pairs. A
  final provider projection that exceeds its budget after system and extension
  processing receives one bounded automatic compaction and same-step
  reprojection before a closed failure.
- Built-in tools share one coordinator for schema validation, interception,
  authorization, resource scheduling, cancellation, recovery, observability,
  bounded result projection, and all-results termination semantics.
- Trusted extensions can define tools, providers, commands, flags, shortcuts,
  renderers, themes, skills, prompt templates, lifecycle hooks, shared events,
  managed processes, resource discovery, and rich UI components through public
  package exports.
- Plugin activation is transactional: candidate listeners, shared-event
  emissions, tools, UI ownership, processes, and disposers remain private until
  commit. Rollback publishes nothing; successful publication is deterministic;
  refresh and shutdown dispose only the owning generation.
- Plugin JSON boundaries use detached, descriptor-safe, pre-bounded
  snapshots. Proxies, accessors, custom prototypes, cycles, sparse arrays,
  inherited serializers, and structurally oversized graphs fail without
  executing owner-controlled code. Live local and supplied-bus payloads use the
  same boundary, including arbitrary bounded topics such as `error`.
- Direct and SDK tool guards support exact plain-data allow or block decisions,
  bounded reasons, and a blocked-result termination hint. Session switch and
  fork guards fail closed on malformed decisions; tree and compaction reducers
  isolate malformed transforms and continue with later valid listeners.
- Public provider extensions receive bounded request, tool-schema, stream,
  continuation-state, diagnostics, usage, and terminal-content adapters in both
  translation directions. Protocol lifecycle, indexes, cardinality, field
  sizes, tool arguments, and terminal reconciliation are validated before use.
- Rich TUI ownership is source- and generation-specific. Print, JSON, and serve
  expose headless UI fallbacks; RPC exposes its documented structural dialog
  and presentation bridge; SDK and embedding hosts retain the same session,
  command, recovery, and authorization lifecycle without terminal-only APIs.
- Reviewed model metadata keeps total context, generated-output, and published
  input ceilings as independent values. Live discovery is authoritative, while
  dynamic or unpublished limits remain unknown instead of being inferred.
  Missing or malformed context metadata uses a conservative 128,000-token
  execution budget without fabricating catalog metadata.
- Effective output ceilings apply to ordinary turns, compaction, and branch
  summaries. Chat Completions routes use each service's documented output-limit
  field, and model switches do not carry an absent output limit forward.
- Twelve built-in provider identities support API-key and subscription sign-in,
  live model discovery, reasoning levels, retry policy, SSE streaming, and
  explicit transport controls.
- OpenCode Go has an independent provider and stored credential identity,
  `OPENCODE_GO_API_KEY` followed by the documented shared environment fallback,
  authenticated availability filtering, reviewed model limits, and explicit
  per-model Responses, Messages, or Chat Completions routing. Its Kimi Chat
  routes supply Moonshot-required property types on a detached tool-schema wire
  copy, so valid enum-only extension schemas remain usable without changing
  non-Kimi requests.
- OpenAI Codex `auto` transport starts with a cached WebSocket, falls back to
  full-context HTTPS/SSE after eligible pre-output transport failures, and
  keeps the session, endpoint, and account identity on SSE after a successful
  fallback or a semantic-boundary failure, with at most 1,024 recent identities
  retained for the adapter lifetime. Failures already classified as
  authentication errors and provider-declared response failures are not replayed
  across transports;
  an SSE fallback that fails before a successful terminal does not pin the
  identity.
  Valid empty lifecycle placeholders remain replay-safe; visible text or
  summary reasoning, hidden provider reasoning, tool drafts, and malformed,
  unknown, or opaque state are not replayed. HTTP body disconnects receive one
  retry only before semantic output. The configured HTTP response-idle limit
  also governs Codex WebSocket response messages. Explicit SSE and strict
  WebSocket modes remain available.
- Local Codex transport diagnostics expose only transport choice, cached-socket
  reuse, fallback state, bounded failure class and output boundary, partial-output
  state, a validated numeric close code, and an allowlisted native transport
  code when available; request content, credentials, URLs, headers, bodies,
  close reasons, and session IDs stay excluded.
- Stored credentials use Linux Secret Service, macOS Keychain Services, or a
  Windows DPAPI-protected envelope with fail-closed backend pinning. OAuth
  library consumers can inject their own store, while the interactive product
  uses the platform-backed credential broker and bounded cross-process locks.
- Global and trusted-project configuration share one versioned schema. Trusted
  extensions receive bounded compare-and-swap configuration and
  generation-owned processes; `/refresh` applies resource changes to the
  current session.
- Local metadata-only logs, metrics, crash reports, and diagnostic bundles are
  bounded, private, redacted, and separate from V4 session content. `ohm
  stats` summarizes aggregate snapshots without opening session history.
- Ready-made terminal, interactive, print, and RPC surfaces redact registered
  secrets from human diagnostics and structured dispatcher failures without
  changing their public severity, event, command, identifier, or response
  fields.
- Plugin package archives and HTML or JSONL session exports create complete
  private files exclusively and refuse existing paths, links, or partial
  publication. Bare `npm:file:` archives retain a validated source-to-package
  identity, recover compatible pre-receipt installs, and remain discoverable
  when multiple archives are configured. Conflicting sources that declare one
  package name fail before replacement. Standalone HTML keeps embedded and
  downloadable V4 payloads byte-exact and does not load external image
  references.
- Static Bash, Zsh, and Fish completions derive from the CLI command catalog
  without starting the runtime. The `ohm-dev` skill documents configuration,
  extensions, internals, testing, and release operation.
- Release artifacts include four npm-compatible package archives, six locked
  standalone runtimes, a source archive, checksums, an SPDX SBOM, attestations,
  and verified install, update, and uninstall scripts. Production dependency
  graphs and installed bytes are checked independently on every target.

- The maintained catalog contains 152 current models across nine of the 12
  built-in provider identities; the other identities use provider-specific or
  live catalogs. Provider-owned protocol, context, output, pricing, modality,
  caching, and reasoning evidence is kept distinct from unknown capabilities.
- Compaction removes only stale pre-compaction local errors, retains errors
  emitted while the summary is running, and reports unavailable cache-read
  telemetry without inventing a zero value. Final system and extension context
  rewrites retain a valid provider usage baseline without crediting removed
  messages toward new content. The TUI keeps prompt `in`, generated `out`, and
  context occupancy concise without qualifier or compaction-policy glyphs.
  `last cache` reflects the newest completed non-summary model request:
  explicit cold zero stays `0.0%`, omitted telemetry is `n/a`, and exact and
  reported aggregate counters remain available through the session interfaces.

- OAuth menus expose only usable authentication paths. Direct and compatibility
  provider registries expose the same usable methods, and login cancellation
  cannot persist a late credential.
- Automatic tool reconciliation durably claims an external recovery attempt
  before invoking it, validates bounded results before settlement, and cannot
  replay a reconciler after process death. Manual SDK recovery applies the same
  tool-result bounds.
- Failed or pre-aborted extension refresh generations are quarantined instead
  of remaining partially active, and HTTP serve prompt admission is bounded,
  FIFO, cancellable, and drained during shutdown.
- Completed nonzero, timeout, signal, and cancellation Bash outcomes retain
  their exit state, output bounds, and spill artifact metadata through session
  events, journaling, SDK calls, and RPC.
- Sparse live model catalogs remain usable in memory without being serialized
  into an invalid persistent cache.

- Built-in refresh, revocation, and GitHub Copilot enterprise-host routing pin
  trusted endpoints and client metadata instead of trusting mutable stored
  credential fields. Authentication-state errors pass through secret
  redaction.
- Provider-private Responses reasoning text stays out of public events while
  explicit summaries and provider-documented public reasoning from Kimi,
  DeepSeek, xAI, and Ollama remain visible and replayable.
