# Messages and event bus

This example connects the process-local event bus and trusted service registry
to session messages.

```text
ohm plugins install ./packages/ohm/examples/messages-bus
```

The plugin publishes a callback-bearing `example.messages` service by exact
reference. `/example-message TEXT` looks up that service, which emits one
JSON-safe local topic. The listener appends a custom session message and renders
it as a structured row. Another trusted plugin in the same process can use
the service too. The host removes the service and subscription when their
runtime generation is replaced.

The Markdown transformer turns `[[example-note]]` into a bold “Example note:”
label in user and assistant Markdown without changing the stored message.
