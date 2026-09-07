# Provider override plugin

This package replaces the active `ollama` catalog with one local
OpenAI-compatible model. ohm restores the original registration when the
plugin generation unloads.

```text
ohm plugins install ./packages/ohm/examples/provider-override
```

`/example-provider-disable` removes the replacement earlier through the host
API.

The endpoint is fixed to `127.0.0.1`. The package does not embed or request a
remote credential. Change the model metadata in a copy before using it with a
real local server.
