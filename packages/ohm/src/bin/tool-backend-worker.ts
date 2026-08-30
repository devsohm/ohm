import { writeFileSync } from "node:fs";

import {
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ShellTool,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
  WriteTool,
  type HarnessTool,
} from "../tools/index.js";
import { DirectProcessRunner } from "../process/index.js";
import { errorMessage } from "../core/errors.js";
import { isJsonObject, isJsonValue, type JsonValue } from "../core/json.js";
import { Check } from "typebox/value";
import { STRING_VALUE } from "../core/value-schemas.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

interface WorkerRequest {
  schemaVersion: 1;
  tool: string;
  input: JsonValue;
  workspace: string;
}

async function readRequest(): Promise<WorkerRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error(`Backend request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(chunk);
  }
  let parsed: JsonValue;
  try {
    const candidate = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isJsonValue(candidate)) throw new Error("Backend request must contain JSON data");
    parsed = candidate;
  } catch {
    throw new Error("Backend request is not valid JSON");
  }
  if (!isJsonObject(parsed)) {
    throw new Error("Backend request must be an object");
  }
  if (
    Object.keys(parsed).some((key) => !["schemaVersion", "tool", "input", "workspace"].includes(key)) ||
    parsed.schemaVersion !== 1 ||
    !Check(STRING_VALUE, parsed.tool) ||
    !Check(STRING_VALUE, parsed.workspace) ||
    !isJsonValue(parsed.input)
  ) {
    throw new Error("Backend request does not match protocol version 1");
  }
  return {
    schemaVersion: 1,
    tool: parsed.tool,
    input: parsed.input,
    workspace: parsed.workspace,
  };
}

function selectedTool(name: string): HarnessTool {
  if (name === "read") return new ReadTool();
  if (name === "write") return new WriteTool();
  if (name === "edit") return new EditTool();
  if (name === "grep") return new GrepTool();
  if (name === "find") return new FindTool();
  if (name === "ls") return new LsTool();
  if (name === "bash" || name === "shell") return new ShellTool(name);
  throw new Error(`Backend tool is not supported: ${name}`);
}

async function main(): Promise<void> {
  const request = await readRequest();
  const tool = selectedTool(request.tool);
  const workspace = await WorkspaceBoundary.create(request.workspace);
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]), {}, undefined, {}, {
    activeTools: [request.tool],
  });
  const [completed] = await coordinator.execute([{
    callId: "external-backend-call",
    name: request.tool,
    input: request.input,
    index: 0,
  }], {
    workspace,
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "external-backend-run",
    threadId: "external-backend-thread",
  });
  if (completed === undefined) throw new Error("Backend tool did not return a result");
  writeFileSync(1, `${JSON.stringify({ schemaVersion: 1, result: completed.result })}\n`);
}

main().catch((error) => {
  const message = errorMessage(error);
  writeFileSync(2, `${message.replaceAll("\0", "�").slice(0, 4096)}\n`);
  process.exitCode = 1;
});
