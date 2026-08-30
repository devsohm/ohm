import { optionalProperties } from "../core/optional-properties.js";
import type {
  BedrockRuntimeClientConfig,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  HttpHandler,
  HttpHandlerOptions,
  HttpResponse as SmithyHttpResponse,
  IHttpRequest,
} from "@smithy/core/protocols";
import { Value } from "typebox/value";

import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import type { ProviderResponseDiagnostics } from "../core/types.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import { fetchAtSdkBoundary } from "./sdk-fetch-boundary.js";
import {
  type FetchLike,
  requestIdFromHeaders,
  responseDiagnostics,
} from "./transport.js";

type BedrockSdk = typeof import("@aws-sdk/client-bedrock-runtime");

export interface BedrockSdkCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface BedrockSdkStreamInput {
  modelId: string;
  body: JsonObject;
  region: string;
  endpoint: string;
  targetUrl?: string;
  headers: Headers;
  bearerToken?: string;
  credentials?: BedrockSdkCredentials;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse(response: Response): void | Promise<void>;
  loadSdk?: () => Promise<BedrockSdk>;
}

export interface OpenedBedrockSdkStream {
  stream: AsyncIterable<ConverseStreamOutput>;
  diagnostics?: ProviderResponseDiagnostics;
  requestId?: string;
}

/** Open an AWS Converse stream through the official client and a host-owned fetch boundary. */
export async function openBedrockSdkStream(input: BedrockSdkStreamInput): Promise<OpenedBedrockSdkStream> {
  const sdk = await (input.loadSdk?.() ?? import("@aws-sdk/client-bedrock-runtime"));
  let diagnostics: ProviderResponseDiagnostics | undefined;
  let observedRequestId: string | undefined;
  const requestHandler = new HostFetchHandler(input.fetch, async (response) => {
    diagnostics = responseDiagnostics(response);
    observedRequestId = requestIdFromHeaders(response.headers);
    await input.onResponse(response);
  });
  const config: BedrockRuntimeClientConfig = {
    region: input.region,
    endpoint: input.endpoint,
    requestHandler,
    ...optionalProperties(input.credentials === undefined ? undefined : { credentials: input.credentials }),
    ...optionalProperties(input.bearerToken === undefined ? undefined : {
          token: { token: input.bearerToken },
          authSchemePreference: ["httpBearerAuth"],
        }),
  };
  const client = new sdk.BedrockRuntimeClient(config);
  addRequestMiddleware(client, input.headers, input.targetUrl);
  const command = new sdk.ConverseStreamCommand(toCommandInput(input.modelId, input.body));
  let output: ConverseStreamCommandOutput;
  try {
    output = await client.send(command, { abortSignal: input.signal });
  } catch (error) {
    client.destroy();
    throw error;
  }
  if (output.stream === undefined) {
    client.destroy();
    throw new TypeError("Bedrock response omitted its event stream");
  }
  const opened: OpenedBedrockSdkStream = {
    stream: ownedStream(output.stream, () => client.destroy()),
  };
  if (diagnostics !== undefined) opened.diagnostics = diagnostics;
  const requestId = output.$metadata.requestId ?? observedRequestId;
  if (requestId !== undefined) opened.requestId = requestId;
  return opened;
}

async function* ownedStream<T>(stream: AsyncIterable<T>, dispose: () => void): AsyncIterable<T> {
  try {
    yield* stream;
  } finally {
    dispose();
  }
}

function toCommandInput(modelId: string, body: JsonObject): ConverseStreamCommandInput {
  const converted = convertBinaryFields(body);
  const commandInput = { ...converted, modelId };
  // SAFETY: buildConverseBody creates an AWS Converse request and convertBinaryFields
  // preserves its structure while decoding only SDK byte fields.
  return commandInput as ConverseStreamCommandInput;
}

function convertBinaryFields(value: JsonObject, key?: string): BedrockCommandObject;
function convertBinaryFields(value: JsonValue, key?: string): BedrockCommandValue;
function convertBinaryFields(value: JsonValue, key?: string): BedrockCommandValue {
  if (key === "bytes" && Value.Check(STRING_VALUE, value)) return Buffer.from(value, "base64");
  if (Array.isArray(value)) return value.map((entry) => convertBinaryFields(entry));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [entryKey, convertBinaryFields(entry, entryKey)]),
  );
}

type BedrockCommandValue = JsonValue | Uint8Array | BedrockCommandValue[] | BedrockCommandObject;
type BedrockCommandObject = { [key: string]: BedrockCommandValue };

function addRequestMiddleware(
  client: InstanceType<BedrockSdk["BedrockRuntimeClient"]>,
  headers: Headers,
  targetUrl: string | undefined,
): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      // SAFETY: AWS invokes build middleware with its documented Smithy HTTP request.
      const request = args.request as IHttpRequest;
      if (request.headers !== undefined) {
        for (const [name, value] of headers) {
          if (!isReservedHeader(name)) request.headers[name] = value;
        }
      }
      if (targetUrl !== undefined) rewriteSmithyTarget(request, new URL(targetUrl));
      return next(args);
    },
    { step: "build", name: "ohmBedrockRequest", priority: "low" },
  );
}

function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "host" || lower.startsWith("x-amz-");
}

function rewriteSmithyTarget(
  request: {
    protocol?: string;
    hostname?: string;
    port?: number;
    path?: string;
    query?: Record<string, string | string[] | null>;
  },
  target: URL,
): void {
  request.protocol = target.protocol;
  request.hostname = target.hostname;
  if (target.port === "") delete request.port;
  else request.port = Number(target.port);
  request.path = target.pathname;
  request.query = {};
  for (const [name, value] of target.searchParams) {
    const previous = request.query[name];
    request.query[name] = previous === undefined
      ? value
      : Array.isArray(previous)
        ? [...previous, value]
        : [previous ?? "", value];
  }
}

class HostFetchHandler implements HttpHandler<Record<string, never>> {
  readonly metadata = { handlerProtocol: "http/1.1" };

  constructor(
    private readonly fetch: FetchLike,
    private readonly observe: (response: Response) => void | Promise<void>,
  ) {}

  async handle(
    request: IHttpRequest,
    options: HttpHandlerOptions = {},
  ): Promise<{ response: SmithyHttpResponse }> {
    const signal = timeoutSignal(nativeAbortSignal(options.abortSignal), options.requestTimeout);
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: request.headers,
      redirect: "error",
    };
    if (signal !== undefined) init.signal = signal;
    if (request.body !== undefined && request.method !== "GET" && request.method !== "HEAD") {
      init.body = requestBody(request.body);
      init.duplex = "half";
    }
    const response = await fetchAtSdkBoundary(this.fetch, new Request(smithyUrl(request), init));
    await this.observe(response);
    return {
      response: {
        statusCode: response.status,
        reason: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: response.body ?? new Uint8Array(await response.arrayBuffer()),
      },
    };
  }

  destroy(): void {}

  updateHttpClientConfig(_key: string, _value: never): void {}

  httpHandlerConfigs(): Record<string, never> {
    return {};
  }
}

function requestBody<Input>(value: Input): BodyInit {
  if (Value.Check(STRING_VALUE, value)) return value;
  if (value instanceof Blob) return value;
  if (value instanceof FormData) return value;
  if (value instanceof URLSearchParams) return value;
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ReadableStream) return value;
  throw new TypeError("AWS SDK produced an unsupported HTTP request body");
}

function nativeAbortSignal<Input>(value: Input): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

function smithyUrl(request: IHttpRequest): string {
  const url = new URL(`${request.protocol}//${request.hostname}${request.port === undefined ? "" : `:${request.port}`}${request.path}`);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, item);
    } else if (value !== null) {
      url.searchParams.append(name, value);
    }
  }
  return url.toString();
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined || timeoutMs <= 0) return signal;
  return signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
