import type { SessionV4ConversationNode, SessionV4Json } from "@ohm/kernel/session-v4";
import { Value } from "typebox/value";
import { isJsonObject, isJsonValue } from "../core/json.js";
import type { CanonicalMessage, ImageBlock, TextBlock } from "../core/types.js";
import { isNormalizedUsage } from "../core/usage.js";
import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";

export const MESSAGE_CUSTOM_PLUGIN = "ohm.session.message-custom";

/** @internal Lightweight metadata for one-to-many plugin session projection. */
export interface SessionEntryProjectionMetadata {
  id: string;
  parentId: string | null;
  projectedEntryCount: number;
}

export function isTextImageBlock<Input>(value: Input): value is Input & (TextBlock | ImageBlock) {
  if (!isJsonObject(value)) return false;
  if (value.type === "text") {
    return Value.Check(STRING_VALUE, value.text)
      && (value.textSignature === undefined || Value.Check(STRING_VALUE, value.textSignature));
  }
  if (value.type !== "image") return false;
  return Value.Check(STRING_VALUE, value.mediaType)
    && (value.data === undefined || Value.Check(STRING_VALUE, value.data))
    && (value.url === undefined || Value.Check(STRING_VALUE, value.url));
}

export function isStringArray<Input>(value: Input): value is Input & string[] {
  return Array.isArray(value) && value.every((entry) => Value.Check(STRING_VALUE, entry));
}

export function isCanonicalContentBlock<Input>(
  value: Input,
): value is Input & CanonicalMessage["content"][number] {
  if (!isJsonObject(value)) return false;
  switch (value.type) {
    case "text":
      return Value.Check(STRING_VALUE, value.text)
        && (value.textSignature === undefined || Value.Check(STRING_VALUE, value.textSignature));
    case "thinking":
      return Value.Check(STRING_VALUE, value.thinking)
        && (value.thinkingSignature === undefined || Value.Check(STRING_VALUE, value.thinkingSignature))
        && (value.redacted === undefined || Value.Check(BOOLEAN_VALUE, value.redacted))
        && (value.visibility === undefined || value.visibility === "summary" || value.visibility === "provider_trace");
    case "image":
      return isTextImageBlock(value);
    case "tool_call":
      return Value.Check(STRING_VALUE, value.callId)
        && Value.Check(STRING_VALUE, value.name)
        && isJsonValue(value.arguments)
        && (value.rawArguments === undefined || Value.Check(STRING_VALUE, value.rawArguments))
        && (value.thoughtSignature === undefined || Value.Check(STRING_VALUE, value.thoughtSignature));
    case "tool_result":
      return Value.Check(STRING_VALUE, value.callId)
        && Value.Check(STRING_VALUE, value.name)
        && Value.Check(STRING_VALUE, value.content)
        && Value.Check(BOOLEAN_VALUE, value.isError)
        && (value.contentBlocks === undefined || (
          Array.isArray(value.contentBlocks) && value.contentBlocks.every(isTextImageBlock)
        ))
        && (value.status === undefined || value.status === "success" || value.status === "warning" || value.status === "error")
        && (value.summary === undefined || Value.Check(STRING_VALUE, value.summary))
        && (value.nextActions === undefined || isStringArray(value.nextActions))
        && (value.images === undefined || (
          Array.isArray(value.images) && value.images.every((entry) => isTextImageBlock(entry) && entry.type === "image")
        ))
        && (value.artifactIds === undefined || isStringArray(value.artifactIds))
        && (value.metadata === undefined || isJsonValue(value.metadata))
        && (value.usage === undefined || isNormalizedUsage(value.usage))
        && (value.addedToolNames === undefined || isStringArray(value.addedToolNames));
    case "provider_opaque":
      return Value.Check(STRING_VALUE, value.provider)
        && Value.Check(STRING_VALUE, value.mediaType)
        && isJsonValue(value.value)
        && (value.serialized === undefined || Value.Check(STRING_VALUE, value.serialized));
    default:
      return false;
  }
}

export function isCanonicalRole(role: string): role is CanonicalMessage["role"] {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

export function isStoredCanonicalMessage<Input>(value: Input): value is Input & CanonicalMessage {
  if (!isJsonObject(value)) return false;
  return Value.Check(STRING_VALUE, value.id)
    && Value.Check(STRING_VALUE, value.createdAt)
    && Value.Check(STRING_VALUE, value.role)
    && isCanonicalRole(value.role)
    && Array.isArray(value.content)
    && value.content.every(isCanonicalContentBlock)
    && (value.custom === undefined || (isJsonObject(value.custom)
      && Value.Check(STRING_VALUE, value.custom.customType)
      && Value.Check(BOOLEAN_VALUE, value.custom.display)
      && Value.Check(NUMBER_VALUE, value.custom.timestamp)));
}

function projectedMessageEntryCount(value: SessionV4Json, fallbackRole?: string): number {
  let content: CanonicalMessage["content"];
  if (isStoredCanonicalMessage(value)) {
    if (value.role !== "tool" || value.custom !== undefined) return 1;
    content = value.content;
  } else {
    if (fallbackRole !== "tool" || !Array.isArray(value) || !value.every(isCanonicalContentBlock)) return 1;
    content = value;
  }
  const count = content.filter((block) => block.type === "tool_result").length;
  return Math.max(1, count);
}

export function projectedSessionEntryCount(node: SessionV4ConversationNode): number {
  if (node.nodeType === "message") return projectedMessageEntryCount(node.content, node.role);
  if (node.nodeType === "extension_context" && node.extensionId === MESSAGE_CUSTOM_PLUGIN) {
    return projectedMessageEntryCount(node.context);
  }
  return 1;
}
