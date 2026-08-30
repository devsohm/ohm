import { Type } from "typebox";
import { Check } from "typebox/value";

/** Shared primitive schemas for decoding values at kernel I/O boundaries. */
export const BOOLEAN_VALUE = Type.Boolean();
export const FUNCTION_VALUE = Type.Function([], Type.Undefined());
export const JSON_CONTAINER_VALUE = Type.Union([Type.Array(Type.Unknown()), Type.Object({})]);
export const NUMBER_VALUE = Type.Number();
export const OBJECT_VALUE = Type.Object({});
export const STRING_VALUE = Type.String();

/** Recognizes non-null, non-callable objects without inspecting caller-owned properties. */
export function isObjectValue<Value>(value: Value): value is Value & object {
	return value !== null && Object(value) === value && !Check(FUNCTION_VALUE, value);
}

function isControlCodePoint(code: number, includeC1: boolean): boolean {
	return code <= 0x1f || code === 0x7f || (includeC1 && code >= 0x80 && code <= 0x9f);
}

/** Detects control characters without using a control-character regular expression. */
export function hasControlCharacters(value: string, includeC1 = true): boolean {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (code !== undefined && isControlCodePoint(code, includeC1)) return true;
	}
	return false;
}

/** Replaces control characters without invoking caller-owned behavior. */
export function replaceControlCharacters(value: string, replacement: string, includeC1 = true): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0);
		result += code !== undefined && isControlCodePoint(code, includeC1) ? replacement : character;
	}
	return result;
}
