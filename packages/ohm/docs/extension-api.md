# Direct extension API

A direct extension is a trusted in-process factory:

```ts
import type { ExtensionAPI } from "ohm/extensions";

export default function activate(ohm: ExtensionAPI): void {
  // Register this generation's contributions.
}
```

The host creates a new factory object for each activation. Every method checks its activation generation. Do not keep this object across a refresh. Also, do not keep a callback context, UI component, model-registry view, or session-manager projection across a refresh.

![Extension generation lifecycle and capability flow](assets/extension-lifecycle.svg)

## Activation, refresh, and disposal

Activation is transactional. Registrations become live only after the factory completes successfully. An error, timeout, or cancellation discards the candidate generation. Activation and module loading each have a normal 30-second limit.

`onDispose(callback)` registers extension-owned cleanup. Cleanup callbacks:

- run once in reverse registration order;
- run after the generation API has become stale;
- continue after one callback fails;
- may be asynchronous;
- must not call the stale `ExtensionAPI`.

Use disposal for resources that the extension creates. These resources include timers, watchers, sockets, raw child processes, and temporary files. The host removes commands, tools, listeners, providers, renderers, shortcuts, flags, UI mounts, and processes started through `ohm.processes`.

The normal shutdown budget is five seconds for each cleanup phase. A timed-out callback is diagnosed while the host continues with the remaining cleanup phases, so cleanup should also own an internal bound.

Refresh is also transactional:

1. the active generation receives `session_shutdown` with reason `refresh`;
2. the host prepares settings, resources, and a candidate generation;
3. a preparation or factory failure disposes the candidate and rebinds the
   previous generation;
4. successful preparation publishes the candidate resource generation;
5. the published generation receives `session_start`;
6. a post-publication `session_start` failure disables and closes that
   incomplete generation. The previous resource generation is no longer a
   rollback target, so recovery requires a refresh that publishes a fresh
   generation.

Repeated refresh must not duplicate any resource.

The focused `ohm/extensions` entrypoint exports the named authoring contracts
used below. Command registration uses `CommandOptions` and `CommandCompletion`;
session replacement uses `ReplacementOptions`, `ForkOptions`,
`NavigateTreeOptions`, and `SwitchSessionOptions`; event registration uses
`ExtensionEventMap` and `ExtensionEventResultMap`; and tool resource callbacks
use `ToolContext`. Configuration, provider, delivery, shortcut, flag, and footer
option types are exported from the same entrypoint. Durable stored message and
label shapes remain on `ohm/storage`.

The public event and result maps are composed from independent trust/resource,
session, conversation, provider, interaction, and tool domains. Those domain
modules are declaration implementation details, not package subpaths; extension
authors use only the composed names exported by `ohm/extensions`.

## Top-level methods

The complete `ExtensionAPI` surface is:

| Member | Return | Contract |
| --- | --- | --- |
| `onDispose(callback)` | `ExtensionRegistrationHandle` | Register generation cleanup. |
| `on(event, handler)` | `ExtensionRegistrationHandle` | Register one typed event listener. |
| `registerTool(tool)` | `ExtensionRegistrationHandle` | Register or replace this extension's tool by name. |
| `registerCommand(name, options)` | `ExtensionRegistrationHandle` | Register a slash command. |
| `registerShortcut(shortcut, options)` | `ExtensionRegistrationHandle` | Register a TUI keybinding. |
| `registerFlag(name, options)` | `ExtensionRegistrationHandle` | Declare a boolean or string CLI flag. |
| `getFlag(name)` | `boolean \| string \| undefined` | Read the parsed value or declared default. |
| `registerMessageRenderer(customType, renderer)` | `ExtensionRegistrationHandle` | Render live and resumed custom messages. |
| `registerMarkdownTransformer(transformer)` | `ExtensionRegistrationHandle` | Transform ordinary transcript Markdown for display only. |
| `registerEntryRenderer(customType, renderer)` | `ExtensionRegistrationHandle` | Render durable custom JSONL entries. |
| `sendMessage(message, options?)` | `void` | Add or deliver a custom model-context message. |
| `sendUserMessage(content, options?)` | `void` | Submit or queue user content. |
| `appendEntry(customType, data?)` | `void` | Append a JSON-safe custom session entry. |
| `setSessionName(name)` | `void` | Append a session-name change. |
| `getSessionName()` | `string \| undefined` | Read the effective session name. |
| `setLabel(entryId, label)` | `void` | Add, replace, or clear an entry label. |
| `exec(command, args, options?)` | `Promise<ExecResult>` | Run an executable with an argv array, without a shell. |
| `config` | `ExtensionConfigStore` | Read or compare-and-swap the extension's user or workspace configuration. |
| `processes` | `ExtensionProcessService` | Start and control generation-owned asynchronous processes. |
| `getActiveTools()` | `string[]` | Snapshot active tool names. |
| `getAllTools()` | `ToolInfo[]` | Snapshot all registered tool metadata. |
| `setActiveTools(names)` | `void` | Select available names; unknown names are omitted by the session. |
| `getCommands()` | `SlashCommandInfo[]` | Unified invokable extension-command, prompt-template, and skill-command catalog. |
| `getDiscoveryView(signal?)` | `Promise<DiscoveryView>` | Bounded callback-free metadata for commands, prompts, and skills. |
| `setModel(model)` | `Promise<boolean>` | Select a model for the session without rewriting the configured default; returns `false` when no model registry or runnable provider adapter exists. |
| `getThinkingLevel()` | `ThinkingLevel` | Read `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `setThinkingLevel(level)` | `void` | Select a supported level, clamping through the session's model policy. |
| `registerProvider(provider)` | `ExtensionRegistrationHandle` | Install a complete `@ohm/models` provider for this generation. |
| `registerProvider(id, config)` | `ExtensionRegistrationHandle` | Compose a provider configuration. |
| `unregisterProvider(id)` | `void` | Remove this generation's provider registration early. |
| `events.on(channel, handler)` | `ExtensionRegistrationHandle` | Subscribe to the process-local extension topic bus. |
| `events.emit(channel, data)` | `void` | Emit on that topic bus. |

Each `getAllTools()` entry contains `sourceInfo`. Extension tools keep their resolved package path, source, scope, and
origin. Built-in and caller-owned tools use temporary synthetic sources named `<builtin:name>` and `<host:name>`.

`ExtensionRegistrationHandle` is callable and also exposes `dispose()` plus a
readonly `disposed` flag. Both invocation forms remove only that exact
registration and are idempotent. Disposing an older handle after a same-name
replacement cannot remove the replacement. Generation teardown still removes
all remaining registrations automatically and marks their handles disposed.

`sendMessage` accepts `{ customType, content, display, details? }`. `details` and durable custom-entry data must be JSON-safe. `deliverAs` can be `steer`, `followUp`, or, for custom messages, `nextTurn`. `triggerTurn: true` starts a turn when idle.

The durable `nextTurn` backlog uses the ordinary run-message limits: at most
100 messages, 1 MiB of text, 64 MiB of image source data, and 12 MiB of custom
metadata. The bound includes messages leased to an active run until they
materialize in the journal. A new message is validated before its `queue_added`
record is committed, and opening a journal rejects an oversized restored
backlog instead of partially loading it.

For path-loaded extensions, the host records an optional immutable `provenance`
object with durable custom entries and messages. Schema version `1` contains the
owning `extensionId` and loaded `sourceSha256`; integrity-resolved packages also
include `packageVersion`, `packageContentSha256`, and `manifestSha256` when those
values are known. Extensions do not supply this identity. Loose files never
receive invented package fields, and historical records without provenance
remain valid.

`sendUserMessage` sends literal user content by default. Pass
`{ expandPromptTemplates: true }` to opt into the host's extension-command,
skill-command, and prompt-template dispatcher. `deliverAs` remains available
for steering or follow-up delivery while a run is active.

Top-level send methods schedule asynchronous delivery and return immediately. They report neither admission nor model completion. Delivery failures become extension diagnostics.

`exec` accepts `{ cwd?, signal?, timeout? }`. The `timeout` value is in milliseconds. Its default is 600,000, and its valid range is 1 through 3,600,000. The output limit is 8 MiB. The result is `{ stdout, stderr, code, killed }`.

### Managed asynchronous processes

Use `ohm.processes` when the extension must return immediately, report status,
exchange framed standard input/output, or keep a worker alive across callbacks.
`spawn(spec)` returns an opaque `process_…` ID synchronously. It never returns a
PID or `ChildProcess`.

The service provides `status`, `subscribe`, `read`, `write`, `closeInput`,
`wait`, and idempotent `cancel`. Status snapshots expose state, elapsed time,
total standard-output and standard-error bytes, retained bytes, truncation,
and the terminal exit result. Status listeners are generation-owned, receive
coalesced immutable snapshots, and do not carry output bytes.

`spec.argv` is always an argv array and never runs through a shell. The working
directory defaults to the canonical workspace, the environment is inherited by
default, and `inheritEnv: false` selects only the supplied `env` record. Windows
batch wrappers are rejected; invoke scripts through a fixed interpreter.
`timeoutMs` is optional and can be at most 24 hours. A caller signal, explicit
cancellation, refresh, or host close terminates the complete owned process tree.

Each output stream selects `capture`, `pipe`, or `ignore`. Capture retains a
prefix of 256 KiB by default and accepts `captureLimitBytes` up to 2 MiB per
stream; total byte counts remain authoritative when the prefix is truncated.
Pipe mode is lossless and backpressured. `read` returns at most 64 KiB and allows
one pending read per stream. A write accepts at most 64 KiB and the process input
queue accepts at most 256 KiB and 64 operations, including the active OS-pipe
write. Aborting a queued caller stops its wait immediately and prevents that
operation from reaching the OS pipe. Its queue slot remains until preceding
writes settle and the aborted operation reaches its turn; bytes already delivered
cannot be retracted. `closeInput` is idempotent and accepts an optional waiter
signal.

One generation can run four processes and one host can run sixteen. Terminal
records are retained only within bounded generation, host, and byte limits, so
an old ID can eventually become unknown. A generation can own at most 64 status
subscriptions. Spawning is rejected while activation is staged; start workers
lazily from a callback after commit. Managed processes are in-memory runtime
resources: they are cancelled on refresh or close and never survive or reattach
after a host restart. The service does not persist a job mailbox or deliver a
result to the model automatically.

### Extension-owned protocol bridges and delegated agents

There is no protocol-specific registry or child-agent service in this API.
Both integrations are ordinary trusted extensions composed from
`registerTool`, `processes`, lifecycle callbacks, configuration, and optional
renderers.

An MCP bridge owns framing, negotiation, discovery, authentication, server
lifecycle, allowlisting, and catalog refresh. It starts a bounded transport
through `ohm.processes`, validates discovered definitions, and publishes each
selected model-facing tool through `registerTool`. Registration handles let the
extension replace or retire its own tool set without a protocol-aware core API.
The tested [`mcp-stdio` example](../examples/mcp-stdio/README.md) implements that
complete boundary.

A specialist-delegation extension owns its profiles, orchestration, limits,
child invocation, streamed event parsing, cancellation, result composition,
and presentation. It can launch an ephemeral ohm JSON-mode process through
`ohm.processes` and expose the workflow as one ordinary registered tool. The
host contributes only the generic process and tool contracts. See the tested
[`subagent-specialists` example](../examples/subagent-specialists/README.md).

`DiscoveryView` is:

```ts
interface DiscoveryView {
  resources: Array<
    | {
        kind: "command";
        source: "builtin" | "runtime_extension" | "extension_template";
        name: string;
        extensionId?: string;
        description?: string;
        argumentHint?: string;
        syntax?: string;
      }
    | { kind: "prompt"; name: string; extensionId: string; description?: string; argumentHint?: string }
    | {
        kind: "skill";
        name: string;
        description: string;
        scope: "user" | "workspace";
        trusted: boolean;
        disableModelInvocation: boolean;
      }
  >;
  truncated: boolean;
  omitted: { commands: number; prompts: number; skills: number };
}
```

Each discovery snapshot includes at most:

- 512 commands;
- 512 prompts;
- 512 skills.

`truncated` and the per-kind `omitted` counts report anything beyond those bounds.

The shared topic bus is neither durable nor cross-process. Its handlers receive `unknown`, and rejected handler promises are reported rather than propagated to `emit`. The function returned by `events.on()` unsubscribes early; generation disposal also removes the listener. During factory activation, subscriptions and emissions are transactional: successful commit registers listeners before delivering snapshotted JSON-safe emissions in call order, while rollback publishes nothing. This staging queue accepts at most 1,024 emissions, 1 MiB per payload, and 4 MiB in aggregate. Every factory-time or live emission is a detached, descriptor-only plain-JSON snapshot limited to 1 MiB, 8,192 values, 4,096 containers, and 59 nested levels. Accessors, symbols, custom prototypes, and cycles are rejected before serialization. Payloads arriving from a supplied event bus pass through the same snapshot boundary before a handler runs; the queue-count and aggregate-byte limits apply only during activation.

## Callback context

Ordinary event handlers, tools, and shortcuts receive `ExtensionContext`:

| Member | Type or result |
| --- | --- |
| `ui` | `ExtensionUIContext` |
| `mode` | `"tui" \| "rpc" \| "json" \| "print" \| "serve" \| "sdk"` |
| `hasUI` | `boolean` |
| `cwd` | Canonical active workspace path |
| `paths.userData` | Extension-owned durable cross-workspace directory |
| `paths.workspaceData` | Extension-owned durable directory isolated to the canonical workspace |
| `sessionManager` | `ReadonlyExtensionSessionManager` |
| `modelRegistry` | `ExtensionModelRegistry` |
| `model` | Current `Model<Api> \| undefined` |
| `scopedModels` | Available scoped entries as `{ model: Model<Api>, thinkingLevel?: ThinkingLevel }[]` |
| `thinkingLevel` | Current `ThinkingLevel` |
| `signal` | Current callback/run signal, when one exists |
| `isIdle()` | Whether the session has no active prompt or branch-summary operation |
| `isProjectTrusted()` | Current project-trust decision |
| `abort()` | Cancel current agent work |
| `hasPendingMessages()` | Whether user steering/follow-up input is queued |
| `shutdown()` | Request host shutdown |
| `getContextUsage()` | `{ tokens, contextWindow, percent } \| undefined`; tokens and percent can be `null` |
| `compact(options?)` | Start compaction with optional instructions and completion/error callbacks |
| `getSystemPrompt()` | Current built system prompt |

`compact()` is callback-based and returns `void`. Use `onComplete` and `onError`; do not assume a compaction has finished when the call returns.

`scopedModels` is a callback snapshot of the active session scope. A later callback observes changes made by
`/scoped-models`. With no configured selectors, it contains every currently available model. Selectors use exact
`provider/model` references. Provider components are 1–128 UTF-8 bytes; model IDs are 1–512 UTF-8 bytes and may
contain further slashes. Whitespace, control characters, and `*`, `?`, `[`, `]`, `{`, and `}` are rejected; a scope
contains at most 1,024 selectors.

### Host-managed extension configuration

Every direct factory receives `ohm.config`, with one bounded JSON document in
its user data root and one in its workspace data root. This is separate from the
main `config.json` settings system. `ohm/extensions` also exports
`createExtensionConfigStore()` for embedding hosts that construct the same
primitive explicitly.

Every replacement or removal requires the `revision` returned by `read()`.
Conflicting writers receive `ExtensionConfigConflictError` instead of silently
overwriting one another. Documents are limited to 64 KiB; snapshots are cloned
and deeply frozen; writes use private files, a file lock, and atomic replacement.

The complete store signature is:

```ts
import type { JsonValue } from "ohm";

type ExtensionConfigScope = "user" | "workspace";

interface ExtensionConfigSnapshot {
  readonly revision: string | null;
  readonly value: JsonValue | undefined;
}

interface ExtensionConfigReadOptions {
  readonly signal?: AbortSignal;
}

interface ExtensionConfigWriteOptions extends ExtensionConfigReadOptions {
  readonly expectedRevision: string | null;
}

interface ExtensionConfigStore {
  read(
    scope: ExtensionConfigScope,
    options?: ExtensionConfigReadOptions,
  ): Promise<ExtensionConfigSnapshot>;
  replace(
    scope: ExtensionConfigScope,
    value: JsonValue,
    options: ExtensionConfigWriteOptions,
  ): Promise<ExtensionConfigSnapshot>;
  remove(
    scope: ExtensionConfigScope,
    options: ExtensionConfigWriteOptions,
  ): Promise<ExtensionConfigSnapshot>;
}
```

An absent document is `{ revision: null, value: undefined }`; JSON `null` is a
present value. Validate and bound `snapshot.value` against the extension's own
schema before using it. Pass the callback signal through every operation and use
the exact observed revision for one compare-and-swap attempt:

```ts
import type { JsonValue } from "ohm";
import { ExtensionConfigConflictError, type ExtensionAPI } from "ohm/extensions";

async function replaceWorkspaceConfig(
  ohm: ExtensionAPI,
  value: JsonValue,
  signal: AbortSignal,
) {
  const current = await ohm.config.read("workspace", { signal });
  try {
    return await ohm.config.replace("workspace", value, {
      expectedRevision: current.revision,
      signal,
    });
  } catch (error) {
    if (error instanceof ExtensionConfigConflictError) {
      throw new Error("Workspace configuration changed; read it again before retrying.");
    }
    throw error;
  }
}

async function removeWorkspaceConfig(ohm: ExtensionAPI, signal: AbortSignal) {
  const current = await ohm.config.read("workspace", { signal });
  if (current.value === undefined) return current;
  return await ohm.config.remove("workspace", {
    expectedRevision: current.revision,
    signal,
  });
}
```

Do not loop blindly after a conflict; reread, revalidate, and decide whether the
requested change still applies. Call write helpers only from a committed
callback such as a command, tool, or event handler, never during activation.

Each runtime contribution has its own stable data namespace. Contributions with
the same declared extension ID but different package-relative source entries do
not share paths or configuration. The same declared ID and relative entry remain
the same logical project-package contribution across refresh, restart, and a
package moving to another installation or workspace root.
The injected store uses the generation-lifetime signal. A staged generation can
read but cannot mutate, so factories must register contributions first and write
configuration lazily after activation commits. A stale generation can do neither.
The store does not merge
the user and workspace documents, interpret an extension schema, or provide a
credential vault. Extension configuration values are never diagnostics or
telemetry fields.

Command handlers receive `ExtensionCommandContext`, which adds:

| Method | Contract |
| --- | --- |
| `getSystemPromptOptions()` | Current system-prompt build inputs. |
| `waitForIdle()` | Wait through prompt admission, active generation, and branch summarization. |
| `newSession({ parentSession?, setup?, withSession? }?)` | Request a guarded replacement and return `{ cancelled }`. |
| `fork(entryId, { position?, withSession? }?)` | Fork `before` or `at` an entry and return `{ cancelled }`. |
| `navigateTree(targetId, { summarize?, customInstructions?, replaceInstructions?, label? }?)` | Move the current leaf and optionally summarize the abandoned branch. |
| `switchSession(path, { withSession? }?)` | Request a guarded resume and return `{ cancelled }`. |
| `refresh()` | Run transactional settings and resource refresh. |

`setup` receives the new mutable `ExtensionSessionManager` before it is exposed. `withSession` receives a frozen `ReplacedSessionContext` after rebinding. That context adds asynchronous `sendMessage` and `sendUserMessage` methods so follow-up work targets the replacement rather than the stale session.

Session replacement invalidates cwd-bound objects. After `newSession`, `fork`, or `switchSession`, use only the object passed to `withSession`; do not continue through the command's original context.

The `serve` host keeps each registered HTTP resource keyed by one immutable
session ID. Its extension-command `newSession`, `fork`, and `switchSession`
requests return `{ cancelled: true }`; use the service create/open endpoints to
obtain another registered session. In-session tree navigation and transactional
refresh remain available.

### Read-only session manager

Event, tool, and command contexts expose:

```ts
interface ReadonlyExtensionSessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getLabel(id: string): string | undefined;
  getBranch(fromId?: string): SessionEntry[];
  findEntriesOnBranch(query?: SessionBranchQuery): SessionEntry[];
  findEntryOnBranch(query?: SessionBranchQuery): SessionEntry | undefined;
  buildContextEntries(): SessionEntry[];
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
  getTree(): SessionTreeNode[];
  getSessionName(): string | undefined;
}
```

Returned entries are the public extension projection. One canonical tool batch can project as multiple public entries with derived IDs. Read this view instead of reopening and racing the active JSONL file.

`findEntriesOnBranch()` reads newest first from the active leaf by default. Its
query can select another `start` entry, use oldest-first order, stop inclusively
at an entry ID or type, filter by entry or custom type, and set a positive
`limit`. Use `findEntryOnBranch()` when only the first match is needed. Passing
`start: null` selects the empty root; an unknown explicit start ID is an error.

`SessionHeader`, `SessionEntry`, `SessionBranchQuery`, and the other types shown
above are public imports from `ohm/extensions`.

### Model registry

`ExtensionModelRegistry` exposes:

- `refresh()`, `getError()`, `getAll()`, `getAvailable()`, and `find(provider, modelId)`;
- `present(internalModel)` and `resolve(publicModel)` for the host boundary;
- `hasConfiguredAuth(model)`, `getApiKeyAndHeaders(model)`, `getApiKeyForProvider(id)`, `getProviderAuthStatus(id)`, `getProviderDisplayName(id)`, `getProviderAuth(id)`, and `isUsingOAuth(model)`;
- `getProvider(id)`, both `registerProvider` forms, `unregisterProvider`, and registration-inspection helpers.

The registration-inspection methods are `getRegisteredProviderConfig(id)`, `getRegisteredNativeProvider(id)`, and `getRegisteredProviderIds()`.

This view is generation-bound. Provider and authentication facades returned by
it have the same lifetime, including methods retained separately from those
objects. Authentication-returning methods can expose credentials to trusted
extension code; never place their values in output, session data, or errors.
Provider registration details are in [Provider authoring](provider-authoring.md).

## UI context

`hasUI` says whether dialogs can be requested. `ui.capabilities` negotiates the exact available surfaces. A missing capability map or a false member means unsupported, which keeps older custom hosts source-compatible. An extension must keep a safe headless path.

| Method or property | Contract |
| --- | --- |
| `capabilities?` | Frozen `ExtensionUICapabilities` map for exact host feature negotiation. |
| `routes` | Generation-owned named structured-component routes in the full rich TUI. |
| `slots` | Keyed, generation-owned plain-text contributions to the full TUI's stable session slots. |
| `select(title, options, { signal?, timeout? }?)` | Resolve a selected string or `undefined`. |
| `confirm(title, message, options?)` | Resolve a boolean. |
| `input(title, placeholder?, options?)` | Resolve text or `undefined`. |
| `notify(message, type?)` | Show `info`, `warning`, or `error`. |
| `onTerminalInput(handler)` | Observe/transform raw input; returns an unsubscribe function. |
| `setStatus(key, text)` | Set or remove one keyed status. |
| `setWorkingMessage(message?)` | Replace the working label. |
| `setWorkingVisible(visible)` | Show or hide it. |
| `setWorkingIndicator({ frames?, intervalMs? }?)` | Replace animation frames and cadence. |
| `setHiddenThinkingLabel(label?)` | Replace the collapsed-reasoning label. |
| `setBackground(factory?)` | Mount or remove a persistent TUI background component. |
| `setWidget(key, linesOrFactory, { placement? }?)` | Mount above or below the editor, or remove with `undefined`. |
| `setFooter(factory?)`, `setHeader(factory?)` | Replace or restore the corresponding component. |
| `setTitle(title)` | Set the terminal title. |
| `custom(factory, options?)` | Mount a component or overlay until its `done(result)` callback runs. |
| `pasteToEditor(text)` | Insert text through the active editor when `editorTextWrite` is available. |
| `setEditorText(text)`, `getEditorText()` | Replace the complete draft with `editorTextWrite`; read the current complete draft only with `editorTextRead`. |
| `editor(title, prefill?)` | Open a larger editor and resolve text or `undefined`. |
| `addAutocompleteProvider(factory)` | Wrap the current provider. |
| `setEditorComponent(factory?)`, `getEditorComponent()` | Replace/read the primary editor factory. |
| `theme` | Current `Theme`. |
| `getAllThemes()` | `{ name, path }[]`. |
| `getTheme(name)` | A theme or `undefined`. |
| `setTheme(nameOrTheme)` | `{ success, error? }`. |
| `getToolsExpanded()`, `setToolsExpanded(value)` | Read or set tool-output expansion. |

`WidgetPlacement` is the exported `"aboveEditor" | "belowEditor"` union used
by `setWidget`.

Blocking `select`, `confirm`, `input`, `editor`, and `custom` calls publish
`ui_prompt_start` and `ui_prompt_end` observer events. Nested or overlapping
calls form one outer span. These notifications are best effort and are not
awaited before the dialog opens or closes.

### Named extension UI routes

`ui.routes.register(name, { title, render })` registers or atomically replaces
one generation-owned route name. It returns an exact registration with
`open(options?)`, `dispose()`, and `disposed`. The service also provides
`open(name, options?)`, `list()`, `current()`, and `close()`. Route names match
`[a-z][a-z0-9-]{0,63}`; one generation can register at most 32 names. Titles
are single-line terminal-safe text limited to 256 bytes.

`render(routeHost)` returns a bounded `RuntimeUiComponent`, synchronously or
asynchronously. The host exposes the route name, generation-bound `signal`,
`requestRender()`, `close()`, and optional open-time `data`. Data must be plain
JSON and is detached, deeply frozen, and limited to 64 KiB, 8,192 values,
4,096 containers, and 59 nested levels. `list()` exposes only route names and
titles; `current()` also includes the active route's detached data.

Only one extension route can be active in the rich TUI. Opening another closes
and disposes the previous route, even when another extension owns it. The route
replaces the transcript region while ohm keeps the composer, status dock, and
other host chrome. The host prepends `← Title · Esc back` (with an ASCII
fallback). The component receives a key first; an unhandled Escape or `Ctrl+C`
closes the route and restores the transcript. Factory or render failure reports
a bounded warning and restores that normal view. Refresh, unload, shutdown, or
generation abort closes the route, and a stale registration or mount handle
cannot close its replacement.

Route components may implement `handlePointer(event, context)`. Pointer cells
are zero-based and local to route content below the host title row. Returning
`handled` consumes the event; `capture` and `releaseCapture` delimit a drag.
The same bounded contract applies to structured custom components and overlays:
the top visible overlay is tried first, and unhandled input falls through to
the core transcript selection, link, and scrollbar behavior.

Host pickers, questions, and editors are rejected while a route is active
because the route owns the main input focus. Close the route before opening one
of those host dialogs. Structured route components may keep their own bounded
interaction state inside the route.

Routes are a single structured terminal surface, not tabs, a desktop/web
router, or a second session runtime. They use the same `RuntimeUiComponent`
sanitization and bounds as other structured mounts. Check
`capabilities.routes` before registration: every line, accessibility, RPC,
print, JSON, serve, SDK, and embedding host rejects registration and opening;
catalog inspection stays empty and `close()` is a safe no-op.

### Ordered session UI slots

`ui.slots.set(path, key, contribution)` returns a registration with `update()`,
`dispose()`, and `disposed`. `ui.slots.remove(path, key)` removes the current
registration owned by that extension generation. The four stable paths are
`session.header`, `session.beforeEditor`, `session.afterEditor`, and
`session.footer`. `EXTENSION_UI_SLOT_PATHS` and the slot types are public from
`ohm` and `ohm/extensions`.

A contribution contains one to four plain-text `lines`, an optional integer
`order`, and optional `placement: "prepend" | "append" | "replace"`.
Replacement is valid only for the header and footer. Prepend contributions
render before append contributions; each group sorts by ascending `order`, then
host extension-load encounter, then registration encounter. The greatest
replacement tuple wins and the next surviving replacement becomes visible if
that winner is removed. A trusted raw `setHeader` or `setFooter` replacement
takes precedence over a slot replacement; without a raw owner, the slot winner
takes precedence over earlier bounded structured replacements.

Keys use 1-128 identifier characters. Order is limited to -1,000,000 through
1,000,000. The host accepts at most 64 contributions total, 16 per path, 16 KiB
per contribution, and 64 KiB in aggregate. Lines cannot contain newlines,
terminal controls, or ANSI sequences. Validation and publication are atomic:
a rejected set or update retains the previous contribution. Handles cannot
remove a newer registration with the same key, and refresh, unload, or shutdown
removes the complete generation.

`capabilities.slots` and `capabilities.routes` are true only in the full rich
TUI. They are false in line and accessibility TUI hosts and in RPC, print,
JSON, serve, SDK, and embedding hosts. Slot mutations and route `register()` or
`open()` calls reject instead of claiming a rendered surface; route `list()`,
`current()`, and `close()` remain safe inspection or no-op operations. Slots
never grant raw terminal ownership.

The built-in hosts bind this surface as follows:

| Host | `mode` / `hasUI` | Public behavior |
| --- | --- | --- |
| Rich TUI | `tui` / `true` | Full dialogs, notifications, keyed status, one active extension route, ordered session slots, themes, editor state, and terminal components. |
| Line or accessibility TUI | `tui` / `true` | Dialogs and notifications use bounded line interaction. There is no persistent status dock, route viewport, or slot compositor, so `setStatus` does not print a row, slot mutations reject, and route registration or opening rejects; route inspection and close remain safe. Use `notify` when a line-mode user must see the update. Raw component, background, overlay, autocomplete, and editor-replacement surfaces are unavailable. |
| RPC | `rpc` / `true` | Dialogs, notifications, status, string-array widgets, title, whole-draft text replacement, and cursor-relative paste requests cross the typed RPC UI bridge. Extension routes, session slots, raw terminal components, and theme switching are unavailable. |
| Print and JSON | `print` or `json` / `false` | Dialogs return cancellation defaults; editor reads are empty; notifications, status, and other presentation setters are no-ops; UI and component factories are not invoked. |
| Serve | `serve` / `false` | Uses the same noninteractive fallback as print and JSON. Do not require UI for an HTTP-session command or tool. |
| SDK and embedding | `sdk` / `false` | Uses the headless fallback while preserving SDK as a distinct host mode for policy and event handling. |

ohm's built-in maps are complete and frozen. Rich TUI enables every member.
Line and accessibility TUI enable `dialogs`, `notifications`, `editorTextRead`,
`editorTextWrite`, `terminalInput`, and `themeSelection`. RPC enables `dialogs`,
`notifications`, `status`, `textWidgets`, `title`, and `editorTextWrite`. RPC
can serialize whole-draft text replacement and cursor-relative paste requests,
but cannot read client-owned edits or cursor state, so it leaves
`editorTextRead` false. All non-rich hosts leave `routes` and `slots` false.
Headless hosts set every member to false.

The compatibility adapter also reports the conservative all-false profile when
it cannot prove which optional surfaces a legacy host implements. A custom host
can supply its own complete map; omitting the map remains supported and means
no optional surface is declared.

SDK and embedding hosts report the first-class `sdk` `ExtensionMode` with
`hasUI: false`. Gate dialogs on `hasUI`, gate narrower surfaces on
`ui.capabilities`, and use `mode === "tui"` only when host identity itself
matters.

Dialog `timeout` values are milliseconds. Raw components receive host-owned `TUI`, theme, and keybinding objects. A mounted component with `dispose()` is disposed when removed or when its generation ends. Do not retain the host objects afterward.

The declared extension ID is presentation and discovery metadata, not the UI ownership key. The host namespaces persistent and keyed UI by the complete runtime contribution (declared ID plus source entry) and its generation. Two active sources that declare the same ID can therefore coexist; unloading or refreshing one source removes only that owner's UI and cannot erase a surviving source or a replacement generation.

A footer factory can call `data.getSnapshot()` to read the values used by the built-in footer, including current run
and working-indicator state. It exposes exact and reported input/output counters, full prompt input and its reported
lower bound, latest-request cache fields, context source, and the automatic-compaction threshold. The snapshot does
not contain credentials.

`custom` options are `{ overlay?, overlayOptions?, onHandle? }`. `overlayOptions` may be an object or a function, and `onHandle` receives the live `OverlayHandle`. The extension must arrange for `done` to run or for cancellation/disposal to settle the operation.

## Commands, shortcuts, flags, and renderers

`registerCommand(name, options)` accepts:

```ts
{
  description?: string;
  getArgumentCompletions?(argumentPrefix: string):
    AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler(args: string, context: ExtensionCommandContext): Promise<void>;
}
```

The handler receives the raw argument suffix. Validate it before side effects. `null` completion results let later providers handle the prefix.
The registration object and `handler` are validated during activation, and the
validated handler is captured as the registration snapshot. An invalid command
rejects that activation transaction instead of committing a command that fails
only when invoked; replacing the original object's `handler` later does not
replace the registered callback.

`registerShortcut(shortcut, { description?, handler })` uses a public `KeyId`. Shortcuts are interactive-only but their handler context remains the ordinary extension context.

`registerFlag(name, { description?, type, default? })` declares either a `boolean` or `string` value. Read flags through `getFlag`; do not parse `process.argv` independently.

A message renderer has `(message, { expanded, outputPad }, theme) => Component | undefined`. An entry renderer has `(entry, { expanded }, theme) => Component | undefined`. Returning `undefined` selects the host fallback. The renderer must not mutate the durable value.

A Markdown transformer has `(markdown, { messageType, isStreaming, availableWidth }) => string`.
Active transformers run in extension order for ordinary user text, assistant text, and visible reasoning content.
The result affects only the interactive display. It does not change the session, provider context, or model message.
If a transformer fails or returns an invalid value, the host keeps the current text and continues the chain.

## Tool contract

Use `defineTool()` for generic inference:

```ts
import { defineTool } from "ohm/extensions";
import { Type } from "@ohm/models";

ohm.registerTool(defineTool({
  name: "length",
  label: "Length",
  description: "Count code points.",
  parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
  async execute(_id, input, signal) {
    signal?.throwIfAborted();
    return {
      content: [{ type: "text", text: String([...input.text].length) }],
      details: {},
    };
  },
}));
```

`ToolDefinition` fields are:

| Field | Contract |
| --- | --- |
| `name`, `label`, `description` | Required strings. |
| `parameters` | TypeBox schema used for final validation. |
| `promptSnippet?`, `promptGuidelines?` | Optional system-prompt guidance. |
| `constrainedSampling?` | `false`, `{ type: "json_schema", strict: "prefer" \| "require" }`, or `{ type: "grammar", variants: Partial<Record<"openai_lark" \| "openai_regex", string>> }`. |
| `loading?` | `eager` or provider-supported `deferred`. |
| `renderShell?` | Omitted or `default` keeps the terminal frame; `self` makes the renderer supply its own frame. |
| `prepareArguments?(raw)` | Normalize accumulated tool arguments before validation. |
| `executionMode?` | `parallel` or `sequential`. |
| `recovery?` | Durable effect policy: `repeatable`, `never_repeat`, or a `reconcile` callback. Omission is conservative and means `never_repeat`. |
| `resources?(params, context)` | Declare file, process, network, workspace, or session claims used to schedule non-conflicting calls. |
| `execute(callId, params, signal, onUpdate, context)` | Return `Promise<AgentToolResult>`. |
| `renderCall?`, `renderResult?` | Optional TUI components. |

`AgentToolResult` is `{ content, details, usage?, addedToolNames?, terminate? }`. Content is an array of text or image blocks. Keep content, update snapshots, details, and usage bounded and serializable. `onUpdate` reports a partial result; the terminal result remains authoritative.

Throw from `execute` to mark a tool call as failed. Returning text that looks
like an error is still a successful result. Tool calls run in source-ordered,
resource-compatible waves. Read claims may overlap; a write claim conflicts
with another claim for the same resource key. A tool with
`executionMode: "sequential"` runs alone
as a barrier between waves; compatible parallel calls on either side may still
overlap with their peers. A `terminate: true` result ends the batch only when
every result in that batch sets it.

File-mutating extension tools must import `withFileMutationQueue` from `ohm`
and wrap the complete read, modify, and write operation for the absolute target
path. This serializes aliases of the same physical file while unrelated files
remain independent.

Tool renderers receive `ToolRenderContext` with `args`, `toolCallId`, `invalidate`, `lastComponent`, mutable renderer `state`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, and `isError`. The result renderer also receives `{ expanded, isPartial }`.

## Event signatures

With the exception of `project_trust`, handlers have:

```ts
(event, context: ExtensionContext) => result | void | Promise<result | void>
```

`project_trust` receives a limited `ProjectTrustContext` containing only `cwd`, `mode`, `hasUI`, and `ui.select`, `ui.confirm`, `ui.input`, and `ui.notify`.

### Trust and resources

| Event | Payload after `type` | Allowed result |
| --- | --- | --- |
| `project_trust` | `cwd` | `{ trusted: "yes" \| "no" \| "undecided", remember?: boolean }` |
| `resources_discover` | `cwd`, `reason: "startup" \| "refresh"` | `{ skillPaths?: string[], promptPaths?: string[], themePaths?: string[] }` |

Discovered relative paths resolve from the package resource root and remain subject to the host's approved boundary. Resource discovery normally has a 30-second bound.

### Session lifecycle

| Event | Payload after `type` | Allowed result |
| --- | --- | --- |
| `session_start` | `reason: "startup" \| "refresh" \| "new" \| "resume" \| "fork"`, `previousSessionFile?` | none |
| `session_info_changed` | `name: string \| undefined` | none |
| `session_before_switch` | `reason: "new" \| "resume"`, `targetSessionFile?` | `{ cancel?: boolean, reason?: string }` |
| `session_before_fork` | `entryId`, `position: "before" \| "at"` | `{ cancel?: boolean, reason?: string }` |
| `session_before_compact` | `preparation`, `branchEntries`, `customInstructions?`, `reason`, `willRetry`, `signal` | `{ cancel?: boolean, compaction?: Omit<CompactionResult, "estimatedTokensAfter"> }` |
| `session_compact` | `compactionEntry`, `fromExtension`, `reason`, `willRetry` | none |
| `session_compact_failed` | `reason`, `aborted`, `willRetry`, `fromExtension`, optional `category`, `errorMessage` | none |
| `session_shutdown` | `reason: "quit" \| "refresh" \| "new" \| "resume" \| "fork"`, `targetSessionFile?` | none |
| `session_before_tree` | `preparation`, `signal` | `{ cancel?, summary?, customInstructions?, replaceInstructions?, label? }` |
| `session_tree` | `newLeafId`, `oldLeafId`, `summaryEntry?`, `fromExtension?` | none |

Compaction preparation contains `firstKeptEntryId`, `messagesToSummarize`, `turnPrefixMessages`, `isSplitTurn`, `tokensBefore`, optional `previousSummary`, file-operation sets, and `{ enabled, reserveTokens, recentTokens, maxInputTokens }`. The last value is the effective input ceiling for that exact plan. A supplied complete compaction result contains `summary`, `firstKeptEntryId`, `tokensBefore`, and optional `usage` and `details`. After applying the summary and retained boundary, the host computes the authoritative `estimatedTokensAfter` output used by events, statistics, and the returned result.

Each kernel compaction failure dispatches `session_compact_failed` exactly once. Observer failures are diagnosed and cannot suppress the session's terminal `compaction_end` delivery.

Tree preparation contains `targetId`, `oldLeafId`, `commonAncestorId`, `entriesToSummarize`, `userWantsSummary`, and optional custom instructions, replacement mode, and label. A supplied summary is `{ summary, details?, usage? }`.

### Agent, messages, and transport

| Event | Payload after `type` | Allowed result |
| --- | --- | --- |
| `context` | `messages` | `{ messages?: AgentMessage[] }` |
| `before_provider_request` | `payload` | A complete replacement JSON payload, or no result |
| `before_provider_headers` | Mutable `headers: Record<string, string \| null>` | none; mutate the record and use `null` to remove |
| `after_provider_response` | `status`, complete normalized `headers` | none |
| `before_agent_start` | `prompt`, `images?`, `systemPrompt`, `systemPromptOptions`, `promptComposition?` | `{ message?, systemPrompt? }` |
| `agent_start` | none | none |
| `agent_end` | `messages` | none |
| `agent_settled` | none | none |
| `turn_start` | `turnIndex`, `timestamp` | none |
| `turn_end` | `turnIndex`, `message`, `toolResults` | none |
| `message_start` | `message` | none |
| `message_update` | accumulated `message`, `assistantMessageEvent` | none |
| `message_end` | `message` | `{ message?: AgentMessage }` |
| `ui_prompt_start`, `ui_prompt_end` | `reason: "ui_prompt"`, `kind`, optional `title` | none |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | none |
| `tool_execution_update` | same identity plus `partialResult` | none |
| `tool_execution_end` | same identity plus `result`, `isError` | none |
| `model_select` | `model`, optional `previousModel`, `source: "set" \| "cycle" \| "restore" \| "run"` | none |
| `thinking_level_select` | `level`, `previousLevel` | none |

Tool arguments are emitted only on `tool_execution_start`; correlate later updates and completion by `toolCallId`.
While a `message_update` carries `toolcall_delta`, consume its `delta` for live argument text. The parsed tool-call `arguments` object is authoritative only at `toolcall_end` and `tool_execution_start` after the JSON is complete.

Provider hooks are available only when the active transport is connected to the session's provider wire lifecycle. Header hooks expose complete credential-bearing headers to trusted code. They never enter ordinary diagnostics or session exports.

`message_end` replacement is revalidated. It cannot change host-owned response metadata, continuation state, or durable identity. Context replacements may contain only model conversation messages.

### Input, shell, and tools

| Event | Payload after `type` | Allowed result |
| --- | --- | --- |
| `input` | `text`, `images?`, `source: "interactive" \| "rpc" \| "serve" \| "extension"`, `streamingBehavior?` | `{ action: "continue" }`, `{ action: "transform", text, images? }`, or `{ action: "handled" }` |
| `user_bash` | `command`, `excludeFromContext`, `cwd` | `{ command?, cwd?, operations?: BashOperations, result?: { output, exitCode?, isError?, cancelled, timedOut?, signal?, truncated, fullOutputPath? } }` |
| `tool_call` | `toolCallId`, `toolName`, typed `input` | `{ block?: boolean, reason?: string, terminate?: boolean }` |
| `tool_result` | `toolCallId`, `toolName`, `input`, `content`, `isError`, `usage?`, typed `details?` | `{ content?, details?, isError?, usage? }` |

For `input`, `interactive` means a prompt made directly by a caller or user. It
covers TUI, print, JSON, SDK, and embedding prompts; it does not imply that a
terminal UI is present. RPC, serve, and extension-originated prompts use their
explicit source values.

Built-in `tool_call` inputs are:

- `bash`: `{ command, timeout? }`;
- `read`: `{ path, offset?, limit? }`;
- `edit`: `{ path, edits: [{ oldText, newText }] }`;
- `write`: `{ path, content }`;
- `grep`: `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }`;
- `find`: `{ pattern, path?, limit? }`;
- `ls`: `{ path?, limit? }`.

Use `isToolCallEventType()` to narrow a call or result to a literal tool name.
The built-in result guards retain the documented input shape for `bash`, `read`,
`edit`, and `write`. Custom tools expose `Record<string, unknown>` input and
`unknown` details.

`terminate: true` is honored only when the same `tool_call` result blocks the
call, and only when every finalized result in that provider-requested batch is
terminating. Allowed calls ignore the hint. Steering and follow-up input retain
precedence over early termination.

`BashOperations.exec(command, cwd, { onData, signal?, timeout?, env? })` returns `{ exitCode: number | null, signal?, timedOut?, cancelled?, durationMs?, stdoutBytes?, stderrBytes? }`. `timeout` is expressed in seconds; duration is milliseconds and stream counts are bytes. Omitted status fields default to no signal, timeout, or cancellation, while omitted stream counts use the bytes observed through `onData`. The custom implementation owns cancellation, timeout, process-tree cleanup, output ordering, and environment safety.

Handled `user_bash` results retain nonzero exits, cancellation, timeout, and
process signals through interactive and RPC sessions. A returned `command` or
`cwd` is the effective execution identity. Legacy handled results that provide
only `signal` still mean cancellation; set `cancelled: false` with `signal` to
report a process signal instead.

## Handler ordering and failure rules

- Listeners run in deterministic extension-load and registration order.
- `session_shutdown` settles listeners in that same sequential order under one shared shutdown deadline; later listeners do not receive a fresh timeout budget.
- Transform results are validated before a later listener receives them.
- A cancellation or tool block stops the guarded operation.
- Tool input is cloned and schema-validated before listeners run. After listener transforms, the final input is schema-validated and tool-validated again before resource claims or execution.
- Caller cancellation and generation replacement abort waiting handlers.
- Dispatch cancellation owns only the in-flight callback. Persistent UI from a
  successfully settled listener remains owned by its extension generation until
  the extension clears it or that generation ends.
- An observer failure is diagnosed but cannot roll back host work that was already committed.
- Event payloads, contexts, and models are snapshots or bounded projections; do not mutate or retain them unless a result contract explicitly permits it.
- Direct handlers run in print, JSON, RPC, serve, SDK, and TUI hosts. Never require an interactive dialog for correctness.

## Stable imports

Use `ohm/extensions` for this API, public tool claims and recovery types; `ohm/tui` for public terminal components; `ohm/providers` for provider transport types; and `ohm/storage` for public session types. Do not import `src/`, `dist/`, or private module paths, and do not bundle another copy of the host runtime into an extension package.
