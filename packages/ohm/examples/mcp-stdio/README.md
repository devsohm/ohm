# MCP stdio tools extension

This example package adapts one MCP stdio server into model-callable ohm
tools. The extension owns discovery, registration, the bounded stdio protocol
adapter, and the managed-process lifecycle. It uses only ordinary
`registerTool` handles plus `ohm.processes`; it never imports
`node:child_process` or opens a shell. Installing or removing this package adds
or removes all MCP behavior.

```text
ohm install ./packages/ohm/examples/mcp-stdio
```

The bundled configuration starts a deterministic fixture server. Copy the
package, then edit [`extensions/server.mjs`](./extensions/server.mjs) before
installing it to point `argv` at a real server. Keep untrusted arguments as
separate argv entries. The fixture sets `env` to an empty record, and the
adapter always starts the server with `inheritEnv: false`. Add only the explicit
environment entries that the selected server requires through reviewed
deployment configuration, and do not commit credentials to the package.

## Deliberate scope

`toolNames` is both an allowlist and a stable name mapping. A discovered remote
tool is exposed only when its exact remote name maps to a valid ohm tool name.
Unknown server tools stay hidden, duplicate names fail startup, and every mapped
tool must exist. This package implements only MCP tools. It does not expose
prompts, resources, roots, sampling, elicitation, or arbitrary server requests.
Server requests receive JSON-RPC `-32601`.

Startup performs `initialize`, requires the exact `2025-06-18` protocol version
implemented by this adapter, sends `notifications/initialized`, follows bounded
`tools/list` pagination, validates object input schemas, then registers the
selected tools. Calls use `tools/call`. Caller cancellation rejects locally and
sends `notifications/cancelled`. Framing, schema, page, tool, output, request,
and process limits are explicit. Malformed or oversized frames fail closed and
terminate the managed server; an unexpected process exit rejects every pending
call. The configured environment is limited to 32 entries and 32 KiB in total.
Every discovered tool is published through an exact generation-owned ordinary
tool handle. A rejected initial registration disposes the already-created
handles, stops the failed server, and permits a clean retry. A rejected live
catalog refresh removes the bridge's complete tool set and stops the server so
the model cannot observe a mixed old/new catalog.

When the server declares `tools.listChanged`, the adapter coalesces
`notifications/tools/list_changed`, repeats bounded discovery, and calls the
same-owner registration path for each selected tool. The active provider step
retains its immutable tool registry and a later step observes the replacements.
Refresh and host close dispose the generation's tool handles and managed
process tree automatically. Tool changes are intentionally extension-owned and
are not presented as a host-level server catalog transaction.

Run the package-local protocol and lifecycle checks with:

```text
npm test --prefix packages/ohm/examples/mcp-stdio
```
