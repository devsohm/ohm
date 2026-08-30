import assert from "node:assert/strict";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/runtime/auth/redaction.js";
import {
  validateProviderAdapterError,
  validateProviderResponseDiagnostics,
} from "../../src/runtime/core/provider-diagnostics.js";
import { isJsonObject } from "../../src/runtime/core/json.js";

test("provider response diagnostics are detached, bounded, and allowlisted", () => {
  const source = {
    status: 429,
    headers: {
      "x-request-id": " request\n123 ",
      authorization: "Bearer secret",
    },
  };
  const selected = validateProviderResponseDiagnostics(source);
  assert.deepEqual(selected, {
    status: 429,
    headers: { "x-request-id": "request 123" },
  });
  source.headers["x-request-id"] = "mutated";
  assert.equal(selected.headers["x-request-id"], "request 123");
});

test("provider response diagnostics reject hostile records without invoking them", () => {
  let getterCalls = 0;
  const outer = { headers: {} };
  Object.defineProperty(outer, "status", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 200;
    },
  });
  assert.throws(() => validateProviderResponseDiagnostics(outer), TypeError);
  assert.equal(getterCalls, 0);

  const headers = {};
  Object.defineProperty(headers, "x-request-id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "request";
    },
  });
  assert.throws(() => validateProviderResponseDiagnostics({ status: 200, headers }), TypeError);
  assert.equal(getterCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      proxyTrapCalls += 1;
      return [];
    },
  });
  assert.throws(() => validateProviderResponseDiagnostics(proxy), TypeError);
  assert.equal(proxyTrapCalls, 0);

  const custom: { status: number; headers: object } = Object.assign(Object.create({ inherited: true }), {
    status: 200,
    headers: {},
  });
  assert.throws(() => validateProviderResponseDiagnostics(custom), TypeError);

  const hidden = { status: 200, headers: {} };
  Object.defineProperty(hidden, "extra", { value: true });
  assert.throws(() => validateProviderResponseDiagnostics(hidden), TypeError);

  const symbolic = { status: 200, headers: {} };
  Object.defineProperty(symbolic, Symbol("extra"), { enumerable: true, value: true });
  assert.throws(() => validateProviderResponseDiagnostics(symbolic), TypeError);
});

test("provider adapter errors are exact, detached, and bounded", () => {
  const source = {
    category: "rate_limit" as const,
    message: "retry later",
    httpStatus: 429,
    providerCode: "rate_limit",
    requestId: "request-1",
    retryAfterMs: 25,
    retryable: true,
    partial: false,
    bodyStarted: false,
    diagnostics: { status: 429, headers: { "x-request-id": "request-1" } },
    raw: { error: { code: "rate_limit" } },
  };
  const selected = validateProviderAdapterError(source);
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), source);
  source.raw.error.code = "mutated";
  assert.ok(isJsonObject(selected.raw));
  assert.ok(isJsonObject(selected.raw.error));
  assert.equal(selected.raw.error.code, "rate_limit");

  const rawOverhead = Buffer.byteLength('{"payload":""}', "utf8");
  const exact = validateProviderAdapterError({
    category: "provider",
    message: "exact",
    retryable: false,
    partial: false,
    raw: { payload: "x".repeat((64 * 1024) - rawOverhead) },
  });
  assert.equal(Buffer.byteLength(JSON.stringify(exact.raw), "utf8"), 64 * 1024);
  const exactValues = validateProviderAdapterError({
    category: "provider",
    message: "exact values",
    retryable: false,
    partial: false,
    raw: Array.from({ length: 8_191 }, () => null),
  });
  assert.equal(Array.isArray(exactValues.raw) ? exactValues.raw.length : undefined, 8_191);
  assert.throws(() => validateProviderAdapterError({
    category: "provider",
    message: "oversized",
    retryable: false,
    partial: false,
    raw: { payload: "x".repeat((64 * 1024) - rawOverhead + 1) },
  }), TypeError);
  assert.throws(() => validateProviderAdapterError({
    category: "provider",
    message: "oversized values",
    retryable: false,
    partial: false,
    raw: Array.from({ length: 8_192 }, () => null),
  }), TypeError);
});

test("provider adapter error messages are redacted before their bounded UTF-8 projection", () => {
  const exact = "x".repeat(16 * 1024);
  assert.equal(validateProviderAdapterError({
    category: "provider",
    message: exact,
    retryable: false,
    partial: false,
  }).message, exact);

  const oversized = `provider failure ${"x".repeat(20 * 1024)}`;
  const truncated = validateProviderAdapterError({
    category: "provider",
    message: oversized,
    retryable: false,
    partial: false,
  }).message;
  assert.equal(Buffer.byteLength(truncated, "utf8"), 16 * 1024);
  assert.equal(truncated, Buffer.from(oversized, "utf8").subarray(0, 16 * 1024).toString("utf8"));

  const secret = `provider-boundary-secret-${"q".repeat(48)}`;
  defaultSecretRedactor.register(secret);
  const prefix = "p".repeat((16 * 1024) - 8);
  const withBoundarySecret = `${prefix}${secret}${"z".repeat(1024)}`;
  const redacted = validateProviderAdapterError({
    category: "provider",
    message: withBoundarySecret,
    retryable: false,
    partial: false,
  }).message;
  const expected = Buffer.from(`${prefix}[REDACTED]${"z".repeat(1024)}`, "utf8")
    .subarray(0, 16 * 1024).toString("utf8");
  assert.equal(redacted, expected);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes(secret.slice(0, 16)), false);

  assert.throws(() => validateProviderAdapterError({
    category: "provider",
    message: "x".repeat(128 * 1024),
    retryable: false,
    partial: false,
  }), /exceeds 131072 UTF-8 bytes/u);
});

test("provider adapter errors reject malformed and hostile values before reading them", () => {
  for (const value of [
    null,
    {},
    { category: "unknown", message: "bad", retryable: false, partial: false },
    { category: "provider", message: "bad", retryable: "no", partial: false },
    { category: "provider", message: "bad", retryable: false, partial: false, extra: true },
    { category: "provider", message: "bad", retryable: false, partial: false, httpStatus: 99 },
    { category: "provider", message: "bad", retryable: false, partial: false, retryAfterMs: -1 },
  ]) assert.throws(() => validateProviderAdapterError(value), TypeError);

  let getterCalls = 0;
  const accessor = {
    category: "provider",
    message: "bad",
    retryable: false,
    partial: false,
  };
  Object.defineProperty(accessor, "raw", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });
  assert.throws(() => validateProviderAdapterError(accessor), TypeError);
  assert.equal(getterCalls, 0);

  let toJsonCalls = 0;
  const raw: { safe: boolean } = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return {};
    },
  }), { safe: true });
  assert.throws(() => validateProviderAdapterError({
    category: "provider",
    message: "bad",
    retryable: false,
    partial: false,
    raw,
  }), TypeError);
  assert.equal(toJsonCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({}, {
    ownKeys() {
      proxyTrapCalls += 1;
      return [];
    },
  });
  assert.throws(() => validateProviderAdapterError(proxy), TypeError);
  assert.equal(proxyTrapCalls, 0);
});
