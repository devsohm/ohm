const primitiveTag = (value) => Object(value) === value
  ? undefined
  : Object.prototype.toString.call(value);

export const isBooleanValue = (value) => value === true || value === false;

export function isFunctionValue(value) {
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

export const isNumberValue = (value) => primitiveTag(value) === "[object Number]";

export const isRecordValue = (value) => (
  value !== null
  && Object(value) === value
  && !Array.isArray(value)
  && !isFunctionValue(value)
);

export const isStringValue = (value) => primitiveTag(value) === "[object String]";

export const isSymbolValue = (value) => primitiveTag(value) === "[object Symbol]";
