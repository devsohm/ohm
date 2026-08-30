# ohm examples

Start with [`starter`](./starter/). It is the smallest installable package, its extension entry is typechecked, and its local test invokes both registered callbacks. The other packages are focused examples: copy only the behavior your extension needs.

Every package in this catalog is also activated through ohm's real package manager and extension runtime by the central conformance suite. `External access` documents what the example exercises; it is not a permission boundary. Direct extensions are trusted Node.js code with the authority of the ohm process.

Run any package without installing it:

```text
ohm --extension /absolute/path/to/packages/ohm/examples/PACKAGE
```

For an installed copy, use `ohm install PATH`, ask the user to run `/refresh`, exercise the documented command or tool, and remove it with `ohm remove SOURCE` when finished.

## Start in five minutes

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [starter](./starter/) | Register a typed command and model-callable tool | `starter` | `all` | `none` | `package test` |

## Recipes by outcome

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [lifecycle-events](./lifecycle-events/) | Observe a complete agent run and dispose generation state | `recipe` | `all` | `none` | `central conformance` |
| [command-controls](./command-controls/) | Add a flag, slash command, and normalized TUI shortcut | `recipe` | `all` | `none` | `central conformance` |
| [tool-rendering](./tool-rendering/) | Wrap a built-in tool and render its call and result | `recipe` | `all` | `filesystem-read` | `central conformance` |
| [input-guard](./input-guard/) | Transform user input and block selected tool calls | `recipe` | `all` | `none` | `central conformance` |
| [context-compaction](./context-compaction/) | Add bounded context and request host-owned compaction | `recipe` | `all` | `none` | `central conformance` |
| [messages-bus](./messages-bus/) | Connect local events to rendered durable messages | `recipe` | `all` | `none` | `central conformance` |
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
| [mcp-stdio](./mcp-stdio/) | Own an allowlisted MCP stdio bridge and publish ordinary extension tools | `example` | `all` | `process` | `package test` |
| [terminal-workbench](./terminal-workbench/) | Coordinate terminal input, editor state, themes, and expansion | `example` | `tui` | `terminal-control` | `central conformance` |
| [state-and-policy](./state-and-policy/) | Persist bounded workspace state and enforce a path policy | `example` | `all` | `filesystem-read, filesystem-write` | `central conformance` |

## Contract probes

| Example | Outcome | Tier | Hosts | External access | Verify |
| --- | --- | --- | --- | --- | --- |
| [runtime-catalog](./runtime-catalog/) | Inspect and change live tool, model, command, and resource state | `contract` | `all` | `none` | `central conformance` |
| [session-lifecycle](./session-lifecycle/) | Observe and request guarded session transitions | `contract` | `tui, print, json, rpc, sdk` | `none` | `central conformance` |
| [provider-hooks](./provider-hooks/) | Add request metadata and inspect credential-bearing headers | `contract` | `all` | `credentials` | `central conformance` |
| [project-trust](./project-trust/) | Participate in an interactive project-trust decision | `contract` | `all` | `none` | `central conformance` |

## Supporting examples

- [`execution-backends`](./execution-backends/) contains standalone external tool-executor adapters rather than an installable extension package.
- [`sdk-composition.mjs`](./sdk-composition.mjs) composes shared services and sessions through the SDK.
- [`embedding-runtime.mjs`](./embedding-runtime.mjs), [`embedding-in-memory.mjs`](./embedding-in-memory.mjs), and [`embedding-cancellation.mjs`](./embedding-cancellation.mjs) cover embedded runtime ownership, deterministic tests, and cancellation.

## Package workflow

Use `ohm extensions author report PACKAGE` before installation. It validates the manifest and exact file set, activates and disposes a staged generation, and checks valid-candidate refresh. Before publishing, also test malformed input, cancellation, cleanup, repeated refresh, the packed archive, and the exact installed artifact. See [Extension packages](../docs/packages.md) for the complete workflow.
