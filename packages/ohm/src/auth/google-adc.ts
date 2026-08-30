import { optionalProperties } from "../core/optional-properties.js";
import { sign } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  BOOLEAN_VALUE,
  FUNCTION_VALUE,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";
import {
  CloudAuthIoError,
  configuredHttpsUrl,
  isLoopbackHost,
  parseJsonRecord,
  readBoundedFile,
  readOptionalBoundedFile,
  requestBounded,
} from "./cloud-http.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";

const ADC_FILE_LIMIT = 1024 * 1024;
const SUBJECT_TOKEN_LIMIT = 64 * 1024;
const DEFAULT_RESPONSE_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_METADATA_TIMEOUT_MS = 1_000;
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_INPUT_RECORD = Type.Record(Type.String(), Type.Unknown());
const GOOGLE_INPUT_ARRAY = Type.Array(Type.Unknown());

type GoogleCredentialRecord = ReturnType<typeof parseJsonRecord>;

function isGoogleCredentialRecord<T>(value: T): value is T & GoogleCredentialRecord {
  return Value.Check(GOOGLE_INPUT_RECORD, value);
}

export interface GoogleAccessToken {
  accessToken: string;
  expiresAt: number;
  tokenType: "Bearer";
  source: string;
  projectId?: string;
  quotaProjectId?: string;
  serviceAccountEmail?: string;
}

export interface GoogleExternalSubjectTokenInput {
  credential: Readonly<GoogleCredentialRecord>;
  scopes: readonly string[];
  signal?: AbortSignal;
}

export type GoogleExternalSubjectTokenResolver = (
  input: GoogleExternalSubjectTokenInput,
) => Promise<string>;

export interface GoogleAdcOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  scopes?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  metadataTimeoutMs?: number;
  maxResponseBytes?: number;
  externalSubjectTokenResolver?: GoogleExternalSubjectTokenResolver;
  signal?: AbortSignal;
  now?: () => number;
  redactor?: SecretRedactor;
}

interface GoogleContext {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  scopes: readonly string[];
  fetch: typeof fetch;
  timeoutMs: number;
  metadataTimeoutMs: number;
  maxResponseBytes: number;
  externalSubjectTokenResolver: GoogleExternalSubjectTokenResolver;
  signal?: AbortSignal;
  now: () => number;
  redactor: SecretRedactor;
}

function context(options: GoogleAdcOptions): GoogleContext {
  const scopes = options.scopes ?? [DEFAULT_SCOPE];
  if (scopes.length === 0 || scopes.some((scope) => scope === "" || /\s/u.test(scope))) {
    throw new TypeError("Google ADC scopes must be non-empty values without whitespace");
  }
  return {
    environment: options.environment ?? process.env,
    homeDirectory: options.homeDirectory ?? homedir(),
    scopes,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    metadataTimeoutMs: options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT,
    externalSubjectTokenResolver: options.externalSubjectTokenResolver ?? resolveOfficialExternalSubjectToken,
    ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    now: options.now ?? Date.now,
    redactor: options.redactor ?? defaultSecretRedactor,
  };
}

async function resolveOfficialExternalSubjectToken(
  input: GoogleExternalSubjectTokenInput,
): Promise<string> {
  input.signal?.throwIfAborted();
  const { ExternalAccountClient } = await import("google-auth-library");
  // SAFETY: The official Google client owns validation of this detached parsed credential object; the added scopes preserve its documented input contract.
  const client = ExternalAccountClient.fromJSON({
    ...input.credential,
    scopes: [...input.scopes],
  } as Parameters<typeof ExternalAccountClient.fromJSON>[0]);
  if (client === null || !("retrieveSubjectToken" in client)
    || !Value.Check(FUNCTION_VALUE, client.retrieveSubjectToken)) {
    throw new Error("Google external-account credential source was unsupported by the official resolver");
  }
  const token = await client.retrieveSubjectToken();
  input.signal?.throwIfAborted();
  return token;
}

function requiredString(record: GoogleCredentialRecord, name: string, label: string): string {
  const value = record[name];
  if (!Value.Check(STRING_VALUE, value) || value.length === 0) throw new Error(`${label} omitted ${name}`);
  return value;
}

function optionalString(record: GoogleCredentialRecord, name: string, label: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (!Value.Check(STRING_VALUE, value) || value.length === 0) throw new Error(`${label} contained an invalid ${name}`);
  return value;
}

function registerToken(token: GoogleAccessToken, redactor: SecretRedactor): GoogleAccessToken {
  redactor.register(token.accessToken);
  return token;
}

function environmentOverrides(token: GoogleAccessToken, ctx: GoogleContext): GoogleAccessToken {
  const quotaProjectId = ctx.environment.GOOGLE_CLOUD_QUOTA_PROJECT;
  const projectId = ctx.environment.GOOGLE_CLOUD_PROJECT ?? ctx.environment.GCLOUD_PROJECT;
  return {
    ...token,
    ...optionalProperties(projectId === undefined || projectId === "" ? undefined : { projectId }),
    ...optionalProperties(quotaProjectId === undefined || quotaProjectId === "" ? undefined : { quotaProjectId }),
  };
}

function expiresIn(record: GoogleCredentialRecord, label: string, now: number): number {
  const raw = record.expires_in;
  const seconds = Value.Check(NUMBER_VALUE, raw)
    ? raw
    : Value.Check(STRING_VALUE, raw)
      ? Number(raw)
      : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new Error(`${label} returned an invalid expires_in`);
  }
  return now + seconds * 1000;
}

function oauthTokenUrl(value: string): URL {
  const url = configuredHttpsUrl(value, "Google OAuth token_uri");
  if (
    url.port !== "" ||
    (url.hostname !== "oauth2.googleapis.com" && url.hostname !== "accounts.google.com")
  ) {
    throw new Error("Google OAuth token_uri must use an official Google OAuth host");
  }
  return url;
}

function stsTokenUrl(value: string): URL {
  const url = configuredHttpsUrl(value, "Google STS token_url");
  if (
    url.port !== "" ||
    !/^sts(?:\.[a-z0-9-]+\.rep)?\.googleapis\.com$/u.test(url.hostname) ||
    (url.pathname !== "/v1/token" && url.pathname !== "/v1beta/token")
  ) {
    throw new Error("Google external-account token_url must use an official Google STS endpoint");
  }
  return url;
}

function impersonationUrl(value: string): URL {
  const url = configuredHttpsUrl(value, "Google service-account impersonation URL");
  if (
    url.port !== "" ||
    !/^(?:[a-z0-9-]+-)?iamcredentials\.googleapis\.com$/u.test(url.hostname) ||
    !/^\/v1\/projects\/-\/serviceAccounts\/[^/]+:generateAccessToken$/u.test(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Google service-account impersonation URL was invalid");
  }
  return url;
}

async function postTokenForm(
  endpoint: URL,
  body: URLSearchParams,
  label: string,
  ctx: GoogleContext,
): Promise<GoogleCredentialRecord> {
  const response = await requestBounded(
    endpoint,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
    {
      fetch: ctx.fetch,
      timeoutMs: ctx.timeoutMs,
      maxResponseBytes: ctx.maxResponseBytes,
      label,
      ...optionalProperties(ctx.signal === undefined ? undefined : { signal: ctx.signal }),
    },
  );
  const record = parseJsonRecord(response.text, label);
  if (!response.ok) {
    const rawCode = record.error;
    const code = Value.Check(STRING_VALUE, rawCode) && /^[A-Za-z0-9._-]{1,128}$/u.test(rawCode)
      ? ` ${rawCode}`
      : "";
    throw new Error(`${label} failed (${response.status}${code})`);
  }
  return record;
}

async function authorizedUserToken(
  record: GoogleCredentialRecord,
  source: string,
  ctx: GoogleContext,
): Promise<GoogleAccessToken> {
  const clientId = requiredString(record, "client_id", "Google authorized_user ADC");
  const clientSecret = requiredString(record, "client_secret", "Google authorized_user ADC");
  const refreshToken = requiredString(record, "refresh_token", "Google authorized_user ADC");
  ctx.redactor.registerAll([clientSecret, refreshToken]);
  const endpoint = oauthTokenUrl(
    optionalString(record, "token_uri", "Google authorized_user ADC") ?? "https://oauth2.googleapis.com/token",
  );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const raptToken = optionalString(record, "rapt_token", "Google authorized_user ADC");
  if (raptToken !== undefined) {
    ctx.redactor.register(raptToken);
    body.set("rapt", raptToken);
  }
  const response = await postTokenForm(endpoint, body, "Google authorized-user refresh", ctx);
  const accessToken = requiredString(response, "access_token", "Google authorized-user refresh");
  const quotaProjectId = optionalString(record, "quota_project_id", "Google authorized_user ADC");
  return registerToken(
    {
      accessToken,
      expiresAt: expiresIn(response, "Google authorized-user refresh", ctx.now()),
      tokenType: "Bearer",
      source,
      ...optionalProperties(quotaProjectId === undefined ? undefined : { quotaProjectId }),
    },
    ctx.redactor,
  );
}

function base64UrlJson<T>(value: T): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function serviceAccountToken(
  record: GoogleCredentialRecord,
  source: string,
  ctx: GoogleContext,
): Promise<GoogleAccessToken> {
  const clientEmail = requiredString(record, "client_email", "Google service_account ADC");
  const privateKey = requiredString(record, "private_key", "Google service_account ADC");
  const projectId = optionalString(record, "project_id", "Google service_account ADC");
  const privateKeyId = optionalString(record, "private_key_id", "Google service_account ADC");
  ctx.redactor.register(privateKey);
  const endpoint = oauthTokenUrl(
    optionalString(record, "token_uri", "Google service_account ADC") ?? "https://oauth2.googleapis.com/token",
  );
  const issuedAt = Math.floor(ctx.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...optionalProperties(privateKeyId === undefined ? undefined : { kid: privateKeyId }),
  };
  const claim = {
    iss: clientEmail,
    scope: ctx.scopes.join(" "),
    aud: endpoint.toString(),
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey);
  } catch {
    throw new Error("Google service_account private key could not sign a JWT assertion");
  }
  const assertion = `${unsigned}.${signature.toString("base64url")}`;
  ctx.redactor.register(assertion);
  const response = await postTokenForm(
    endpoint,
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    "Google service-account JWT exchange",
    ctx,
  );
  const accessToken = requiredString(response, "access_token", "Google service-account JWT exchange");
  return registerToken(
    {
      accessToken,
      expiresAt: expiresIn(response, "Google service-account JWT exchange", ctx.now()),
      tokenType: "Bearer",
      source,
      serviceAccountEmail: clientEmail,
      ...optionalProperties(projectId === undefined ? undefined : { projectId }),
    },
    ctx.redactor,
  );
}

function credentialSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Google external-account credential source URL was invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  const allowedHttp = isLoopbackHost(hostname) || hostname === "169.254.169.254" || hostname === "metadata.google.internal";
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && allowedHttp))
  ) {
    throw new Error("Google external-account credential source must use HTTPS or a local metadata host");
  }
  return url;
}

function sourceFormat(source: GoogleCredentialRecord): { type: "text" } | { type: "json"; field: string } {
  const raw = source.format;
  if (raw === undefined) return { type: "text" };
  if (!isGoogleCredentialRecord(raw)) {
    throw new Error("Google external-account credential source format was invalid");
  }
  const format = raw;
  if (format.type === "text") return { type: "text" };
  if (format.type === "json") {
    const field = requiredString(format, "subject_token_field_name", "Google external-account format");
    return { type: "json", field };
  }
  throw new Error("Google external-account credential source format was unsupported");
}

function parseSubjectToken(text: string, format: ReturnType<typeof sourceFormat>): string {
  const token = format.type === "text"
    ? text.trim()
    : requiredString(parseJsonRecord(text, "Google external-account credential source"), format.field, "Google external-account credential source");
  if (token === "" || Buffer.byteLength(token, "utf8") > SUBJECT_TOKEN_LIMIT) {
    throw new Error("Google external-account subject token was invalid");
  }
  return token;
}

async function externalSubjectToken(
  credential: GoogleCredentialRecord,
  source: GoogleCredentialRecord,
  ctx: GoogleContext,
): Promise<string> {
  const format = sourceFormat(source);
  const file = optionalString(source, "file", "Google external-account credential_source");
  const urlValue = optionalString(source, "url", "Google external-account credential_source");
  if (file !== undefined && urlValue !== undefined) {
    throw new Error("Google external-account credential source selected multiple mechanisms");
  }
  if (file !== undefined) {
    const token = parseSubjectToken(
      await readBoundedFile(file, SUBJECT_TOKEN_LIMIT, "Google external-account subject token file"),
      format,
    );
    ctx.redactor.register(token);
    return token;
  }
  if (urlValue !== undefined) {
    const headers = new Headers({ accept: "application/json, text/plain" });
    if (source.headers !== undefined) {
      if (!isGoogleCredentialRecord(source.headers)) {
        throw new Error("Google external-account credential source headers were invalid");
      }
      const entries = Object.entries(source.headers);
      if (entries.length > 32) throw new Error("Google external-account credential source had too many headers");
      for (const [name, value] of entries) {
        if (!Value.Check(STRING_VALUE, value) || value.length > 8 * 1024 || /^(?:host|content-length)$/iu.test(name)) {
          throw new Error("Google external-account credential source header was invalid");
        }
        try {
          headers.set(name, value);
        } catch {
          throw new Error("Google external-account credential source header was invalid");
        }
        if (/^(?:authorization|x-api-key)$/iu.test(name)) ctx.redactor.register(value);
      }
    }
    const response = await requestBounded(
      credentialSourceUrl(urlValue),
      { method: "GET", headers },
      {
        fetch: ctx.fetch,
        timeoutMs: ctx.timeoutMs,
        maxResponseBytes: SUBJECT_TOKEN_LIMIT,
        label: "Google external-account credential source",
        ...optionalProperties(ctx.signal === undefined ? undefined : { signal: ctx.signal }),
      },
    );
    if (!response.ok) throw new Error(`Google external-account credential source failed (${response.status})`);
    const token = parseSubjectToken(response.text, format);
    ctx.redactor.register(token);
    return token;
  }
  if (source.environment_id !== undefined) {
    validateAwsExternalSource(source);
    return officialExternalSubjectToken(credential, ctx);
  }
  if (source.executable !== undefined) {
    validateExecutableExternalSource(source.executable, ctx);
    return officialExternalSubjectToken(credential, ctx);
  }
  if (source.certificate !== undefined || source.cert !== undefined) {
    if (source.cert !== undefined) throw new Error("Google external-account X.509 credential source used an unsupported cert alias");
    validateCertificateExternalSource(source.certificate);
    return officialExternalSubjectToken(credential, ctx);
  }
  throw new Error("Google external-account credential source was unsupported");
}

function awsMetadataUrl<T>(value: T, label: string): void {
  if (value === undefined) return;
  if (!Value.Check(STRING_VALUE, value) || value.length === 0) throw new Error(`${label} was invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} was invalid`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (url.protocol !== "http:" || (host !== "169.254.169.254" && host !== "fd00:ec2::254")
    || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error(`${label} must use the AWS instance metadata host`);
  }
}

function validateAwsExternalSource(source: GoogleCredentialRecord): void {
  if (source.environment_id !== "aws1") {
    throw new Error("Google external-account AWS environment_id must be aws1");
  }
  awsMetadataUrl(source.region_url, "Google external-account AWS region_url");
  awsMetadataUrl(source.url, "Google external-account AWS credential URL");
  awsMetadataUrl(source.imdsv2_session_token_url, "Google external-account AWS IMDSv2 URL");
  const rawVerification = source.regional_cred_verification_url;
  if (!Value.Check(STRING_VALUE, rawVerification) || rawVerification.length === 0) {
    throw new Error("Google external-account AWS regional credential verification URL was invalid");
  }
  let verification: URL;
  try {
    verification = new URL(rawVerification.replaceAll("{region}", "us-east-1"));
  } catch {
    throw new Error("Google external-account AWS regional credential verification URL was invalid");
  }
  if (verification.protocol !== "https:" || verification.port !== ""
    || !/^sts\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u.test(verification.hostname)
    || verification.username !== "" || verification.password !== "" || verification.hash !== ""
    || verification.searchParams.get("Action") !== "GetCallerIdentity") {
    throw new Error("Google external-account AWS regional credential verification URL was invalid");
  }
}

function validateExecutableExternalSource<T>(value: T, ctx: GoogleContext): void {
  if (ctx.environment.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES !== "1") {
    throw new Error("Google external-account executable credentials require GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1");
  }
  if (!isGoogleCredentialRecord(value)) {
    throw new Error("Google external-account executable credential source was invalid");
  }
  const executable = value;
  const command = requiredString(executable, "command", "Google external-account executable credential source");
  const program = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/u.exec(command)?.slice(1).find((part) => part !== undefined);
  if (program === undefined || !isAbsolute(program)) {
    throw new Error("Google external-account executable command must start with an absolute path");
  }
  const timeout = executable.timeout_millis;
  if (timeout !== undefined && (
    !Value.Check(NUMBER_VALUE, timeout) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 5_000 ||
    timeout > 120_000
  )) {
    throw new Error("Google external-account executable timeout_millis was invalid");
  }
  const outputFile = executable.output_file;
  if (outputFile !== undefined && (!Value.Check(STRING_VALUE, outputFile) || !isAbsolute(outputFile))) {
    throw new Error("Google external-account executable output_file must be an absolute path");
  }
}

function validateCertificateExternalSource<T>(value: T): void {
  if (!isGoogleCredentialRecord(value)) {
    throw new Error("Google external-account X.509 credential source was invalid");
  }
  const certificate = value;
  const useDefault = certificate.use_default_certificate_config;
  const location = certificate.certificate_config_location;
  if ((useDefault !== undefined && !Value.Check(BOOLEAN_VALUE, useDefault))
    || (location !== undefined && (!Value.Check(STRING_VALUE, location) || !isAbsolute(location)))
    || (useDefault !== true && location === undefined)
    || (useDefault === true && location !== undefined)) {
    throw new Error("Google external-account X.509 certificate configuration was invalid");
  }
  const trustChain = certificate.trust_chain_path;
  if (trustChain !== undefined && (!Value.Check(STRING_VALUE, trustChain) || !isAbsolute(trustChain))) {
    throw new Error("Google external-account X.509 trust_chain_path must be an absolute path");
  }
}

async function officialExternalSubjectToken(
  credential: GoogleCredentialRecord,
  ctx: GoogleContext,
): Promise<string> {
  const token = await ctx.externalSubjectTokenResolver({
    credential,
    scopes: ctx.scopes,
    ...optionalProperties(ctx.signal === undefined ? undefined : { signal: ctx.signal }),
  });
  if (!Value.Check(STRING_VALUE, token) || token === "" || Buffer.byteLength(token, "utf8") > SUBJECT_TOKEN_LIMIT) {
    throw new Error("Google external-account official resolver returned an invalid subject token");
  }
  ctx.redactor.register(token);
  return token;
}

async function impersonateServiceAccount(
  endpointValue: string,
  sourceToken: string,
  source: string,
  ctx: GoogleContext,
  options: { lifetimeSeconds?: number; delegates?: readonly string[]; quotaProjectId?: string } = {},
): Promise<GoogleAccessToken> {
  const lifetimeSeconds = options.lifetimeSeconds ?? 3600;
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 600 || lifetimeSeconds > 43_200) {
    throw new Error("Google service-account impersonation lifetime was invalid");
  }
  ctx.redactor.register(sourceToken);
  const response = await requestBounded(
    impersonationUrl(endpointValue),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${sourceToken}`,
      },
      body: JSON.stringify({
        scope: [...ctx.scopes],
        lifetime: `${lifetimeSeconds}s`,
        ...optionalProperties(options.delegates === undefined || options.delegates.length === 0 ? undefined : { delegates: [...options.delegates] }),
      }),
    },
    {
      fetch: ctx.fetch,
      timeoutMs: ctx.timeoutMs,
      maxResponseBytes: ctx.maxResponseBytes,
      label: "Google service-account impersonation",
      ...optionalProperties(ctx.signal === undefined ? undefined : { signal: ctx.signal }),
    },
  );
  const record = parseJsonRecord(response.text, "Google service-account impersonation");
  if (!response.ok) throw new Error(`Google service-account impersonation failed (${response.status})`);
  const accessToken = requiredString(record, "accessToken", "Google service-account impersonation");
  const expireTime = requiredString(record, "expireTime", "Google service-account impersonation");
  const expiresAt = Date.parse(expireTime);
  if (!Number.isFinite(expiresAt) || expiresAt <= ctx.now()) {
    throw new Error("Google service-account impersonation returned an invalid expiration");
  }
  const emailMatch = /\/serviceAccounts\/([^/]+):generateAccessToken$/u.exec(impersonationUrl(endpointValue).pathname);
  const serviceAccountEmail = emailMatch?.[1] === undefined ? undefined : decodeURIComponent(emailMatch[1]);
  return registerToken(
    {
      accessToken,
      expiresAt,
      tokenType: "Bearer",
      source,
      ...optionalProperties(serviceAccountEmail === undefined ? undefined : { serviceAccountEmail }),
      ...optionalProperties(options.quotaProjectId === undefined ? undefined : { quotaProjectId: options.quotaProjectId }),
    },
    ctx.redactor,
  );
}

async function externalAccountToken(
  record: GoogleCredentialRecord,
  source: string,
  ctx: GoogleContext,
): Promise<GoogleAccessToken> {
  const audience = requiredString(record, "audience", "Google external_account ADC");
  const subjectTokenType = requiredString(record, "subject_token_type", "Google external_account ADC");
  const tokenUrl = stsTokenUrl(requiredString(record, "token_url", "Google external_account ADC"));
  const rawSource = record.credential_source;
  if (!isGoogleCredentialRecord(rawSource)) {
    throw new Error("Google external_account ADC omitted credential_source");
  }
  const subjectToken = await externalSubjectToken(record, rawSource, ctx);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience,
    scope: ctx.scopes.join(" "),
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: subjectToken,
    subject_token_type: subjectTokenType,
  });
  const workforceProject = optionalString(record, "workforce_pool_user_project", "Google external_account ADC");
  if (workforceProject !== undefined) body.set("options", JSON.stringify({ userProject: workforceProject }));
  const response = await postTokenForm(tokenUrl, body, "Google external-account STS exchange", ctx);
  const federatedToken = requiredString(response, "access_token", "Google external-account STS exchange");
  ctx.redactor.register(federatedToken);
  const quotaProjectId = optionalString(record, "quota_project_id", "Google external_account ADC");
  const impersonation = optionalString(record, "service_account_impersonation_url", "Google external_account ADC");
  if (impersonation !== undefined) {
    let lifetimeSeconds: number | undefined;
    if (record.service_account_impersonation !== undefined) {
      if (!isGoogleCredentialRecord(record.service_account_impersonation)) {
        throw new Error("Google external-account service_account_impersonation was invalid");
      }
      const rawLifetime = record.service_account_impersonation.token_lifetime_seconds;
      if (rawLifetime !== undefined) {
        if (!Value.Check(NUMBER_VALUE, rawLifetime)) throw new Error("Google service-account impersonation lifetime was invalid");
        lifetimeSeconds = rawLifetime;
      }
    }
    return impersonateServiceAccount(
      impersonation,
      federatedToken,
      `${source}:service_account_impersonation`,
      ctx,
      {
        ...optionalProperties(lifetimeSeconds === undefined ? undefined : { lifetimeSeconds }),
        ...optionalProperties(quotaProjectId === undefined ? undefined : { quotaProjectId }),
      },
    );
  }
  return registerToken(
    {
      accessToken: federatedToken,
      expiresAt: expiresIn(response, "Google external-account STS exchange", ctx.now()),
      tokenType: "Bearer",
      source,
      ...optionalProperties(quotaProjectId === undefined ? undefined : { quotaProjectId }),
    },
    ctx.redactor,
  );
}

function stringArray<T>(value: T, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(GOOGLE_INPUT_ARRAY, value)) throw new Error(`${label} was invalid`);
  const result: string[] = [];
  for (const item of value) {
    if (!Value.Check(STRING_VALUE, item) || item === "") throw new Error(`${label} was invalid`);
    result.push(item);
  }
  return result;
}

async function credentialRecordToken(
  record: GoogleCredentialRecord,
  source: string,
  ctx: GoogleContext,
  depth: number,
): Promise<GoogleAccessToken> {
  if (depth > 3) throw new Error("Google ADC credential nesting was too deep");
  switch (record.type) {
    case "authorized_user":
      return authorizedUserToken(record, source, ctx);
    case "service_account":
      return serviceAccountToken(record, source, ctx);
    case "external_account":
      return externalAccountToken(record, source, ctx);
    case "impersonated_service_account": {
      const rawSource = record.source_credentials;
      if (!isGoogleCredentialRecord(rawSource)) {
        throw new Error("Google impersonated ADC omitted source_credentials");
      }
      const sourceCredential = await credentialRecordToken(
        rawSource,
        `${source}:source`,
        ctx,
        depth + 1,
      );
      const quotaProjectId = optionalString(record, "quota_project_id", "Google impersonated ADC");
      const delegates = stringArray(record.delegates, "Google impersonated ADC delegates");
      return impersonateServiceAccount(
        requiredString(record, "service_account_impersonation_url", "Google impersonated ADC"),
        sourceCredential.accessToken,
        `${source}:service_account_impersonation`,
        ctx,
        {
          ...optionalProperties(delegates === undefined ? undefined : { delegates }),
          ...optionalProperties(quotaProjectId === undefined ? undefined : { quotaProjectId }),
        },
      );
    }
    default:
      throw new Error("Google ADC credential type is unsupported");
  }
}

async function metadataToken(ctx: GoogleContext): Promise<GoogleAccessToken | undefined> {
  let response;
  try {
    response = await requestBounded(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { method: "GET", headers: { "metadata-flavor": "Google", accept: "application/json" } },
      {
        fetch: ctx.fetch,
        timeoutMs: ctx.metadataTimeoutMs,
        maxResponseBytes: ctx.maxResponseBytes,
        label: "Google metadata token",
        ...optionalProperties(ctx.signal === undefined ? undefined : { signal: ctx.signal }),
      },
    );
  } catch (error) {
    if (error instanceof CloudAuthIoError) return undefined;
    throw error;
  }
  if (!response.ok) return undefined;
  if (response.headers.get("metadata-flavor")?.toLowerCase() !== "google") {
    throw new Error("Google metadata response omitted the Metadata-Flavor header");
  }
  const record = parseJsonRecord(response.text, "Google metadata token");
  const accessToken = requiredString(record, "access_token", "Google metadata token");
  return registerToken(
    {
      accessToken,
      expiresAt: expiresIn(record, "Google metadata token", ctx.now()),
      tokenType: "Bearer",
      source: "metadata",
    },
    ctx.redactor,
  );
}

function wellKnownPath(ctx: GoogleContext): string {
  if (process.platform === "win32") {
    const appData = ctx.environment.APPDATA;
    if (appData !== undefined && appData !== "") return join(appData, "gcloud", "application_default_credentials.json");
  }
  return join(ctx.homeDirectory, ".config", "gcloud", "application_default_credentials.json");
}

export async function resolveGoogleApplicationDefaultCredentials(
  options: GoogleAdcOptions = {},
): Promise<GoogleAccessToken | undefined> {
  const ctx = context(options);
  ctx.signal?.throwIfAborted();

  const explicitPath = ctx.environment.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicitPath !== undefined && explicitPath !== "") {
    const record = parseJsonRecord(
      await readBoundedFile(explicitPath, ADC_FILE_LIMIT, "Google application credential file"),
      "Google application credential file",
    );
    return environmentOverrides(await credentialRecordToken(record, "environment_file", ctx, 0), ctx);
  }
  const adc = await readOptionalBoundedFile(
    wellKnownPath(ctx),
    ADC_FILE_LIMIT,
    "Google well-known ADC file",
  );
  if (adc !== undefined) {
    return environmentOverrides(
      await credentialRecordToken(parseJsonRecord(adc, "Google well-known ADC file"), "well_known_file", ctx, 0),
      ctx,
    );
  }
  const metadata = await metadataToken(ctx);
  return metadata === undefined ? undefined : environmentOverrides(metadata, ctx);
}
