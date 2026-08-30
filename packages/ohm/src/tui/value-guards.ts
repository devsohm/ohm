import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const BOOLEAN_VALUE = Type.Boolean();
const FUNCTION_VALUE = Type.Function([], Type.Unknown());
const NUMBER_VALUE = Type.Number();
const RECORD_VALUE = Type.Record(Type.String(), Type.Unknown());
const STRING_VALUE = Type.String();

type CallableValue = (...arguments_: never[]) => void;
type NarrowedValue<Value, Selected> = Value & (
  [Extract<Value, Selected>] extends [never] ? Selected : Extract<Value, Selected>
);

export type RuntimeRecord = Static<typeof RECORD_VALUE>;
export type RuntimeValue = undefined | null | boolean | number | bigint | string | symbol | object | CallableValue;

interface ErrorPredicate {
  isError<Value>(candidate: Value): boolean;
}

function hasErrorPredicate(value: ErrorConstructor): value is ErrorConstructor & ErrorPredicate {
  return "isError" in value && isFunctionValue(value.isError);
}

export function isBooleanValue<Value>(value: Value): value is NarrowedValue<Value, boolean> {
  return Check(BOOLEAN_VALUE, value);
}

export function isFunctionValue<Value>(value: Value): value is NarrowedValue<Value, CallableValue> {
  return Check(FUNCTION_VALUE, value);
}

export function isErrorValue<Value>(value: Value): value is Value & Error {
  return hasErrorPredicate(Error) && Error.isError(value);
}

export function isNumberValue<Value>(value: Value): value is NarrowedValue<Value, number> {
  return Check(NUMBER_VALUE, value);
}

export function isSafeIntegerValue<Value>(value: Value): value is NarrowedValue<Value, number> {
  return isNumberValue(value) && Number.isSafeInteger(value);
}

export function isStringValue<Value>(value: Value): value is NarrowedValue<Value, string> {
  return Check(STRING_VALUE, value);
}

/** Preserves JavaScript's object-type distinction while providing a reusable typed boundary. */
export function hasObjectType<Value>(value: Value): value is NarrowedValue<Value, object | null> {
  return value === null || isObjectValue(value);
}

export function isObjectValue<Value>(value: Value): value is NarrowedValue<Value, object> {
  return value !== null && Object(value) === value && !isFunctionValue(value);
}

export function isRecordValue<Value>(value: Value): value is NarrowedValue<Value, RuntimeRecord> {
  return isObjectValue(value) && !Array.isArray(value);
}

export function isStringMember<Value, const Options extends readonly string[]>(
  value: Value,
  options: Options,
): value is NarrowedValue<Value, Options[number]> {
  return isStringValue(value) && options.some((option) => option === value);
}
