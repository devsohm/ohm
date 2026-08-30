/** Preserve own-property omission without conditional empty-object spreads at each call site. */
export function optionalProperties<T extends object>(properties: Partial<T> | undefined): Partial<T> | undefined {
  return properties;
}
