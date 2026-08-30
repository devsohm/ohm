import { optionalProperties } from "./optional-properties.js";
import {
  RuntimeEngine as KernelRuntimeEngine,
  RunControl,
  type AgentLifecycleObserver,
  type AgentRunRequest as KernelAgentRunRequest,
  type AgentRunResult,
} from "@ohm/kernel/runtime/core/agent";
import type {
  ToolExecutionObserver,
  ToolExecutionPort,
} from "@ohm/kernel/runtime/tools/execution";

import type { ToolCoordinator, ToolCoordinatorObserver } from "../tools/coordinator.js";
import type { ToolContext } from "../tools/types.js";
import type { EventSink } from "./events.js";
import type { RunId, ThreadId } from "./ids.js";
import type { ConversationPort } from "./ports.js";
import type { RetryPolicy } from "./retry.js";

export {
  RunControl,
  assertQueuedRunMessages,
  attachQueuedRunDelivery,
  cloneQueuedRunMessage,
  queuedMessageSizes,
  queuedRunDeliveryId,
  queuedRunDeliveryMessageId,
} from "@ohm/kernel/runtime/core/agent";
export type {
  AgentCompactionDirective,
  AgentExtensionReducers,
  AgentExtensionRunScope,
  AgentFinalizedAssistantReduction,
  AgentFinalizedAssistantResponse,
  AgentLifecycleObserver,
  AgentRunResult,
  AgentTurnSelection,
  AgentTurnSelectionContext,
  QueueMode,
  QueuedRunDeliveryReceipt,
  QueuedRunMessage,
} from "@ohm/kernel/runtime/core/agent";

export interface AgentRunRequest extends Omit<KernelAgentRunRequest, "operationId" | "tools"> {
  /** Stable caller-supplied identity for this operation. A generated run id is used when omitted. */
  operationId?: string;
  tools: ToolCoordinator;
  toolContext: Omit<ToolContext, "eventSink" | "signal" | "runId" | "threadId">;
}

function executionObserver(observer: ToolExecutionObserver): ToolCoordinatorObserver {
  return {
    ...optionalProperties(observer.transformed === undefined ? undefined : { transformed: observer.transformed }),
    ...optionalProperties(observer.started === undefined ? undefined : { started: observer.started }),
    ...optionalProperties(observer.dispatching === undefined ? undefined : { dispatching: observer.dispatching }),
    ...optionalProperties(observer.progress === undefined ? undefined : { progress: observer.progress }),
    ...optionalProperties(observer.completed === undefined ? undefined : { completed: observer.completed }),
  };
}

function executionPort(request: AgentRunRequest): ToolExecutionPort {
  return {
    turnSnapshot: () => request.tools.turnSnapshot(),
    execute: (invocations, context, observer, options) => request.tools.execute(
      invocations,
      { ...request.toolContext, ...context },
      executionObserver(observer),
      options,
    ),
  };
}

function kernelRequest(request: AgentRunRequest): KernelAgentRunRequest {
  return {
    ...request,
    tools: executionPort(request),
  };
}

export class AgentRunner {
  readonly #runner: KernelRuntimeEngine;

  constructor(options: {
    conversation: ConversationPort;
    events: (threadId: ThreadId, runId: RunId, branch: string | undefined, signal: AbortSignal) => EventSink;
    retry?: RetryPolicy;
    random?: () => number;
    lifecycle?: AgentLifecycleObserver;
  }) {
    this.#runner = new KernelRuntimeEngine(options);
  }

  run(
    request: AgentRunRequest,
    control?: RunControl,
    continuation = false,
  ): Promise<AgentRunResult> {
    return this.#runner.run(kernelRequest(request), control, continuation);
  }
}
