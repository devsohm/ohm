import server from "./server.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_OUTBOUND_BYTES = 60 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_PAGES = 32;
const MAX_TOOLS = 128;
const MAX_CONTENT_BLOCKS = 64;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_BYTES = 32 * 1024;

const primitiveTag = (value) => Object(value) === value
  ? undefined
  : Object.prototype.toString.call(value);

function isFunctionValue(value) {
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

const isNumberValue = (value) => primitiveTag(value) === "[object Number]";
const isStringValue = (value) => primitiveTag(value) === "[object String]";

function record(value) {
  return value !== null && Object(value) === value && !Array.isArray(value) && !isFunctionValue(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function errorFrom(value, fallback) {
  return value instanceof Error ? value : new Error(isStringValue(value) ? value : fallback);
}

function abortReason(signal) {
  return errorFrom(signal.reason, "MCP request cancelled");
}

function boundedString(value, label, maximum, { empty = false } = {}) {
  if (!isStringValue(value) || (!empty && value.trim() === "") || byteLength(value) > maximum || value.includes("\0")) {
    throw new Error(`${label} must be ${empty ? "a" : "a non-empty"} string no larger than ${maximum} bytes`);
  }
  return value;
}

function jsonClone(value, label, maximum) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-safe`);
  }
  if (encoded === undefined || byteLength(encoded) > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
  return JSON.parse(encoded);
}

function validateSchema(value, toolName) {
  const schema = jsonClone(value, `MCP tool ${toolName} input schema`, MAX_SCHEMA_BYTES);
  if (!record(schema) || schema.type !== "object") {
    throw new Error(`MCP tool ${toolName} must declare an object input schema`);
  }
  return schema;
}

function validateConfiguration(value) {
  if (!record(value)) throw new Error("MCP server configuration must be an object");
  const id = boundedString(value.id, "MCP server id", 64);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 128) {
    throw new Error("MCP server argv must contain 1 through 128 entries");
  }
  const argv = value.argv.map((entry, index) => boundedString(entry, `MCP server argv[${index}]`, 16 * 1024, { empty: true }));
  if (!record(value.toolNames) || Object.keys(value.toolNames).length === 0 || Object.keys(value.toolNames).length > MAX_TOOLS) {
    throw new Error(`MCP toolNames must contain 1 through ${MAX_TOOLS} entries`);
  }
  const toolNames = new Map();
  const localNames = new Set();
  for (const [remoteName, localValue] of Object.entries(value.toolNames)) {
    boundedString(remoteName, "Remote MCP tool name", 128);
    const localName = boundedString(localValue, `ohm name for ${remoteName}`, 128);
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(localName)) {
      throw new Error(`ohm name for ${remoteName} is invalid: ${localName}`);
    }
    if (localNames.has(localName)) throw new Error(`MCP tool mapping repeats ohm name ${localName}`);
    localNames.add(localName);
    toolNames.set(remoteName, localName);
  }
  const requestTimeoutMs = value.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000) {
    throw new Error("MCP requestTimeoutMs must be from 1 through 300000");
  }
  const configuredEnv = value.env ?? {};
  if (!record(configuredEnv)) throw new Error("MCP server env must be a string record");
  const envEntries = Object.entries(configuredEnv);
  if (envEntries.length > MAX_ENV_ENTRIES) {
    throw new Error(`MCP server env exceeds ${MAX_ENV_ENTRIES} entries`);
  }
  let envBytes = 0;
  const validatedEnv = [];
  for (const [rawKey, rawValue] of envEntries) {
    const key = boundedString(rawKey, "MCP server env key", MAX_ENV_BYTES);
    if (key.includes("=")) throw new Error("MCP server env key must not contain =");
    const envValue = boundedString(rawValue, `MCP server env ${key}`, MAX_ENV_BYTES, { empty: true });
    envBytes += byteLength(key) + byteLength(envValue);
    if (envBytes > MAX_ENV_BYTES) throw new Error(`MCP server env exceeds ${MAX_ENV_BYTES} bytes`);
    validatedEnv.push([key, envValue]);
  }
  const env = Object.freeze(Object.fromEntries(validatedEnv));
  return Object.freeze({ id, argv: Object.freeze(argv), env, toolNames, requestTimeoutMs });
}

function rpcError(value) {
  if (!record(value) || !Number.isSafeInteger(value.code) || !isStringValue(value.message)) {
    return new Error("MCP server returned an invalid JSON-RPC error");
  }
  return new Error(`MCP error ${value.code}: ${value.message}`);
}

export class McpStdioClient {
  #service;
  #configuration;
  #processId;
  #nextId = 1;
  #pending = new Map();
  #alive = false;
  #failure;
  #buffer = Buffer.alloc(0);
  #listChanged = false;
  #catalogListener;
  #catalogRefreshQueued = false;
  #catalogRefreshRunning = false;

  constructor(service, configuration) {
    this.#service = service;
    this.#configuration = validateConfiguration(configuration);
  }

  get alive() {
    return this.#alive;
  }

  async start(signal) {
    if (this.#processId !== undefined) throw new Error("MCP client has already started");
    signal?.throwIfAborted();
    // The managed-process owner supplies the generation lifetime. This signal
    // only bounds initialization and discovery requests below.
    this.#processId = this.#service.spawn({
      argv: this.#configuration.argv,
      env: this.#configuration.env,
      inheritEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "capture",
      captureLimitBytes: 64 * 1024,
    });
    this.#alive = true;
    void this.#readLoop().catch((cause) => this.#fail(cause, true));
    void this.#waitForExit().catch((cause) => this.#fail(cause, false));

    const initialized = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ohm-mcp-stdio-example", version: "1" },
    }, { signal, timeoutMs: this.#configuration.requestTimeoutMs });
    if (!record(initialized)) throw new Error("MCP initialize result must be an object");
    const negotiatedVersion = boundedString(initialized.protocolVersion, "MCP protocol version", 64);
    if (negotiatedVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported MCP protocol version ${negotiatedVersion}; expected ${PROTOCOL_VERSION}`);
    }
    if (!record(initialized.capabilities) || !record(initialized.capabilities.tools)) {
      throw new Error("MCP server does not declare the tools capability");
    }
    this.#listChanged = initialized.capabilities.tools.listChanged === true;
    await this.notify("notifications/initialized", {});
    return await this.#listTools(signal);
  }

  onToolsChanged(listener) {
    if (!isFunctionValue(listener)) throw new Error("MCP tool catalog listener must be a function");
    if (this.#catalogListener !== undefined) throw new Error("MCP tool catalog listener is already registered");
    this.#catalogListener = listener;
    return () => {
      if (this.#catalogListener === listener) this.#catalogListener = undefined;
    };
  }

  async #listTools(signal) {
    const discovered = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, {
        signal,
        timeoutMs: this.#configuration.requestTimeoutMs,
      });
      if (!record(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid page");
      for (const value of result.tools) {
        if (!record(value)) throw new Error("MCP tools/list returned an invalid tool");
        const name = boundedString(value.name, "MCP tool name", 128);
        if (discovered.has(name)) throw new Error(`MCP tools/list repeated ${name}`);
        if (discovered.size >= MAX_TOOLS) throw new Error(`MCP server exposes more than ${MAX_TOOLS} tools`);
        discovered.set(name, {
          name,
          description: boundedString(value.description ?? `Call ${name} through MCP.`, `MCP tool ${name} description`, MAX_DESCRIPTION_BYTES),
          inputSchema: validateSchema(value.inputSchema, name),
        });
      }
      if (result.nextCursor === undefined) break;
      cursor = boundedString(result.nextCursor, "MCP tools/list cursor", 1024);
      if (cursors.has(cursor)) throw new Error("MCP tools/list repeated a pagination cursor");
      cursors.add(cursor);
      if (page === MAX_PAGES - 1) throw new Error(`MCP tools/list exceeded ${MAX_PAGES} pages`);
    }

    const selected = [];
    for (const [remoteName, localName] of this.#configuration.toolNames) {
      const tool = discovered.get(remoteName);
      if (tool === undefined) throw new Error(`Configured MCP tool is missing: ${remoteName}`);
      selected.push(Object.freeze({ ...tool, localName }));
    }
    return Object.freeze(selected);
  }

  async callTool(name, args, signal) {
    const result = await this.request("tools/call", { name, arguments: args }, {
      signal,
      timeoutMs: this.#configuration.requestTimeoutMs,
    });
    return toolResult(result, this.#configuration.id, name);
  }

  async notify(method, params) {
    await this.#send({ jsonrpc: "2.0", method, params });
  }

  async request(method, params, { signal, timeoutMs } = {}) {
    if (!this.#alive || this.#processId === undefined) throw this.#failure ?? new Error("MCP process is unavailable");
    signal?.throwIfAborted();
    const id = this.#nextId++;
    let resolveValue;
    let rejectValue;
    const response = new Promise((resolve, reject) => {
      resolveValue = resolve;
      rejectValue = reject;
    });
    const cleanup = [];
    const reject = (cause, notify = false) => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      for (const dispose of cleanup) dispose();
      rejectValue(cause);
      if (notify && this.#alive) {
        void this.notify("notifications/cancelled", { requestId: id, reason: cause.message }).catch(() => undefined);
      }
    };
    if (signal !== undefined) {
      const onAbort = () => reject(abortReason(signal), true);
      signal.addEventListener("abort", onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", onAbort));
    }
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms`), true), timeoutMs);
      timer.unref?.();
      cleanup.push(() => clearTimeout(timer));
    }
    this.#pending.set(id, {
      resolve(value) {
        for (const dispose of cleanup) dispose();
        resolveValue(value);
      },
      reject(cause) {
        for (const dispose of cleanup) dispose();
        rejectValue(cause);
      },
    });
    try {
      await this.#send({ jsonrpc: "2.0", id, method, params });
    } catch (cause) {
      reject(errorFrom(cause, `Failed to write MCP ${method}`));
      this.#fail(cause, true);
    }
    return await response;
  }

  detach(cause = new Error("MCP extension generation was disposed")) {
    this.#fail(cause, false);
  }

  async stop(cause = new Error("MCP client stopped")) {
    const processId = this.#processId;
    this.#fail(cause, false);
    if (processId === undefined) return;
    try {
      await this.#service.cancel(processId);
    } catch {
      // A concurrent generation disposal may already have made the service stale.
    }
  }

  async #send(message) {
    if (!this.#alive || this.#processId === undefined) throw this.#failure ?? new Error("MCP process is unavailable");
    const frame = `${JSON.stringify(message)}\n`;
    if (byteLength(frame) > MAX_OUTBOUND_BYTES) throw new Error(`MCP outbound frame exceeds ${MAX_OUTBOUND_BYTES} bytes`);
    await this.#service.write(this.#processId, frame);
  }

  async #readLoop() {
    while (this.#alive && this.#processId !== undefined) {
      const page = await this.#service.read(this.#processId, "stdout", { maxBytes: 64 * 1024 });
      if (page.data.length > 0) {
        this.#buffer = Buffer.concat([this.#buffer, Buffer.from(page.data)]);
        await this.#drainFrames();
      }
      if (page.eof) throw new Error("MCP server closed stdout");
      if (this.#buffer.length > MAX_FRAME_BYTES) throw new Error(`MCP frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
  }

  async #drainFrames() {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > MAX_FRAME_BYTES) throw new Error(`MCP frame exceeds ${MAX_FRAME_BYTES} bytes`);
        return;
      }
      if (newline > MAX_FRAME_BYTES) throw new Error(`MCP frame exceeds ${MAX_FRAME_BYTES} bytes`);
      let frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length === 0) throw new Error("MCP server emitted an empty frame");
      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch {
        throw new Error("MCP server emitted malformed JSON");
      }
      await this.#handleMessage(message);
    }
  }

  async #handleMessage(message) {
    if (!record(message) || message.jsonrpc !== "2.0") throw new Error("MCP server emitted an invalid JSON-RPC message");
    if (isStringValue(message.method)) {
      if (!Object.hasOwn(message, "id") && message.method === "notifications/tools/list_changed") {
        if (!this.#listChanged) throw new Error("MCP server sent tools/list_changed without declaring support");
        this.#queueCatalogRefresh();
        return;
      }
      if (Object.hasOwn(message, "id")) {
        if (!isStringValue(message.id) && !isNumberValue(message.id)) {
          throw new Error("MCP server request id must be a string or number");
        }
        await this.#send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Client-side MCP requests are not supported" },
        });
      }
      return;
    }
    if (!isNumberValue(message.id)) throw new Error("MCP response id must be a number");
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      pending.reject(new Error("MCP response must contain exactly one of result or error"));
    } else if (hasError) {
      pending.reject(rpcError(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  #queueCatalogRefresh() {
    this.#catalogRefreshQueued = true;
    if (this.#catalogRefreshRunning) return;
    this.#catalogRefreshRunning = true;
    queueMicrotask(() => {
      void (async () => {
        try {
          while (this.#alive && this.#catalogRefreshQueued) {
            this.#catalogRefreshQueued = false;
            const tools = await this.#listTools();
            await this.#catalogListener?.(tools);
          }
        } catch (cause) {
          this.#fail(cause, true);
        } finally {
          this.#catalogRefreshRunning = false;
          if (this.#alive && this.#catalogRefreshQueued) this.#queueCatalogRefresh();
        }
      })();
    });
  }

  async #waitForExit() {
    if (this.#processId === undefined) return;
    const result = await this.#service.wait(this.#processId);
    const stderr = Buffer.from(result.stderr).toString("utf8").trim().slice(0, 2048);
    throw new Error(stderr || `MCP process ended in state ${result.state}${result.exitCode === null ? "" : ` with exit code ${result.exitCode}`}`);
  }

  #fail(cause, cancel) {
    if (!this.#alive && this.#failure !== undefined) return;
    this.#failure = errorFrom(cause, "MCP process failed");
    this.#alive = false;
    this.#catalogRefreshQueued = false;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    if (cancel && this.#processId !== undefined) {
      try {
        void this.#service.cancel(this.#processId).catch(() => undefined);
      } catch {
        // Generation disposal can make the managed-process service stale first.
      }
    }
  }
}

function toolResult(value, serverId, remoteName) {
  if (!record(value) || !Array.isArray(value.content) || value.content.length > MAX_CONTENT_BLOCKS) {
    throw new Error(`MCP tool ${remoteName} returned invalid content`);
  }
  const content = value.content.map((block, index) => {
    if (!record(block)) throw new Error(`MCP tool ${remoteName} content[${index}] is invalid`);
    if (block.type === "text") {
      return { type: "text", text: boundedString(block.text, `MCP tool ${remoteName} text`, MAX_FRAME_BYTES, { empty: true }) };
    }
    if (block.type === "image") {
      return {
        type: "image",
        data: boundedString(block.data, `MCP tool ${remoteName} image`, MAX_FRAME_BYTES),
        mimeType: boundedString(block.mimeType, `MCP tool ${remoteName} image MIME type`, 256),
      };
    }
    throw new Error(`MCP tool ${remoteName} returned unsupported ${String(block.type)} content`);
  });
  if (value.isError === true) {
    const summary = content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(0, 8192);
    throw new Error(summary || `MCP tool ${remoteName} failed`);
  }
  const structuredContent = value.structuredContent === undefined
    ? undefined
    : jsonClone(value.structuredContent, `MCP tool ${remoteName} structured content`, MAX_FRAME_BYTES);
  const details = {
    server: serverId,
    remoteTool: remoteName,
  };
  if (structuredContent !== undefined) details.structuredContent = structuredContent;
  return {
    content,
    details,
  };
}

export function createMcpExtension(configuration = server) {
  const selected = validateConfiguration(configuration);
  return function activate(ohm) {
    let client;
    let toolRegistrations = [];
    const toolDefinitions = (candidate, tools) => tools.map((tool) => ({
      name: tool.localName,
      label: tool.name,
      description: `${tool.description} Routed through the ${selected.id} MCP stdio server.`,
      parameters: tool.inputSchema,
      executionMode: "parallel",
      async execute(_callId, input, signal) {
        if (client !== candidate || !candidate.alive) throw new Error(`MCP server ${selected.id} is unavailable; refresh to reconnect`);
        return await candidate.callTool(tool.name, input, signal);
      },
    }));
    const publishTools = async (candidate, tools) => {
      const next = [];
      const previous = toolRegistrations;
      try {
        for (const tool of toolDefinitions(candidate, tools)) {
          const registration = ohm.registerTool(tool);
          next.push(registration);
          if (registration.disposed) {
            throw new Error(`MCP tool registration was rejected: ${tool.name}`);
          }
        }
      } catch (cause) {
        toolRegistrations = [];
        await Promise.allSettled([...next, ...previous].map(async (registration) => await registration.dispose()));
        throw cause;
      }
      toolRegistrations = next;
      await Promise.allSettled(previous.map(async (registration) => await registration.dispose()));
    };
    ohm.on("session_start", async (_event, context) => {
      if (client !== undefined) return;
      const candidate = new McpStdioClient(ohm.processes, configuration);
      client = candidate;
      try {
        candidate.onToolsChanged(async (tools) => {
          if (client !== candidate) return;
          await publishTools(candidate, tools);
        });
        const tools = await candidate.start(context.signal);
        await publishTools(candidate, tools);
      } catch (cause) {
        await candidate.stop(errorFrom(cause, `MCP server ${selected.id} failed during startup`));
        if (client === candidate) client = undefined;
        throw cause;
      }
    });
    ohm.onDispose(() => {
      client?.detach();
      client = undefined;
      toolRegistrations = [];
    });
  };
}

export default createMcpExtension();
