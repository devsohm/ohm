import { optionalProperties } from "../../core/optional-properties.js";
import { isJsonObject, type JsonValue } from "../../core/json.js";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { preprocessImage, sniffImageMediaType } from "../../images/preprocess.js";
import { inspectImage } from "../image-info.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool, type StandaloneToolDefinition } from "../direct-tool.js";
import { assertSchema } from "../schema.js";
import { providerInputSchema } from "../parameter-schema.js";
import { inputObject, stringInput } from "../input.js";
import { safeIntegerInput } from "../integer-input.js";
import {
  displayToolPath,
  MAX_TOOL_SOURCE_FILE_BYTES,
  readFileSnapshotBounded,
  resolveToolReadPath,
  snapshotRegularFile,
} from "../paths.js";
import {
  formatBytes,
  isToolTruncation,
  TOOL_MAX_BYTES,
  TOOL_MAX_LINES,
  truncateToolHead,
  type ToolTruncation,
} from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

const readParameters = Type.Object({
  path: Type.String({ description: "File path. It can be absolute or relative to the workspace." }),
  offset: Type.Optional(Type.Integer({
    description: "First text line to return, starting at 1. Defaults to 1; use the returned continuation offset for the next page.",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })),
  limit: Type.Optional(Type.Integer({
    description: `Requested text line count. Each response still stops at ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024} KiB.`,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })),
});

export type ReadToolInput = Static<typeof readParameters>;
export interface ReadToolDetails { truncation?: ToolTruncation }
export interface ReadOperations {
  readFile(path: string): Promise<Buffer>;
  access(path: string): Promise<void>;
  detectImageMimeType?(path: string): Promise<string | null | undefined>;
}
export interface ReadToolOptions { autoResizeImages?: boolean; operations?: ReadOperations }

const schema = providerInputSchema(readParameters);

function textMetadata(
  path: string,
  offset: number,
  totalLines: number,
  truncation: ToolTruncation,
  nextOffset?: number,
): JsonValue {
  return {
    path,
    offset,
    totalLines,
    totalBytes: truncation.totalBytes,
    shownLines: truncation.outputLines,
    truncated: truncation.truncated || nextOffset !== undefined,
    ...optionalProperties(nextOffset === undefined ? undefined : { nextOffset }),
    ...optionalProperties(truncation.truncated ? { truncation: { ...truncation } } : undefined),
  };
}

export class ReadTool implements HarnessTool {
  readonly recovery = { mode: "repeatable" } as const;
  readonly #autoResizeImages: boolean;
  readonly #operations: ReadOperations | undefined;

  constructor(options: ReadToolOptions = {}) {
    this.#autoResizeImages = options.autoResizeImages ?? true;
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "read",
    description: `Read a text file or attach a JPEG, PNG, GIF, WebP, or BMP image. Text starts at the 1-based offset (default 1) and returns up to limit lines, capped at ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024} KiB per response. Images ignore offset and limit.`,
    promptSnippet: "Load text or an image from a file",
    promptGuidelines: [
      "Use read to inspect file contents before editing them.",
      "For truncated text, continue at the offset reported by read; increasing limit does not remove the response cap. A single oversized line needs a targeted shell command.",
    ],
    inputSchema: schema,
  };

  validate(input: JsonValue): void {
    assertSchema(schema, input);
  }

  async resources(input: JsonValue, context: ToolContext): Promise<ResourceClaim[]> {
    const requested = stringInput(inputObject(input), "path");
    return [{ kind: "file", key: await resolveToolReadPath(requested, context.workspace.root), mode: "read" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    this.validate(input);
    const object = inputObject(input);
    const requested = stringInput(object, "path");
    const absolute = await resolveToolReadPath(requested, context.workspace.root);
    const shownPath = displayToolPath(absolute, context.workspace.root);
    context.signal.throwIfAborted();
    let bytes: Buffer;
    let detected: string | undefined;
    if (this.#operations !== undefined) {
      await this.#operations.access(absolute);
      context.signal.throwIfAborted();
      bytes = await this.#operations.readFile(absolute);
      if (bytes.byteLength > MAX_TOOL_SOURCE_FILE_BYTES) {
        throw new Error(`File is too large to read safely (${formatBytes(bytes.byteLength)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
      }
      detected = (await this.#operations.detectImageMimeType?.(absolute)) ?? undefined;
    } else {
      await fsAccess(absolute, constants.R_OK);
      context.signal.throwIfAborted();
      const initial = await snapshotRegularFile(absolute);
      if (initial.snapshot.size > MAX_TOOL_SOURCE_FILE_BYTES) {
        throw new Error(`File is too large to read safely (${formatBytes(initial.snapshot.size)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
      }
      const loaded = await readFileSnapshotBounded(absolute, MAX_TOOL_SOURCE_FILE_BYTES);
      if (loaded.truncated) {
        throw new Error(`File is too large to read safely (${formatBytes(loaded.totalBytes)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
      }
      bytes = loaded.data;
      detected = sniffImageMediaType(bytes);
    }
    context.signal.throwIfAborted();

    if (detected !== undefined && IMAGE_TYPES.has(detected)) {
      const modelImageNote = context.activeModel !== undefined && !context.activeModel.input.includes("image")
        ? "[The selected model cannot receive images, so this attachment is not sent.]"
        : undefined;
      try {
        const image = await preprocessImage(bytes, {
          signal: context.signal,
          autoResize: this.#autoResizeImages,
        });
        const info = inspectImage(image.bytes);
        if (info === undefined) throw new Error("Processed image could not be validated");
        const notes = [`Loaded image (${image.mediaType}).`];
        if (image.sourceMediaType !== image.mediaType) {
          notes.push(`Converted image: ${image.sourceMediaType} -> ${image.mediaType}.`);
        }
        if (image.coordinates.resized) {
          notes.push(`Resized image: ${image.coordinates.originalWidth}x${image.coordinates.originalHeight} -> ${image.coordinates.width}x${image.coordinates.height}.`);
        }
        if (modelImageNote !== undefined) notes.push(modelImageNote);
        return {
          content: notes.join("\n"),
          isError: false,
          images: [{ type: "image", mediaType: image.mediaType, data: Buffer.from(image.bytes).toString("base64") }],
          metadata: {
            path: shownPath,
            mediaType: image.mediaType,
            width: info.width,
            height: info.height,
            totalBytes: bytes.byteLength,
            resized: image.coordinates.resized,
          },
        };
      } catch (error) {
        const notes = [
          `Detected image (${detected}).`,
          `Image attachment skipped: ${error instanceof Error ? error.message : String(error)}`,
          ...(modelImageNote === undefined ? [] : [modelImageNote]),
        ];
        return {
          content: notes.join("\n"),
          isError: false,
          metadata: { path: shownPath, mediaType: detected, totalBytes: bytes.byteLength, omitted: true },
        };
      }
    }

    const text = bytes.toString("utf8");
    const offset = safeIntegerInput(object, "offset", 1, 1);
    const start = offset - 1;
    const requestedLimit = object.limit === undefined ? undefined : safeIntegerInput(object, "limit", 1, 1);
    const requestedEnd = requestedLimit === undefined ? undefined : start + requestedLimit;
    let totalLines = 1;
    let startCharacter = 0;
    let endCharacter = text.length;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1)) {
      if (totalLines === start) startCharacter = newline + 1;
      if (totalLines === requestedEnd) endCharacter = newline;
      totalLines++;
    }
    if (start >= totalLines) {
      const detail = `Cannot start at line ${offset}; this file contains ${totalLines} lines`;
      throw new Error(detail);
    }
    const end = requestedEnd === undefined ? totalLines : Math.min(requestedEnd, totalLines);
    const selected = text.slice(startCharacter, endCharacter);
    const truncated = truncateToolHead(selected);
    if (truncated.truncatedBy === "bytes" && !truncated.firstLineExceedsLimit
      && truncated.content.length < selected.length && selected[truncated.content.length] !== "\n") {
      // Offsets address whole lines, so leave the byte-clipped line for the next page.
      truncated.content = truncated.content.slice(0, truncated.content.lastIndexOf("\n"));
      truncated.outputLines = truncated.content.split("\n").length;
      truncated.outputBytes = Buffer.byteLength(truncated.content, "utf8");
    }
    const firstShown = start + 1;
    let content: string;
    let nextOffset: number | undefined;

    if (truncated.firstLineExceedsLimit) {
      const newline = selected.indexOf("\n");
      const size = formatBytes(Buffer.byteLength(newline === -1 ? selected : selected.slice(0, newline), "utf8"));
      content = `[Line ${firstShown} is ${size}, above the ${formatBytes(TOOL_MAX_BYTES)} read limit.]`;
    } else if (truncated.truncated) {
      const lastShown = firstShown + truncated.outputLines - 1;
      nextOffset = lastShown + 1;
      const byteNote = truncated.truncatedBy === "bytes" ? ` (${formatBytes(TOOL_MAX_BYTES)} limit)` : "";
      content = `${truncated.content}\n\n[Returned lines ${firstShown}-${lastShown} of ${totalLines}${byteNote}. Continue at offset=${nextOffset}.]`;
    } else if (requestedLimit !== undefined && end < totalLines) {
      nextOffset = end + 1;
      content = `${truncated.content}\n\n[${totalLines - end} lines remain. Continue at offset=${nextOffset}.]`;
    } else {
      content = truncated.content;
    }

    return {
      content,
      isError: false,
      metadata: textMetadata(shownPath, firstShown, totalLines, truncated, nextOffset),
    };
  }
}

function readDetails(result: ToolResult): ReadToolDetails | undefined {
  const metadata = result.metadata;
  if (!isJsonObject(metadata) || !isToolTruncation(metadata.truncation)) return undefined;
  return { truncation: metadata.truncation };
}

export function createReadToolDefinition(
  cwd: string,
  options?: ReadToolOptions,
): StandaloneToolDefinition<typeof readParameters, ReadToolDetails | undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new ReadTool(options),
    label: "read",
    parameters: readParameters,
    details: readDetails,
  });
}

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<typeof readParameters, ReadToolDetails | undefined> {
  return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
