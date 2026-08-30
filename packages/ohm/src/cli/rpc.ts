import { optionalProperties } from "../core/optional-properties.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { getAgentDir } from "../config/paths.js";
import { isJsonValue } from "../core/json.js";
import type { RuntimeInlineExtension } from "../extensions/runtime.js";
import { RpcExtensionUiBridge } from "../interfaces/rpc-extension-ui.js";
import { boundedRpcErrorMessage, createRpcExtensionErrorEvent } from "../interfaces/rpc-error.js";
import { RpcRuntimeDispatcher } from "../interfaces/rpc-runtime.js";
import {
  decodeRpcLines,
  parseRpcInput,
  RpcWriter,
  type ParsedRpcInput,
  type RpcUnknownCommand,
} from "../interfaces/rpc.js";
import type { RpcResponse } from "../interfaces/rpc-protocol.js";
import { withGracefulTermination, type GracefulTerminationContext } from "../process/graceful-termination.js";
import {
  createAgentSessionRuntime,
  type AgentSessionRuntime,
  type AgentSessionRuntimeServices,
  type SessionStartEvent as RuntimeSessionStartEvent,
} from "../service/agent-session-runtime.js";
import type { AgentSession } from "../service/agent-session.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";
import { SessionManager } from "../storage/session-manager.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import type { Args } from "./args.js";
import { applyRuntimeExtensionFlags } from "./extension-flags.js";
import { loadRuntime, type LoadedRuntime } from "./runtime.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import { selectStartupSession } from "./session-picker.js";
import { createStartupSession, resolveStartupSessionDirectory } from "./session-startup.js";
import { activeToolsForSelection, selectedTools } from "./tool-selection.js";

const RPC_STDIN_RELAY_SOURCE = String.raw`
const { createReadStream, writeFileSync } = require("node:fs");
let completed = false;
process.once("disconnect", () => {
  if (!completed) process.kill(process.pid, "SIGKILL");
});
(async () => {
  try {
    for await (const chunk of createReadStream("", { fd: 0 })) writeFileSync(1, chunk);
  } catch (error) {
    try { writeFileSync(2, error instanceof Error ? error.message : String(error)); } catch {}
    process.exitCode = 1;
  } finally {
    completed = true;
    if (process.connected) process.disconnect();
  }
})();
`;

const MAX_CONCURRENT_RPC_HANDLERS = 64;
const MAX_PENDING_RPC_COMMANDS = 1_024;
const PRIORITY_RPC_COMMANDS = new Set(["abort", "abort_bash", "abort_retry"]);
const RPC_EXTENSION_UI_RESPONSE_VALUE = Type.Union([
  Type.Object({ type: Type.Literal("extension_ui_response"), id: Type.String(), value: Type.String() }, { additionalProperties: true }),
  Type.Object({ type: Type.Literal("extension_ui_response"), id: Type.String(), confirmed: Type.Boolean() }, { additionalProperties: true }),
  Type.Object({ type: Type.Literal("extension_ui_response"), id: Type.String(), cancelled: Type.Literal(true) }, { additionalProperties: true }),
]);

type RpcFailureCause = Parameters<typeof boundedRpcErrorMessage>[0];

interface RpcInput {
  readonly stream: AsyncIterable<string | Uint8Array>;
  close(): void;
  failure(): Promise<Error | undefined>;
}

interface RpcLoadedServices extends AgentSessionRuntimeServices {
  runtime: LoadedRuntime;
  sessionStartEvent?: RuntimeSessionStartEvent;
}

function createRpcInput(): RpcInput {
  const relay = spawn(process.execPath, ["--input-type=commonjs", "--eval", RPC_STDIN_RELAY_SOURCE], {
    stdio: [0, "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (relay.stdout === null || relay.stderr === null) throw new Error("RPC stdin relay pipes are unavailable");
  let closing = false;
  let diagnostic = Buffer.alloc(0);
  relay.stderr.on("data", (value: Buffer) => {
    if (diagnostic.length >= 4_096) return;
    const chunk = Buffer.from(value);
    diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, 4_096 - diagnostic.length)]);
  });
  const settled = new Promise<Error | undefined>((finish) => {
    let done = false;
    const settle = (error?: Error): void => {
      if (done) return;
      done = true;
      finish(error);
    };
    relay.once("error", settle);
    relay.once("close", (code, signal) => {
      if (closing || code === 0) settle();
      else {
        const detail = diagnostic.toString("utf8").trim();
        settle(new Error(
          `RPC stdin relay failed${code === null ? ` with signal ${signal ?? "unknown"}` : ` with exit ${code}`}${detail === "" ? "" : `: ${detail}`}`,
        ));
      }
    });
  });
  relay.stdout.on("error", () => undefined);
  return {
    stream: relay.stdout,
    close() {
      if (closing) return;
      closing = true;
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
      relay.stdout?.destroy();
      relay.stderr?.destroy();
    },
    async failure() { return await settled; },
  };
}

function message<Failure>(error: Failure): string {
  return boundedRpcErrorMessage(error);
}

function errorResponse<Failure>(id: string | undefined, command: string, error: Failure): RpcResponse {
  return { ...optionalProperties(id === undefined ? undefined : { id }), type: "response", command, success: false, error: message(error) };
}

/** @internal Send one correlated response with a bounded error if serialization or output fails. */
export async function sendRpcCommandResponse<Response>(
  writer: Pick<RpcWriter, "send">,
  record: { id?: string; type: string },
  response: Response,
): Promise<void> {
  try {
    await writer.send(response);
  } catch (error) {
    const detail = message(error);
    await writer.send(errorResponse(record.id, record.type, `Failed to send response: ${detail}`));
  }
}

async function settleBounded(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface RpcCommandLoopOptions {
  lines: AsyncIterable<string>;
  writer: Pick<RpcWriter, "send">;
  bridge: Pick<RpcExtensionUiBridge, "handle">;
  dispatcher: Pick<RpcRuntimeDispatcher, "dispatch">;
}

class RpcCommandBacklogError extends Error {
  readonly id: string | undefined;
  readonly command: string;

  constructor(record?: { id?: string; type?: string }) {
    super(`RPC command backlog exceeded ${MAX_PENDING_RPC_COMMANDS}`);
    this.name = "RpcCommandBacklogError";
    this.id = record?.id;
    this.command = record?.type ?? "parse";
  }
}

/** @internal Schedule the installed CLI's parsed RPC records without blocking control responses. */
export async function runRpcCommandLoop(options: RpcCommandLoopOptions): Promise<void> {
  type ScheduledRpcInput = { kind: "record"; record: RpcUnknownCommand };
  type InputRecord = ScheduledRpcInput | { kind: "error"; error: RpcFailureCause };
  const handlers = new Set<Promise<void>>();
  const pending: InputRecord[] = [];
  let pendingOffset = 0;
  let priorityPending = 0;
  let priorityTail: Promise<void> = Promise.resolve();
  let stopped = false;

  const hasPending = (): boolean => pendingOffset < pending.length;
  const execute = async (input: InputRecord): Promise<void> => {
    if (input.kind === "error") {
      await options.writer.send(errorResponse(
        undefined,
        "parse",
        `Failed to parse command: ${message(input.error)}`,
      ));
      return;
    }
    const record = input.record;
    const response = await options.dispatcher.dispatch(record);
    if (response !== undefined) await sendRpcCommandResponse(options.writer, record, response);
  };
  const reportFailure = async <Failure>(input: InputRecord, error: Failure): Promise<void> => {
    const record = input.kind === "record" ? input.record : undefined;
    await options.writer.send(errorResponse(record?.id, record?.type ?? "parse", error)).catch(() => undefined);
  };

  const startHandler = (input: InputRecord): void => {
    const operation = execute(input)
      .catch(async (error) => await reportFailure(input, error))
      .finally(() => {
        handlers.delete(operation);
        drain();
      });
    handlers.add(operation);
  };
  function drain(): void {
    if (stopped) return;
    while (handlers.size < MAX_CONCURRENT_RPC_HANDLERS && hasPending()) {
      startHandler(pending[pendingOffset++]!);
    }
    if (!hasPending() && pendingOffset > 0) {
      pending.length = 0;
      pendingOffset = 0;
    }
  }
  const startPriority = (input: ScheduledRpcInput): void => {
    if (priorityPending >= MAX_PENDING_RPC_COMMANDS) throw new RpcCommandBacklogError(input.record);
    priorityPending += 1;
    const operation = priorityTail
      .then(async () => await execute(input))
      .catch(async (error) => await reportFailure(input, error))
      .finally(() => { priorityPending -= 1; });
    priorityTail = operation;
  };

  try {
    for await (const line of options.lines) {
      if (line.trim() === "") continue;
      let parsed: ParsedRpcInput;
      try {
        parsed = parseRpcInput(line);
      } catch (error) {
        if (pending.length - pendingOffset >= MAX_PENDING_RPC_COMMANDS) {
          throw new RpcCommandBacklogError();
        }
        pending.push({ kind: "error", error });
        drain();
        continue;
      }
      if (parsed.type === "extension_ui_response") {
        if (Value.Check(RPC_EXTENSION_UI_RESPONSE_VALUE, parsed)) {
          options.bridge.handle(parsed);
        } else {
          await options.writer.send(errorResponse(
            parsed.id,
            parsed.type,
            "Invalid extension UI response",
          ));
        }
        continue;
      }
      const record: RpcUnknownCommand = { type: parsed.type };
      for (const [key, value] of Object.entries(parsed)) {
        if (!isJsonValue(value)) throw new Error("Parsed RPC command contained a non-JSON value");
        record[key] = value;
      }
      if (PRIORITY_RPC_COMMANDS.has(record.type)) {
        startPriority({ kind: "record", record });
        continue;
      }
      if (pending.length - pendingOffset >= MAX_PENDING_RPC_COMMANDS) {
        throw new RpcCommandBacklogError(record);
      }
      pending.push({ kind: "record", record });
      drain();
    }

    drain();
    while (hasPending() || handlers.size > 0) {
      if (handlers.size === 0) {
        drain();
        continue;
      }
      await Promise.race(handlers);
    }
    if (priorityPending > 0) await priorityTail;
  } catch (error) {
    stopped = true;
    pending.length = 0;
    pendingOffset = 0;
    await settleBounded([
      ...handlers,
      ...(priorityPending === 0 ? [] : [priorityTail]),
    ], 5_000);
    throw error;
  }
}

/** @internal Apply only an explicitly requested thinking level during RPC model selection. */
export interface RpcModelSelectionRuntime {
  session: {
    readonly model: { provider: string; id: string } | undefined;
    resolveModel(
      reference: string,
      options: Parameters<LoadedRuntime["session"]["resolveModel"]>[1],
    ): ReturnType<LoadedRuntime["session"]["resolveModel"]>;
    setModel(
      model: Awaited<ReturnType<LoadedRuntime["session"]["resolveModel"]>>,
    ): Promise<void>;
    setThinkingLevel(level: Parameters<LoadedRuntime["session"]["setThinkingLevel"]>[0]): void;
  };
  settings: Pick<LoadedRuntime["settings"], "getDefaultModel" | "getDefaultProvider">;
}

export async function selectRpcConfiguredModel(runtime: RpcModelSelectionRuntime, args: Args): Promise<void> {
  const reference = args.model ?? runtime.session.model?.id ?? runtime.settings.getDefaultModel();
  const provider = args.provider ?? runtime.session.model?.provider ?? runtime.settings.getDefaultProvider();
  const thinking = args.thinking;
  if (reference !== undefined) {
    const model = await runtime.session.resolveModel(reference, {
      ...optionalProperties(provider === undefined ? undefined : { provider }),
      ...optionalProperties(thinking === undefined ? undefined : { reasoningEffort: thinking }),
    });
    await runtime.session.setModel(model);
  }
  if (args.thinking !== undefined) runtime.session.setThinkingLevel(args.thinking);
}

async function createRuntimeOwner(
  args: Args,
  manager: SessionManager,
  sessionDirectory: string | undefined,
  extensionFactories: readonly RuntimeInlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<AgentSessionRuntime<RpcLoadedServices>> {
  const create = async ({ cwd, agentDir, sessionManager, modelScope, sessionStartEvent, signal }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    modelScope?: readonly string[];
    sessionStartEvent?: RuntimeSessionStartEvent;
    signal?: AbortSignal;
  }) => {
    const runtime = await loadRuntime({
      localObservabilityMode: "rpc",
      workspace: cwd,
      sessionManager,
      ...optionalProperties(modelScope === undefined ? undefined : { modelScope }),
      ...optionalProperties(sessionDirectory === undefined ? undefined : { sessionDirectory }),
      extensions: args.noExtensions !== true,
      extensionPaths: args.extensions ?? [],
      extensionFactories,
      ...optionalProperties(projectTrustResolver === undefined ? undefined : { projectTrustResolver }),
      skills: args.noSkills !== true,
      skillPaths: args.skills ?? [],
      promptTemplates: args.noPromptTemplates !== true,
      promptTemplatePaths: args.promptTemplates ?? [],
      themes: args.noThemes !== true,
      themePaths: args.themes ?? [],
      ...optionalProperties(args.apiKey === undefined ? undefined : { apiKey: args.apiKey, apiKeyProvider: args.provider ?? "openai" }),
      ...optionalProperties(projectTrustResolver === undefined && args.projectTrustOverride !== undefined ? { projectTrusted: args.projectTrustOverride } : undefined),
      ...optionalProperties(sessionStartEvent === undefined ? undefined : { sessionStartEvent }),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
      ...optionalProperties(args.systemPrompt === undefined ? undefined : { systemPrompt: args.systemPrompt }),
      ...optionalProperties(args.appendSystemPrompt === undefined ? undefined : { appendSystemPrompt: args.appendSystemPrompt }),
      extensionRuntime: true,
      offline: args.offline === true || /^(?:1|true|yes)$/iu.test(process.env.OHM_OFFLINE ?? ""),
      ...optionalProperties(toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler }),
    });
    try {
      applyRuntimeExtensionFlags(args, runtime.runtimeExtensions);
      const argumentErrors = args.diagnostics.filter((entry) => entry.type === "error");
      if (argumentErrors.length > 0) throw new Error(argumentErrors.map((entry) => entry.message).join("\n"));
      return {
        session: runtime.session,
        extensionsResult: runtime.resourceLoader.getExtensions(),
        diagnostics: runtime.runtimeExtensions.diagnostics().map((entry) => ({
          type: "warning" as const,
          message: entry.message,
        })),
        services: {
          cwd,
          agentDir,
          runtime,
          ...optionalProperties(sessionStartEvent === undefined ? undefined : { sessionStartEvent }),
          async close() { await runtime.close(); },
        },
      };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  };
  let owner: AgentSessionRuntime<RpcLoadedServices>;
  owner = await createAgentSessionRuntime(create, {
    cwd: manager.getCwd(),
    agentDir: getAgentDir(),
    sessionManager: manager,
  }, {
    async beforeSwitch(event, signal) {
      const host = owner.services.runtime.runtimeExtensions;
      return await host.reduceSessionBeforeSwitch({
        reason: event.reason,
        ...optionalProperties(event.targetSessionFile === undefined ? undefined : { targetSessionFile: event.targetSessionFile }),
      }, signal);
    },
    async beforeFork(event, signal) {
      return await owner.services.runtime.runtimeExtensions.reduceSessionBeforeFork({
        sourceThreadId: owner.services.runtime.session.sessionId,
        sourceEventId: event.entryId,
        position: event.position,
      }, signal);
    },
    async shutdown(event) {
      const runtime = owner.services.runtime;
      await runtime.runtimeExtensions.dispatch("session_shutdown", {
        reason: event.reason,
        ...optionalProperties(event.targetSessionFile === undefined ? undefined : { targetSessionFile: event.targetSessionFile }),
      });
    },
  });
  return owner;
}

export interface RpcServerOptions {
  extensionFactories?: readonly RuntimeInlineExtension[];
  projectTrustResolver?: ProjectTrustResolver;
  /** Optional caller-owned gate for model-requested tool effects in every RPC session. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

export async function runRpcServer(argumentsValue: Args, options: RpcServerOptions = {}): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await runRpcServerOperation(argumentsValue, termination, options);
  });
}

async function runRpcServerOperation(
  args: Args,
  termination: GracefulTerminationContext,
  options: RpcServerOptions,
): Promise<void> {
  selectedTools(args);
  const workspace = resolve(args.workspace ?? process.cwd());
  const projectTrusted = options.projectTrustResolver === undefined
    ? args.projectTrustOverride === true
    : await options.projectTrustResolver.isTrusted(workspace);
  const sessionDirectory = await resolveStartupSessionDirectory(args, workspace, { projectTrusted });
  const selected = await createStartupSession(args, workspace, sessionDirectory, {
    async selectSession(current, all) { return await selectStartupSession(current, all); },
    async confirmForkFromWorkspace(targetWorkspace) {
      return await new Promise<boolean>((answer) => {
        const input = createInterface({ input: process.stdin, output: process.stderr });
        input.question(`Session found in different workspace: ${targetWorkspace}\nFork it into the current workspace? [y/N] `, (value) => {
          input.close();
          answer(/^(?:y|yes)$/iu.test(value.trim()));
        });
      });
    },
  });
  if (selected.cancelled || selected.sessionManager === undefined) return;
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (name === "") throw new Error("--name cannot be blank");
    selected.sessionManager.appendSessionInfo(name);
  }

  const writer = new RpcWriter();
  const owner = await createRuntimeOwner(
    args,
    selected.sessionManager,
    sessionDirectory,
    options.extensionFactories,
    options.projectTrustResolver,
    options.toolAuthorizationHandler,
  );
  const input = createRpcInput();
  let closing = false;
  let configuredModelSelectionPending: AgentSession | undefined;
  const applyConfiguredSession = async (session: AgentSession): Promise<void> => {
    if (configuredModelSelectionPending !== undefined && configuredModelSelectionPending !== session) {
      configuredModelSelectionPending = undefined;
    }
    if (session.suspendedRun !== undefined) {
      configuredModelSelectionPending = session;
      return;
    }
    const runtime = owner.services.runtime;
    await selectRpcConfiguredModel(runtime, args);
    const configuredTools = runtime.settings.getToolSettings();
    const selection = selectedTools(
      args,
      runtime.runtimeExtensions.tools().map((tool) => tool.definition.name),
      {
        ...optionalProperties(configuredTools.enabled === undefined ? undefined : { allowedTools: configuredTools.enabled }),
        ...optionalProperties(configuredTools.excluded === undefined ? undefined : { excludedTools: configuredTools.excluded }),
      },
    );
    session.setActiveTools(activeToolsForSelection(
      session.getAllTools().map((tool) => tool.name),
      selection,
    ));
    if (configuredModelSelectionPending === session) configuredModelSelectionPending = undefined;
  };
  const bridge = new RpcExtensionUiBridge({ async emit(request) { await writer.send(request); } });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: owner,
    async output(value) { await writer.send(value); },
    promptOptions() {
      const configuredTools = owner.services.runtime.settings.getToolSettings();
      const selection = selectedTools(
        args,
        owner.services.runtime.runtimeExtensions.tools().map((tool) => tool.definition.name),
        {
          ...optionalProperties(configuredTools.enabled === undefined ? undefined : { allowedTools: configuredTools.enabled }),
          ...optionalProperties(configuredTools.excluded === undefined ? undefined : { excludedTools: configuredTools.excluded }),
        },
      );
      return {
        ...optionalProperties(selection.allowedTools === undefined ? undefined : { allowedTools: selection.allowedTools }),
        ...optionalProperties(selection.excludedTools === undefined ? undefined : { excludedTools: selection.excludedTools }),
      };
    },
    async bindSession(session) {
      owner.services.runtime.runtimeExtensions.setDirectUiHandler((extensionId, signal, ownerKey) =>
        bridge.context(extensionId, ownerKey, signal));
      owner.services.runtime.setExtensionShutdownHandler(async () => {
        closing = true;
        input.close();
      });
      await session.bindExtensions({
        mode: "rpc",
        uiContext: bridge.context(
          "runtime",
          "runtime",
          owner.services.runtime.runtimeExtensions.lifecycleSignal(),
        ),
        commandContextActions: createAgentSessionRuntimeCommandActions(owner, session),
        onError(error) {
          void writer.send(createRpcExtensionErrorEvent(error)).catch(() => undefined);
        },
      });
      await applyConfiguredSession(session);
    },
  });
  let recoveryConfiguration: Promise<RpcResponse | undefined> | undefined;
  const commandDispatcher: Pick<RpcRuntimeDispatcher, "dispatch"> = {
    async dispatch(command) {
      if (command.type === "recover_interrupted_run") {
        const previous = recoveryConfiguration;
        const operation = (async (): Promise<RpcResponse | undefined> => {
          if (previous !== undefined) await previous.catch(() => undefined);
          const response = await dispatcher.dispatch(command);
          if (response?.success === true && configuredModelSelectionPending === owner.session) {
            await applyConfiguredSession(owner.session);
          }
          return response;
        })();
        recoveryConfiguration = operation;
        try {
          return await operation;
        } finally {
          if (recoveryConfiguration === operation) recoveryConfiguration = undefined;
        }
      }
      const recovery = recoveryConfiguration;
      if (recovery !== undefined && !PRIORITY_RPC_COMMANDS.has(command.type)) {
        await recovery.catch(() => undefined);
      }
      if (
        configuredModelSelectionPending === owner.session
        && owner.session.suspendedRun === undefined
      ) {
        throw new Error("Configured model selection is still pending after interrupted-run recovery");
      }
      return await dispatcher.dispatch(command);
    },
  };
  const closeInput = (): void => {
    if (closing) return;
    closing = true;
    input.close();
  };
  const uninstallTermination = termination.onTerminate(() => closeInput());
  let started = false;
  let cleanupFlight: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupFlight ??= (async () => {
      closeInput();
      try {
        bridge.close();
        await dispatcher.close();
      } finally {
        await owner.dispose();
      }
    })();
    return cleanupFlight;
  };
  try {
    termination.throwIfTerminated();
    await dispatcher.start();
    started = true;
    termination.throwIfTerminated();
    await runRpcCommandLoop({
      lines: decodeRpcLines(input.stream),
      writer,
      bridge,
      dispatcher: commandDispatcher,
    });
    const failure = await input.failure();
    if (failure !== undefined) throw failure;
  } catch (error) {
    if (!started) throw error;
    if (!closing) {
      const backlog = error instanceof RpcCommandBacklogError ? error : undefined;
      await writer.send(errorResponse(backlog?.id, backlog?.command ?? "parse", error)).catch(() => undefined);
      process.exitCode = 1;
    }
  } finally {
    try {
      await cleanup();
    } finally {
      uninstallTermination();
    }
  }
}
