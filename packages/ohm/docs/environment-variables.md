# Environment variables

ohm uses environment variables for process-level configuration. It also gives model-invoked shell commands a
current, non-secret session identity. [Providers](providers.md) lists credential variables separately.

## Shell-tool session identity

The built-in `bash` tool resolves these values immediately before each command:

| Variable | Value |
| --- | --- |
| `OHM_SESSION_ID` | Active session ID. |
| `OHM_SESSION_FILE` | Absolute JSONL path for a persisted session; otherwise unset. |
| `OHM_PROVIDER` | Selected provider ID; unset when no model is selected. |
| `OHM_MODEL` | Selected model ID; unset when no model is selected. |
| `OHM_REASONING_LEVEL` | Effective `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` level; otherwise unset. |

Model-invoked commands can read these values when they need the current runtime selection. A model or reasoning-level
change appears in the next command. The variables identify the route selected by ohm. A gateway may make another
upstream routing decision that ohm cannot observe.

User-entered `!` and `!!` commands do not receive this injection. A custom bash tool created with `createBashTool()`
or `createBashToolDefinition()` receives it by default. Disable it when the child must not receive session metadata:

```ts
const bash = createBashTool(cwd, {
  exposeSessionEnvironment: false,
});
```

ohm removes inherited values before injection or opt-out, so a nested harness cannot report stale parent-session
metadata by accident. Before built-in local shell execution, it also removes inherited entries whose names identify
common API keys, authentication values, cookies, credentials, tokens, passwords, private keys, or secrets, plus
entries whose values begin with an authenticated URL. Removed nonempty values are registered with the output
redactor. Ordinary values such as `PATH` and build flags remain available. Current non-secret `OHM_*` fields are
injected only after this scrub for model-invoked tools.

A `spawnHook` runs afterward and receives the final environment. It must preserve existing entries when adding its
own, and trusted hook code can deliberately reintroduce removed values. Environment scrubbing prevents accidental
inheritance; it is not an operating-system isolation boundary. Shell commands still run with the invoking user's
authority, and the scrub does not protect against same-user process inspection through `/proc` or a debugger, or
against access to user-readable files, credential agents, and metadata services.

## Process configuration

| Variable | Purpose |
| --- | --- |
| `OHM_ACTIVE` | Set to `true` by the CLI and RPC executables so child processes can detect an active ohm harness. Direct SDK use does not set it. |
| `OHM_HOME` | Select the ohm home instead of `~/.ohm`. Configuration, credentials, sessions, logs, resources, and managed runtime state live below this root. |
| `OHM_SESSION_DIR` | Select session storage unless `--session-dir` overrides it. |
| `OHM_SERVE_TOKEN` | Required ASCII token68 bearer token containing 32 through 4,096 characters for `ohm serve`. The command does not accept the token as a flag. |
| `OHM_CACHE_RETENTION` | Set the process-wide provider cache policy to `none`, `short`, or `long`. |
| `OHM_LOG_LEVEL` | Override local operational logging for this process: `off`, `error`, `info`, or `debug`. |
| `OHM_OFFLINE` | Disable startup network refreshes and package network operations when set to `1`, `true`, or `yes`. |
| `OHM_ACCESSIBLE` | Request accessible, control-sequence-free output when set to `1`. |
| `OHM_ASCII` | Replace Unicode presentation glyphs when set to `1`. |
| `OHM_HARDWARE_CURSOR` | Hide the default positioned cursor when set to `0` and `showHardwareCursor` is omitted. |
| `OHM_CLEAR_ON_SHRINK` | Clear rows after rendered content shrinks when set to `1`. |
| `OHM_DEBUG_REDRAW` | Write bounded, metadata-only renderer diagnostics under `<ohmHome>/logs` when set to `1`. |
| `OHM_SYNC_UPDATE` | Disable synchronized terminal updates when set to `0`. |
| `OHM_OPENAI_CODEX_OAUTH_CLIENT_ID` | Override the bundled public client ID used by ChatGPT/Codex browser and device login. |
| `OHM_ANTHROPIC_OAUTH_CLIENT_ID` | Override the bundled public client ID used by Anthropic browser login. Account eligibility and billing are determined by Anthropic. |
| `OHM_GITHUB_COPILOT_OAUTH_CLIENT_ID` | Override the bundled public client ID used by GitHub device login. The subsequent Copilot token brokerage and raw model transport remain experimental. |
| `OHM_KIMI_CODE_OAUTH_CLIENT_ID` | Override the bundled public client ID used by Kimi Code device login. |
| `OHM_XAI_OAUTH_CLIENT_ID` | Override the bundled public client ID used by xAI device login. |
| `VISUAL`, `EDITOR` | External-editor fallback when `externalEditor` is unset. |
| `http_proxy` / `HTTP_PROXY`, `https_proxy` / `HTTPS_PROXY`, `all_proxy` / `ALL_PROXY`, `no_proxy` / `NO_PROXY` | Proxy defaults for outbound HTTP clients. Lowercase wins over uppercase, `all_proxy` supplies either missing scheme-specific proxy, and `no_proxy` lists destinations that bypass the proxy. |

The standalone launcher sets `OHM_DISTRIBUTION=standalone`. It uses the normal ohm home unless the caller
sets `OHM_HOME`. The source-built private launcher sets `OHM_HOME` to its installation root.

Session lookup and storage use this order: invocation `--session-dir`, `OHM_SESSION_DIR`, the effective
`config.json` `sessionDir`, then `<ohmHome>/sessions`.

`OHM_CACHE_RETENTION=none` disables optional prompt-cache markers,
continuation retention, and session-affinity hints where the selected protocol
supports that policy. `short` requests normal short retention. `long` requests
the longer supported retention. A provider can ignore a retention request or
apply its own billing and duration rules. Any other value stops startup with a
validation error.

OAuth client IDs are public registration identifiers, not client secrets. ohm bundles the reviewed public native-client
registration used by each built-in account flow; a deployment can replace it with the corresponding `OHM_*_OAUTH_CLIENT_ID`
setting. ohm validates both bundled and configured IDs as 1 through 512 visible ASCII characters without surrounding
whitespace. An override is an explicit deployment choice and must be authorized for that provider flow.
