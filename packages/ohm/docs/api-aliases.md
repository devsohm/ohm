# Root API aliases and adapters

ohm exposes convenient names from the package root and the relevant public subpaths. These names use ohm's existing session, model, plugin, tool, image, compaction, and terminal modules. They do not create a second runtime.

Plugin authors start with `PluginAPI` and the complete `ohm/plugins` entry point.

## Classification

Root re-exports retain their focused module's implementation and contract. Thin
adapters add documented convenience or lifecycle behavior; their differences are
listed below. Neither form creates a second runtime or plugin API.

Choose imports through the [public API policy](public-api.md), then use the
[plugin](plugin-api.md), [SDK](sdk.md), or [TUI](tui.md) reference for signatures.
The [named-export inventory](public-api.md#named-export-conformance) tracks exact
runtime and type exports; this guide covers the ownership differences.

`readStoredCredential()` is the deprecated synchronous reader for legacy plaintext `auth.json` files.
`readStoredCredentialAsync()` follows the durable backend selection used by the CLI.

`discoverAndLoadPlugins()` is a low-level helper for a caller that has already approved project-local executable code. It does not prompt for or establish project trust; application entry points should use the normal trust-aware resource loader.

Canonical persisted `BashExecutionMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`, and `LabelEntry` shapes are deliberately scoped to `ohm/storage`. Plugins receive the public session projection from `ohm/plugins`; callback signatures are expressed by `PluginAPI`, `PluginActions`, `PluginEventMap`, and `PluginEventResultMap` rather than separate per-method handler aliases.

## Deliberate native contracts

- `ProjectTrustStore` uses the CLI's canonicalized, lock-protected `trusted-workspaces.json` authority. Its `get`, `getEntry`, `set`, and `setMany` methods return promises.
- Compaction helpers use ohm's `ContextSummarizer` and normalized usage contracts.
- `runPrintMode` owns an already-created `AgentSessionRuntime`. It emits either assistant text or public JSON events, then disposes the runtime. Its embedded host owns process signals, cancellation, and process exit.
- `runRpcMode` owns an already-created `AgentSessionRuntime`. It serves the correlated RPC protocol until shutdown. The executable `ohm/rpc-entry` remains unchanged.
- `InteractiveMode` provides an embeddable prompt loop. The full application UI, command palette, refresh flow, and project-trust prompts remain owned by `main`.
- `MainOptions.pluginFactories` accepts trusted in-process plugin factories and carries them through every runtime generation and management path that constructs plugin resources.
- `ModelRuntime` uses ohm credential and provider-model stores. Its default editable provider configuration is `model-providers.json`, separate from the CLI-owned `models.json` catalog. An explicit `modelsPath` remains supported. Create-time refresh is offline unless `allowModelNetwork` is set. Transport-specific timeout policy stays with the provider transport.
- Root `ModelInfo` is the stable RPC model summary with provider, ID, context window, optional maximum input ceiling, and reasoning support. The richer provider-runtime `ModelInfo` remains available from `ohm/core`.
- Root `KeybindingsManager` accepts application action overrides or terminal definitions and exposes `getEffectiveConfig()`. The low-level terminal manager remains available as `KeybindingsManager` from `ohm/tui` and `@ohm/terminal`; `loadKeybindings()` from `ohm/tui` is the explicit bounded file loader for embedding hosts.
