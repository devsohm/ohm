import type { JsonValue } from "../../core/json.js";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { withFileMutation } from "../file-mutation-queue.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool, type StandaloneToolDefinition } from "../direct-tool.js";
import { inputObject, stringInput } from "../input.js";
import { atomicWritePath, displayToolPath, resolveToolPath } from "../paths.js";
import { assertSchema } from "../schema.js";
import { providerInputSchema } from "../parameter-schema.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const writeParameters = Type.Object({
  path: Type.String({ description: "Target file path. It can be absolute or relative to the workspace." }),
  content: Type.String({ description: "Complete replacement text, not a patch or text to append." }),
});
const schema = providerInputSchema(writeParameters);

export type WriteToolInput = Static<typeof writeParameters>;
export interface WriteOperations {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
export interface WriteToolOptions { operations?: WriteOperations }

export class WriteTool implements HarnessTool {
  readonly recovery = { mode: "never_repeat" } as const;
  readonly #operations: WriteOperations | undefined;

  constructor(options: WriteToolOptions = {}) {
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "write",
    description: "Write the complete contents of one file, replacing all existing text. Creates the file and missing parent directories if needed; it does not append or apply a patch.",
    promptSnippet: "Store a complete file",
    promptGuidelines: ["Use write for a new file or an intentional whole-file replacement. Use edit for partial changes to an existing file."],
    inputSchema: schema,
  };

  validate(input: JsonValue): void {
    assertSchema(schema, input);
  }

  resources(input: JsonValue, context: ToolContext): ResourceClaim[] {
    const requested = stringInput(inputObject(input), "path");
    return [{ kind: "file", key: resolveToolPath(requested, context.workspace.root), mode: "write" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    this.validate(input);
    const object = inputObject(input);
    const requested = stringInput(object, "path");
    const content = stringInput(object, "content");
    const absolute = resolveToolPath(requested, context.workspace.root);
    const shownPath = displayToolPath(absolute, context.workspace.root);

    return await withFileMutation(absolute, async () => {
      const throwIfAborted = (): void => context.signal.throwIfAborted();
      throwIfAborted();
      if (this.#operations === undefined) {
        await atomicWritePath(absolute, Buffer.from(content, "utf8"), {
          createParents: true,
          signal: context.signal,
        });
      } else {
        await this.#operations.mkdir(dirname(absolute));
        throwIfAborted();
        await this.#operations.writeFile(absolute, content);
      }
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: `Successfully wrote ${bytes} bytes to ${requested}`,
        isError: false,
        metadata: { path: shownPath, bytes },
      };
    });
  }
}

export function createWriteToolDefinition(
  cwd: string,
  options?: WriteToolOptions,
): StandaloneToolDefinition<typeof writeParameters, undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new WriteTool(options),
    label: "write",
    parameters: writeParameters,
    details: () => undefined,
  });
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeParameters, undefined> {
  return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
