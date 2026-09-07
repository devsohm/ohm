# Offline headless HTTP proof

From `packages/ohm`, after building the workspace, run:

```sh
node examples/serve-headless.mjs
```

The example starts a loopback HTTP service on a temporary port with a random
bearer token, a temporary durable session, and a scripted provider. It uses only
public package imports. It does not read installed credentials, contact a model
provider, install a plugin, or retain the temporary session after completion.
The JSON result reports successful assertions, not a model-quality evaluation.

The fixed client workflow exercises:

1. Session creation, metadata-only inspection, wire-service discovery and
   invocation, and a versioned portable presentation action.
2. Prompt admission, an intentional SSE disconnect, and retained-event replay
   using both the stream identity and the last received numeric event ID.
3. A replay gap followed by committed-history recovery in one-entry pages.
4. Explicit cancellation of a second scripted run through HTTP.
5. Closing and reopening the durable session, rejecting the stale stream
   identity with `409`, and recovering identical committed entries under the
   new identity.

`createServeSessionRuntime(() => session, lifecycle)` adapts the same
`AgentSession` used by the other hosts. The getter lets an owning host resolve
its current session after a refresh. Lifecycle hooks keep plugin binding and resource cleanup with
the owning host. HTTP calls do not implement an agent loop or execute tools
directly. The optional inline plugin supplies the small echo service and
presentation action through the normal plugin contracts.

## Boundaries to preserve in a real client

The example reuses the public bounded JSON reader and SSE decoder, validates
the fields it consumes, retains only the current SSE event, and caps its small
assembled history at 128 entries and 1 MiB. These are proof limits, not a
recommended transcript-storage design. A long-lived UI should page its display
and reconcile committed rows by entry ID instead of retaining every delta.

History recovery subscribes using the **first page's** `streamId` and
`eventCursor` before requesting later pages. This deterministic proof has no
concurrent writer during page assembly. A real client must buffer live updates
within explicit limits until assembly finishes, discard partial pages and
restart on a history `409`, and restart recovery on another replay gap. Never
silently drop an overflowing live queue. History cannot recreate missed
transient deltas or tool-progress events.

The proof deliberately makes its requests once. It is not a retry framework:
do not resend a prompt or presentation action just because its HTTP connection
failed. Reinspect state and reconcile the outcome first. A stream cursor is not
a journal sequence; an old numeric cursor cannot be reused across runtime
identities. Cancellation is a request to stop work, not proof that an external
tool effect was undone.

The focused repository test invokes the exported `runServeClientProof` under
the offline network guard and asserts its result. See
[HTTP service](../docs/serve.md) for endpoint schemas, authentication, paging
conflicts, uncertain-effect recovery, and the trusted-local-operator boundary.
