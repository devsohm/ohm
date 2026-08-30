import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";

import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

type JsonSchema = JsonObject;

interface CoercionContext {
  root: JsonSchema;
  ids: Map<string, JsonSchema>;
}

const validatorCache = new WeakMap<object, SchemaValidator>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
const MAX_COERCION_DEPTH = 256;

interface SchemaValidator {
  Check<Value>(value: Value): boolean;
  Errors<Value>(value: Value): TLocalizedValidationError[];
}

function schemaObject<Value>(value: Value): value is Value & JsonSchema {
  return isJsonObject(value);
}

function typeBoxSchema(schema: JsonSchema): boolean {
  return Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
}

function validatorFor(schema: JsonSchema): SchemaValidator {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) return cached;
  const compiled = Compile(schema);
  const validator: SchemaValidator = {
    Check(value) {
      try {
        return compiled.Check(value);
      } catch {
        // Preserve compiled validation as the fast path, but do not let a
        // generated validator defect reject a value the interpreter accepts.
        return Value.Check(schema, value);
      }
    },
    Errors(value) {
      try {
        return compiled.Errors(value);
      } catch {
        return Value.Errors(schema, value);
      }
    },
  };
  validatorCache.set(schema, validator);
  return validator;
}

function collectSchemaIds(value: JsonValue, ids: Map<string, JsonSchema>, visited: Set<object>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaIds(entry, ids, visited);
    return;
  }
  if (!schemaObject(value) || visited.has(value)) return;
  visited.add(value);
  if (Value.Check(STRING_VALUE, value.$id) && value.$id !== "") ids.set(value.$id, value);
  for (const entry of Object.values(value)) collectSchemaIds(entry, ids, visited);
}

function coercionContext(root: JsonSchema): CoercionContext {
  const ids = new Map<string, JsonSchema>();
  collectSchemaIds(root, ids, new Set());
  return { root, ids };
}

function decodePointerToken(value: string): string {
  return decodeURIComponent(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

function followPointer(root: JsonSchema, pointer: string): JsonSchema | undefined {
  if (pointer === "" || pointer === "#") return schemaObject(root) ? root : undefined;
  const fragment = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!fragment.startsWith("/")) return undefined;
  let value: JsonValue | undefined = root;
  try {
    for (const token of fragment.slice(1).split("/")) {
      const decoded = decodePointerToken(token);
      if (Array.isArray(value)) {
        const index = Number(decoded);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== decoded) return undefined;
        value = value[index];
      } else if (schemaObject(value)) {
        value = value[decoded];
      } else {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return schemaObject(value) ? value : undefined;
}

function resolveReference(reference: string, context: CoercionContext): JsonSchema | undefined {
  if (reference.startsWith("#")) return followPointer(context.root, reference);
  const fragmentAt = reference.indexOf("#");
  const id = fragmentAt === -1 ? reference : reference.slice(0, fragmentAt);
  const base = context.ids.get(id);
  if (base === undefined) return undefined;
  return fragmentAt === -1 ? base : followPointer(base, reference.slice(fragmentAt));
}

function declaredTypes(schema: JsonSchema): string[] {
  if (Value.Check(STRING_VALUE, schema.type)) return [schema.type];
  return Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => Value.Check(STRING_VALUE, entry))
    : [];
}

function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return Value.Check(BOOLEAN_VALUE, value);
    case "integer": return Value.Check(NUMBER_VALUE, value) && Number.isInteger(value);
    case "null": return value === null;
    case "number": return Value.Check(NUMBER_VALUE, value);
    case "object": return schemaObject(value);
    case "string": return Value.Check(STRING_VALUE, value);
    default: return false;
  }
}

function coercePrimitive(value: JsonValue, type: string): JsonValue {
  switch (type) {
    case "number": {
      if (value === null) return 0;
      if (Value.Check(BOOLEAN_VALUE, value)) return value ? 1 : 0;
      if (!Value.Check(STRING_VALUE, value) || value.trim() === "") return value;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "integer": {
      if (value === null) return 0;
      if (Value.Check(BOOLEAN_VALUE, value)) return value ? 1 : 0;
      if (!Value.Check(STRING_VALUE, value) || value.trim() === "") return value;
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : value;
    }
    case "boolean":
      if (value === null) return false;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      return value;
    case "string":
      if (value === null) return "";
      return Value.Check(NUMBER_VALUE, value) || Value.Check(BOOLEAN_VALUE, value) ? String(value) : value;
    case "null":
      return value === "" || value === 0 || value === false ? null : value;
    default:
      return value;
  }
}

function schemaWithRootDefinitions(schema: JsonSchema, context: CoercionContext): JsonSchema {
  if (schema === context.root || context.root.$defs === undefined || schema.$defs !== undefined) return schema;
  return { ...schema, $defs: context.root.$defs };
}

function schemaAccepts(schema: JsonSchema, value: JsonValue, context: CoercionContext): boolean {
  try {
    return Value.Check(
      Object.fromEntries(context.ids),
      schemaWithRootDefinitions(schema, context),
      value,
    );
  } catch {
    return false;
  }
}

function coerceUnion(value: JsonValue, schemas: JsonValue[], context: CoercionContext, depth: number): JsonValue {
  for (const schema of schemas) {
    if (!schemaObject(schema)) continue;
    const candidate = structuredClone(value);
    const coerced = coercePlainJsonSchema(candidate, schema, context, depth + 1);
    if (schemaAccepts(schema, coerced, context)) return coerced;
  }
  return value;
}

function coerceObject(value: JsonSchema, schema: JsonSchema, context: CoercionContext, depth: number): void {
  const properties = schemaObject(schema.properties) ? schema.properties : undefined;
  const known = new Set(properties === undefined ? [] : Object.keys(properties));
  if (properties !== undefined) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      const entry = value[name];
      if (entry !== undefined && schemaObject(propertySchema)) {
        value[name] = coercePlainJsonSchema(entry, propertySchema, context, depth + 1);
      }
    }
  }
  if (schemaObject(schema.additionalProperties)) {
    for (const [name, entry] of Object.entries(value)) {
      if (!known.has(name)) {
        value[name] = coercePlainJsonSchema(entry, schema.additionalProperties, context, depth + 1);
      }
    }
  }
}

function coerceArray(value: JsonValue[], schema: JsonSchema, context: CoercionContext, depth: number): void {
  if (Array.isArray(schema.items)) {
    const count = Math.min(value.length, schema.items.length);
    for (let index = 0; index < count; index += 1) {
      const itemSchema = schema.items[index];
      const entry = value[index];
      if (entry !== undefined && schemaObject(itemSchema)) {
        value[index] = coercePlainJsonSchema(entry, itemSchema, context, depth + 1);
      }
    }
    return;
  }
  if (schemaObject(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry !== undefined) value[index] = coercePlainJsonSchema(entry, schema.items, context, depth + 1);
    }
  }
}

function coercePlainJsonSchema(
  value: JsonValue,
  schema: JsonSchema,
  context: CoercionContext,
  depth = 0,
): JsonValue {
  if (depth > MAX_COERCION_DEPTH) return value;
  let result = value;

  if (Value.Check(STRING_VALUE, schema.$ref)) {
    const referenced = resolveReference(schema.$ref, context);
    if (referenced !== undefined && referenced !== schema) {
      result = coercePlainJsonSchema(result, referenced, context, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf) {
      if (schemaObject(entry)) result = coercePlainJsonSchema(result, entry, context, depth + 1);
    }
  }
  if (Array.isArray(schema.anyOf)) result = coerceUnion(result, schema.anyOf, context, depth);
  if (Array.isArray(schema.oneOf)) result = coerceUnion(result, schema.oneOf, context, depth);

  const types = declaredTypes(schema);
  const alreadyMatchesUnion = types.length > 1 && types.some((type) => matchesType(result, type));
  if (types.length > 0 && !alreadyMatchesUnion) {
    for (const type of types) {
      const candidate = coercePrimitive(result, type);
      if (candidate !== result) {
        result = candidate;
        break;
      }
    }
  }

  if (types.includes("object") && schemaObject(result)) coerceObject(result, schema, context, depth);
  if (types.includes("array") && Array.isArray(result)) coerceArray(result, schema, context, depth);
  return result;
}

function formatPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const properties = isJsonObject(error.params) ? error.params.requiredProperties : undefined;
    if (Array.isArray(properties) && Value.Check(STRING_VALUE, properties[0])) {
      return `${pointerPath(error.instancePath)}.${properties[0]}`.replace(/^\$\./u, "$.");
    }
  }
  return pointerPath(error.instancePath);
}

function pointerPath(pointer: string): string {
  if (pointer === "") return "$";
  try {
    const parts = pointer.replace(/^\//u, "").split("/").map(decodePointerToken);
    return `$${parts.map((part) => /^\d+$/u.test(part) ? `[${part}]` : `.${part}`).join("")}`;
  } catch {
    return "$";
  }
}

function issuesFor(validator: SchemaValidator, value: JsonValue): ValidationIssue[] {
  return validator.Errors(value).map((error) => ({ path: formatPath(error), message: error.message }));
}

/** Ensures a schema can be consumed by the TypeBox compiler. */
export function assertSupportedSchema(schema: JsonObject): void {
  try {
    validatorFor(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool schema: ${message}`);
  }
}

/**
 * Returns a detached, coerced input using TypeBox conversion rules followed by
 * JSON-Schema coercion for schemas that crossed a serialization boundary.
 */
export function coerceSchemaValue(schema: JsonObject, value: JsonValue): JsonValue {
  const input = structuredClone(value);
  const converted = Value.Convert(schema, input);
  if (!isJsonValue(converted)) throw new Error("Tool schema conversion produced a non-JSON value");
  let coerced = converted;
  if (!typeBoxSchema(schema)) {
    coerced = coercePlainJsonSchema(coerced, schema, coercionContext(schema));
  }
  if (!isJsonValue(coerced)) throw new Error("Tool schema conversion produced a non-JSON value");
  return coerced;
}

export function validateSchema(schema: JsonObject, value: JsonValue): ValidationIssue[] {
  const validator = validatorFor(schema);
  const coerced = coerceSchemaValue(schema, value);
  return validator.Check(coerced) ? [] : issuesFor(validator, coerced);
}

/** Returns the detached, coerced input or throws with all schema errors. */
export function assertSchema(schema: JsonObject, value: JsonValue): JsonValue {
  const validator = validatorFor(schema);
  const coerced = coerceSchemaValue(schema, value);
  if (validator.Check(coerced)) return coerced;
  const issues = issuesFor(validator, coerced);
  throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") || "Tool input is invalid");
}
