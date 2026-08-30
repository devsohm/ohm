import { SecretRedactor, type AuthCredential } from "ohm/auth";
import { SettingsManager, type Settings } from "ohm/config";
import { deriveContextBudget, estimateToolDefinitionTokens, type ContextBudget } from "ohm/context";
import { HarnessError, type RuntimeEvent } from "ohm/core";
import { defineTool, type ExtensionFactory } from "ohm/extensions";
import { createImagesModels, type ImagesModels } from "ohm/images";
import {
  RpcClient,
  RpcWriter,
  parseRpcInput,
  type RpcCommand,
  type RpcResponse,
} from "ohm/interfaces";
import { createNetworkTransport, type NetworkTransport } from "ohm/net";
import { DirectProcessRunner, type ProcessRunner } from "ohm/process";
import { buildSystemPrompt } from "ohm/prompts";
import { ModelRegistry, ProviderRegistry, type ProviderModel } from "ohm/providers";
import { AgentSession, buildHarnessResourceCatalog, type HarnessResourceCatalog } from "ohm/service";
import {
  startServeServer,
  type ServeCreateSessionRequest,
  type ServeOpenSessionRequest,
  type ServeServer,
  type ServeSessionFactory,
  type ServeSessionRuntime,
  type StartServeServerOptions,
} from "ohm/serve";
import {
  SessionManager,
  type ExtensionSessionProvenance,
  type SessionBranchQuery,
  type SessionEntry,
} from "ohm/storage";
import {
  ToolRegistry,
  ToolResourceArbiter,
  type HarnessTool,
  type ToolResourceLease,
} from "ohm/tools";
import {
  fuzzyScore,
  uiText,
  type RuntimeUiView,
  type Theme,
  type TuiControllerOptions,
} from "ohm/tui";

const fixedViewportOptions = { mode: "full" } satisfies TuiControllerOptions;
// @ts-expect-error The product rich viewport has no selectable screen host.
const removedScreenOverride: TuiControllerOptions = { alternateScreen: false };
void [fixedViewportOptions, removedScreenOverride];

export const layerValues = [
  SecretRedactor,
  SettingsManager,
  deriveContextBudget,
  estimateToolDefinitionTokens,
  HarnessError,
  defineTool,
  createImagesModels,
  RpcClient,
  RpcWriter,
  parseRpcInput,
  createNetworkTransport,
  DirectProcessRunner,
  buildSystemPrompt,
  ModelRegistry,
  ProviderRegistry,
  AgentSession,
  buildHarnessResourceCatalog,
  startServeServer,
  SessionManager,
  ToolRegistry,
  ToolResourceArbiter,
  fuzzyScore,
  uiText,
] as const;

declare const serveRuntime: ServeSessionRuntime;
void serveRuntime.suspendedRun?.effects.map((effect) => `${effect.effectId}:${effect.status}`);
void serveRuntime.recoverInterruptedRun({
  resolutions: [{ effectId: "verified-effect", outcome: "abandoned" }],
});

export interface LayerConsumerContracts {
  auth: AuthCredential;
  config: Settings;
  context: ContextBudget;
  extension: ExtensionFactory;
  images: ImagesModels;
  command: RpcCommand;
  response: RpcResponse;
  event: RuntimeEvent;
  net: NetworkTransport;
  process: ProcessRunner;
  resourceLease: ToolResourceLease;
  model: ProviderModel;
  catalog: HarnessResourceCatalog;
  serve: {
    create: ServeCreateSessionRequest;
    open: ServeOpenSessionRequest;
    server: ServeServer;
    factory: ServeSessionFactory;
    runtime: ServeSessionRuntime;
    options: StartServeServerOptions;
  };
  entry: SessionEntry;
  extensionSessionProvenance: ExtensionSessionProvenance;
  branchQuery: SessionBranchQuery;
  tool: HarnessTool;
  tui: Theme & { view?: RuntimeUiView };
}
