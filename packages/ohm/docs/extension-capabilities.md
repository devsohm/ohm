# Extension capability matrix

The machine-readable [`extension-capabilities.json`](extension-capabilities.json)
maps each supported direct-factory capability to its hosts, public API members,
owned event/result contracts, documentation, examples, and executable tests.
Repository tests validate every referenced path and require every public event
to have exactly one capability owner. The compile-time inventory also covers
every public factory, callback, command, and UI member in the current TypeScript
contracts, so adding a surface without matrix ownership fails test typechecking.

Callback UI support is negotiated separately through the optional
`context.ui.capabilities` map. ohm's built-in hosts always provide a complete,
frozen map; custom hosts that omit it declare no optional UI surfaces.

ohm has one trusted in-process extension model. A package declares direct entries in `package.json`. A successful factory publishes its commands, tools, events, services, providers, UI, and resources together. A failed candidate publishes nothing. Refresh replaces the complete generation, makes the old API stale, and then runs its disposers.

## Focused examples

| Example | Capability |
| --- | --- |
| `starter` | Commands and tools |
| `lifecycle-events` | Lifecycle observation and disposal |
| `command-controls` | Flags, commands, and shortcuts |
| `tool-rendering` | Built-in tool replacement and rendering |
| `input-guard` | Input transformation and tool-call blocking |
| `ui-surfaces` | UI capability negotiation plus one active named route, ordered session slots, status, autocomplete, and overlay components |
| `context-compaction` | Prompt transformation, usage, and compaction |
| `messages-bus` | Trusted services, shared topics, custom messages, and rendering |
| `model-controls` | Active model-scope inspection and thinking selection |
| `provider-override` | Generation-owned provider replacement |
| `raw-editor-ui` | Primary editor replacement through public TUI exports |
| `session-jsonl` | Read-only current-session inspection |
| `session-control` | Explicit session transitions |
| `session-metadata` | Naming, custom entries, labels, and rendering |
| `subagent-specialists` | Extension-owned named delegation through ordinary tools and managed processes |
| `mcp-stdio` | Extension-owned MCP discovery and tool registration through a managed stdio process |
| `dynamic-package` | Runtime-discovered skills and prompts |
| `provider-hooks` | Request mutation and complete request/response header observation for trusted direct extensions |
| `runtime-catalog` | Active tools, model selection, discovery, and user-message delivery |
| `session-lifecycle` | Session guards, compaction, tree events, and navigation |
| `provider-catalog` | Custom providers, managed OAuth callbacks, and refreshed catalogs |
| `terminal-workbench` | Terminal input, editor helpers, custom themes, and tool expansion |
| `project-trust` | Invocation-scoped interactive trust decisions |
| `state-and-policy` | Extension-owned workspace memory, task state, and protected-path preflight |

Host names are `tui`, `print`, `json`, `rpc`, `serve`, and `sdk`. Direct SDK and
embedding sessions report the first-class headless `sdk` mode. Only TUI-specific
behavior is marked `tui`. Registrations and session/process contracts work in
any host that binds their required context. Packages must still fail safely when
a dialog or visual component is unavailable.

Named extension routes are a rich-TUI-only structured component surface. One
route is active at a time across the viewport; it replaces the transcript
region without replacing the composer, status dock, or session runtime.

Managed-process ownership controls cancellation and lifecycle rather than
providing a confidentiality or sandbox boundary. Protocol bridges and delegated
agents remain trusted extension code; untrusted packages must not be loaded as
direct extensions.

The trusted service registry is also process-local rather than an isolation
boundary. It lets cooperating extensions share callback-bearing objects by
reference; durable or cross-process coordination needs a different contract.

The HTTP service keeps session identity under its endpoint registry. Extension
commands can navigate the current tree and refresh resources there, but
`newSession`, `fork`, and `switchSession` return `{ cancelled: true }`; clients
create or open another service session through the documented HTTP endpoints.
