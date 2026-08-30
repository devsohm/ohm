# UI surfaces

This example adds generation-owned content to the interactive TUI.

```text
ohm install ./packages/ohm/examples/ui-surfaces
```

- `/example-ui-panel` mounts status plus keyed header and before-editor slots.
- `/example-ui-overlay` opens a centered component that closes on Enter or
  Escape.
- `/example-ui-route` registers and opens a bounded `example-details` route.

The status is compact text in the shared footer status row. The two session
slots are bounded plain text with deterministic ordering. They are removed with
the extension generation and never take raw terminal ownership.

The named route uses the structured `RuntimeUiComponent` helpers from
`ohm/tui`. It replaces only the transcript region, while the composer and
status dock remain visible. ohm supplies the route title and back affordance;
an unhandled Escape returns to the transcript. Only one extension route is
active at a time, so opening another route closes the previous one. Routes are
generation-owned rich-TUI surfaces, not tabs or additional session runtimes.

At session start, the extension wraps the active autocomplete provider with
three bounded snippets: `:todo`, `:note`, and `:review`. Unmatched input goes
to the previous provider. Applying a completion keeps that provider's editing
behavior. An aborted request returns no suggestions.

The extension checks `context.ui.capabilities` before using each surface. Rich
TUI hosts mount every feature; line, accessibility, RPC, and headless hosts
declare routes and slots unavailable. Missing capability metadata is treated as
unsupported so older custom hosts remain safe. The host removes the
autocomplete layer and every mounted surface on refresh or unload.
