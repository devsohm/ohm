import { isProxy } from "node:util/types";

import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "./errors.js";
import { validateImageSource } from "./image-source.js";
import { isJsonObject, type JsonObject } from "./json.js";
import type { ImageBlock } from "./types.js";

const MAX_PUBLIC_IMAGES = 20;
const MAX_IMAGE_LIST_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_LIST_VALUES = 1 + MAX_PUBLIC_IMAGES * 5;
const MAX_IMAGE_LIST_CONTAINERS = 1 + MAX_PUBLIC_IMAGES;
const ARRAY_LENGTH_VALUE = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const OBJECT_VALUE = Type.Object({}, { additionalProperties: true });
const STRING_VALUE = Type.String();
const PUBLIC_IMAGE_FIELDS = new Set(["type", "data", "mimeType"]);

const PUBLIC_IMAGE_VALUE = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
}, { additionalProperties: false });
type PublicImageValue = Static<typeof PUBLIC_IMAGE_VALUE>;

const INTERNAL_IMAGE_VALUE = Type.Object({
  type: Type.Literal("image"),
  mediaType: Type.String(),
  data: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
}, { additionalProperties: true });

function imageListSnapshot<T>(value: T, label: string): JsonObject[] {
  if (Value.Check(OBJECT_VALUE, value) && isProxy(value)) {
    throw new TypeError(`${label} must not contain proxies`);
  }
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a vanilla array`);
  const lengthValue = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Value.Check(ARRAY_LENGTH_VALUE, lengthValue)) {
    throw new TypeError(`${label} must be a dense vanilla array`);
  }
  const length = lengthValue;
  if (length > MAX_PUBLIC_IMAGES) throw new TypeError(`${label} must contain at most ${MAX_PUBLIC_IMAGES} images`);
  const selected = boundedJsonSnapshot(value, {
    label,
    maximumBytes: MAX_IMAGE_LIST_BYTES,
    maximumValues: MAX_IMAGE_LIST_VALUES,
    maximumContainers: MAX_IMAGE_LIST_CONTAINERS,
    maximumDepth: 2,
  }).value;
  if (!Array.isArray(selected)) throw new TypeError(`${label} must be an array`);
  return selected.map((image, index) => {
    if (isJsonObject(image)) return image;
    throw new TypeError(`${label}[${index}] must be an image object`);
  });
}

function publicImageRecord(record: JsonObject, label: string): PublicImageValue {
  for (const field of Object.keys(record)) {
    if (!PUBLIC_IMAGE_FIELDS.has(field)) throw new TypeError(`${label} contains unsupported field ${field}`);
  }
  if (record["type"] !== "image") throw new TypeError(`${label} type must be image`);
  if (!Value.Check(STRING_VALUE, record["mimeType"])) throw new TypeError(`${label} mimeType must be a string`);
  if (!Value.Check(STRING_VALUE, record["data"])) throw new TypeError(`${label} data must be a base64 string`);
  return { type: "image", mimeType: record["mimeType"], data: record["data"] };
}

function canonicalPublicImageRecord(record: JsonObject, label: string): ImageBlock {
  const selected = publicImageRecord(record, label);
  try {
    const source = validateImageSource({
      type: "image",
      mediaType: selected.mimeType,
      data: selected.data,
    });
    if (source.kind !== "base64") throw new TypeError(`${label} must contain base64 data`);
    return { type: "image", mediaType: source.mediaType, data: source.data };
  } catch (error) {
    throw new TypeError(`${label} is invalid: ${errorMessage(error).replaceAll("mediaType", "mimeType")}`);
  }
}

function canonicalInternalImage(record: JsonObject, label: string): ImageBlock {
  if (!Value.Check(INTERNAL_IMAGE_VALUE, record)) {
    throw new TypeError(`${label} must use the internal image contract`);
  }
  try {
    const source = validateImageSource(record);
    return source.kind === "base64"
      ? { type: "image", mediaType: source.mediaType, data: source.data }
      : { type: "image", mediaType: source.mediaType, url: source.url };
  } catch (error) {
    throw new TypeError(`${label} is invalid: ${errorMessage(error)}`);
  }
}

/** Validate and copy a public image list before it crosses into the runtime. */
export function canonicalPublicImages<T>(
  value: T,
  label: string,
): ImageBlock[] {
  return imageListSnapshot(value, label)
    .map((image, index) => canonicalPublicImageRecord(image, `${label}[${index}]`));
}

/** Canonicalize the SDK's legacy ImageBlock or public ImageContent list without inspecting caller objects. */
export function canonicalAgentInputImages<T>(value: T, label: string): ImageBlock[] {
  const images = imageListSnapshot(value, label);
  const usesPublicImageContract = images.some((image) => "mimeType" in image);
  return images.map((image, index) => {
    if (usesPublicImageContract) {
      return canonicalPublicImageRecord(image, `${label}[${index}]`);
    }
    return canonicalInternalImage(image, `${label}[${index}]`);
  });
}
