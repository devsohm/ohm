# Tool replacement and rendering

This example deliberately replaces the built-in `read` registration while
delegating execution to the public `createReadToolDefinition` factory. It
preserves the host's bounded, workspace-aware file behavior and adds tool-call
and tool-result renderers from `ohm/tui`.

```text
ohm install ./packages/ohm/examples/tool-rendering
```

Use it to learn safe built-in composition and replacement precedence. Removing
the package restores the original host registration.
