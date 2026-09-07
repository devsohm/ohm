import type { ToolDefinition } from "../plugins/direct.js";
import { isHarnessTool, type AgentSessionTool } from "./direct-tool.js";

export function customToolInventory(tools: readonly AgentSessionTool[]) {
  const names: string[] = [];
  const direct = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (isHarnessTool(tool)) {
      names.push(tool.definition.name);
      direct.delete(tool.definition.name);
    } else {
      if ("definition" in tool) {
        void tool.definition;
        throw new TypeError("Custom harness tool has an invalid definition");
      }
      names.push(tool.name);
      direct.set(tool.name, tool);
    }
  }
  return { names, direct: [...direct.values()] };
}
