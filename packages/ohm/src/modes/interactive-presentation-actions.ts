import { Type } from "typebox";
import { Value } from "typebox/value";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import { PORTABLE_PRESENTATION_LIMITS } from "../interfaces/portable-presentation.js";
import type { AgentSession } from "../service/agent-session.js";
import { byteTruncate, sanitizeTerminalText } from "../tui/unicode.js";
import type { InteractiveSessionOperationsTerminal } from "./interactive-session-operations.js";

type ActionTerminal = Pick<InteractiveSessionOperationsTerminal, "choose" | "question" | "notify">;
type ActionSession = Pick<AgentSession, "listPortablePresentations" | "invokePortablePresentationAction">;

function actionLabel(value: string): string {
  return byteTruncate(sanitizeTerminalText(value).replaceAll("\n", " "), 1_024);
}

async function actionInput(
  schema: JsonObject,
  label: string,
  terminal: ActionTerminal,
  signal: AbortSignal,
  depth = 0,
): Promise<JsonValue> {
  signal.throwIfAborted();
  const shownLabel = actionLabel(label);
  const contract = Type.Unsafe(schema);
  const enumeration = schema.enum;
  if (Array.isArray(enumeration) && enumeration.length > 0 && enumeration.length <= 64) {
    return await terminal.choose(shownLabel, enumeration.map((value) => ({ label: actionLabel(JSON.stringify(value)), value })), signal);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.type === "null") return null;
  if (schema.type === "boolean") {
    return await terminal.choose(shownLabel, [{ label: "Yes", value: true }, { label: "No", value: false }], signal);
  }
  if (schema.type === "object" && depth < 8 && isJsonObject(schema.properties)
    && schema.patternProperties === undefined && schema.additionalProperties === false) {
    const properties = Object.entries(schema.properties);
    if (properties.length <= 32 && properties.every(([, field]) => isJsonObject(field))) {
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key) => Value.Check(STRING_VALUE, key)) : []);
      const fields: Array<[string, JsonValue]> = [];
      for (const [name, field] of properties) {
        if (!isJsonObject(field)) continue;
        if (!required.has(name)) {
          const include = await terminal.choose(`Include ${actionLabel(name)}?`, [{ label: "Skip", value: false }, { label: "Include", value: true }], signal);
          if (!include) continue;
        }
        fields.push([name, await actionInput(field, name, terminal, signal, depth + 1)]);
      }
      const value: JsonObject = Object.fromEntries(fields);
      if (!Value.Check(contract, value)) throw new Error(`${shownLabel} does not match the action's input requirements`);
      return value;
    }
  }
  for (;;) {
    signal.throwIfAborted();
    const text = await terminal.question(schema.type === "string" ? `${shownLabel}: ` : `${shownLabel} (JSON): `, signal);
    if (Buffer.byteLength(text, "utf8") > PORTABLE_PRESENTATION_LIMITS.maxActionInputBytes) {
      terminal.notify("Action input exceeds 256 KiB", "error");
      continue;
    }
    let value: JsonValue;
    if (schema.type === "string") value = text;
    else {
      try {
        const parsed: JsonValue = JSON.parse(text);
        if (!isJsonValue(parsed)) throw new Error("Expected JSON");
        value = parsed;
      } catch {
        terminal.notify("Enter a valid JSON value", "error");
        continue;
      }
    }
    if (Value.Check(contract, value)) return value;
    terminal.notify(`${shownLabel} does not match the action's input requirements`, "error");
  }
}

/** Invoke the same revision-checked plugin actions exposed by RPC and the SDK. */
export async function runInteractivePresentationAction(
  session: ActionSession,
  terminal: ActionTerminal,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const presentations = session.listPortablePresentations()
    .filter((event) => event.operation === "show")
    .filter((event) => event.presentation.actions.some((action) => action.disabled !== true));
  if (presentations.length === 0) {
    terminal.notify("No plugin actions are available");
    return;
  }
  const selected = presentations.length === 1 ? presentations[0]! : await terminal.choose(
    "Plugin views",
    presentations.map((event) => ({
      label: actionLabel(event.presentation.title ?? event.presentation.id),
      detail: actionLabel(event.owner),
      value: event,
    })),
    signal,
  );
  const action = await terminal.choose(
    actionLabel(selected.presentation.title ?? "Plugin actions"),
    selected.presentation.actions.filter((entry) => entry.disabled !== true).map((entry) => ({
      label: actionLabel(entry.label),
      value: entry,
    })),
    signal,
  );
  const input = await actionInput(action.inputSchema, action.label, terminal, signal);
  signal.throwIfAborted();
  const response = await session.invokePortablePresentationAction({
    protocolVersion: 1,
    owner: selected.owner,
    presentationId: selected.presentation.id,
    revision: selected.presentation.revision,
    actionId: action.id,
    input,
  }, signal);
  const result = response.result === null ? "" : `\n${byteTruncate(sanitizeTerminalText(
    defaultSecretRedactor.redact(JSON.stringify(response.result, null, 2)),
  ), 16 * 1024)}`;
  terminal.notify(`${actionLabel(action.label)} completed${result}`);
}
