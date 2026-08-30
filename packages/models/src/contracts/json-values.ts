/** Values that can cross provider JSON protocol boundaries without type erasure. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A provider JSON object after parsing at the transport boundary. */
export interface JsonObject {
  [name: string]: JsonValue;
}
