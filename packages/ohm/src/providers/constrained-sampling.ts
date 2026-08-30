import { optionalProperties } from "../core/optional-properties.js";
import {
  appendGrammarInputDelta,
  grammarInput,
  grammarSampling,
  grammarToolProperties,
  strictToolValue,
  type GrammarInputBuffer,
  type Tool,
} from "@ohm/models";
import { Type } from "typebox";

import type { JsonObject } from "../core/json.js";
import type { ProviderToolDefinition } from "../core/types.js";

function modelTool(tool: ProviderToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.inputSchema),
    ...optionalProperties(tool.constrainedSampling === undefined ? undefined : { constrainedSampling: tool.constrainedSampling }),
  };
}

export function providerStrictTool(tool: ProviderToolDefinition, supported: boolean): boolean | undefined {
  return strictToolValue(modelTool(tool), supported);
}

export function providerGrammarTool(tool: ProviderToolDefinition, supported: boolean) {
  return grammarSampling(modelTool(tool), supported);
}

export function providerGrammarProperties(
  tools: readonly ProviderToolDefinition[],
  supported: boolean,
): ReadonlyMap<string, string> {
  return grammarToolProperties(tools.map(modelTool), supported);
}

export function providerGrammarInput(toolName: string, arguments_: JsonObject, property: string): string {
  return grammarInput(toolName, arguments_, property);
}

export { appendGrammarInputDelta, type GrammarInputBuffer };
