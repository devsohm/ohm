/**
 * Returns an object whose properties are present only when their condition is true.
 *
 * This keeps own-property omission explicit without repeating conditional empty-object
 * spreads at every call site.
 */
export function optionalProperties<T extends object>(condition: boolean, properties: () => T): Partial<T> {
  const selected: Partial<T> = {};
  if (condition) Object.assign(selected, properties());
  return selected;
}

type OptionalProperty<Key extends PropertyKey, Value> = {
  [Property in Key]?: Exclude<Value, undefined>;
};

/** Returns one own enumerable property exactly when its value is defined. */
export function optionalProperty<Key extends PropertyKey, Value>(
  key: Key,
  value: Value,
): OptionalProperty<Key, Value> {
  const selected: OptionalProperty<Key, Value> = Object.create(null);
  if (value !== undefined) {
    Object.defineProperty(selected, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return selected;
}
