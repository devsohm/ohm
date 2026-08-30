import { Socket } from "node:net";

const marker = Symbol.for("ohm.offline-release-network-guard");

const primitiveTag = (value) => Object(value) === value
  ? undefined
  : Object.prototype.toString.call(value);
const isNumberValue = (value) => primitiveTag(value) === "[object Number]";
const isStringValue = (value) => primitiveTag(value) === "[object String]";

function isFunctionValue(value) {
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

const isRecordValue = (value) => (
  value !== null && Object(value) === value && !Array.isArray(value) && !isFunctionValue(value)
);

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return normalized === "localhost"
    || normalized === "localhost."
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

function connectHost(args) {
  const first = args[0];
  if (isNumberValue(first)) return isStringValue(args[1]) ? args[1] : "localhost";
  if (isRecordValue(first)) {
    if (isStringValue(first.path)) return undefined;
    if (first.port !== undefined) {
      if (isStringValue(first.hostname)) return first.hostname;
      if (isStringValue(first.host)) return first.host;
      return "localhost";
    }
  }
  return undefined;
}

if (globalThis[marker] !== true) {
  const nativeFetch = globalThis.fetch;
  const nativeConnect = Socket.prototype.connect;

  globalThis.fetch = async (input, init) => {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url.hostname)) {
      throw new Error(`External network access is disabled in the offline release evaluation: ${url.origin}`);
    }
    return await nativeFetch(input, init);
  };

  Socket.prototype.connect = function guardedConnect(...args) {
    const hostname = connectHost(args);
    if (hostname !== undefined && !isLoopback(hostname)) {
      throw new Error(`External network access is disabled in the offline release evaluation: ${hostname}`);
    }
    return nativeConnect.apply(this, args);
  };

  Object.defineProperty(globalThis, marker, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}
