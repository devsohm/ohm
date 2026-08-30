import { Type } from "typebox";
import { Value } from "typebox/value";

import { optionalProperties } from "../core/optional-properties.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";
import { minimalProcessEnvironment, runSafeProcess } from "./process.js";
import type { ApiKeyCredential, AuthProviderId, BearerCredential } from "./types.js";

export interface ExternalCommandOptions {
  provider: AuthProviderId;
  argv: readonly [string, ...string[]];
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  redactor?: SecretRedactor;
}

interface CommandApiKeyResult {
  type: "api_key";
  apiKey: string;
  accountId?: string;
}

interface CommandBearerResult {
  type: "bearer";
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
  subject?: string;
}

const COMMAND_API_KEY_RESULT_VALUE = Type.Object({
  type: Type.Literal("api_key"),
  apiKey: Type.String({ minLength: 1 }),
  accountId: Type.Optional(Type.String()),
}, { additionalProperties: true });
const COMMAND_BEARER_RESULT_VALUE = Type.Object({
  type: Type.Literal("bearer"),
  accessToken: Type.String({ minLength: 1 }),
  expiresAt: Type.Optional(Type.Number()),
  accountId: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
}, { additionalProperties: true });

function parseResult<T>(value: T): CommandApiKeyResult | CommandBearerResult {
  if (Value.Check(COMMAND_API_KEY_RESULT_VALUE, value)) return value;
  if (
    Value.Check(COMMAND_BEARER_RESULT_VALUE, value) &&
    (value.expiresAt === undefined || Number.isFinite(value.expiresAt))
  ) {
    return value;
  }
  throw new Error("External credential command returned an unsupported credential");
}

export async function resolveExternalCommandCredential(
  options: ExternalCommandOptions,
): Promise<ApiKeyCredential | BearerCredential> {
  const [command, ...args] = options.argv;
  const redactor = options.redactor ?? defaultSecretRedactor;
  const result = await runSafeProcess({
    command,
    args,
    environment: minimalProcessEnvironment(options.environment),
    timeoutMs: options.timeoutMs ?? 10_000,
    maxOutputBytes: options.maxOutputBytes ?? 16 * 1024,
    ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    redactor,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      detail.length === 0
        ? `External credential command exited with ${result.exitCode}`
        : `External credential command failed: ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("External credential command did not return JSON", { cause: error });
  }
  const credential = parseResult(parsed);
  if (credential.type === "api_key") {
    redactor.register(credential.apiKey);
    return {
      kind: "api_key",
      provider: options.provider,
      apiKey: credential.apiKey,
      ...optionalProperties(credential.accountId === undefined ? undefined : { accountId: credential.accountId }),
    };
  }
  redactor.register(credential.accessToken);
  return {
    kind: "bearer",
    provider: options.provider,
    accessToken: credential.accessToken,
    ...optionalProperties(credential.expiresAt === undefined ? undefined : { expiresAt: credential.expiresAt }),
    ...optionalProperties(credential.accountId === undefined ? undefined : { accountId: credential.accountId }),
    ...optionalProperties(credential.subject === undefined ? undefined : { subject: credential.subject }),
  };
}
