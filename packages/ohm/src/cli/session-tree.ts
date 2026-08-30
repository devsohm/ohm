import { optionalProperties } from "../core/optional-properties.js";
import type { PickerItem, SessionTreeMetadata } from "../tui/types.js";
import {
  isRecordValue,
  isStringValue,
  type RuntimeRecord,
  type RuntimeValue,
} from "../tui/value-guards.js";
import type { PersistedSessionMessage, SessionEntry, SessionTreeNode } from "../storage/types.js";

const MAX_PREVIEW_CHARACTERS = 500;
const MAX_VISIBLE_ANCESTOR_DEPTH = 12;

interface SessionEntryPreview {
  kind: string;
  text: string;
}

function previewRecord(value: RuntimeValue): RuntimeRecord | undefined {
  return isRecordValue(value) ? value : undefined;
}

function previewString(value: RuntimeValue): string | undefined {
  return isStringValue(value) ? value : undefined;
}

function contentText(content: RuntimeValue): string {
  if (isStringValue(content)) return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const value = previewRecord(block);
    if (value === undefined) return [];
    const type = value["type"];
    const text = value["text"];
    const name = value["name"];
    if (type === "text" && isStringValue(text)) return [text];
    if ((type === "tool_call" || type === "toolCall") && isStringValue(name)) {
      return [`[tool: ${name}]`];
    }
    return [];
  }).join(" ");
}

function compactPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_PREVIEW_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_PREVIEW_CHARACTERS - 1)}…`;
}

function assistantContainsOnlyToolCalls(message: PersistedSessionMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  let hasToolCall = false;
  let hasVisibleContent = false;
  for (const block of message.content) {
    const value = previewRecord(block);
    if (value === undefined) continue;
    const type = value["type"];
    const text = value["text"];
    if (type === "tool_call" || type === "toolCall") hasToolCall = true;
    if (type === "text" && isStringValue(text) && text.trim() !== "") {
      hasVisibleContent = true;
    }
    if (type === "image") hasVisibleContent = true;
    const thinking = value["thinking"];
    if (
      type === "thinking"
      && value["redacted"] !== true
      && value["visibility"] !== "provider_trace"
      && isStringValue(thinking)
      && thinking.trim() !== ""
    ) {
      hasVisibleContent = true;
    }
  }
  const stopReason = previewString(message.stopReason);
  const failed = stopReason !== undefined
    && stopReason !== "stop"
    && stopReason !== "tool_calls"
    && stopReason !== "toolUse";
  return hasToolCall && !hasVisibleContent && !failed;
}

function messagePreview(message: PersistedSessionMessage): SessionEntryPreview {
  if (message.role === "bashExecution") {
    return { kind: "bash", text: compactPreview(message.command) || "Shell command" };
  }
  if (message.role === "custom") {
    return { kind: "custom", text: compactPreview(contentText(message.content)) || message.customType };
  }
  const role = previewString(message.role) ?? "message";
  const text = compactPreview(contentText(message.content));
  if (assistantContainsOnlyToolCalls(message)) {
    return { kind: "tool_call", text: text || "Assistant tool call" };
  }
  return { kind: role === "toolResult" ? "tool" : role, text: text || `${role} message` };
}

export function sessionEntryPreview(entry: SessionEntry): SessionEntryPreview {
  if (entry.type === "message") return messagePreview(entry.message);
  if (entry.type === "custom_message") {
    return { kind: "custom", text: compactPreview(contentText(entry.content)) || entry.customType };
  }
  if (entry.type === "compaction") {
    return { kind: "compaction", text: compactPreview(entry.summary) || "Context compaction" };
  }
  if (entry.type === "branch_summary") {
    return { kind: "branch_summary", text: compactPreview(entry.summary) || "Branch summary" };
  }
  if (entry.type === "model_change") return { kind: "model", text: `${entry.provider}/${entry.modelId}` };
  if (entry.type === "thinking_level_change") return { kind: "thinking", text: `Thinking: ${entry.thinkingLevel}` };
  if (entry.type === "label") return { kind: "label", text: entry.label ? `Label: ${entry.label}` : "Label cleared" };
  if (entry.type === "session_info") return { kind: "session", text: entry.name ? `Session: ${entry.name}` : "Session metadata" };
  return { kind: entry.type, text: entry.type };
}

interface TreeFrame {
  node: SessionTreeNode;
  depth: number;
  isLast: boolean;
  ancestorLast: boolean[];
}

function visibleAncestors(depth: number): boolean[] {
  return Array.from({ length: Math.min(depth, MAX_VISIBLE_ANCESTOR_DEPTH) }, () => true);
}

function childAncestors(frame: TreeFrame): boolean[] {
  const selected = [...frame.ancestorLast, frame.isLast];
  return selected.length <= MAX_VISIBLE_ANCESTOR_DEPTH
    ? selected
    : selected.slice(-MAX_VISIBLE_ANCESTOR_DEPTH);
}

function treePrefix(frame: TreeFrame): string {
  const omitted = frame.depth > frame.ancestorLast.length ? "… " : "";
  return `${omitted}${frame.ancestorLast.map((last) => last ? "   " : "│  ").join("")}${frame.isLast ? "└─ " : "├─ "}`;
}

/** Build bounded, display-only rows without recursing through deep session trees. */
export function sessionTreePickerItems(
  roots: readonly SessionTreeNode[],
  activeEntryIds: ReadonlySet<string>,
): Array<PickerItem<string> & { tree: SessionTreeMetadata }> {
  const rows: Array<PickerItem<string> & { tree: SessionTreeMetadata }> = [];
  const stack: TreeFrame[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const node = roots[index]!;
    const depth = node.depth ?? 0;
    stack.push({
      node,
      depth,
      isLast: index === roots.length - 1,
      ancestorLast: visibleAncestors(depth),
    });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { entry, children } = frame.node;
    const preview = sessionEntryPreview(entry);
    const prefix = treePrefix(frame);
    rows.push({
      id: entry.id,
      label: preview.text,
      detail: `${preview.kind} · ${entry.timestamp}`,
      keywords: [entry.id, entry.type, preview.kind],
      value: entry.id,
      tree: {
        eventId: entry.id,
        ...optionalProperties(entry.parentId === null ? undefined : { parentEventId: entry.parentId }),
        kind: preview.kind,
        depth: frame.depth,
        prefix,
        branches: children.length > 1 ? children.map((child) => child.entry.id) : [],
        paths: [activeEntryIds.has(entry.id) ? "active" : "alternate"],
        active: activeEntryIds.has(entry.id),
        ...optionalProperties(frame.node.label === undefined ? undefined : { label: frame.node.label }),
        ...optionalProperties(frame.node.labelTimestamp === undefined ? undefined : { labelTimestamp: frame.node.labelTimestamp }),
      },
    });

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index]!,
        depth: children[index]!.depth ?? frame.depth + 1,
        isLast: index === children.length - 1,
        ancestorLast: childAncestors(frame),
      });
    }
  }
  return rows;
}
