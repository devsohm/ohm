import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { JsonObject, JsonValue } from "../core/json.js";
import {
  FUNCTION_VALUE,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";
import type { ExtensionRegistrationHandle } from "./capabilities/internal/api/registration.js";
import type { ExtensionLifecycleCapabilities } from "./capabilities/internal/api/lifecycle.js";

export const EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION = 1 as const;

export const EXTENSION_WIRE_SERVICE_LIMITS = Object.freeze({
  maxPayloadBytes: 1024 * 1024,
  maxSchemaBytes: 64 * 1024,
  maxCatalogBytes: 2 * 1024 * 1024,
  maxCatalogEntries: 256,
  maxValues: 32_768,
  maxContainers: 8_192,
  maxDepth: 64,
});

const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const WIRE_RECORD_VALUE = Type.Record(Type.String(), Type.Unknown());

type WireRecord = Static<typeof WIRE_RECORD_VALUE>;

export interface ExtensionWireServiceContract<
  TRequestSchema extends TSchema = TSchema,
  TResponseSchema extends TSchema = TSchema,
> {
  readonly name: string;
  readonly version: number;
  readonly requestSchema: TRequestSchema;
  readonly responseSchema: TResponseSchema;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface ExtensionWireServiceRequest<TPayload extends JsonValue = JsonValue> {
  readonly protocolVersion: typeof EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION;
  readonly service: string;
  readonly serviceVersion: number;
  readonly id: string;
  readonly payload: TPayload;
}

export type ExtensionWireServiceResponse<TPayload extends JsonValue = JsonValue> =
  | {
      readonly protocolVersion: typeof EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION;
      readonly service: string;
      readonly serviceVersion: number;
      readonly id: string;
      readonly ok: true;
      readonly payload: TPayload;
    }
  | {
      readonly protocolVersion: typeof EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION;
      readonly service: string;
      readonly serviceVersion: number;
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_request" | "handler_failed";
        readonly message: string;
      };
    };

export interface ExtensionWireServiceContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
}

export interface ExtensionWireServiceEndpoint<
  TRequest extends JsonValue = JsonValue,
  TResponse extends JsonValue = JsonValue,
> {
  readonly protocolVersion: typeof EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION;
  readonly name: string;
  readonly version: number;
  readonly requestSchema: JsonObject;
  readonly responseSchema: JsonObject;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  request(
    envelope: ExtensionWireServiceRequest<TRequest>,
    signal?: AbortSignal,
  ): Promise<ExtensionWireServiceResponse<TResponse>>;
}

export interface ExtensionWireServiceDescriptor {
  readonly protocolVersion: typeof EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION;
  readonly name: string;
  readonly version: number;
  readonly owner: string;
  readonly requestSchema: JsonObject;
  readonly responseSchema: JsonObject;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export interface ExtensionWireServiceProvider {
  provide<TRequestSchema extends TSchema, TResponseSchema extends TSchema>(
    contract: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
    handler: (
      request: Static<TRequestSchema>,
      context: ExtensionWireServiceContext,
    ) => Static<TResponseSchema> | Promise<Static<TResponseSchema>>,
  ): ExtensionRegistrationHandle;
  get<TRequestSchema extends TSchema, TResponseSchema extends TSchema>(
    contract: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
  ): ExtensionWireServiceEndpoint<Static<TRequestSchema>, Static<TResponseSchema>> | undefined;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes) {
    throw new RangeError(`${label} must be from 1 through ${EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes}`);
  }
  return selected;
}

function serviceVersion<Candidate>(value: Candidate): number {
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Extension wire service version must be a positive safe integer");
  }
  return value;
}

function contractName<Candidate>(value: Candidate): string {
  if (!Value.Check(STRING_VALUE, value) || !SERVICE_NAME.test(value)) {
    throw new TypeError("Extension wire service name is invalid");
  }
  return value;
}

function requestId<Candidate>(value: Candidate): string {
  if (!Value.Check(STRING_VALUE, value) || !CALL_ID.test(value)) {
    throw new TypeError("Extension wire service request ID is invalid");
  }
  return value;
}

function ownerId<Candidate>(value: Candidate): string {
  if (
    !Value.Check(STRING_VALUE, value)
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 512
  ) throw new TypeError("Extension wire service owner is invalid");
  return value;
}

function exact(value: WireRecord, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new TypeError(`${label}.${unexpected} is not allowed`);
}

function isWireRecord<Candidate>(value: Candidate): value is Candidate & WireRecord {
  return value !== null
    && Object(value) === value
    && !Array.isArray(value)
    && !Value.Check(FUNCTION_VALUE, value);
}

function record<Candidate>(value: Candidate, label: string): WireRecord {
  if (!isWireRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function jsonSnapshot<Candidate>(value: Candidate, label: string, maximumBytes: number): JsonValue {
  const snapshot = structuredClone(boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: EXTENSION_WIRE_SERVICE_LIMITS.maxValues,
    maximumContainers: EXTENSION_WIRE_SERVICE_LIMITS.maxContainers,
    maximumDepth: EXTENSION_WIRE_SERVICE_LIMITS.maxDepth,
  }).value);
  const pending: JsonValue[] = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current !== undefined
      && (Array.isArray(current) || Value.Check(WIRE_RECORD_VALUE, current))
      && !Object.isFrozen(current)
    ) {
      Object.freeze(current);
      pending.push(...Object.values(current));
    }
  }
  return snapshot;
}

function validateSchema<Schema extends TSchema>(schema: Schema, label: string): Schema & JsonObject {
  const snapshot = boundedJsonSnapshot(schema, {
    label,
    maximumBytes: EXTENSION_WIRE_SERVICE_LIMITS.maxSchemaBytes,
    maximumValues: EXTENSION_WIRE_SERVICE_LIMITS.maxValues,
    maximumContainers: EXTENSION_WIRE_SERVICE_LIMITS.maxContainers,
    maximumDepth: EXTENSION_WIRE_SERVICE_LIMITS.maxDepth,
    ignoredNonEnumerableDataKeys: ["~kind", "~optional", "~readonly"],
  }).value;
  if (!Value.Check(WIRE_RECORD_VALUE, snapshot)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const detached = jsonSnapshot(snapshot, label, EXTENSION_WIRE_SERVICE_LIMITS.maxSchemaBytes);
  if (!Value.Check(WIRE_RECORD_VALUE, detached)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  // SAFETY: the bounded clone preserves the admitted schema's JSON contract; the object form was checked above.
  return detached as Schema & JsonObject;
}

function validatedContract<TRequestSchema extends TSchema, TResponseSchema extends TSchema>(
  value: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
): ExtensionWireServiceContract<TRequestSchema, TResponseSchema> & {
  readonly requestSchema: TRequestSchema & JsonObject;
  readonly responseSchema: TResponseSchema & JsonObject;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
} {
  const selected = record(value, "Extension wire service contract");
  exact(
    selected,
    ["name", "version", "requestSchema", "responseSchema", "maxRequestBytes", "maxResponseBytes"],
    "Extension wire service contract",
  );
  const name = contractName(selected["name"]);
  const version = serviceVersion(selected["version"]);
  const requestSchema = validateSchema(value.requestSchema, "Extension wire service request schema");
  const responseSchema = validateSchema(value.responseSchema, "Extension wire service response schema");
  return Object.freeze({
    name,
    version,
    requestSchema,
    responseSchema,
    maxRequestBytes: positiveLimit(value.maxRequestBytes, EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes, "Extension wire service request limit"),
    maxResponseBytes: positiveLimit(value.maxResponseBytes, EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes, "Extension wire service response limit"),
  });
}

export function defineExtensionWireService<
  TRequestSchema extends TSchema,
  TResponseSchema extends TSchema,
>(
  contract: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
): ExtensionWireServiceContract<TRequestSchema, TResponseSchema> {
  return validatedContract(contract);
}

/** Stable registry key used by trusted in-process discovery of one wire endpoint. */
export function extensionWireServiceRegistryName(
  contract: Pick<ExtensionWireServiceContract, "name" | "version">,
): string {
  return `ohm.wire.${contractName(contract.name)}.v${serviceVersion(contract.version)}`;
}

function failure(
  contract: Pick<ExtensionWireServiceContract, "name" | "version">,
  id: string,
  code: "invalid_request" | "handler_failed",
  cause: unknown,
): ExtensionWireServiceResponse<never> {
  const raw = code === "handler_failed"
    ? "Extension wire service handler failed"
    : cause instanceof Error ? cause.message : String(cause);
  const message = Buffer.from(raw, "utf8").subarray(0, 4_096).toString("utf8").replaceAll("\0", "");
  return Object.freeze({
    protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
    service: contract.name,
    serviceVersion: contract.version,
    id,
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

/** Validate and detach an untrusted wire request before broker lookup. */
export function validateExtensionWireServiceRequest<TPayload extends JsonValue>(
  rawEnvelope: ExtensionWireServiceRequest<TPayload>,
): ExtensionWireServiceRequest<TPayload>;
export function validateExtensionWireServiceRequest<Envelope>(
  rawEnvelope: Envelope,
): ExtensionWireServiceRequest;
export function validateExtensionWireServiceRequest<Envelope>(
  rawEnvelope: Envelope,
): ExtensionWireServiceRequest {
  const envelope = record(rawEnvelope, "Extension wire service request");
  exact(
    envelope,
    ["protocolVersion", "service", "serviceVersion", "id", "payload"],
    "Extension wire service request",
  );
  if (envelope["protocolVersion"] !== EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION) {
    throw new TypeError("Extension wire service protocol version is unsupported");
  }
  return Object.freeze({
    protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
    service: contractName(envelope["service"]),
    serviceVersion: serviceVersion(envelope["serviceVersion"]),
    id: requestId(envelope["id"]),
    payload: jsonSnapshot(
      envelope["payload"],
      "Extension wire service request payload",
      EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes,
    ),
  });
}

/** Validate, detach, and bound an endpoint response before it crosses a host transport. */
export function validateExtensionWireServiceResponse<Response>(
  rawResponse: Response,
  requestValue: ExtensionWireServiceRequest,
  maximumPayloadBytes = EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes,
): ExtensionWireServiceResponse {
  const request = validateExtensionWireServiceRequest(requestValue);
  const response = record(rawResponse, "Extension wire service response");
  if (response["ok"] === true) {
    exact(
      response,
      ["protocolVersion", "service", "serviceVersion", "id", "ok", "payload"],
      "Extension wire service response",
    );
  } else if (response["ok"] === false) {
    exact(
      response,
      ["protocolVersion", "service", "serviceVersion", "id", "ok", "error"],
      "Extension wire service response",
    );
  } else throw new TypeError("Extension wire service response.ok must be boolean");
  if (
    response["protocolVersion"] !== EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION
    || response["service"] !== request.service
    || response["serviceVersion"] !== request.serviceVersion
    || response["id"] !== request.id
  ) throw new TypeError("Extension wire service response identity does not match its request");
  if (response["ok"] === true) {
    return Object.freeze({
      protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
      service: request.service,
      serviceVersion: request.serviceVersion,
      id: request.id,
      ok: true,
      payload: jsonSnapshot(
        response["payload"],
        "Extension wire service response payload",
        positiveLimit(maximumPayloadBytes, EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes, "Extension wire service response limit"),
      ),
    });
  }
  const error = record(response["error"], "Extension wire service response error");
  exact(error, ["code", "message"], "Extension wire service response error");
  if (error["code"] !== "invalid_request" && error["code"] !== "handler_failed") {
    throw new TypeError("Extension wire service response error code is invalid");
  }
  const errorMessage = error["message"];
  const message = error["code"] === "handler_failed"
    ? "Extension wire service handler failed"
    : Value.Check(STRING_VALUE, errorMessage)
      && !errorMessage.includes("\0")
      && Buffer.byteLength(errorMessage, "utf8") <= 4_096
      ? errorMessage
      : undefined;
  if (message === undefined) throw new TypeError("Extension wire service response error message is invalid");
  return Object.freeze({
    protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
    service: request.service,
    serviceVersion: request.serviceVersion,
    id: request.id,
    ok: false,
    error: Object.freeze({ code: error["code"], message }),
  });
}

export function createExtensionWireServiceEndpoint<
  TRequestSchema extends TSchema,
  TResponseSchema extends TSchema,
>(
  sourceContract: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
  handler: (
    request: Static<TRequestSchema>,
    context: ExtensionWireServiceContext,
  ) => Static<TResponseSchema> | Promise<Static<TResponseSchema>>,
  options: { readonly signal?: AbortSignal } = {},
): ExtensionWireServiceEndpoint<Static<TRequestSchema>, Static<TResponseSchema>> {
  const contract = validatedContract(sourceContract);
  if (!Value.Check(FUNCTION_VALUE, handler)) {
    throw new TypeError("Extension wire service handler must be a function");
  }
  const endpoint: ExtensionWireServiceEndpoint<Static<TRequestSchema>, Static<TResponseSchema>> = {
    protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
    name: contract.name,
    version: contract.version,
    requestSchema: contract.requestSchema,
    responseSchema: contract.responseSchema,
    maxRequestBytes: contract.maxRequestBytes,
    maxResponseBytes: contract.maxResponseBytes,
    async request(
      rawEnvelope: ExtensionWireServiceRequest<Static<TRequestSchema>>,
      signal?: AbortSignal,
    ) {
      options.signal?.throwIfAborted();
      signal?.throwIfAborted();
      let id = "invalid";
      let payload: JsonValue;
      try {
        const envelope = validateExtensionWireServiceRequest(rawEnvelope);
        id = envelope.id;
        if (envelope.service !== contract.name) {
          throw new TypeError("Extension wire service request targets another service");
        }
        if (envelope.serviceVersion !== contract.version) {
          throw new TypeError("Extension wire service version is unsupported");
        }
        payload = jsonSnapshot(envelope.payload, "Extension wire service request payload", contract.maxRequestBytes);
        if (!Value.Check(contract.requestSchema, payload)) {
          throw new TypeError("Extension wire service request payload does not match its schema");
        }
      } catch (error) {
        return failure(contract, id, "invalid_request", error);
      }
      const selectedSignal = options.signal === undefined
        ? signal ?? new AbortController().signal
        : signal === undefined
          ? options.signal
          : AbortSignal.any([options.signal, signal]);
      try {
        selectedSignal.throwIfAborted();
        const response = jsonSnapshot(await handler(payload, Object.freeze({
          signal: selectedSignal,
          requestId: id,
        })), "Extension wire service response payload", contract.maxResponseBytes);
        selectedSignal.throwIfAborted();
        if (!Value.Check(contract.responseSchema, response)) {
          throw new TypeError("Extension wire service response payload does not match its schema");
        }
        return Object.freeze({
          protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
          service: contract.name,
          serviceVersion: contract.version,
          id,
          ok: true,
          payload: response,
        });
      } catch (error) {
        selectedSignal.throwIfAborted();
        return failure(contract, id, "handler_failed", error);
      }
    },
  };
  return Object.freeze(endpoint);
}

/** Detach the JSON contract advertised by a generation-owned wire endpoint. */
export function describeExtensionWireServiceEndpoint(
  endpoint: Pick<
    ExtensionWireServiceEndpoint,
    | "protocolVersion"
    | "name"
    | "version"
    | "requestSchema"
    | "responseSchema"
    | "maxRequestBytes"
    | "maxResponseBytes"
  >,
  ownerValue: string,
): ExtensionWireServiceDescriptor {
  if (endpoint.protocolVersion !== EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION) {
    throw new TypeError("Extension wire service endpoint protocol version is unsupported");
  }
  return Object.freeze({
    protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
    name: contractName(endpoint.name),
    version: serviceVersion(endpoint.version),
    owner: ownerId(ownerValue),
    requestSchema: validateSchema(endpoint.requestSchema, "Extension wire service request schema"),
    responseSchema: validateSchema(endpoint.responseSchema, "Extension wire service response schema"),
    maxRequestBytes: positiveLimit(
      endpoint.maxRequestBytes,
      EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes,
      "Extension wire service request limit",
    ),
    maxResponseBytes: positiveLimit(
      endpoint.maxResponseBytes,
      EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes,
      "Extension wire service response limit",
    ),
  });
}

export function createExtensionWireServiceProvider(
  lifecycle: Pick<ExtensionLifecycleCapabilities, "services">,
  signal?: AbortSignal,
): ExtensionWireServiceProvider {
  const provider: ExtensionWireServiceProvider = {
    provide<TRequestSchema extends TSchema, TResponseSchema extends TSchema>(
      contract: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
      handler: (
        request: Static<TRequestSchema>,
        context: ExtensionWireServiceContext,
      ) => Static<TResponseSchema> | Promise<Static<TResponseSchema>>,
    ) {
      signal?.throwIfAborted();
      const endpoint = createExtensionWireServiceEndpoint(
        contract,
        handler,
        signal === undefined ? {} : { signal },
      );
      return lifecycle.services.register(extensionWireServiceRegistryName(endpoint), endpoint);
    },
    get<TRequestSchema extends TSchema, TResponseSchema extends TSchema>(
      contract: ExtensionWireServiceContract<TRequestSchema, TResponseSchema>,
    ) {
      signal?.throwIfAborted();
      const selected = validatedContract(contract);
      const endpoint = lifecycle.services.get<ExtensionWireServiceEndpoint<
        Static<TRequestSchema>,
        Static<TResponseSchema>
      >>(
        extensionWireServiceRegistryName(selected),
      );
      if (endpoint === undefined) return undefined;
      if (
        endpoint.protocolVersion !== EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION
        || endpoint.name !== selected.name
        || endpoint.version !== selected.version
        || !Value.Check(FUNCTION_VALUE, endpoint.request)
      ) throw new TypeError(`Extension wire service ${selected.name} has an incompatible endpoint`);
      describeExtensionWireServiceEndpoint(endpoint, "extension-consumer");
      return endpoint;
    },
  };
  return Object.freeze(provider);
}

export function extensionWireServiceRequest<TPayload extends JsonValue>(
  contract: Pick<ExtensionWireServiceContract, "name" | "version">,
  idValue: string,
  payloadValue: TPayload,
): ExtensionWireServiceRequest<TPayload> {
  return validateExtensionWireServiceRequest({
    protocolVersion: EXTENSION_WIRE_SERVICE_PROTOCOL_VERSION,
    service: contractName(contract.name),
    serviceVersion: serviceVersion(contract.version),
    id: requestId(idValue),
    payload: payloadValue,
  });
}
