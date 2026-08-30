export const MAX_FIXTURE_FRAME_BYTES = 256 * 1024;

const emptySchema = { type: "object", additionalProperties: false, properties: {} };
const pages = {
  first: [
    {
      name: "fixture.echo",
      description: "Return the supplied text.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", maxLength: 4096 } },
      },
    },
    {
      name: "fixture.add",
      description: "Add two finite numbers.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["left", "right"],
        properties: { left: { type: "number" }, right: { type: "number" } },
      },
    },
    { name: "fixture.hidden", description: "Not present in the client allowlist.", inputSchema: emptySchema },
  ],
  second: [
    {
      name: "fixture.slow",
      description: "Wait until cancelled or the delay expires.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["delayMs"],
        properties: { delayMs: { type: "integer", minimum: 1, maximum: 10_000 } },
      },
    },
    { name: "fixture.cancelled", description: "Return the observed cancellation count.", inputSchema: emptySchema },
    { name: "fixture.catalog-change", description: "Publish one bounded tool catalog change.", inputSchema: emptySchema },
    { name: "fixture.state", description: "Return fixture protocol state.", inputSchema: emptySchema },
    { name: "fixture.pid", description: "Return the fixture process id.", inputSchema: emptySchema },
    { name: "fixture.client-request", description: "Verify unsupported server requests are rejected.", inputSchema: emptySchema },
    { name: "fixture.malformed", description: "Emit a malformed protocol frame.", inputSchema: emptySchema },
    { name: "fixture.oversized", description: "Emit an oversized protocol frame.", inputSchema: emptySchema },
    { name: "fixture.die", description: "Exit while a request is pending.", inputSchema: emptySchema },
  ],
};

const isStringValue = (value) => (
  Object(value) !== value && Object.prototype.toString.call(value) === "[object String]"
);

function text(value, structuredContent) {
  const result = {
    content: [{ type: "text", text: isStringValue(value) ? value : JSON.stringify(value) }],
  };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

export function createFixtureProtocol({
  exit,
  processId = process.pid,
  protocolVersion = "2025-06-18",
  send,
  sendRaw,
}) {
  let initialized = false;
  let listCalls = 0;
  let catalogRevision = 0;
  let cancelledCalls = 0;
  const slowCalls = new Map();
  const clientRequests = new Map();
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  function callTool(id, params) {
    if (!initialized) return error(id, -32002, "Client did not send notifications/initialized");
    if (params?.name === "fixture.echo") return result(id, text(params.arguments?.text ?? ""));
    if (params?.name === "fixture.add") {
      const sum = Number(params.arguments?.left) + Number(params.arguments?.right);
      return result(id, text(String(sum), { sum }));
    }
    if (params?.name === "fixture.cancelled") return result(id, text(String(cancelledCalls)));
    if (params?.name === "fixture.catalog-change") {
      catalogRevision += 1;
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
      return result(id, text(String(catalogRevision)));
    }
    if (params?.name === "fixture.state") return result(id, text({ initialized, listCalls }));
    if (params?.name === "fixture.pid") return result(id, text(String(processId)));
    if (params?.name === "fixture.slow") {
      const timer = setTimeout(() => {
        slowCalls.delete(id);
        result(id, text("completed"));
      }, params.arguments?.delayMs ?? 10_000);
      slowCalls.set(id, timer);
      return;
    }
    if (params?.name === "fixture.client-request") {
      const requestId = `fixture-client-${id}`;
      clientRequests.set(requestId, id);
      send({ jsonrpc: "2.0", id: requestId, method: "sampling/createMessage", params: {} });
      return;
    }
    if (params?.name === "fixture.malformed") return sendRaw("not-json\n");
    if (params?.name === "fixture.oversized") return sendRaw(`${"x".repeat(MAX_FIXTURE_FRAME_BYTES + 1)}\n`);
    if (params?.name === "fixture.die") return exit(17);
    return error(id, -32601, `Unknown fixture tool: ${String(params?.name)}`);
  }

  return Object.freeze({
    close() {
      for (const timer of slowCalls.values()) clearTimeout(timer);
      slowCalls.clear();
      clientRequests.clear();
    },
    handle(message) {
      if (message?.method === "initialize") {
        return result(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "ohm-mcp-fixture", version: "1" },
        });
      }
      if (message?.method === "notifications/initialized") {
        initialized = true;
        return;
      }
      if (message?.method === "tools/list") {
        if (!initialized) return error(message.id, -32002, "Client did not initialize");
        listCalls += 1;
        if (message.params?.cursor === undefined) {
          const first = catalogRevision === 0
            ? pages.first
            : pages.first.map((tool) => tool.name === "fixture.echo"
              ? { ...tool, description: `Return the supplied text (catalog revision ${catalogRevision}).` }
              : tool);
          return result(message.id, { tools: first, nextCursor: "second" });
        }
        if (message.params.cursor === "second") return result(message.id, { tools: pages.second });
        return error(message.id, -32602, "Unknown cursor");
      }
      if (message?.method === "tools/call") return callTool(message.id, message.params);
      if (message?.method === "notifications/cancelled") {
        const timer = slowCalls.get(message.params?.requestId);
        if (timer !== undefined) {
          clearTimeout(timer);
          slowCalls.delete(message.params.requestId);
          cancelledCalls += 1;
        }
        return;
      }
      if (message?.method !== undefined) return error(message.id, -32601, "Unknown method");
      const pendingCall = clientRequests.get(message?.id);
      if (pendingCall !== undefined) {
        clientRequests.delete(message.id);
        return result(pendingCall, text(`rejected:${message.error?.code ?? "missing"}`));
      }
    },
  });
}
