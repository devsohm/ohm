# Providers and authentication

ohm ships 12 chat-provider identities. These are the only providers that appear as built-ins in the model picker and default authentication registry.

| Provider ID | Request protocol | Authentication |
| --- | --- | --- |
| `openai-codex` | OpenAI Responses for ChatGPT | browser or device account login, or an existing stored OAuth credential |
| `openai` | OpenAI Responses | `OPENAI_API_KEY` or a stored API key |
| `anthropic` | Anthropic Messages | browser account login, `ANTHROPIC_API_KEY`, or an API-billed Console bearer in `ANTHROPIC_AUTH_TOKEN` (`ANTHROPIC_OAUTH_TOKEN` remains a compatibility alias) |
| `google` | Gemini Generate Content | `GEMINI_API_KEY` or a stored API key |
| `openrouter` | OpenAI Chat Completions | browser login that mints and stores an OpenRouter API key, `OPENROUTER_API_KEY`, or a stored API key |
| `github-copilot` | provider-selected Messages, Chat Completions, or Responses | GitHub device login, `COPILOT_GITHUB_TOKEN`, or a stored token |
| `xai` | OpenAI Responses | xAI device login, `XAI_API_KEY`, or a stored API key |
| `deepseek` | OpenAI Chat Completions | `DEEPSEEK_API_KEY` or a stored API key |
| `kimi-code` | OpenAI Chat Completions | Kimi Code device login, `KIMI_CODE_API_KEY`, or a stored membership key |
| `ollama` | Ollama Chat | no key for the local default; `OLLAMA_API_KEY` or a stored bearer token for a protected endpoint |
| `opencode` | OpenCode Zen routes across Messages, Generate Content, Chat Completions, and Responses | `OPENCODE_API_KEY` or a stored API key |
| `opencode-go` | OpenCode Go routes current models across Messages, Chat Completions, and Responses | `OPENCODE_GO_API_KEY`, then the shared `OPENCODE_API_KEY` environment fallback, or a separately stored Go API key |

`google` is the public provider ID. The runtime uses `gemini` as its internal adapter key; both names resolve to the same built-in provider.

`/login anthropic` exposes Anthropic's PKCE browser flow. Anthropic determines account eligibility and whether plan usage, extra usage, or API billing applies; ohm does not promise which allowance will be used. Claude subscriptions and Console/API billing can be [separate](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console).

The official [`ant` CLI can also export a Console access token](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/scripting) for API-billed requests:

```bash
export ANTHROPIC_AUTH_TOKEN="$(ant auth print-credentials --access-token)"
```

ohm sends that value as an ordinary bearer token. It does not add Claude Code headers or rewrite tool names.

Image generation is separate from the chat picker. The built-in image provider is OpenRouter. See [Image generation](image-generation.md).

## Connect a provider

Run:

```text
/login
```

The command shows only methods that the selected provider supports. A provider can offer OAuth and an API-key method at the same time. `/logout PROVIDER` removes the selected stored profile and requests revocation when that OAuth service supports it.

You can also set an environment variable before starting ohm:

```bash
export OPENAI_API_KEY="..."
ohm
```

Environment credentials are read when needed. They are not copied into the credential store or session file. Stored credentials take precedence over environment credentials for the same provider.

OpenCode Go is a separate provider and stored credential identity. A stored OpenCode Zen key is never reused for Go. For the official shared environment-key workflow only, Go checks `OPENCODE_GO_API_KEY` first and then `OPENCODE_API_KEY`; Zen continues to use `OPENCODE_API_KEY`.

A model brand is not an authentication identity. Kimi and Qwen routes selected under OpenCode Zen or OpenCode Go use that provider's credential. The separate `kimi-code` provider accepts its device account login or the membership API key created in the Kimi Code console. Qwen plans use their provider-issued API keys through a configured provider or extension; current Qwen browser OAuth is not a built-in login path.

## OAuth behavior

ohm provides native account login for five client-registration flows and one clientless flow:

- ChatGPT/Codex browser or device login uses OpenAI's OAuth service and the Codex Responses transport;
- Anthropic browser login uses PKCE and the Anthropic Messages transport. For an OAuth credential only, the transport sends
  the `oauth-2025-04-20` and `claude-code-20250219` compatibility betas, the direct-browser-access marker, a truthful
  `ohm/<version>` user agent, and the generic CLI application class. It also canonicalizes the built-in
  `read`/`write`/`edit`/`bash`/`grep` tool names to the casing expected by that compatibility path, then maps returned calls
  back to the registered ohm names. API keys and Console bearer tokens do not use these compatibility fields or rename
  tools. Anthropic decides account eligibility and billing;
- GitHub Copilot device login uses GitHub OAuth, then exchanges the GitHub token for a short-lived Copilot service token. That brokerage and raw model transport remain experimental because they are not a documented public model API;
- Kimi Code device login uses its bundled public registration and stores refreshable account credentials under the `kimi-code` identity;
- xAI device login uses the endpoints and scopes advertised by [xAI's OIDC discovery document](https://auth.x.ai/.well-known/openid-configuration);
- OpenRouter's provider-owned PKCE flow requires no client registration. It exchanges the browser authorization code for an OpenRouter API key and stores that key in ohm's credential store.

The five client-registration flows have bundled public client IDs. `OHM_OPENAI_CODEX_OAUTH_CLIENT_ID`, `OHM_ANTHROPIC_OAUTH_CLIENT_ID`, `OHM_GITHUB_COPILOT_OAUTH_CLIENT_ID`, `OHM_KIMI_CODE_OAUTH_CLIENT_ID`, and `OHM_XAI_OAUTH_CLIENT_ID` can replace the corresponding default for a deployment. Overrides must contain 1 through 512 visible ASCII characters with no surrounding whitespace; an invalid override stops setup. API-key, environment-token, cloud, and stored-credential paths remain available alongside account login.

Browser flows validate their callback state. Device flows bound polling, cancellation, response size, and expiry. Refreshable credentials are refreshed before expiry, and rotating refresh tokens replace the previous stored token atomically. Cross-process refresh is serialized; a valid lock whose owning process has exited is reclaimed immediately, while a live owner is never displaced merely because the lock is old. Failed refreshes do not erase the last credential. OAuth credentials and API keys are never written to model catalogs, session JSONL, ordinary diagnostics, or tool output.

Direct OAuth protocols and account eligibility can change. Use a provider's documented API-key or token method when you need its public API contract.

## Models and discovery

The normal model picker lists models from connected providers. Live discovery is authoritative when a provider offers it. OpenRouter refreshes from its live model endpoint; its maintained entries are offline metadata, not a replacement for that listing. The package also contains a small reviewed fallback catalog for offline metadata and providers that do not expose a complete listing endpoint.

Fallback metadata can declare:

- total context, independent input, and output limits;
- supported input types and tools;
- exact thinking levels and wire mappings;
- cache and request compatibility;
- reviewed token prices.

Unknown values remain unknown. ohm does not invent capabilities. A successful live listing does not gain extra model IDs from the fallback catalog.

Ollama discovers models from its configured local endpoint without requiring a key. `openai-codex` uses its reviewed static Codex catalog. Other providers use live or maintained data according to their adapter contract.

As observed on August 26, 2026, OpenCode Zen has 64 reviewed routes and OpenCode Go has 23. Their authenticated model listings filter those routes to models available to the account. IDs reported by an endpoint without reviewed protocol metadata, and deprecated IDs absent from the active catalog, are not guessed into the picker. Zen routes use Responses, Messages, Gemini Generate Content, and Chat Completions according to each model's provider-native contract. Go routes use Responses for GPT-5.6 Luna, Grok 4.6, and Muse Spark 1.2 Contributor; Messages for MiniMax and Qwen; and Chat Completions for DeepSeek, GLM, Hy, Kimi, LongCat, and MiMo.

Moonshot's Kimi Chat boundary requires every property schema to carry an explicit JSON Schema `type`. Before a direct Moonshot or OpenCode Kimi request is serialized, ohm deep-copies the tool schemas and fills only missing wire types from their existing enum, constant, object, array, string, or numeric constraints. The registered schema is never mutated, and non-Kimi OpenCode routes are unchanged. This keeps standards-valid enum-only schemas from extensions and external tools compatible with Kimi's stricter wire validator.

Cost estimates follow reviewed provider documentation and the machine-readable models.dev snapshot used to maintain the catalog. When those sources conflict, the conflict is reviewed instead of silently choosing one. OpenCode Go currently publishes weekday UTC time-window pricing for DeepSeek models, which the fixed-price catalog schema cannot represent truthfully. The new DeepSeek V4 Flash Vision Exp route therefore has no maintained price, and the existing Flash and Pro fixed estimates are retained as legacy estimates rather than presented as the current schedule.

Use:

```bash
ohm --list-models
ohm --list-models openai
ohm --offline --list-models
```

`--offline` reads local metadata only. It does not prove that a hosted model is available to the current account.

## Request behavior

All built-in adapters normalize text, public reasoning, tool calls, tool results, images, usage, cancellation, retry outcomes, and provider continuation state into the same agent contract.

Only provider-authorized public reasoning is rendered. Opaque continuation data remains provider state. A provider or model change discards incompatible continuation state.

Request retries are bounded. A request is never replayed after semantic output has started. Responses transports may retry one HTTP body disconnect before any text, refusal, reasoning, tool, or unknown semantic event; transport-only metadata and valid empty lifecycle placeholders do not close that retry gate, while malformed, opaque, or unknown state does. Provider-reported cache reads and writes are normalized when available; missing telemetry remains unknown rather than being estimated as a hit.
After a metered request, the built-in TUI footer shows the latest-request `cache hit N.N%` value beside non-zero aggregate cache-read (`R`) and cache-write (`W`) counters when space permits. A reported cold read is `cache hit 0.0%`; the chip is omitted when the newest completed non-summary model request lacks cache-read telemetry or an exact prompt denominator. The same aggregate counters remain available through session statistics, RPC, SDK, and footer extension data.

| Provider ID | Cache-read telemetry | Cache-write telemetry |
| --- | --- | --- |
| `openai-codex` | Responses `cached_tokens`, when returned | Responses `cache_write_tokens`, when returned |
| `openai` | Responses `cached_tokens`, when returned | Responses `cache_write_tokens`, when returned |
| `anthropic` | `cache_read_input_tokens` | aggregate and lifetime-specific cache creation counters |
| `google` | `cachedContentTokenCount` | not reported by the built-in Generate Content route |
| `openrouter` | `prompt_tokens_details.cached_tokens`, when upstream supplies it | `cache_write_tokens`, when upstream supplies it |
| `github-copilot` | selected Messages, Chat, or Responses counter, when relayed | selected protocol counter, when relayed |
| `xai` | Responses `cached_tokens` | not documented by the maintained route |
| `deepseek` | `prompt_cache_hit_tokens` | not reported; cache misses remain uncached input |
| `kimi-code` | top-level `cached_tokens` | not reported by the maintained route |
| `ollama` | unavailable from Ollama Chat usage | unavailable from Ollama Chat usage |
| `opencode` | selected route counter, when relayed | selected route counter, when relayed |
| `opencode-go` | selected route counter, when relayed | selected route counter, when relayed |

## Custom providers

The 12 entries above are the default product set, not a limit on extensions. Trusted extensions and SDK hosts can register a complete `@ohm/models` provider or compose a runtime provider configuration. Low-level generic protocol transports remain public so an extension can add another service without changing the built-in picker.

A custom provider must define:

- a unique provider ID;
- its exact endpoint and protocol;
- model metadata or bounded discovery;
- its authentication method;
- normalized streaming and cancellation behavior.

Custom providers are generation-scoped and removable. They do not become built-ins and are not added to the default environment credential map. See [Provider authoring](provider-authoring.md) and [Extension API](extension-api.md).

## Troubleshooting

If `/model` shows no models:

1. Run `/login PROVIDER`.
2. Confirm the credential status.
3. Run `/refresh` or reopen `/model`.
4. Use `ohm --list-models PROVIDER` to inspect discovery.

If an OAuth credential expired or was revoked, log out and sign in again. If a local Ollama endpoint is unavailable, verify that the service is running and that its configured URL is reachable.
