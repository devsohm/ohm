import { boundedRedactedMessage, utf8Prefix } from "../core/bounded-diagnostic.js";
import { errorMessage } from "../core/errors.js";
import { projectPluginError } from "../modes/plugin-error.js";
import type { RpcPluginErrorEvent } from "./rpc-protocol.js";
import { Value } from "typebox/value";
import { STRING_VALUE } from "../core/value-schemas.js";

const MAX_RPC_PLUGIN_ID_BYTES = 1_024;

/** @internal Bound untrusted failure input before applying secret-redaction patterns. */
export function boundedRpcErrorMessage<ErrorValue>(error: ErrorValue): string {
  return boundedRedactedMessage(errorMessage(error));
}

/** @internal Keep extension ownership present and bounded on the public RPC wire. */
export function boundedRpcPluginId<ValueType>(value: ValueType): string {
  const selected = Value.Check(STRING_VALUE, value) ? value.replaceAll("\0", "") : "";
  if (selected === "") return "runtime";
  return utf8Prefix(selected, MAX_RPC_PLUGIN_ID_BYTES) || "runtime";
}

/** @internal Project one redacted, owner-identified extension failure onto RPC. */
export function createRpcPluginErrorEvent(error: {
  extensionId?: string;
  extensionPath: string;
  event: string;
  error: string;
}): RpcPluginErrorEvent {
  return projectPluginError(error);
}
