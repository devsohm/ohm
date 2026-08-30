# JSON event stream

Use JSON mode when another program needs live session events but does not need
to send RPC commands:

```sh
ohm --mode json "Inspect the workspace"
```

Standard output uses UTF-8 JSON Lines. Each line contains one complete JSON
object followed by LF. Human diagnostics go to standard error, so consumers
should parse standard output only.

The process exits with status `0` after a successful run. It exits with a
nonzero status after an argument, startup, provider, or runtime failure.

The first record is the public V4 session projection:

```json
{"type":"session","version":4,"id":"SESSION_ID","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/workspace"}
```

Later records are public `AgentSessionEvent` objects or bounded, redacted
`extension_error` records. ohm emits session events after extension reducers
finish; extension startup failures are queued until after the session header.
The event families are:

| Family | Event types |
| --- | --- |
| Agent | `agent_start`, `agent_end`, `agent_settled` |
| Turn | `turn_start`, `turn_end` |
| Message | `message_start`, `message_update`, `message_end` |
| Tool | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` |
| Shell | `bash_execution_update` |
| Compaction | `compaction_start`, `compaction_end` |
| Provider retry | `auto_retry_start`, `auto_retry_end` |
| Summary retry | `summarization_retry_scheduled`, `summarization_retry_attempt_start`, `summarization_retry_finished` |
| Queue and session | `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed` |
| Extension failure | `extension_error` |

`message_update` contains the current message snapshot and the incremental
assistant event. During `toolcall_delta`, its `delta` is the guaranteed live
tool-argument representation; the parsed `arguments` object is authoritative
at `toolcall_end` and `tool_execution_start`, not while its JSON is incomplete.
`tool_execution_start` contains the call ID, name, and arguments. Later tool
updates deliberately omit repeated arguments: `tool_execution_update` adds a
partial result, and `tool_execution_end` adds the final result and error flag.
`bash_execution_update` contains a shell-output delta and the optional
correlation ID supplied by an SDK or RPC caller.
`queue_update` contains complete steering and follow-up queue
snapshots. Compaction and retry records include the reason, attempt, delay, and
final status when those fields apply. Fields with an `undefined` value are not
serialized.

The authoritative TypeScript contract is `AgentSessionEvent` from `ohm/sdk`.
[Session JSONL](session-jsonl.md) documents the strict durable header and
commit records. The public header above and the live event stream are not raw
session journal rows.

Example filtering:

```sh
ohm --mode json "List the changed files" 2>ohm-errors.log \
  | jq -c 'select(.type == "message_end")'
```

JSON mode is output-only. Use [RPC](rpc.md) when a client must send commands,
steer active work, answer extension dialogs, switch sessions, or query a
running process.
