import { parentPort } from "node:worker_threads";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE, isObjectValue } from "../core/value-schemas.js";
import { preprocessImageInProcess } from "./preprocess-core.js";

const IMAGE_OPTIONS_VALUE = Type.Object({
  autoResize: Type.Optional(BOOLEAN_VALUE),
  maxWidth: Type.Optional(NUMBER_VALUE),
  maxHeight: Type.Optional(NUMBER_VALUE),
  maxOutputBytes: Type.Optional(NUMBER_VALUE),
  maxInputPixels: Type.Optional(NUMBER_VALUE),
  jpegQuality: Type.Optional(NUMBER_VALUE),
});
type WorkerImageOptions = Static<typeof IMAGE_OPTIONS_VALUE>;

interface WorkerRequest {
  input: Uint8Array;
  options?: WorkerImageOptions;
}

function workerRequest<ValueType>(value: ValueType): WorkerRequest | undefined {
  if (!isObjectValue(value)) return undefined;
  const input = Object.getOwnPropertyDescriptor(value, "input")?.value;
  const options = Object.getOwnPropertyDescriptor(value, "options")?.value;
  if (!(input instanceof Uint8Array)) return undefined;
  if (options !== undefined) {
    if (isObjectValue(options)) {
      const autoResize = Object.getOwnPropertyDescriptor(options, "autoResize")?.value;
      if (autoResize !== undefined && !Value.Check(BOOLEAN_VALUE, autoResize)) {
        throw new TypeError("autoResize must be a boolean");
      }
    }
    if (!Value.Check(IMAGE_OPTIONS_VALUE, options)) return undefined;
  }
  return options === undefined ? { input } : { input, options };
}

const port = parentPort;
if (port === null) throw new Error("Image preprocessing worker requires a parent port");

port.once("message", async (value) => {
  try {
    const request = workerRequest(value);
    if (request === undefined) throw new TypeError("Invalid image worker request");
    const image = await preprocessImageInProcess(request.input, request.options);
    const transfer = image.bytes.buffer;
    if (!(transfer instanceof ArrayBuffer)) throw new TypeError("Image worker output must use an ArrayBuffer");
    port.postMessage({ ok: true, image }, [transfer]);
  } catch (error) {
    const descriptor = Error.isError(error)
      ? Object.getOwnPropertyDescriptor(error, "message")
      : undefined;
    const candidate = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    const message = Value.Check(STRING_VALUE, candidate) ? candidate : "Image preprocessing failed";
    port.postMessage({ ok: false, error: message.slice(0, 16 * 1024) });
  }
});
