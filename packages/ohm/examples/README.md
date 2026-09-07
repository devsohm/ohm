# ohm examples

Start with [`task-prompts`](./task-prompts/) when Markdown instructions are enough, or [`starter`](./starter/) for a command or tool. The starter's entry is typechecked and its local test invokes both registered callbacks. Copy only the behavior your plugin needs.

The central conformance suite resolves every package through the real package manager and activates packages with runtime code. Declarative packages need no activation factory. `External access` documents what the example exercises; it is not a permission boundary. Runtime plugins are trusted Node.js code with the authority of the ohm process.

Prompt templates supply task text. Invoking one can lead the model to use the session's available tools.

Run any package without installing it:

```text
ohm --plugin /absolute/path/to/packages/ohm/examples/PACKAGE
```

For an installed copy, use `ohm plugins install PATH`, ask the user to run `/refresh`, exercise the documented command or tool, and remove it with `ohm plugins remove SOURCE` when finished.

## Start in five minutes

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [task-prompts](./task-prompts/) | Review, diagnose, or implement a scoped change using Markdown templates | `starter` | `all` | `none` | `package test` |
| [starter](./starter/) | Register a typed command and model-callable tool | `starter` | `all` | `none` | `package test` |

Choose the smallest mechanism: a prompt for a repeatable request, a skill for
on-demand instructions with supporting files, or runtime code for a new tool,
command handler, event hook, or UI contribution. They belong in the same plugin
package; an optional resource does not require an empty JavaScript factory.

## Recipes by outcome

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [lifecycle-events](./lifecycle-events/) | Observe a complete agent run and dispose generation state | `recipe` | `all` | `none` | `central conformance` |
| [command-controls](./command-controls/) | Add a flag, slash command, and normalized TUI shortcut | `recipe` | `all` | `none` | `central conformance` |
| [tool-rendering](./tool-rendering/) | Wrap a built-in tool and render its call and result | `recipe` | `all` | `filesystem-read` | `central conformance` |
| [input-guard](./input-guard/) | Transform user input and block selected tool calls | `recipe` | `all` | `none` | `central conformance` |
| [context-compaction](./context-compaction/) | Add bounded context and request host-owned compaction | `recipe` | `all` | `none` | `central conformance` |
| [messages-bus](./messages-bus/) | Connect trusted services and local events to rendered durable messages | `recipe` | `all` | `none` | `central conformance` |
| [model-controls](./model-controls/) | Inspect the model and change its thinking level | `recipe` | `all` | `none` | `central conformance` |
| [session-jsonl](./session-jsonl/) | Inspect the active session through the read-only facade | `recipe` | `all` | `none` | `central conformance` |
| [session-control](./session-control/) | Request new, fork, switch, refresh, abort, and shutdown flows | `recipe` | `tui, print, json, rpc, sdk` | `none` | `central conformance` |
| [session-metadata](./session-metadata/) | Name a session, append a custom entry, and label history | `recipe` | `all` | `none` | `central conformance` |
| [provider-override](./provider-override/) | Replace a provider catalog for a fixed local endpoint | `recipe` | `all` | `network` | `central conformance` |
| [ui-surfaces](./ui-surfaces/) | Mount trusted terminal status, components, and autocomplete | `recipe` | `tui` | `none` | `central conformance` |
| [raw-editor-ui](./raw-editor-ui/) | Replace and restore the primary terminal editor | `recipe` | `tui` | `terminal-control` | `central conformance` |

## Integration examples

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [subagent-specialists](./subagent-specialists/) | Delegate named specialists through ordinary tools and managed child processes | `example` | `all` | `process` | `package test` |
| [dynamic-package](./dynamic-package/) | Discover runtime-dependent skills and prompts | `example` | `all` | `filesystem-read` | `central conformance` |
| [provider-catalog](./provider-catalog/) | Register provider, model-catalog, and OAuth contracts | `example` | `all` | `network, credentials` | `central conformance` |
| [mcp-stdio](./mcp-stdio/) | Own an allowlisted MCP stdio bridge and publish ordinary plugin tools | `example` | `all` | `process` | `package test` |
| [terminal-workbench](./terminal-workbench/) | Coordinate terminal input, editor state, themes, and expansion | `example` | `tui` | `terminal-control` | `central conformance` |
| [state-and-policy](./state-and-policy/) | Persist bounded workspace state and enforce a path policy | `example` | `all` | `filesystem-read, filesystem-write` | `central conformance` |
| [workspace-memory](./workspace-memory/) | Remember explicit workspace notes and manage them through portable actions | `example` | `all` | `filesystem-read, filesystem-write` | `package test` |
| [code-review](./code-review/) | Run and resume an independent review using the public RPC client | `example` | `all` | `filesystem-read, filesystem-write, process, network, credentials` | `package test` |

## Contract probes

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [runtime-catalog](./runtime-catalog/) | Inspect and change live tool, model, command, and resource state | `contract` | `all` | `none` | `central conformance` |
| [session-lifecycle](./session-lifecycle/) | Observe and request guarded session transitions | `contract` | `tui, print, json, rpc, sdk` | `none` | `central conformance` |
| [provider-hooks](./provider-hooks/) | Add request metadata and inspect credential-bearing headers | `contract` | `all` | `credentials` | `central conformance` |
| [project-trust](./project-trust/) | Participate in an interactive project-trust decision | `contract` | `all` | `none` | `central conformance` |

## Supporting examples

- [`execution-backends`](./execution-backends/) contains standalone external tool-executor adapters rather than an installable plugin package.
- [`sdk-composition.mjs`](./sdk-composition.mjs) composes shared services and sessions through the SDK.
- [`serve-headless.mjs`](./serve-headless.mjs) proves public HTTP discovery, actions, cancellation and reconnect recovery with a local scripted provider. See the [walkthrough](./serve-headless.md).
- [`embedding-runtime.mjs`](./embedding-runtime.mjs), [`embedding-in-memory.mjs`](./embedding-in-memory.mjs), and [`embedding-cancellation.mjs`](./embedding-cancellation.mjs) cover embedded runtime ownership, deterministic tests, and cancellation.

## Package workflow

Run the package's `npm test`, then `ohm plugins verify PACKAGE` before installation. Verification checks the source, builds an archive, installs it into temporary package state using cached dependencies with lifecycle scripts disabled, and activates, replaces, disposes, and removes that installed copy. It catches files missing from the archive without altering your installed packages. Plugin code still executes with your user account's authority. Package tests exercise behavior such as malformed input, cancellation, and recovery; generic verification cannot infer those workflows. See [Plugin packages](../docs/packages.md) for the edit, test, and refresh workflow.
