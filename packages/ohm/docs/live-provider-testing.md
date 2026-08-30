# Live provider contract tests

Mocked protocol tests are deterministic and free, so they remain the default. The opt-in live suite checks the same adapters against credentials that ohm has already resolved:

```bash
npm run test:live --workspace ohm
```

The script loads `.env.local` and `.env` when present. Credentials still flow through the normal credential broker. Test code never reads, prints, snapshots, or enumerates secret values. Ordinary `npm test` discovers the live test file but skips it.

By default the suite uses `openai` and prefers a low-cost live model. Non-secret selectors can override that choice:

```bash
OHM_LIVE_PROVIDER=anthropic \
OHM_LIVE_MODEL=claude-haiku-4-5 \
npm run test:live --workspace ohm
```

The default scenarios cover text streaming, normalized usage, tool calls, multi-turn continuation, image input when confirmed by live metadata, and cancellation. Limit a run with `OHM_LIVE_SCENARIOS=text,tool`.

Prompt-cache validation is separate because it sends a sufficiently large repeated prefix and can incur additional token charges:

```bash
OHM_LIVE_CACHE=1 npm run test:live --workspace ohm
```

The cache scenario runs only when live model metadata confirms caching. It verifies provider-reported cache counters; it never estimates a hit from repeated text.

Success means the selected provider:

- returns the requested model from live discovery;
- emits start, streamed content, normalized usage, and a terminal event;
- round-trips native continuation state across turns;
- produces a structured tool call when tool support is confirmed;
- accepts confirmed image input and honors cancellation;
- reports cache reads or writes when the explicit cache scenario is enabled.

These tests are compatibility probes, not unit tests or a billing-free health check. Use a dedicated low-spend project where possible.

## Live session summaries

The paid session-summary harness is separate from the provider smoke suite:

```bash
npm run test:live:session --workspace ohm
```

The npm script enables the test directly; `OHM_LIVE_SESSION=1` enables the same file when it is selected through
another test command. It defaults to `openai-codex/gpt-5.6-terra`; `OHM_LIVE_PROVIDER` and `OHM_LIVE_MODEL`
override that selection. The test has an eight-minute bound. It makes real model calls for manual compaction, branch
summarization, navigation, and a continuation turn, then reopens the persistent journal to verify the saved summary.
Run it only with explicit authorization to use the configured credentials and incur provider charges.

When `OPENROUTER_API_KEY` is configured, the live command also makes one low-volume image-generation request through the independent `ohm/images` surface. It verifies:

- brokered authentication;
- the maintained image catalog;
- the lazy SDK transport;
- a non-empty base64 image result.

This request can incur image-generation charges. It remains disabled during ordinary `npm test` runs.
