# Advanced plugin lifecycle, presentations, and services

Start with a single factory, commands, tools, events, and `onDispose`, as described
in [Plugins](plugins.md). The following host-lifecycle APIs are only needed
when work must follow session or UI ownership rather than the whole generation.

Facets are optional lifecycle components inside one trusted plugin
generation. They are part of `PluginAPI`, not another plugin system.
Use `ohm.facets.register()` only when one package needs work split by host role.
There is no user-facing facet switch: the plugin author registers the parts,
and the host automatically starts only the parts that match its active role.

```ts
await ohm.facets.register({
  apiVersion: 1,
  kind: "worker",
  name: "indexer",
  setup(facet) {
    facet.states.open("index", { files: 0 });
  },
});
```

## Facet kinds and ownership

`worker` starts once immediately after its plugin generation commits and
then remains live for that generation. It never runs during factory staging,
so a factory rollback has no worker side effects. `session` and
`presentation` start for each bound session. `rich-tui` starts only in a TUI
host that advertises structural components. `web` and `desktop` are reserved
vocabulary in protocol version 1; current hosts do not activate them. Raw
terminal components, overlays, editors, key handling, and theme objects remain
rich-TUI-only and are never serialized into RPC or HTTP.

Initial loading waits for worker setup within the normal activation deadline,
so a successful load has no service-readiness race. A worker setup failure is
reported as a host-local plugin diagnostic while the generation's other
contributions stay live; a later session binding may retry that worker.

Every definition uses `apiVersion: 1`, a bounded unique kind/name pair, and one
setup function. There are at most 64 live facet registrations and 32 named
state channels per generation. Setup receives its own abort signal. Session
replacement stops session-bound facets in reverse cleanup order; refresh or
host close also stops the worker and closes generation-owned services, state,
and presentations. Observer failures cannot roll back committed state or stop
later observers.

Calling the returned registration's `dispose()` promptly aborts in-flight
setup. Concurrent disposal calls join the same cleanup completion for an
already-active facet. If aborted setup returns a cleanup function only later,
the host invokes it exactly once and observes its completion or rejection, but
`dispose()` does not wait for that late setup or cleanup. Setup and cleanup
should therefore honor cancellation and bound their own work.

## Named replicated JSON state

`facet.createState(initial, options?)` is an activation-local bounded reducer.
For actual cross-facet sharing, use `facet.states.open(name, initial, options?)`
and `facet.states.get(name)`. The first opener selects the initial value and
limits. The channel then stays owned by the plugin generation, so worker,
session, presentation, and rich-TUI facets see the same revision stream. It is
not durable across refresh or process restart. The returned shared view omits
`close()`; only generation teardown closes the channel and its wire endpoint.

Snapshots and deltas are detached, deeply frozen JSON. A delta advances exactly
one revision and contains bounded replace, set, or delete operations. Unsafe
prototype path segments are rejected. State is capped at 768 KiB for named
wire-visible channels, each delta at 256 KiB, retained history at 768 KiB and
256 entries, and listeners at 64. A listener that throws is isolated after the
commit; another listener and retained replay still see the immutable delta.

Each named channel automatically publishes one discoverable service named
`ohm.state.<owner-hash>.<channel>` version 1. Its schema advertises
`snapshot`, `deltas_since`, and revision-checked `apply` operations. RPC and
serve clients discover and invoke it through the ordinary wire-service broker.

## Typed wire services

Use `definePluginWireService()` with a stable name, positive integer service
version, TypeBox request/response schemas, and optional byte limits. A facet's
`services.provide()` registers the handler with its generation; `services.get()`
is the typed in-process client. RPC and serve list the same endpoints and invoke
them with version 1 JSON request/response envelopes.

Schemas are detached when the contract and endpoint are created. Later
plugin mutation cannot change admission. Requests, responses, descriptors,
and schemas are bounded and deeply frozen. Individual schemas are at most 64
KiB, payloads at most 1 MiB, and the complete catalog at most 256 entries or 2
MiB. Caller, request, and generation cancellation reach handlers where the
transport provides them. Handler exception messages never cross RPC or HTTP;
clients receive `Plugin wire service handler failed`.

## Portable presentations

A presentation is version 1 JSON: an ID, monotonic revision, optional title,
bounded text/Markdown/field/list/progress blocks, and optional schema-validated
actions. Show/update/remove events are generation-owned. Current snapshots plus
live events let RPC and serve clients recover after they
connect late. Line and accessibility hosts use the deterministic text
projection; the rich TUI maps the same document to a runtime UI block.
Each document is capped at 512 KiB and the complete retained snapshot JSON array
at 8 MiB. A show or update that would exceed the aggregate limit is rejected;
snapshot reads are never silently truncated.
Show and update validate the candidate and project it into the active TUI before
publishing its snapshot or event. If validation or that projection fails, the
previous published revision remains unchanged and the same update can be retried.
This does not roll back other effects performed by an action or a custom UI adapter.

Action requests include the exact owner, presentation ID, revision, action ID,
and JSON input. The host rejects unknown fields, stale revisions, disabled
actions, invalid schemas, oversized values, and stopped generations before or
after the handler. SDK callers use `AgentSession.invokePortablePresentationAction`;
RPC and serve expose dedicated routes. In interactive mode, `/actions` opens a
keyboard-operated picker of active presentations and their enabled actions.
Returned action results are shown as terminal-safe, secret-redacted JSON, capped
at 16 KiB; SDK/RPC/HTTP callers retain the full contract-bounded result.
Strings, numbers, booleans, choices, and closed object fields use the ordinary
terminal input controls; open objects and complex schemas accept a JSON value.
The picker invokes the same
validated host boundary, including revision and generation checks. Escape
cancels the pending interaction. Plugins can also invoke a registration from
their own command through its `invoke()` method.
