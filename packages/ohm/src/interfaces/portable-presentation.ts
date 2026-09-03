import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import {
  BOOLEAN_VALUE,
  FUNCTION_VALUE,
  NUMBER_VALUE,
  OBJECT_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";

export const PORTABLE_PRESENTATION_PROTOCOL_VERSION = 1 as const;

export const PORTABLE_PRESENTATION_LIMITS = Object.freeze({
  maxActionInputBytes: 256 * 1024,
  maxActionResultBytes: 256 * 1024,
  maxActions: 64,
  maxBlocks: 256,
  maxDocumentBytes: 512 * 1024,
  maxFieldBytes: 64 * 1024,
  maxListItems: 512,
  maxSnapshotBytes: 8 * 1024 * 1024,
});

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const OWNER = /^[A-Za-z0-9@][A-Za-z0-9@/_.:-]{0,255}$/u;
const PRESENTATION_ROLES = ["normal", "muted", "accent", "success", "warning", "error"] as const;
const ACTION_STYLES = ["default", "primary", "danger"] as const;

const PRESENTATION_ACTION_REQUEST_SOURCE_VALUE = Type.Object({
  protocolVersion: Type.Optional(Type.Unknown()),
  owner: Type.Optional(Type.Unknown()),
  presentationId: Type.Optional(Type.Unknown()),
  revision: Type.Optional(Type.Unknown()),
  actionId: Type.Optional(Type.Unknown()),
  input: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });

export type PortablePresentationRole = (typeof PRESENTATION_ROLES)[number];
export type PortablePresentationActionStyle = (typeof ACTION_STYLES)[number];

export interface PortablePresentationTextBlock {
  readonly type: "text";
  readonly text: string;
  readonly role?: PortablePresentationRole;
}

export interface PortablePresentationMarkdownBlock {
  readonly type: "markdown";
  readonly markdown: string;
}

export interface PortablePresentationFieldsBlock {
  readonly type: "fields";
  readonly fields: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export interface PortablePresentationListBlock {
  readonly type: "list";
  readonly items: readonly string[];
  readonly ordered?: boolean;
}

export interface PortablePresentationProgressBlock {
  readonly type: "progress";
  readonly value: number;
  readonly max: number;
  readonly label?: string;
}

export type PortablePresentationBlock =
  | PortablePresentationTextBlock
  | PortablePresentationMarkdownBlock
  | PortablePresentationFieldsBlock
  | PortablePresentationListBlock
  | PortablePresentationProgressBlock;

export interface PortablePresentationAction {
  readonly id: string;
  readonly label: string;
  readonly inputSchema: JsonObject;
  readonly style?: PortablePresentationActionStyle;
  readonly disabled?: boolean;
}

/** JSON-only view shared by terminal, RPC, serve, web, and desktop adapters. */
export interface PortablePresentationDocument {
  readonly protocolVersion: typeof PORTABLE_PRESENTATION_PROTOCOL_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly title?: string;
  readonly blocks: readonly PortablePresentationBlock[];
  readonly actions: readonly PortablePresentationAction[];
}

export interface PortablePresentationActionDefinition<
  TInputSchema extends TSchema = TSchema,
> {
  readonly id: string;
  readonly label: string;
  readonly inputSchema: TInputSchema;
  readonly style?: PortablePresentationActionStyle;
  readonly disabled?: boolean;
  run(input: Static<TInputSchema>, context: PortablePresentationActionContext):
    | JsonValue
    | Promise<JsonValue>;
}

export interface PortablePresentationDefinition {
  readonly id: string;
  readonly revision?: number;
  readonly title?: string;
  readonly blocks: readonly PortablePresentationBlock[];
  readonly actions?: readonly PortablePresentationActionDefinition[];
}

/** Preserve a TypeBox input schema's static type when authoring an action. */
export function definePortablePresentationAction<TInputSchema extends TSchema>(
  action: PortablePresentationActionDefinition<TInputSchema>,
): PortablePresentationActionDefinition<TInputSchema> {
  return action;
}

export interface PortablePresentationActionContext {
  readonly signal: AbortSignal;
  readonly owner: string;
  readonly presentationId: string;
  readonly revision: number;
  readonly actionId: string;
}

export interface PortablePresentationActionRequest {
  readonly protocolVersion: typeof PORTABLE_PRESENTATION_PROTOCOL_VERSION;
  readonly owner: string;
  readonly presentationId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly input: JsonValue;
}

export interface PortablePresentationActionResult {
  readonly protocolVersion: typeof PORTABLE_PRESENTATION_PROTOCOL_VERSION;
  readonly owner: string;
  readonly presentationId: string;
  readonly revision: number;
  readonly actionId: string;
  readonly result: JsonValue;
}

export type PortablePresentationEvent =
  | {
      readonly type: "portable_presentation";
      readonly protocolVersion: typeof PORTABLE_PRESENTATION_PROTOCOL_VERSION;
      readonly operation: "show";
      readonly owner: string;
      readonly presentation: PortablePresentationDocument;
    }
  | {
      readonly type: "portable_presentation";
      readonly protocolVersion: typeof PORTABLE_PRESENTATION_PROTOCOL_VERSION;
      readonly operation: "remove";
      readonly owner: string;
      readonly presentationId: string;
      readonly revision: number;
    };

export interface PortablePresentationController {
  readonly document: PortablePresentationDocument;
  invoke(request: PortablePresentationActionRequest, signal?: AbortSignal): Promise<PortablePresentationActionResult>;
}

interface PortablePresentationActionOwner {
  id: string;
  label: string;
  inputSchema: JsonObject;
  style?: PortablePresentationActionStyle;
  disabled?: boolean;
}

interface PortablePresentationDocumentOwner {
  protocolVersion: typeof PORTABLE_PRESENTATION_PROTOCOL_VERSION;
  id: string;
  revision: number;
  title?: string;
  blocks: readonly PortablePresentationBlock[];
  actions: readonly PortablePresentationAction[];
}

interface ValidatedPortablePresentationDefinition {
  document: PortablePresentationDocument;
  actions: ReadonlyMap<string, PortablePresentationActionDefinition>;
}

function matchesSource<SchemaType extends TSchema, ValueType>(schema: SchemaType, value: ValueType): boolean {
  return Value.Check(schema, value);
}

function boundedString<ValueType>(
  value: ValueType,
  label: string,
  maximumBytes = PORTABLE_PRESENTATION_LIMITS.maxFieldBytes,
): string {
  if (!Value.Check(STRING_VALUE, value) || value.includes("\0")) {
    throw new TypeError(`${label} must be a NUL-free string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new RangeError(`${label} exceeds ${maximumBytes} bytes`);
  return value;
}

function identifier<ValueType>(value: ValueType, label: string): string {
  if (!Value.Check(STRING_VALUE, value) || !IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function ownerIdentifier<ValueType>(value: ValueType, label: string): string {
  if (!Value.Check(STRING_VALUE, value) || !OWNER.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function nonNegativeInteger<ValueType>(value: ValueType, label: string): number {
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function exact<ValueType extends object>(value: ValueType, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new TypeError(`${label}.${unexpected} is not allowed`);
}

function finiteNumber<ValueType>(value: ValueType, label: string): number {
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function presentationRole<ValueType>(value: ValueType, label: string): PortablePresentationRole {
  const selected = Value.Check(STRING_VALUE, value)
    ? PRESENTATION_ROLES.find((candidate) => candidate === value)
    : undefined;
  if (selected === undefined) throw new TypeError(`${label} is invalid`);
  return selected;
}

function actionStyle<ValueType>(value: ValueType, label: string): PortablePresentationActionStyle {
  const selected = Value.Check(STRING_VALUE, value)
    ? ACTION_STYLES.find((candidate) => candidate === value)
    : undefined;
  if (selected === undefined) throw new TypeError(`${label} is invalid`);
  return selected;
}

function presentationBlock(value: PortablePresentationBlock, index: number): PortablePresentationBlock {
  const label = `Portable presentation block ${index}`;
  if (!matchesSource(OBJECT_VALUE, value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const type = value.type;
  if (type === "text") {
    exact(value, ["type", "text", "role"], label);
    const text = boundedString(value.text, `${label}.text`);
    if (value.role === undefined) {
      return Object.freeze({ type, text });
    }
    return Object.freeze({ type, text, role: presentationRole(value.role, `${label}.role`) });
  }
  if (type === "markdown") {
    exact(value, ["type", "markdown"], label);
    return Object.freeze({
      type,
      markdown: boundedString(value.markdown, `${label}.markdown`),
    });
  }
  if (type === "fields") {
    exact(value, ["type", "fields"], label);
    const { fields } = value;
    if (!Array.isArray(fields) || fields.length > PORTABLE_PRESENTATION_LIMITS.maxListItems) {
      throw new RangeError(`${label}.fields exceeds ${PORTABLE_PRESENTATION_LIMITS.maxListItems} entries`);
    }
    return Object.freeze({
      type,
      fields: Object.freeze(fields.map((fieldValue, fieldIndex) => {
        const fieldLabel = `${label}.fields[${fieldIndex}]`;
        if (!matchesSource(OBJECT_VALUE, fieldValue)) {
          throw new TypeError(`${fieldLabel} must be an object`);
        }
        exact(fieldValue, ["label", "value"], fieldLabel);
        return Object.freeze({
          label: boundedString(fieldValue.label, `${fieldLabel}.label`, 4 * 1024),
          value: boundedString(fieldValue.value, `${fieldLabel}.value`),
        });
      })),
    });
  }
  if (type === "list") {
    exact(value, ["type", "items", "ordered"], label);
    const { items } = value;
    if (!Array.isArray(items) || items.length > PORTABLE_PRESENTATION_LIMITS.maxListItems) {
      throw new RangeError(`${label}.items exceeds ${PORTABLE_PRESENTATION_LIMITS.maxListItems} entries`);
    }
    if (value.ordered !== undefined && !Value.Check(BOOLEAN_VALUE, value.ordered)) {
      throw new TypeError(`${label}.ordered must be boolean`);
    }
    const selectedItems = Object.freeze(items.map((item, itemIndex) =>
      boundedString(item, `${label}.items[${itemIndex}]`)));
    if (value.ordered === undefined) return Object.freeze({ type, items: selectedItems });
    return Object.freeze({ type, items: selectedItems, ordered: value.ordered });
  }
  if (type === "progress") {
    exact(value, ["type", "value", "max", "label"], label);
    const max = finiteNumber(value.max, `${label}.max`);
    const progress = finiteNumber(value.value, `${label}.value`);
    if (max <= 0 || progress < 0 || progress > max) {
      throw new RangeError(`${label} progress must be between zero and max`);
    }
    if (value.label === undefined) return Object.freeze({ type, value: progress, max });
    return Object.freeze({
      type,
      value: progress,
      max,
      label: boundedString(value.label, `${label}.label`, 4 * 1024),
    });
  }
  throw new TypeError(`${label}.type is invalid`);
}

function deepFreezeJson<ValueType extends JsonValue>(value: ValueType): ValueType {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current === null || Value.Check(STRING_VALUE, current)
      || Value.Check(NUMBER_VALUE, current) || Value.Check(BOOLEAN_VALUE, current)
      || Object.isFrozen(current)) continue;
    Object.freeze(current);
    pending.push(...Object.values(current));
  }
  return value;
}

function schemaSnapshot(schema: TSchema, label: string): JsonObject {
  const snapshot = structuredClone(boundedJsonSnapshot(schema, {
    label,
    maximumBytes: PORTABLE_PRESENTATION_LIMITS.maxActionInputBytes,
    maximumValues: 16_384,
    maximumContainers: 4_096,
    maximumDepth: 64,
    ignoredNonEnumerableDataKeys: ["~kind", "~optional", "~readonly"],
  }).value);
  if (!isJsonObject(snapshot)) throw new TypeError(`${label} must be a JSON object`);
  return deepFreezeJson(snapshot);
}

function jsonSnapshot(
  value: PortablePresentationDocument,
  label: string,
  maximumBytes: number,
): PortablePresentationDocument;
function jsonSnapshot<ValueType>(value: ValueType, label: string, maximumBytes: number): JsonValue;
function jsonSnapshot<ValueType>(
  value: ValueType,
  label: string,
  maximumBytes: number,
): JsonValue | PortablePresentationDocument {
  return deepFreezeJson(structuredClone(boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: 16_384,
    maximumContainers: 4_096,
    maximumDepth: 64,
  }).value));
}

function validateDefinition(definition: PortablePresentationDefinition): ValidatedPortablePresentationDefinition {
  if (!matchesSource(OBJECT_VALUE, definition)) {
    throw new TypeError("Portable presentation must be an object");
  }
  exact(definition, ["id", "revision", "title", "blocks", "actions"], "Portable presentation");
  const id = identifier(definition.id, "Portable presentation ID");
  const revision = definition.revision === undefined
    ? 0
    : nonNegativeInteger(definition.revision, "Portable presentation revision");
  const { blocks } = definition;
  if (!Array.isArray(blocks) || blocks.length > PORTABLE_PRESENTATION_LIMITS.maxBlocks) {
    throw new RangeError(`Portable presentation blocks exceed ${PORTABLE_PRESENTATION_LIMITS.maxBlocks} entries`);
  }
  const actionValues = definition.actions ?? [];
  if (!Array.isArray(actionValues) || actionValues.length > PORTABLE_PRESENTATION_LIMITS.maxActions) {
    throw new RangeError(`Portable presentation actions exceed ${PORTABLE_PRESENTATION_LIMITS.maxActions} entries`);
  }
  const actions = new Map<string, PortablePresentationActionDefinition>();
  const actionDocuments = actionValues.map((actionValue, index): PortablePresentationAction => {
    const label = `Portable presentation action ${index}`;
    if (!matchesSource(OBJECT_VALUE, actionValue)) {
      throw new TypeError(`${label} must be an object`);
    }
    exact(actionValue, ["id", "label", "inputSchema", "style", "disabled", "run"], label);
    const actionId = identifier(actionValue.id, `${label} ID`);
    if (actions.has(actionId)) throw new TypeError(`Portable presentation action ${actionId} is duplicated`);
    if (!Value.Check(FUNCTION_VALUE, actionValue.run)) throw new TypeError(`${label}.run must be a function`);
    const style = actionValue.style === undefined
      ? undefined
      : actionStyle(actionValue.style, `${label}.style`);
    if (actionValue.disabled !== undefined && !Value.Check(BOOLEAN_VALUE, actionValue.disabled)) {
      throw new TypeError(`${label}.disabled must be boolean`);
    }
    const inputSchema = schemaSnapshot(actionValue.inputSchema, `${label} input schema`);
    const selected: PortablePresentationActionDefinition = Object.freeze({
      ...actionValue,
      id: actionId,
      inputSchema,
    });
    actions.set(actionId, selected);
    const actionDocument: PortablePresentationActionOwner = {
      id: actionId,
      label: boundedString(actionValue.label, `${label}.label`, 4 * 1024),
      inputSchema,
    };
    if (style !== undefined) actionDocument.style = style;
    if (actionValue.disabled !== undefined) actionDocument.disabled = actionValue.disabled;
    return Object.freeze(actionDocument);
  });
  const selectedBlocks = Object.freeze(blocks.map(presentationBlock));
  const selectedActions = Object.freeze(actionDocuments);
  let documentOwner: PortablePresentationDocumentOwner;
  if (definition.title === undefined) {
    documentOwner = {
      protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
      id,
      revision,
      blocks: selectedBlocks,
      actions: selectedActions,
    };
  } else {
    documentOwner = {
      protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
      id,
      revision,
      title: boundedString(definition.title, "Portable presentation title", 8 * 1024),
      blocks: selectedBlocks,
      actions: selectedActions,
    };
  }
  const document = Object.freeze(documentOwner);
  jsonSnapshot(document, "Portable presentation document", PORTABLE_PRESENTATION_LIMITS.maxDocumentBytes);
  return { document, actions };
}

export function validatePortablePresentationActionRequest<ValueType>(
  value: ValueType,
): PortablePresentationActionRequest {
  if (!Value.Check(PRESENTATION_ACTION_REQUEST_SOURCE_VALUE, value)) {
    throw new TypeError("Portable presentation action request must be an object");
  }
  exact(
    value,
    ["protocolVersion", "owner", "presentationId", "revision", "actionId", "input"],
    "Portable presentation action request",
  );
  if (value.protocolVersion !== PORTABLE_PRESENTATION_PROTOCOL_VERSION) {
    throw new TypeError("Portable presentation action protocol version is unsupported");
  }
  return Object.freeze({
    protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
    owner: ownerIdentifier(value.owner, "Portable presentation action owner"),
    presentationId: identifier(value.presentationId, "Portable presentation action presentation ID"),
    revision: nonNegativeInteger(value.revision, "Portable presentation action revision"),
    actionId: identifier(value.actionId, "Portable presentation action ID"),
    input: jsonSnapshot(
      value.input,
      "Portable presentation action input",
      PORTABLE_PRESENTATION_LIMITS.maxActionInputBytes,
    ),
  });
}

function validateActionRequest<ValueType>(
  value: ValueType,
  document: PortablePresentationDocument,
  owner: string,
): PortablePresentationActionRequest {
  const input = validatePortablePresentationActionRequest(value);
  if (input.owner !== owner) {
    throw new TypeError("Portable presentation action owner does not match");
  }
  if (input.presentationId !== document.id) {
    throw new TypeError("Portable presentation action presentation does not match");
  }
  if (input.revision !== document.revision) {
    throw new TypeError("Portable presentation action revision is stale");
  }
  return input;
}

/** Build an immutable controller whose action boundary is schema and size checked. */
export function createPortablePresentation(
  ownerValue: string,
  definition: PortablePresentationDefinition,
  options: { readonly signal?: AbortSignal } = {},
): PortablePresentationController {
  const owner = ownerIdentifier(ownerValue, "Portable presentation owner");
  const { document, actions } = validateDefinition(definition);
  const lifecycle = options.signal;
  const controller: PortablePresentationController = {
    document,
    async invoke(value: PortablePresentationActionRequest, signal?: AbortSignal) {
      lifecycle?.throwIfAborted();
      signal?.throwIfAborted();
      const request = validateActionRequest(value, document, owner);
      const action = actions.get(request.actionId);
      if (action === undefined) throw new TypeError(`Portable presentation action ${request.actionId} is unavailable`);
      if (action.disabled === true) throw new TypeError(`Portable presentation action ${request.actionId} is disabled`);
      if (!Value.Check(action.inputSchema, request.input)) {
        throw new TypeError(`Portable presentation action ${request.actionId} input does not match its schema`);
      }
      const selectedSignal = lifecycle === undefined
        ? signal ?? new AbortController().signal
        : signal === undefined
          ? lifecycle
          : AbortSignal.any([lifecycle, signal]);
      selectedSignal.throwIfAborted();
      const result = jsonSnapshot(await action.run(request.input, Object.freeze({
        signal: selectedSignal,
        owner,
        presentationId: document.id,
        revision: document.revision,
        actionId: request.actionId,
      })), "Portable presentation action result", PORTABLE_PRESENTATION_LIMITS.maxActionResultBytes);
      selectedSignal.throwIfAborted();
      return Object.freeze({
        protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
        owner,
        presentationId: document.id,
        revision: document.revision,
        actionId: request.actionId,
        result,
      });
    },
  };
  return Object.freeze(controller);
}

function visibleText(value: string): string {
  return [...value].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint > 31 || codePoint === 9 || codePoint === 10 || codePoint === 13)
      && (codePoint < 127 || codePoint > 159);
  }).join("");
}

/** Deterministic plain-text projection shared by line and accessibility hosts. */
export function projectPortablePresentationToLines(
  document: PortablePresentationDocument,
  options: { readonly accessible?: boolean } = {},
): readonly string[] {
  const lines: string[] = [];
  if (document.title !== undefined) lines.push(visibleText(document.title));
  for (const block of document.blocks) {
    if (block.type === "text") lines.push(...visibleText(block.text).split(/\r?\n/u));
    else if (block.type === "markdown") lines.push(...visibleText(block.markdown).split(/\r?\n/u));
    else if (block.type === "fields") {
      for (const field of block.fields) lines.push(`${visibleText(field.label)}: ${visibleText(field.value)}`);
    } else if (block.type === "list") {
      for (const [index, item] of block.items.entries()) {
        lines.push(`${block.ordered === true ? `${index + 1}.` : "-"} ${visibleText(item)}`);
      }
    } else {
      const percent = Math.round(block.value / block.max * 100);
      lines.push(`${block.label === undefined ? "Progress" : visibleText(block.label)}: ${percent}%`);
    }
  }
  const actions = document.actions.filter((action) => action.disabled !== true);
  if (actions.length > 0) {
    lines.push(options.accessible === true ? "Available actions:" : "Actions:");
    for (const action of actions) lines.push(`- ${visibleText(action.label)} [${action.id}]`);
  }
  return Object.freeze(lines);
}

export function portablePresentationShowEvent(
  ownerValue: string,
  document: PortablePresentationDocument,
): PortablePresentationEvent {
  const owner = ownerIdentifier(ownerValue, "Portable presentation owner");
  const presentation = jsonSnapshot(
    document,
    "Portable presentation event document",
    PORTABLE_PRESENTATION_LIMITS.maxDocumentBytes,
  );
  return Object.freeze({
    type: "portable_presentation",
    protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
    operation: "show",
    owner,
    presentation,
  });
}

export function portablePresentationRemoveEvent(
  ownerValue: string,
  presentationIdValue: string,
  revisionValue: number,
): PortablePresentationEvent {
  return Object.freeze({
    type: "portable_presentation",
    protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
    operation: "remove",
    owner: ownerIdentifier(ownerValue, "Portable presentation owner"),
    presentationId: identifier(presentationIdValue, "Portable presentation ID"),
    revision: nonNegativeInteger(revisionValue, "Portable presentation revision"),
  });
}
