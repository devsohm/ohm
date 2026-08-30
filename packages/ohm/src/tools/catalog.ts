import type { ToolDefinition } from "../extensions/direct.js";
import {
  createBashTool,
  createBashToolDefinition,
  type BashToolOptions,
} from "./builtins/shell.js";
import {
  createEditTool,
  createEditToolDefinition,
  type EditToolOptions,
} from "./builtins/edit.js";
import {
  createFindTool,
  createFindToolDefinition,
  type FindToolOptions,
} from "./builtins/find.js";
import {
  createGrepTool,
  createGrepToolDefinition,
  type GrepToolOptions,
} from "./builtins/grep.js";
import {
  createLsTool,
  createLsToolDefinition,
  type LsToolOptions,
} from "./builtins/ls.js";
import {
  createReadTool,
  createReadToolDefinition,
  type ReadToolOptions,
} from "./builtins/read.js";
import {
  createWriteTool,
  createWriteToolDefinition,
  type WriteToolOptions,
} from "./builtins/write.js";
import type { AgentTool } from "./direct-tool.js";

export const allToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const codingToolNames = ["read", "bash", "edit", "write"] as const;
const readOnlyToolNames = ["read", "grep", "find", "ls"] as const;

export type ToolName = (typeof allToolNames)[number];
export type Tool = AgentTool;
export type ToolDef = ToolDefinition;
type ToolDefinitions = { [Name in ToolName]: ToolDef };
type ToolCatalog = { [Name in ToolName]: Tool };

export interface ToolsOptions {
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  edit?: EditToolOptions;
  write?: WriteToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

export function createToolDefinition(
  name: ToolName,
  cwd: string,
  options: ToolsOptions = {},
): ToolDef {
  switch (name) {
    case "read": return createReadToolDefinition(cwd, options.read);
    case "bash": return createBashToolDefinition(cwd, options.bash);
    case "edit": return createEditToolDefinition(cwd, options.edit);
    case "write": return createWriteToolDefinition(cwd, options.write);
    case "grep": return createGrepToolDefinition(cwd, options.grep);
    case "find": return createFindToolDefinition(cwd, options.find);
    case "ls": return createLsToolDefinition(cwd, options.ls);
  }
}

export function createTool(
  name: ToolName,
  cwd: string,
  options: ToolsOptions = {},
): Tool {
  switch (name) {
    case "read": return createReadTool(cwd, options.read);
    case "bash": return createBashTool(cwd, options.bash);
    case "edit": return createEditTool(cwd, options.edit);
    case "write": return createWriteTool(cwd, options.write);
    case "grep": return createGrepTool(cwd, options.grep);
    case "find": return createFindTool(cwd, options.find);
    case "ls": return createLsTool(cwd, options.ls);
  }
}

function definitions<const TNames extends readonly ToolName[]>(
  names: TNames,
  cwd: string,
  options: ToolsOptions,
): ToolDef[] {
  return names.map((name) => createToolDefinition(name, cwd, options));
}

function tools<const TNames extends readonly ToolName[]>(
  names: TNames,
  cwd: string,
  options: ToolsOptions,
): Tool[] {
  return names.map((name) => createTool(name, cwd, options));
}

export function createCodingToolDefinitions(cwd: string, options: ToolsOptions = {}): ToolDef[] {
  return definitions(codingToolNames, cwd, options);
}

export function createCodingTools(cwd: string, options: ToolsOptions = {}): Tool[] {
  return tools(codingToolNames, cwd, options);
}

export function createReadOnlyToolDefinitions(cwd: string, options: ToolsOptions = {}): ToolDef[] {
  return definitions(readOnlyToolNames, cwd, options);
}

export function createReadOnlyTools(cwd: string, options: ToolsOptions = {}): Tool[] {
  return tools(readOnlyToolNames, cwd, options);
}

export function createAllToolDefinitions(cwd: string, options: ToolsOptions = {}): ToolDefinitions {
  return {
    read: createToolDefinition("read", cwd, options),
    bash: createToolDefinition("bash", cwd, options),
    edit: createToolDefinition("edit", cwd, options),
    write: createToolDefinition("write", cwd, options),
    grep: createToolDefinition("grep", cwd, options),
    find: createToolDefinition("find", cwd, options),
    ls: createToolDefinition("ls", cwd, options),
  };
}

export function createAllTools(cwd: string, options: ToolsOptions = {}): ToolCatalog {
  return {
    read: createTool("read", cwd, options),
    bash: createTool("bash", cwd, options),
    edit: createTool("edit", cwd, options),
    write: createTool("write", cwd, options),
    grep: createTool("grep", cwd, options),
    find: createTool("find", cwd, options),
    ls: createTool("ls", cwd, options),
  };
}
