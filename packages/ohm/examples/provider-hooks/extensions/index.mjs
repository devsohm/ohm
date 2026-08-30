export default function activate(ohm) {
  const state = { status: undefined, requestId: undefined };

  ohm.on("before_provider_request", (event) => ({
    ...event.payload,
    metadata: { ...event.payload?.metadata, extensionExample: true },
  }));
  ohm.on("before_provider_headers", (event) => {
    event.headers["x-ohm-example"] = "provider-hooks";
  });
  ohm.on("after_provider_response", (event) => {
    state.status = event.status;
    state.requestId = event.headers["x-request-id"]?.slice(0, 128);
  });

  ohm.registerCommand("example-provider-hooks", {
    description: "Show the latest redacted provider response observation",
    async handler(_args, context) {
      context.ui.notify(JSON.stringify(state), "info");
    },
  });
}
