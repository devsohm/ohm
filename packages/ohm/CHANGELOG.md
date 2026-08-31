# Changelog

## Unreleased

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
- Extension registrations return one callable, idempotent disposal handle with
  exact-registration ownership and automatic generation teardown.
- RPC extension UI distinguishes cursor-relative `paste_editor_text` from
  whole-draft `set_editor_text` requests.
- Extension UI contexts expose a frozen per-host capability map so packages can
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
  accessibility interaction remains immediate. Extension authoring guidance
  asks the user to run `/refresh` after ordinary resource changes.
- Extension tool schemas accept valid TypeBox optional and readonly metadata.
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
- Extension activation is transactional: candidate listeners, shared-event
  emissions, tools, UI ownership, processes, and disposers remain private until
  commit. Rollback publishes nothing; successful publication is deterministic;
  refresh and shutdown dispose only the owning generation.
- Extension JSON boundaries use detached, descriptor-safe, pre-bounded
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
- Extension package archives and HTML or JSONL session exports create complete
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
