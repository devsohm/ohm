import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { Check } from "typebox/value";

import { STRING_VALUE } from "../core/value-schemas.js";

const nativeSocketErrorCodes = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_INFO",
  "UND_ERR_SOCKET",
]);

interface NativeErrorCapture {
  socket?: object;
  code?: string;
}

const activeCapture = new AsyncLocalStorage<NativeErrorCapture>();
const socketCaptures = new WeakMap<object, NativeErrorCapture>();

channel("undici:websocket:socket_error").subscribe((error) => {
  try {
    const capture = activeCapture.getStore();
    const socket = capture?.socket;
    if (
      capture === undefined
      || socket === undefined
      || capture.code !== undefined
      || socketCaptures.get(socket) !== capture
    ) return;
    const code = nativeErrorCode(error);
    if (code !== undefined) capture.code = code;
  } catch {
    // Diagnostics must never interfere with the WebSocket lifecycle.
  }
});

/** @internal Constructs one WebSocket inside a correlation scope for Undici diagnostics. */
export function createWebSocketWithNativeErrorCapture<TSocket extends object>(create: () => TSocket): TSocket {
  const capture: NativeErrorCapture = {};
  const socket = activeCapture.run(capture, create);
  capture.socket = socket;
  socketCaptures.set(socket, capture);
  return socket;
}

/** @internal Consumes the allowlisted native transport code captured for one WebSocket. */
export function consumeWebSocketNativeErrorCode<TSocket extends object>(socket: TSocket): string | undefined {
  const capture = socketCaptures.get(socket);
  if (capture === undefined) return undefined;
  socketCaptures.delete(socket);
  return capture.code;
}

/** @internal Retains only native transport codes approved for local diagnostics. */
export function safeWebSocketNativeErrorCode<Value>(value: Value): string | undefined {
  return Check(STRING_VALUE, value) && nativeSocketErrorCodes.has(value) ? value : undefined;
}

function nativeErrorCode<Value>(value: Value): string | undefined {
  if (!Error.isError(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "code");
  if (descriptor === undefined || !("value" in descriptor) || !Check(STRING_VALUE, descriptor.value)) return undefined;
  return safeWebSocketNativeErrorCode(descriptor.value);
}
