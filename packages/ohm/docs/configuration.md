# Settings

ohm has one editable `config.json` format managed by `SettingsManager`, with global and trusted-project scopes. An
installation creates the portable global baseline from packaged `resources/config.example.json` when it is missing.
`ohm config edit` creates the same baseline for a missing user file. A missing project override starts with only
`$schema`, so opening project scope cannot silently replace global choices. Reinstall and update preserve existing
files.

Comments and trailing commas are not accepted. The generated global baseline contains explicit, portable, non-null
defaults that are useful to edit. Missing keys inherit the dynamic, provider, environment, or platform default.
Existing explicit `null` values remain accepted and mean the same thing, but ohm does not generate them. Unknown
keys remain in the file but have no effect. ohm does not generate a second “effective configuration” document.

Each generated document's `$schema` points to the versioned editor schema at
[`resources/schemas/config-v1.json`](../resources/schemas/config-v1.json). Editors can use it for completion and
flag unknown core keys. `$schema` is metadata and never enters effective runtime settings. The runtime still
preserves unknown keys so a newer extension or ohm release can own them without an older process deleting them.
JSON Schema counts Unicode characters rather than UTF-8 bytes, so it prechecks model-selector shape and character
length while `ohm config validate`, startup, and `/refresh` enforce the exact byte limits documented below.

## Locations and precedence

```text
~/.ohm/config.json              global settings
$OHM_HOME/config.json           global settings with a custom ohm home
WORKSPACE/.ohm/config.json      trusted project settings
```

The standalone launcher uses `~/.ohm` unless the caller sets `OHM_HOME`. The source-built
private launcher sets that variable to `INSTALL_ROOT`, keeping its settings, authentication, sessions,
resources, and model catalog under the private installation root.

`config.json` stores choices and source declarations. It does not contain installed code or resource text. The
default physical locations are:

| Data | User scope | Trusted project scope |
|---|---|---|
| Loose extensions | `~/.ohm/extensions/` | `WORKSPACE/.ohm/extensions/` |
| Skills | `~/.ohm/skills/` | `WORKSPACE/.ohm/skills/` |
| Prompt templates | `~/.ohm/prompts/` | `WORKSPACE/.ohm/prompts/` |
| Themes | `~/.ohm/themes/` | `WORKSPACE/.ohm/themes/` |
| Operational logs | `~/.ohm/logs/` | Not applicable |
| Diagnostic bundles | `~/.ohm/diagnostics/` | Not applicable |
| Crash records | `~/.ohm/crash/` | Not applicable |
| Managed npm packages | `~/.ohm/npm/node_modules/` | `WORKSPACE/.ohm/npm/node_modules/` |
| Managed Git packages | `~/.ohm/git/repositories/` | `WORKSPACE/.ohm/git/repositories/` |
| Declarative project packages | Not applicable | `WORKSPACE/.ohm/packages/`, declared by `WORKSPACE/.ohm/packages.json` and pinned by `WORKSPACE/.ohm/packages.lock.json` |

ohm uses packages as installable extension bundles; it does not have a second plugin store. A custom ohm home
directory replaces the `~/.ohm` prefix in this table.

Global settings load first. Trusted project settings override them. Nested objects merge recursively. Arrays and
scalar values replace earlier values. A nested or top-level `null` inherits the lower-precedence or default value.
ohm neither reads nor writes project settings until the workspace is trusted. `defaultProjectTrust` is global-only,
even if a project file contains it.

The active ohm home is always user scope. If `WORKSPACE/.ohm` is the same directory as `OHM_HOME`, project
scope stays disabled, including when an old saved trust decision exists. A different `OHM_HOME` leaves the
workspace's `.ohm` directory available as normal project scope. In the collision case, `config path`, `config edit`,
and `config validate` reject `--scope project`, while `/trust` reports that project trust is unavailable without
saving a decision.

With `defaultProjectTrust` set to `ask`, a raw terminal uses a compact selector. It starts on **Keep disabled for this
launch**. Use Left/Right or Up/Down, `h`/`j`/`k`/`l`, or the displayed number; press Enter to select and Escape
or Ctrl+C to cancel. `OHM_ACCESSIBLE=1` keeps the searchable numbered prompt. Non-interactive runs do not prompt;
an unresolved `ask` decision keeps project resources disabled.

`/refresh` requires an idle session and blocks interactive input while it runs. It first waits for pending writes. It
then rereads both active settings scopes, including `keybindings`. Finally, it
rebuilds extensions, skills, prompt templates, themes, and context files without switching the active JSONL session.
`/refresh` reloads runtime configuration and resources, including extensions, but it does not load changed ohm core
or source modules; source changes require a build followed by an explicit process exit and relaunch.

`/refresh` restores model state from cached catalogs and never waits for live provider discovery. A parse failure leaves
the last valid in-memory scope active and reports the error. Settings writes lock the file and merge only fields
changed by the process, so unrelated external edits survive.

Credential state is stored separately from settings, using the selected platform backend or the private auth file.
Sessions are append-only JSONL files under `sessions/`. Neither belongs in `config.json`. Provider and model
declarations and authentication commands are also not settings. Use the model registry and trusted provider
extensions described in [Providers](providers.md).

The CLI owns `models.json` as its durable discovered-model catalog snapshot. It may rewrite the file after catalog
refreshes. Its top level is `{ "version": 1, "savedAt": "...", "providers": [...] }`. The SDK compatibility
`ModelRuntime` does not parse this file as configuration.

`ModelRuntime.create()` instead reads optional editable provider declarations from `model-providers.json`. That file
has a provider-keyed top level such as
`{ "providers": { "company": { "baseUrl": "...", "api": "openai-completions", "models": [...] } } }`. The CLI does
not read `model-providers.json`; CLI provider customization remains extension-owned. An explicit SDK `modelsPath`
selects another provider configuration file. `modelsPath: null` disables file loading.

There is no automatic rename or copy from `models.json`, because it may contain a live CLI catalog. An SDK-only
installation that placed provider declarations there should move that provider-keyed document to
`model-providers.json` before starting the CLI.

Application and editor overrides live under `keybindings` in `config.json`. See [Keybindings](keybindings.md) for
the action map and chord format. `/refresh` applies keybinding, settings, and extension-resource changes together.

## Agent instructions

Use `AGENTS.md` to personalize the agent without changing the built-in system prompt:

```text
~/.ohm/AGENTS.md              global instructions
$OHM_HOME/AGENTS.md           global instructions with a custom ohm home
ANCESTOR/AGENTS.md              project or directory-specific instructions
```

A self-contained install creates an empty, user-owned global `AGENTS.md` when
it is missing. Edit it directly and run `/refresh` in an active session.
Reinstall and update preserve the customized file byte-for-byte.

ohm loads the global file first. It then loads one instruction file from each ancestor directory, from the
filesystem root to the working directory. More specific instructions therefore appear later. `/refresh` rereads the
active files. `--no-context-files` disables instruction discovery for one invocation. Instruction files are prompt
text; they do not grant extension trust or more operating-system authority.

## Locate or edit settings

The settings commands default to user scope:

```sh
ohm config path
ohm config edit
ohm config validate
ohm config path --scope project
ohm config edit --scope project
ohm config validate --scope project
```

`path` prints the exact file path without creating it. Add `--json` for structured output. `edit` uses
`externalEditor`, `$VISUAL`, `$EDITOR`, or the platform editor. A missing user file starts from the same portable
baseline installed by ohm. A missing project file starts with only `$schema`, because project scope is an override
of the global file. The result must be a JSON object, and every known setting must have an accepted type and range.
Unknown fields are preserved.

`validate` checks the full shape and range of every known setting through the same parser and user-plus-project
merge used by `/refresh`. It does not create, normalize, or write either file. A missing file is a valid empty scope.
Use `--json` for a structured report. Project validation, like project editing, requires trust or `--approve`.

The settings lock commits the edit only when the file still matches the version opened in the editor. Invalid JSON,
editor failure, or a concurrent change leaves the original untouched. Project scope targets
`WORKSPACE/.ohm/config.json` and honors `--workspace DIR`. Editing project scope requires a trusted workspace or
the invocation-only `--approve`. `-l` is the short project-scope form.

## Supported settings

`/settings` contains the controls people commonly change while working, including compaction, reasoning, queue
delivery, Codex transport and timeout, terminal images, skill commands, theme, project trust, terminal progress,
and session navigation. Transport and timeout changes take effect after `/refresh`. More specialized terminal and
provider controls remain available in `config.json` and through the existing programmatic settings APIs.

Model selectors below are exact and case-sensitive `provider/model` values. Providers are 1–128 UTF-8 bytes;
model IDs are 1–512 UTF-8 bytes and may contain further slashes. Whitespace, control characters, and the glob
metacharacters `*`, `?`, `[`, `]`, `{`, and `}` are rejected.

| Key | Default | Purpose |
| --- | --- | --- |
| `lastChangelogVersion` | none | ohm-managed marker for startup release notes; normally do not edit. |
| `defaultProvider` | none | Preferred provider when no session selection exists. |
| `defaultModel` | none | Preferred model ID. |
| `defaultThinkingLevel` | model default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `enabledModels` | all available models | Up to 1,024 exact `provider/model` selectors allowed for session selection and the model picker. An empty array also means all available models. |
| `modelThinkingLevels` | none | Object mapping up to 1,024 exact `provider/model` selectors to that model's default thinking level. An explicit model-reference or invocation thinking level takes precedence. |
| `transport` | `auto` | OpenAI Codex transport. `auto` starts with a cached WebSocket and falls back to full-context HTTPS/SSE after an eligible pre-output transport failure. After a successful pre-output HTTPS/SSE fallback, or immediately after a failure beyond a semantic boundary, the session, endpoint, and account identity stays on SSE for the adapter lifetime, subject to a 1,024-entry recent-identity bound. Valid empty lifecycle placeholders remain replay-safe; visible text or summary reasoning, hidden provider reasoning, tool drafts, and malformed, unknown, or opaque state are not replayed across transports. Failures already classified as authentication errors and provider-declared response failures are not replayed across transports; an SSE fallback that fails before a successful terminal does not pin the identity. Select `sse` to force HTTPS/SSE. `websocket` and `websocket-cached` are strict explicit modes without SSE fallback. Other providers keep their native transports. |
| `steeringMode` | `one-at-a-time` | Drain steering messages `one-at-a-time` or `all`. |
| `followUpMode` | `one-at-a-time` | Drain follow-up messages `one-at-a-time` or `all`. |
| `theme` | `signal` | Built-in `signal` or `mono`, or a discovered custom theme name. A `LIGHT/DARK` pair may select two themes automatically. |
| `compaction.enabled` | `true` | Enable automatic compaction. |
| `compaction.triggerPercent` | `85` | Proactive trigger as a percentage of the model context window. Accepted range: `50` through `95`. Omit it to use the equivalent 15% headroom policy. |
| `compaction.reserveTokens` | 15% of context | Optional fixed response-headroom override. An explicit per-call output ceiling can still enlarge it. |
| `compaction.recentTokens` | 20% of trigger | Optional fixed recent-context target retained verbatim where possible. |
| `branchSummary.reserveTokens` | `18000` | Output room reserved for branch summaries. |
| `branchSummary.skipPrompt` | `false` | Skip the optional summary question during tree navigation. |
| `retry.enabled` | `true` | Enable replay-safe transient retries. |
| `retry.maxRetries` | `3` | Replay-safe agent, compaction, and branch-summary retries after the initial attempt. |
| `retry.baseDelayMs` | `2000` | Initial retry delay. |
| `retry.provider.timeoutMs` | provider default | Optional provider timeout. |
| `retry.provider.maxRetries` | `0` | Provider-transport retries after the first request. Keep this at `0` unless the transport must retry before the agent receives the error. |
| `retry.provider.maxRetryDelayMs` | `60000` | Retry backoff ceiling; a longer server-requested delay fails, and `0` removes the ceiling. |
| `observability.level` | `debug` | Global-only local metadata diagnostics: `off`, `error`, `info`, or `debug`. |
| `showCacheMissNotices` | `false` | Show a neutral cache-reuse estimate when one request leaves at least 20,000 prior-prompt tokens uncached or has about $0.10 of estimated added cost. |
| `externalEditor` | `$VISUAL`, `$EDITOR`, or platform editor | External editor command. |
| `shellPath` | platform shell | Shell path; `~` is expanded. |
| `shellCommandPrefix` | none | Trusted operator prefix run in the same shell invocation. |
| `quietStartup` | `false` | Suppress the normal startup report. |
| `defaultProjectTrust` | `ask` | Global-only trust default: `ask`, `always`, or `never`. |
| `npmCommand` | platform npm | Executable plus fixed argv prefix for package operations. |
| `packages` | `[]` | npm, Git, or local package sources and optional resource filters. |
| `extensions` | `[]` | Additional extension files or directories. |
| `skills` | `[]` | Additional skill files or directories. |
| `prompts` | `[]` | Additional prompt-template files or directories. |
| `themes` | `[]` | Additional custom theme files or directories. |
| `enableSkillCommands` | `true` | Register discovered skills as slash commands. |
| `tools.enabled` | all built-in and extension tools | Persistent tool allowlist; `null` keeps every available tool enabled. Invocation flags take precedence. |
| `tools.excluded` | `[]` | Persistent tool exclusions, combined with `--exclude-tools`. |
| `terminal.showImages` | `true` | Render supported terminal images. |
| `terminal.imageWidthCells` | `60` | Preferred terminal image width. |
| `terminal.clearOnShrink` | `OHM_CLEAR_ON_SHRINK=1` or `false` | Clear and redraw after terminal shrink. |
| `terminal.showTerminalProgress` | `false` | Show terminal-level progress state. |
| `fullscreenScrollbar` | `auto` | Fullscreen transcript scrollbar policy: `auto`, `always`, or `hidden`. |
| `fullscreenCopyOnSelect` | `true` | Copy a mouse selection when the button is released. When `false`, the highlight remains until the normal copy action is used. |
| `images.autoResize` | `true` | Resize provider-bound images to safe bounds. |
| `images.blockImages` | `false` | Prevent images from being sent to providers. |
| `doubleEscapeAction` | `atlas` | `atlas` or `none`. |
| `treeFilterMode` | `default` | Atlas journal-entry filter: `default`, `no-tools`, `user-only`, `labeled-only`, or `all`. |
| `thinkingBudgets` | provider defaults | Optional `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` token budgets. |
| `editorPaddingX` | `0` | Composer horizontal padding, clamped from 0 through 3. |
| `outputPad` | `1` | Transcript horizontal padding: 0 or 1. |
| `autocompleteMaxVisible` | `5` | Visible autocomplete rows, clamped from 3 through 20. |
| `showHardwareCursor` | `true` | Show the terminal cursor at the exact editor insertion point. An explicit setting wins; only when omitted does `OHM_HARDWARE_CURSOR=0` hide it. |
| `markdown.codeBlockIndent` | two spaces | Indentation used for rendered code blocks. |
| `warnings.anthropicExtraUsage` | `true` | Legacy-compatible setting name for the warning shown once per interactive process when Anthropic account OAuth or an API bearer is active; set `false` to suppress. |
| `sessionDir` | `<ohmHome>/sessions` | Alternate session directory; `~` is expanded. |
| `httpProxy` | environment/default dispatcher | Proxy URL for ohm-managed HTTP clients. |
| `httpIdleTimeoutMs` | `300000` | HTTP header/body and OpenAI Codex WebSocket response-message idle timeout from 0 through 2,147,483,647 ms; `0` or `"disabled"` disables it. |
| `websocketConnectTimeoutMs` | `30000` | WebSocket connect timeout from 0 through 2,147,483,647 ms; `0` or `"disabled"` disables it. |
| `collapseChangelog` | `false` | Prefer a condensed changelog display. |
| `keybindings` | platform defaults | Complete application/editor action map. `null` on an action keeps its built-in binding; `[]` unbinds it. |

For `extensions`, `skills`, `prompts`, and `themes`, entries beginning with `!`, `+`, or `-` remain resource-filter
rules. Every other entry is an additional file or directory path. Global paths resolve from `$OHM_HOME`; trusted
project paths resolve from `WORKSPACE/.ohm`. Untrusted project paths are not read or activated.

The cached WebSocket retains one bounded connection and continuation state per session/transport identity; it is
separate from the provider's prompt-token cache reported by `cacheRead` and the TUI cache percentage. Changing
transport therefore targets continuation latency and reliability, not a higher prompt-cache hit rate.

Session lookup and storage use this order: `--session-dir`, `OHM_SESSION_DIR`, then the effective
`sessionDir` setting. A trusted project may override that setting. An untrusted project may not.

ohm does not send install or usage telemetry. Local operational records stay under `<ohmHome>/logs`, requested
support bundles belong under `<ohmHome>/diagnostics`, and private crash reports stay under `<ohmHome>/crash`.
Continuous records do not intentionally include secrets, OAuth tokens, prompts, model text, reasoning text, tool
inputs, tool output, stacks, free-form failure or warning messages, cancellation reasons, in-doubt explanations, or
raw provider request or response bodies. Failure records retain fixed codes, normalized categories, counts, booleans,
durations, and allowlisted transport metadata such as status, a validated bare media type, and bounded opaque-token
transport codes or request identifiers. Nonconforming metadata is omitted. Diagnostic messages and stacks remain
outside continuous logs: exact run failures remain in the active UI and private V4 session journal, while fatal
process messages and stacks live in private crash reports. Both require explicit, scoped access during diagnosis.

The first interactive startup records the installed version without replaying old release notes. After an update,
startup shows only sections newer than that version. Set `collapseChangelog` to `true` for a one-line notice.
`/changelog` always shows the complete packaged changelog.

## Portable baseline and complete schema

The installed global `config.json` starts from the non-null portable baseline in
[`../resources/config.example.json`](../resources/config.example.json). It exposes stable defaults people can safely
edit, including compaction, retry, observability, terminal and image behavior, resource lists, timeouts, and an empty
keybinding object. The same document remains the single source for persistent settings; `/settings` edits its common
interactive controls and `ohm config edit` exposes the whole file.

The baseline deliberately omits values whose correct default depends on the current environment, provider, model, or
filesystem path. It also omits provider-specific thinking budgets and an unrestricted `tools.enabled` allowlist.
Those settings are still supported and discoverable in the complete versioned editor
contract at [`../resources/schemas/config-v1.json`](../resources/schemas/config-v1.json); keybinding action names are
documented in [Keybindings](keybindings.md). Add an omitted key only when you intend to override its derived default,
then run `/refresh` after editing.

A newly created trusted-project file contains only `$schema`. Add only the project overrides you want; all other
values continue to come from the global file. Both scopes use the same schema and merge rules.

## Package-resource selector

`ohm config` opens the package-resource selector. It updates only the `packages` setting in the selected global or trusted-project scope. It does not print or maintain another configuration format.

## Extension-owned configuration

Keep custom providers, model metadata, OAuth clients, request headers, credential commands, and external execution
policy in a reviewed provider or tool extension. This keeps provider authority and secrets out of the main settings
file.
