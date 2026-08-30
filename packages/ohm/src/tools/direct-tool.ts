import { optionalProperties } from "../core/optional-properties.js";
import { isProxy } from "node:util/types";

import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import type { AgentTool as KernelAgentTool } from "@ohm/kernel";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type {
  AgentToolResult,
  ExtensionContext,
  RegisteredTool,
  ToolRenderState,
  ToolDefinition,
} from "../extensions/direct.js";
import {
  canonicalContent,
  canonicalUsage,
  extensionContent,
  extensionUsage,
} from "../extensions/session-contract.js";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import { BOOLEAN_VALUE, FUNCTION_VALUE, isObjectValue, STRING_VALUE } from "../core/value-schemas.js";
import type { ProviderToolDefinition } from "../core/types.js";
import { DirectProcessRunner } from "../process/runner.js";
import { assertSchema } from "./schema.js";
import { WorkspaceBoundary } from "./paths.js";
import type {
  HarnessTool,
  ToolContext,
  ToolExecutionContext,
  ToolResult,
} from "./types.js";

const MAX_DIRECT_DETAILS_BYTES = 16 * 1024;
const MAX_DIRECT_CONTENT_BYTES = 1024 * 1024;
const MAX_DIRECT_VALUES = 65_536;
const MAX_DIRECT_CONTAINERS = 16_384;
const MAX_DIRECT_DEPTH = 64;
const MAX_ADDED_TOOLS = 256;
const MAX_DIRECT_SCHEMA_BYTES = 1024 * 1024;
const STANDALONE_TOOL_EXECUTE = Symbol("ohm.standaloneToolExecute");

const DIRECT_CONTENT_VALUE = Type.Array(Type.Union([
  Type.Object({ type: Type.Literal("text"), text: STRING_VALUE }, { additionalProperties: true }),
  Type.Object({
    type: Type.Literal("image"),
    data: STRING_VALUE,
    mimeType: STRING_VALUE,
  }, { additionalProperties: true }),
]));
const DIRECT_USAGE_VALUE = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Optional(Type.Number()),
  cost: Type.Optional(Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

type DirectToolMetadata<TParameters extends TSchema, TDetails, TState> = Pick<
  ToolDefinition<TParameters, TDetails, TState>,
  | "constrainedSampling"
  | "executionMode"
  | "loading"
  | "prepareArguments"
  | "promptGuidelines"
  | "promptSnippet"
  | "recovery"
  | "renderCall"
  | "renderResult"
  | "renderShell"
  | "resources"
>;

type StandaloneToolExecute<TParameters extends TSchema, TDetails> = (
  toolCallId: string,
  input: Static<TParameters>,
  signal?: AbortSignal,
  onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
) => Promise<AgentToolResult<TDetails>>;

export interface StandaloneToolDefinition<
  TParameters extends TSchema,
  TDetails,
  TState = ToolRenderState,
> extends ToolDefinition<TParameters, TDetails, TState> {
  readonly [STANDALONE_TOOL_EXECUTE]: StandaloneToolExecute<TParameters, TDetails>;
  execute(
    toolCallId: string,
    input: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
    context?: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

/** Agent-loop tool shape augmented with ohm execution and rendering metadata. */
export type AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TState = ToolRenderState,
> = Omit<KernelAgentTool<TParameters, TDetails>, "execute" | "prepareArguments"> &
  DirectToolMetadata<TParameters, TDetails, TState> & {
    execute(
      toolCallId: string,
      params: Static<TParameters>,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
    ): Promise<AgentToolResult<TDetails>>;
  };

export type AgentSessionTool = HarnessTool | ToolDefinition;

export interface HarnessToolDefinitionOptions<
  TParameters extends TSchema,
  TDetails,
> {
  cwd: string;
  tool: HarnessTool;
  label: string;
  parameters: TParameters;
  details(result: ToolResult): TDetails;
}

function boundedClone<T>(value: T, label: string, maximumBytes: number): T {
  boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: MAX_DIRECT_VALUES,
    maximumContainers: MAX_DIRECT_CONTAINERS,
    maximumDepth: MAX_DIRECT_DEPTH,
  });
  return structuredClone(value);
}

function boundedJson<Input>(value: Input, label: string, maximumBytes: number): JsonValue {
  return boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: MAX_DIRECT_VALUES,
    maximumContainers: MAX_DIRECT_CONTAINERS,
    maximumDepth: MAX_DIRECT_DEPTH,
  }).value;
}

interface DirectResultRecord {
  readonly directResultRecord?: undefined;
}

function record<Input>(value: Input, label: string): Input & DirectResultRecord {
  if (!isObjectValue(value) || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function dataField(source: DirectResultRecord, name: string, label: string): JsonValue | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(source, name);
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError(`${label}.${name} must be an enumerable data property`);
  }
  if (descriptor.value === undefined) return undefined;
  if (!isJsonValue(descriptor.value)) throw new TypeError(`${label}.${name} must contain JSON data`);
  return descriptor.value;
}

function addedToolNames<Input>(value: Input): string[] | undefined {
  if (value === undefined) return undefined;
  const snapshot = boundedJson(value, "Tool addedToolNames", 32 * 1024);
  if (!Array.isArray(snapshot) || snapshot.length > MAX_ADDED_TOOLS) {
    throw new TypeError(`Tool addedToolNames must contain at most ${MAX_ADDED_TOOLS} names`);
  }
  const names = snapshot.map((name) => {
    if (!Value.Check(STRING_VALUE, name) || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(name)) {
      throw new TypeError("Tool addedToolNames contains an invalid name");
    }
    return name;
  });
  return [...new Set(names)];
}

function requiredJsonValue<Input>(value: Input, label: string): JsonValue {
  if (!isJsonValue(value)) throw new TypeError(`${label} must be JSON data`);
  return value;
}

function providerInputSchema<Input>(value: Input): JsonObject {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Tool parameter schema",
    maximumBytes: MAX_DIRECT_SCHEMA_BYTES,
    maximumValues: MAX_DIRECT_VALUES,
    maximumContainers: MAX_DIRECT_CONTAINERS,
    maximumDepth: MAX_DIRECT_DEPTH,
    ignoredNonEnumerableDataKeys: [
      "~codec",
      "~immutable",
      "~kind",
      "~optional",
      "~readonly",
      "~refine",
      "~unsafe",
    ],
  }).value;
  if (!isJsonObject(snapshot)) throw new TypeError("Tool parameter schema must be an object");
  return snapshot;
}

function directToolInput<TParameters extends TSchema>(
  schema: TParameters,
  input: JsonValue,
): Static<TParameters> {
  if (!Value.Check(schema, input)) throw new TypeError("Tool input does not match its parameter schema");
  return input;
}

function isStandaloneToolDefinition<TParameters extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
): definition is StandaloneToolDefinition<TParameters, TDetails, TState> {
  const descriptor = Reflect.getOwnPropertyDescriptor(definition, STANDALONE_TOOL_EXECUTE);
  return descriptor !== undefined && "value" in descriptor && Value.Check(FUNCTION_VALUE, descriptor.value);
}

function directResult<Input>(value: Input): ToolResult {
  const selected = record(value, "Tool result");
  const rawContent = dataField(selected, "content", "Tool result") ?? [];
  const contentSnapshot = boundedJson(
    rawContent,
    "Tool result content",
    MAX_DIRECT_CONTENT_BYTES,
  );
  if (!Value.Check(DIRECT_CONTENT_VALUE, contentSnapshot)) {
    throw new TypeError("Tool result content must contain text or image blocks");
  }
  const content = canonicalContent(contentSnapshot);
  let metadata: JsonValue | undefined;
  try {
    const details = dataField(selected, "details", "Tool result");
    if (details !== undefined) metadata = boundedJson(details, "Tool result details", MAX_DIRECT_DETAILS_BYTES);
  } catch {
    metadata = undefined;
  }
  const usage = dataField(selected, "usage", "Tool result");
  const terminate = dataField(selected, "terminate", "Tool result");
  if (terminate !== undefined && !Value.Check(BOOLEAN_VALUE, terminate)) {
    throw new TypeError("Tool result.terminate must be a boolean");
  }
  const names = addedToolNames(dataField(selected, "addedToolNames", "Tool result"));
  const images = content.filter((block) => block.type === "image");
  let normalizedUsage: ToolResult["usage"];
  if (usage !== undefined) {
    const usageSnapshot = boundedJson(usage, "Tool result usage", MAX_DIRECT_DETAILS_BYTES);
    if (!Value.Check(DIRECT_USAGE_VALUE, usageSnapshot)) throw new TypeError("Tool result usage is invalid");
    normalizedUsage = canonicalUsage(usageSnapshot);
  }
  return {
    content: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"),
    contentBlocks: content,
    isError: false,
    ...optionalProperties(normalizedUsage === undefined ? undefined : { usage: normalizedUsage }),
    ...optionalProperties(metadata === undefined ? undefined : { metadata }),
    ...optionalProperties(images.length === 0 ? undefined : { images }),
    ...optionalProperties(names === undefined ? undefined : { addedToolNames: names }),
    ...optionalProperties(terminate === undefined ? undefined : { terminate }),
  };
}

function directContent(result: ToolResult): AgentToolResult["content"] {
  if (result.contentBlocks !== undefined) return extensionContent(result.contentBlocks);
  const blocks: Parameters<typeof extensionContent>[0][number][] = [];
  if (result.content !== "") blocks.push({ type: "text", text: result.content });
  blocks.push(...result.images ?? []);
  return extensionContent(blocks);
}

function publicResult<TDetails>(
  result: ToolResult,
  details: (result: ToolResult) => TDetails,
): AgentToolResult<TDetails> {
  const selectedDetails = details(result);
  const safeDetails = selectedDetails === undefined
    ? selectedDetails
    : boundedClone(selectedDetails, "Tool result details", MAX_DIRECT_DETAILS_BYTES);
  const names = result.addedToolNames === undefined
    ? undefined
    : addedToolNames(result.addedToolNames);
  return {
    content: directContent(result),
    details: safeDetails,
    ...optionalProperties(result.usage === undefined ? undefined : { usage: extensionUsage(result.usage) }),
    ...optionalProperties(names === undefined ? undefined : { addedToolNames: names }),
    ...optionalProperties(result.terminate === undefined ? undefined : { terminate: result.terminate }),
  };
}

function standaloneWorkspace(cwd: string): WorkspaceBoundary {
  try {
    return WorkspaceBoundary.createSync(cwd);
  } catch {
    // Injected filesystem operations are allowed to use a virtual working directory.
    return WorkspaceBoundary.createVirtual(cwd);
  }
}

function standaloneContext(
  cwd: string,
  toolCallId: string,
  signal: AbortSignal,
  reportProgress: ToolContext["reportProgress"],
): ToolExecutionContext {
  return {
    workspace: standaloneWorkspace(cwd),
    runner: new DirectProcessRunner(),
    signal,
    runId: `direct:${toolCallId}`,
    threadId: "direct",
    toolCallId,
    ...optionalProperties(reportProgress === undefined ? undefined : { reportProgress }),
  };
}

/** Project a harness-native tool into the public TypeBox definition contract. */
export function createHarnessToolDefinition<
  TParameters extends TSchema,
  TDetails,
>(options: HarnessToolDefinitionOptions<TParameters, TDetails>): StandaloneToolDefinition<TParameters, TDetails> {
  const definition = options.tool.definition;
  const prepareInput = options.tool.prepareInput;
  const executeStandalone: StandaloneToolExecute<TParameters, TDetails> = async (
    toolCallId,
    input,
    signal,
    onUpdate,
  ) => {
    const selectedSignal = signal ?? new AbortController().signal;
    selectedSignal.throwIfAborted();
    const reportProgress: ToolContext["reportProgress"] = onUpdate === undefined
      ? undefined
      : (progress) => {
          const content = progress.type === "output" ? progress.delta : progress.content;
          const progressResult: ToolResult = {
            content,
            isError: progress.type === "result" && progress.isError,
            ...optionalProperties(progress.type !== "result" || progress.metadata === undefined
              ? undefined
              : { metadata: progress.metadata }),
          };
          onUpdate({
            content: content === "" ? [] : [{ type: "text", text: content }],
            details: options.details(progressResult),
          });
        };
    const result = await options.tool.execute(
      requiredJsonValue(input, "Tool input"),
      standaloneContext(options.cwd, toolCallId, selectedSignal, reportProgress),
    );
    selectedSignal.throwIfAborted();
    if (result.isError) {
      throw new Error(result.content.startsWith("Tool failed: ")
        ? result.content.slice("Tool failed: ".length)
        : result.content);
    }
    return publicResult(result, options.details);
  };
  return {
    name: definition.name,
    label: options.label,
    description: definition.description,
    parameters: options.parameters,
    ...optionalProperties(definition.constrainedSampling === undefined ? undefined : { constrainedSampling: definition.constrainedSampling }),
    ...optionalProperties(definition.loading === undefined ? undefined : { loading: definition.loading }),
    ...optionalProperties(definition.promptSnippet === undefined ? undefined : { promptSnippet: definition.promptSnippet }),
    ...optionalProperties(definition.promptGuidelines === undefined ? undefined : { promptGuidelines: [...definition.promptGuidelines] }),
    ...optionalProperties(prepareInput === undefined ? undefined : {
      prepareArguments: async (input) => directToolInput(
        options.parameters,
        await prepareInput(requiredJsonValue(input, "Tool input"), {
          workspace: standaloneWorkspace(options.cwd),
          runner: new DirectProcessRunner(),
          signal: new AbortController().signal,
          runId: "direct:prepare",
          threadId: "direct",
        }),
      ),
    }),
    ...optionalProperties(options.tool.executionMode === undefined ? undefined : { executionMode: options.tool.executionMode }),
    ...optionalProperties(options.tool.recovery === undefined ? undefined : { recovery: options.tool.recovery }),
    resources: (input, context) => options.tool.resources(requiredJsonValue(input, "Tool input"), context),
    execute: executeStandalone,
    [STANDALONE_TOOL_EXECUTE]: executeStandalone,
  };
}

/** Adapt a public direct tool for the coordinated harness runtime. */
export function createHarnessToolFromDefinition<
  TParameters extends TSchema,
  TDetails,
  TState,
>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
  context: (toolContext: ToolExecutionContext) => ExtensionContext,
): HarnessTool {
  const prepareArguments = definition.prepareArguments;
  const resourceClaims = definition.resources;
  const providerDefinition: ProviderToolDefinition = {
    name: definition.name,
    ...optionalProperties(definition.label === undefined ? undefined : { label: definition.label }),
    description: definition.description,
    inputSchema: providerInputSchema(definition.parameters),
    ...optionalProperties(definition.constrainedSampling === undefined ? undefined : { constrainedSampling: definition.constrainedSampling }),
    ...optionalProperties(definition.loading === undefined ? undefined : { loading: definition.loading }),
    ...optionalProperties(definition.promptSnippet === undefined ? undefined : { promptSnippet: definition.promptSnippet }),
    ...optionalProperties(definition.promptGuidelines === undefined ? undefined : { promptGuidelines: [...definition.promptGuidelines] }),
  };
  return {
    definition: providerDefinition,
    ...optionalProperties(prepareArguments === undefined ? undefined : {
      prepareInput: async (input) => requiredJsonValue(
        await prepareArguments(directToolInput(definition.parameters, input)),
        "Prepared tool input",
      ),
    }),
    ...optionalProperties(definition.executionMode === undefined ? undefined : { executionMode: definition.executionMode }),
    ...optionalProperties(definition.recovery === undefined ? undefined : { recovery: definition.recovery }),
    validate(input): void {
      assertSchema(providerDefinition.inputSchema, input);
    },
    resources: resourceClaims === undefined
      ? () => []
      : (input, toolContext) => resourceClaims(directToolInput(definition.parameters, input), toolContext),
    async execute(input, toolContext) {
      toolContext.signal.throwIfAborted();
      const onUpdate = toolContext.reportProgress === undefined
        ? undefined
        : (partial: AgentToolResult<TDetails>): void => {
            const converted = directResult(partial);
            toolContext.reportProgress?.({
              type: "result",
              content: converted.content,
              isError: false,
              ...optionalProperties(converted.metadata === undefined ? undefined : { metadata: converted.metadata }),
            });
          };
      const result = await definition.execute(
        toolContext.toolCallId,
        directToolInput(definition.parameters, input),
        toolContext.signal,
        onUpdate,
        context(toolContext),
      );
      toolContext.signal.throwIfAborted();
      return directResult(result);
    },
  };
}

/** Retain the public definition while presenting the agent-loop callable shape. */
export function wrapToolDefinition<
  TParameters extends TSchema,
  TDetails,
  TState,
>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
  context?: ExtensionContext,
): AgentTool<TParameters, TDetails, TState> {
  const standaloneExecute = isStandaloneToolDefinition(definition)
    ? definition[STANDALONE_TOOL_EXECUTE]
    : undefined;
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...optionalProperties(definition.constrainedSampling === undefined ? undefined : { constrainedSampling: definition.constrainedSampling }),
    ...optionalProperties(definition.loading === undefined ? undefined : { loading: definition.loading }),
    ...optionalProperties(definition.promptSnippet === undefined ? undefined : { promptSnippet: definition.promptSnippet }),
    ...optionalProperties(definition.promptGuidelines === undefined ? undefined : { promptGuidelines: [...definition.promptGuidelines] }),
    ...optionalProperties(definition.prepareArguments === undefined ? undefined : { prepareArguments: definition.prepareArguments }),
    ...optionalProperties(definition.executionMode === undefined ? undefined : { executionMode: definition.executionMode }),
    ...optionalProperties(definition.recovery === undefined ? undefined : { recovery: definition.recovery }),
    ...optionalProperties(definition.resources === undefined ? undefined : { resources: definition.resources }),
    ...optionalProperties(definition.renderShell === undefined ? undefined : { renderShell: definition.renderShell }),
    ...optionalProperties(definition.renderCall === undefined ? undefined : { renderCall: definition.renderCall }),
    ...optionalProperties(definition.renderResult === undefined ? undefined : { renderResult: definition.renderResult }),
    async execute(toolCallId, params, signal, onUpdate) {
      if (standaloneExecute !== undefined) return await standaloneExecute(toolCallId, params, signal, onUpdate);
      if (context === undefined) {
        throw new Error(`Direct tool ${definition.name} requires an extension context`);
      }
      return await definition.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

/** Recreate a public direct definition from an agent-loop tool. */
export function createToolDefinitionFromAgentTool<
  TParameters extends TSchema,
  TDetails,
  TState,
>(tool: AgentTool<TParameters, TDetails, TState>): StandaloneToolDefinition<TParameters, TDetails, TState> {
  const resourceClaims = tool.resources;
  const executeStandalone: StandaloneToolExecute<TParameters, TDetails> = (
    toolCallId,
    input,
    signal,
    onUpdate,
  ) => tool.execute(toolCallId, input, signal, onUpdate);
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...optionalProperties(tool.constrainedSampling === undefined ? undefined : { constrainedSampling: tool.constrainedSampling }),
    ...optionalProperties(tool.loading === undefined ? undefined : { loading: tool.loading }),
    ...optionalProperties(tool.promptSnippet === undefined ? undefined : { promptSnippet: tool.promptSnippet }),
    ...optionalProperties(tool.promptGuidelines === undefined ? undefined : { promptGuidelines: [...tool.promptGuidelines] }),
    ...optionalProperties(tool.prepareArguments === undefined ? undefined : { prepareArguments: tool.prepareArguments }),
    ...optionalProperties(tool.executionMode === undefined ? undefined : { executionMode: tool.executionMode }),
    ...optionalProperties(tool.recovery === undefined ? undefined : { recovery: tool.recovery }),
    ...optionalProperties(resourceClaims === undefined ? undefined : { resources: (input, context) => resourceClaims(input, context) }),
    ...optionalProperties(tool.renderShell === undefined ? undefined : { renderShell: tool.renderShell }),
    ...optionalProperties(tool.renderCall === undefined ? undefined : { renderCall: tool.renderCall }),
    ...optionalProperties(tool.renderResult === undefined ? undefined : { renderResult: tool.renderResult }),
    execute: executeStandalone,
    [STANDALONE_TOOL_EXECUTE]: executeStandalone,
  };
}

export function wrapRegisteredTool(tool: RegisteredTool, context?: ExtensionContext): AgentTool {
  return wrapToolDefinition(tool.definition, context);
}

export function wrapRegisteredTools(tools: Iterable<RegisteredTool>, context?: ExtensionContext): AgentTool[] {
  return [...tools].map((tool) => wrapRegisteredTool(tool, context));
}

function descriptorAt<Owner extends object>(source: Owner, key: PropertyKey): PropertyDescriptor | undefined {
  let selected: object | null = source;
  while (selected !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(selected, key);
    if (descriptor !== undefined) return descriptor;
    selected = Object.getPrototypeOf(selected);
  }
  return undefined;
}

export function isHarnessTool<Input>(value: Input): value is Input & HarnessTool {
  if (!isObjectValue(value) || isProxy(value)) return false;
  const definitionDescriptor = descriptorAt(value, "definition");
  const definition = definitionDescriptor !== undefined && "value" in definitionDescriptor
    ? definitionDescriptor.value
    : undefined;
  if (!isObjectValue(definition) || isProxy(definition)) return false;
  const name = descriptorAt(definition, "name");
  const validate = descriptorAt(value, "validate");
  const resources = descriptorAt(value, "resources");
  const execute = descriptorAt(value, "execute");
  return name !== undefined && "value" in name && Value.Check(STRING_VALUE, name.value)
    && validate !== undefined && "value" in validate && Value.Check(FUNCTION_VALUE, validate.value)
    && resources !== undefined && "value" in resources && Value.Check(FUNCTION_VALUE, resources.value)
    && execute !== undefined && "value" in execute && Value.Check(FUNCTION_VALUE, execute.value);
}
