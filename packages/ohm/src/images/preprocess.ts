import { Worker } from "node:worker_threads";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE, isObjectValue } from "../core/value-schemas.js";
import { inspectImage } from "../tools/image-info.js";
import {
  MAX_PREPROCESS_INPUT_BYTES,
  sniffImageMediaType,
  type ImageCoordinateMetadata,
  type ImagePreprocessOptions,
  type PreprocessedImage,
} from "./preprocess-core.js";

export {
  DEFAULT_PREPROCESS_MAX_HEIGHT,
  DEFAULT_PREPROCESS_MAX_WIDTH,
  DEFAULT_PREPROCESS_OUTPUT_BYTES,
  MAX_PREPROCESS_INPUT_BYTES,
  sniffImageMediaType,
} from "./preprocess-core.js";
export type {
  ImageCoordinateMetadata,
  ImagePreprocessOptions,
  PreprocessedImage,
  SniffedImageMediaType,
} from "./preprocess-core.js";

export interface ImagePreprocessExecutionOptions extends ImagePreprocessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type WorkerResponse =
  | { ok: true; image: PreprocessedImage }
  | { ok: false; error: string };

const COORDINATE_METADATA_VALUE = Type.Object({
  originalWidth: NUMBER_VALUE,
  originalHeight: NUMBER_VALUE,
  width: NUMBER_VALUE,
  height: NUMBER_VALUE,
  scaleX: NUMBER_VALUE,
  scaleY: NUMBER_VALUE,
  orientationApplied: BOOLEAN_VALUE,
  resized: BOOLEAN_VALUE,
  converted: BOOLEAN_VALUE,
});
const IMAGE_MEDIA_TYPE_VALUE = Type.Union([
  Type.Literal("image/png"),
  Type.Literal("image/jpeg"),
  Type.Literal("image/gif"),
  Type.Literal("image/webp"),
]);
const SOURCE_MEDIA_TYPE_VALUE = Type.Union([
  IMAGE_MEDIA_TYPE_VALUE,
  Type.Literal("image/bmp"),
  Type.Literal("image/tiff"),
]);
type ImageMediaType = Static<typeof IMAGE_MEDIA_TYPE_VALUE>;
type SourceMediaType = Static<typeof SOURCE_MEDIA_TYPE_VALUE>;

function workerResponse<ValueType>(value: ValueType): WorkerResponse | undefined {
  if (!isObjectValue(value)) return undefined;
  const ok = Object.getOwnPropertyDescriptor(value, "ok")?.value;
  if (ok === false) {
    const error = Object.getOwnPropertyDescriptor(value, "error")?.value;
    return Value.Check(STRING_VALUE, error) ? { ok: false, error } : undefined;
  }
  if (ok !== true) return undefined;
  const image = Object.getOwnPropertyDescriptor(value, "image")?.value;
  if (!isObjectValue(image)) return undefined;
  const bytes = Object.getOwnPropertyDescriptor(image, "bytes")?.value;
  const mediaType = Object.getOwnPropertyDescriptor(image, "mediaType")?.value;
  const sourceMediaType = Object.getOwnPropertyDescriptor(image, "sourceMediaType")?.value;
  const coordinates = Object.getOwnPropertyDescriptor(image, "coordinates")?.value;
  if (
    !(bytes instanceof Uint8Array)
    || !Value.Check(IMAGE_MEDIA_TYPE_VALUE, mediaType)
    || !Value.Check(SOURCE_MEDIA_TYPE_VALUE, sourceMediaType)
    || !Value.Check(COORDINATE_METADATA_VALUE, coordinates)
  ) return undefined;
  return {
    ok: true,
    image: {
      bytes,
      mediaType: mediaType satisfies ImageMediaType,
      sourceMediaType: sourceMediaType satisfies SourceMediaType,
      coordinates,
    },
  };
}

function executionTimeout(value: number | undefined): number {
  const selected = value ?? 15_000;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 60_000) {
    throw new RangeError("Image preprocessing timeout must be an integer from 1 to 60000 milliseconds");
  }
  return selected;
}

function validateWorkerImage(image: PreprocessedImage): PreprocessedImage {
  if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength < 1 || image.bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("Image preprocessing worker returned invalid bytes");
  }
  const sniffed = sniffImageMediaType(image.bytes);
  const info = inspectImage(image.bytes);
  if (info === undefined || sniffed !== image.mediaType || info.mediaType !== image.mediaType) {
    throw new Error("Image preprocessing worker returned mismatched image content");
  }
  const coordinates: ImageCoordinateMetadata = image.coordinates;
  if (
    info.width !== coordinates.width
    || info.height !== coordinates.height
    || !Number.isFinite(coordinates.scaleX)
    || !Number.isFinite(coordinates.scaleY)
    || coordinates.scaleX < 1
    || coordinates.scaleY < 1
  ) throw new Error("Image preprocessing worker returned invalid coordinate metadata");
  return image;
}

/** Converts, orients, and bounds image bytes on an isolated worker thread. */
export async function preprocessImage(
  input: Uint8Array,
  options: ImagePreprocessExecutionOptions = {},
): Promise<PreprocessedImage> {
  if (!(input instanceof Uint8Array) || input.byteLength < 1) throw new Error("Image input is empty");
  if (input.byteLength > MAX_PREPROCESS_INPUT_BYTES) throw new RangeError(`Image input exceeds ${MAX_PREPROCESS_INPUT_BYTES} bytes`);
  options.signal?.throwIfAborted();
  const timeoutMs = executionTimeout(options.timeoutMs);
  const { timeoutMs: _timeoutMs, signal, ...imageOptions } = options;
  const owned = new Uint8Array(input);
  const source = new URL(import.meta.url.endsWith(".ts") ? "./preprocess-worker.ts" : "./preprocess-worker.js", import.meta.url);
  const worker = new Worker(source);
  try {
    return await new Promise<PreprocessedImage>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => {
        const reason = signal?.reason;
        reject(reason === undefined ? new Error("Image preprocessing cancelled") : reason);
      });
      const timer = setTimeout(() => finish(() => reject(new Error(`Image preprocessing exceeded ${timeoutMs} milliseconds`))), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      worker.once("message", (message) => finish(() => {
        const response = workerResponse(message);
        if (response === undefined) {
          reject(new Error("Image preprocessing worker returned an invalid response"));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error));
          return;
        }
        try {
          resolve(validateWorkerImage(response.image));
        } catch (error) {
          reject(error);
        }
      }));
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new Error(`Image preprocessing worker exited with code ${code}`)));
      });
      worker.postMessage({ input: owned, options: imageOptions }, [owned.buffer]);
    });
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

export function imageCoordinateHint(coordinates: ImageCoordinateMetadata): string | undefined {
  if (!coordinates.resized && !coordinates.orientationApplied) return undefined;
  const scale = coordinates.resized
    ? ` Scale model coordinates by x=${coordinates.scaleX.toFixed(3)}, y=${coordinates.scaleY.toFixed(3)} for the original.`
    : "";
  return `Attached image geometry: original ${coordinates.originalWidth}x${coordinates.originalHeight}, supplied ${coordinates.width}x${coordinates.height}.${scale}`;
}
