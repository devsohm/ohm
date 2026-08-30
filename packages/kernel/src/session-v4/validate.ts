import { optionalProperty } from "../internal/optional-properties.js";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
	BOOLEAN_VALUE,
	FUNCTION_VALUE,
	isObjectValue,
	NUMBER_VALUE,
	STRING_VALUE,
} from "../internal/value-schemas.js";
import type {
	SessionV4Change,
	SessionV4Changes,
	SessionV4Commit,
	SessionV4CommitDraft,
	SessionV4Header,
	SessionV4Json,
	SessionV4RunSelection,
} from "./types.js";
import {
	SESSION_V4_MAX_JSON_DEPTH,
	SESSION_V4_MAX_JSON_VALUE_COUNT,
} from "./limits.js";

export class SessionV4ValidationError extends Error {
	constructor(message: string) {
		super(`invalid session file: ${message}`);
		this.name = "SessionV4ValidationError";
	}
}

const SESSION_V4_SOURCE = Type.Record(Type.String(), Type.Unknown());
type SessionV4Source = Static<typeof SESSION_V4_SOURCE>;

function fail(path: string, expectation: string): never {
	throw new SessionV4ValidationError(`${path} ${expectation}`);
}

function record<Value>(value: Value, path: string): SessionV4Source {
	if (!Check(SESSION_V4_SOURCE, value) || Array.isArray(value)) {
		return fail(path, "must be an object");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return fail(path, "must be a plain object");
	}
	return value;
}

function assertJsonBounds<Value>(value: Value, path: string): void {
	let count = 0;
	const ancestors = new Set<object>();

	const visit = <Candidate>(candidate: Candidate, candidatePath: string, depth: number): void => {
		count += 1;
		if (count > SESSION_V4_MAX_JSON_VALUE_COUNT) {
			fail(path, `must contain at most ${SESSION_V4_MAX_JSON_VALUE_COUNT} JSON values`);
		}
		if (depth > SESSION_V4_MAX_JSON_DEPTH) {
			fail(candidatePath, `must be nested at most ${SESSION_V4_MAX_JSON_DEPTH} levels`);
		}
		if (!isObjectValue(candidate) && !Check(FUNCTION_VALUE, candidate)) return;
		if (ancestors.has(candidate)) fail(candidatePath, "must not contain a cycle");
		ancestors.add(candidate);
		try {
			if (Array.isArray(candidate)) {
				for (let index = 0; index < candidate.length; index += 1) {
					visit(candidate[index], `${candidatePath}[${index}]`, depth + 1);
				}
				return;
			}
			for (const [key, item] of Object.entries(candidate)) {
				visit(item, `${candidatePath}.${key}`, depth + 1);
			}
		} finally {
			ancestors.delete(candidate);
		}
	};

	visit(value, path, 0);
}

function exactKeys(value: SessionV4Source, path: string, required: readonly string[], optional: readonly string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed");
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
	}
}

function literal<T extends string | number, Value>(value: Value, expected: T, path: string): T {
	if (!Object.is(value, expected)) fail(path, `must equal ${JSON.stringify(expected)}`);
	return expected;
}

function isChoice<const Choices extends readonly string[]>(
	value: string,
	choices: Choices,
): value is Choices[number] {
	return new Set<string>(choices).has(value);
}

function oneOf<const Choices extends readonly string[], Value>(
	value: Value,
	choices: Choices,
	path: string,
): Choices[number] {
	if (!Check(STRING_VALUE, value) || !isChoice(value, choices)) {
		return fail(path, `must be one of ${choices.join(", ")}`);
	}
	return value;
}

function text<Value>(value: Value, path: string, maximum = 4096): string {
	if (!Check(STRING_VALUE, value)) fail(path, "must be a string");
	if (value.length === 0) fail(path, "must not be empty");
	if (value.trim() !== value) fail(path, "must not start or end with whitespace");
	if (value.length > maximum) fail(path, `must contain at most ${maximum} characters`);
	return value;
}

function boundedString<Value>(value: Value, path: string, maximum = 65_536): string {
	if (!Check(STRING_VALUE, value)) fail(path, "must be a string");
	if (value.length === 0) fail(path, "must not be empty");
	if (value.length > maximum) fail(path, `must contain at most ${maximum} characters`);
	return value;
}

function boundedUtf8String<Value>(value: Value, path: string, maximumBytes: number): string {
	if (!Check(STRING_VALUE, value)) fail(path, "must be a string");
	if (value.length === 0) fail(path, "must not be empty");
	if (Buffer.byteLength(value, "utf8") > maximumBytes) {
		fail(path, `must contain at most ${maximumBytes} UTF-8 bytes`);
	}
	return value;
}

function nullableText<Value>(value: Value, path: string, maximum = 256): string | null {
	if (value === null) return null;
	return text(value, path, maximum);
}

function id<Value>(value: Value, path: string): string {
	return text(value, path, 256);
}

function timestamp<Value>(value: Value, path: string): string {
	if (!Check(STRING_VALUE, value)) fail(path, "must be a timestamp");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
		return fail(path, "must be a UTC ISO 8601 timestamp");
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf())) fail(path, "must be a valid timestamp");
	const canonical = parsed.toISOString();
	const expected = value.includes(".") ? value : value.replace(/Z$/u, ".000Z");
	if (canonical !== expected) fail(path, "must be a valid timestamp");
	return value;
}

function integer<Value>(value: Value, path: string, minimum: number): number {
	if (!Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < minimum) {
		fail(path, `must be a safe integer greater than or equal to ${minimum}`);
	}
	return value;
}

function stringList<Value>(value: Value, path: string): string[] {
	if (!Array.isArray(value)) fail(path, "must be an array");
	const result = Array.from(value, (item, index) => text(item, `${path}[${index}]`, 256));
	if (new Set(result).size !== result.length) fail(path, "must not contain duplicates");
	return result;
}

function jsonValue<Value>(value: Value, path: string, ancestors = new Set<object>()): SessionV4Json {
	if (value === null) return null;
	if (Check(BOOLEAN_VALUE, value)) return value;
	if (Check(STRING_VALUE, value)) return value;
	if (Check(NUMBER_VALUE, value)) {
		if (!Number.isFinite(value)) fail(path, "must contain only finite numbers");
		return Object.is(value, -0) ? 0 : value;
	}
	if (!isObjectValue(value)) return fail(path, "must be JSON data");
	if (ancestors.has(value)) fail(path, "must not contain a cycle");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return Array.from(value, (item, index) => jsonValue(item, `${path}[${index}]`, ancestors));
		}
		const source = record(value, path);
		const result: Record<string, SessionV4Json> = {};
		for (const [key, item] of Object.entries(source)) {
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: jsonValue(item, `${path}.${key}`, ancestors),
				writable: true,
			});
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function optionalJson(source: SessionV4Source, key: string, path: string): { present: false } | { present: true; value: SessionV4Json } {
	if (!Object.hasOwn(source, key)) return { present: false };
	return { present: true, value: jsonValue(source[key], `${path}.${key}`) };
}

function optionalReason(source: SessionV4Source, key: string, path: string): { present: false } | { present: true; value: string } {
	if (!Object.hasOwn(source, key)) return { present: false };
	return { present: true, value: text(source[key], `${path}.${key}`) };
}

function parseParent<Value>(value: Value, path: string): NonNullable<SessionV4Header["parent"]> {
	const source = record(value, path);
	exactKeys(source, path, ["sessionId"], ["originOperationId", "originToolEffectId", "purpose"]);
	return {
		sessionId: id(source.sessionId, `${path}.sessionId`),
		...optionalProperty(
			"originOperationId",
			Object.hasOwn(source, "originOperationId")
				? id(source.originOperationId, `${path}.originOperationId`)
				: undefined,
		),
		...optionalProperty(
			"originToolEffectId",
			Object.hasOwn(source, "originToolEffectId")
				? id(source.originToolEffectId, `${path}.originToolEffectId`)
				: undefined,
		),
		...optionalProperty(
			"purpose",
			Object.hasOwn(source, "purpose") ? text(source.purpose, `${path}.purpose`) : undefined,
		),
	};
}

export function parseSessionV4Header<Value>(value: Value): SessionV4Header {
	assertJsonBounds(value, "header");
	const source = record(value, "header");
	exactKeys(source, "header", ["record", "version", "sessionId", "createdAt", "workspace", "cwd"], ["parent"]);
	const header: SessionV4Header = {
		record: literal(source.record, "session", "header.record"),
		version: literal(source.version, 4, "header.version"),
		sessionId: id(source.sessionId, "header.sessionId"),
		createdAt: timestamp(source.createdAt, "header.createdAt"),
		workspace: boundedString(source.workspace, "header.workspace", 8192),
		cwd: boundedString(source.cwd, "header.cwd", 8192),
		...optionalProperty(
			"parent",
			Object.hasOwn(source, "parent") ? parseParent(source.parent, "header.parent") : undefined,
		),
	};
	if (header.parent?.sessionId === header.sessionId) {
		fail("header.parent.sessionId", "must identify a different session");
	}
	return header;
}

function parseConversationNodeChange(source: SessionV4Source, path: string): SessionV4Change {
	exactKeys(source, path, ["type", "node"]);
	const nodeSource = record(source.node, `${path}.node`);
	const nodePath = `${path}.node`;
	if (!Check(STRING_VALUE, nodeSource.nodeType)) fail(`${nodePath}.nodeType`, "must be a string");
	const parentId = nodeSource.parentId === null ? null : id(nodeSource.parentId, `${path}.node.parentId`);
	const nodeId = id(nodeSource.id, `${path}.node.id`);
	if (parentId === nodeId) fail(`${path}.node.parentId`, "must not equal the node id");
	const base = {
		id: nodeId,
		parentId,
		createdAt: timestamp(nodeSource.createdAt, `${nodePath}.createdAt`),
		...optionalProperty(
			"operationId",
			Object.hasOwn(nodeSource, "operationId")
				? id(nodeSource.operationId, `${nodePath}.operationId`)
				: undefined,
		),
	};
	const optional = ["operationId"] as const;
	switch (nodeSource.nodeType) {
		case "message":
			exactKeys(nodeSource, nodePath, ["id", "parentId", "nodeType", "role", "content", "createdAt"], optional);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "message",
					role: oneOf(nodeSource.role, ["system", "user", "assistant", "tool"], `${nodePath}.role`),
					content: jsonValue(nodeSource.content, `${nodePath}.content`),
				},
			};
		case "model_change":
			exactKeys(nodeSource, nodePath, ["id", "parentId", "nodeType", "provider", "model", "createdAt"], optional);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "model_change",
					provider: text(nodeSource.provider, `${nodePath}.provider`, 256),
					model: text(nodeSource.model, `${nodePath}.model`, 256),
				},
			};
		case "thinking_change":
			exactKeys(nodeSource, nodePath, ["id", "parentId", "nodeType", "level", "createdAt"], optional);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "thinking_change",
					level: oneOf(
						nodeSource.level,
						["off", "minimal", "low", "medium", "high", "xhigh", "max"],
						`${nodePath}.level`,
					),
				},
			};
		case "tools_change":
			exactKeys(
				nodeSource,
				nodePath,
				["id", "parentId", "nodeType", "tools", "toolsetFingerprint", "createdAt"],
				optional,
			);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "tools_change",
					tools: stringList(nodeSource.tools, `${nodePath}.tools`),
					toolsetFingerprint: text(nodeSource.toolsetFingerprint, `${nodePath}.toolsetFingerprint`, 512),
				},
			};
		case "compaction":
			exactKeys(
				nodeSource,
				nodePath,
				["id", "parentId", "nodeType", "summary", "retainedNodeIds", "createdAt"],
				optional,
			);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "compaction",
					summary: jsonValue(nodeSource.summary, `${nodePath}.summary`),
					retainedNodeIds: stringList(nodeSource.retainedNodeIds, `${nodePath}.retainedNodeIds`),
				},
			};
		case "branch_summary":
			exactKeys(
				nodeSource,
				nodePath,
				["id", "parentId", "nodeType", "fromNodeId", "toNodeId", "summary", "createdAt"],
				optional,
			);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "branch_summary",
					fromNodeId: id(nodeSource.fromNodeId, `${nodePath}.fromNodeId`),
					toNodeId: id(nodeSource.toNodeId, `${nodePath}.toNodeId`),
					summary: jsonValue(nodeSource.summary, `${nodePath}.summary`),
				},
			};
		case "extension_context":
			exactKeys(
				nodeSource,
				nodePath,
				["id", "parentId", "nodeType", "extensionId", "context", "createdAt"],
				optional,
			);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "extension_context",
					extensionId: id(nodeSource.extensionId, `${nodePath}.extensionId`),
					context: jsonValue(nodeSource.context, `${nodePath}.context`),
				},
			};
		case "extension_state":
			exactKeys(
				nodeSource,
				nodePath,
				["id", "parentId", "nodeType", "extensionId", "state", "createdAt"],
				optional,
			);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "extension_state",
					extensionId: id(nodeSource.extensionId, `${nodePath}.extensionId`),
					state: jsonValue(nodeSource.state, `${nodePath}.state`),
				},
			};
		case "shell":
			exactKeys(
				nodeSource,
				nodePath,
				["id", "parentId", "nodeType", "command", "cwd", "result", "createdAt"],
				optional,
			);
			return {
				type: "conversation_node",
				node: {
					...base,
					nodeType: "shell",
					command: boundedString(nodeSource.command, `${nodePath}.command`),
					cwd: boundedString(nodeSource.cwd, `${nodePath}.cwd`, 8192),
					result: jsonValue(nodeSource.result, `${nodePath}.result`),
				},
			};
		default:
			return fail(`${nodePath}.nodeType`, "is not recognized");
	}
}

function parseRunSelection<Value>(value: Value, path: string): SessionV4RunSelection {
	const selection = record(value, path);
	exactKeys(selection, path, [
		"provider",
		"model",
		"api",
		"thinkingLevel",
		"toolNames",
		"toolsetFingerprint",
	]);
	return {
		provider: text(selection.provider, `${path}.provider`, 256),
		model: text(selection.model, `${path}.model`, 256),
		api: nullableText(selection.api, `${path}.api`, 256),
		thinkingLevel: oneOf(
			selection.thinkingLevel,
			["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			`${path}.thinkingLevel`,
		),
		toolNames: stringList(selection.toolNames, `${path}.toolNames`),
		toolsetFingerprint: text(selection.toolsetFingerprint, `${path}.toolsetFingerprint`, 512),
	};
}

function parseChange<Value>(value: Value, path: string): SessionV4Change {
	const source = record(value, path);
	if (!Check(STRING_VALUE, source.type)) fail(`${path}.type`, "must be a string");
	switch (source.type) {
		case "conversation_node":
			return parseConversationNodeChange(source, path);
		case "head":
			exactKeys(source, path, ["type", "branchId", "nodeId"]);
			return {
				type: "head",
				branchId: literal(source.branchId, "main", `${path}.branchId`),
				nodeId: source.nodeId === null ? null : id(source.nodeId, `${path}.nodeId`),
			};
		case "session_name":
			exactKeys(source, path, ["type", "name"]);
			return { type: "session_name", name: nullableText(source.name, `${path}.name`) };
		case "node_label":
			exactKeys(source, path, ["type", "nodeId", "label"]);
			return {
				type: "node_label",
				nodeId: id(source.nodeId, `${path}.nodeId`),
				label: nullableText(source.label, `${path}.label`),
			};
		case "run_accepted": {
			exactKeys(source, path, [
				"type",
				"branchId",
				"operationId",
				"promptNodeId",
				"sourceHeadId",
				"acceptedAt",
				"request",
				"selection",
			]);
			return {
				type: "run_accepted",
				branchId: literal(source.branchId, "main", `${path}.branchId`),
				operationId: id(source.operationId, `${path}.operationId`),
				promptNodeId:
					source.promptNodeId === null ? null : id(source.promptNodeId, `${path}.promptNodeId`),
				sourceHeadId: source.sourceHeadId === null ? null : id(source.sourceHeadId, `${path}.sourceHeadId`),
				acceptedAt: timestamp(source.acceptedAt, `${path}.acceptedAt`),
				request: jsonValue(source.request, `${path}.request`),
				selection: parseRunSelection(source.selection, `${path}.selection`),
			};
		}
		case "run_step_selected":
			exactKeys(source, path, ["type", "operationId", "step", "selectedAt", "selection"]);
			return {
				type: "run_step_selected",
				operationId: id(source.operationId, `${path}.operationId`),
				step: integer(source.step, `${path}.step`, 0),
				selectedAt: timestamp(source.selectedAt, `${path}.selectedAt`),
				selection: parseRunSelection(source.selection, `${path}.selection`),
			};
		case "run_attempt":
			exactKeys(source, path, ["type", "operationId", "attemptId", "step", "attempt", "task", "startedAt"]);
			return {
				type: "run_attempt",
				operationId: id(source.operationId, `${path}.operationId`),
				attemptId: id(source.attemptId, `${path}.attemptId`),
				step: integer(source.step, `${path}.step`, 0),
				attempt: integer(source.attempt, `${path}.attempt`, 1),
				task: text(source.task, `${path}.task`, 256),
				startedAt: timestamp(source.startedAt, `${path}.startedAt`),
			};
		case "run_cancel": {
			exactKeys(source, path, ["type", "operationId", "cancelId", "requestedAt"], ["reason"]);
			const reason = optionalReason(source, "reason", path);
			return {
				type: "run_cancel",
				operationId: id(source.operationId, `${path}.operationId`),
				cancelId: id(source.cancelId, `${path}.cancelId`),
				requestedAt: timestamp(source.requestedAt, `${path}.requestedAt`),
				...optionalProperty("reason", reason.present ? reason.value : undefined),
			};
		}
		case "run_checkpoint":
			exactKeys(source, path, ["type", "operationId", "checkpointId", "createdAt", "data"]);
			return {
				type: "run_checkpoint",
				operationId: id(source.operationId, `${path}.operationId`),
				checkpointId: id(source.checkpointId, `${path}.checkpointId`),
				createdAt: timestamp(source.createdAt, `${path}.createdAt`),
				data: jsonValue(source.data, `${path}.data`),
			};
		case "run_finished": {
			exactKeys(source, path, ["type", "operationId", "finishedAt", "outcome"], ["detail"]);
			const detail = optionalJson(source, "detail", path);
			return {
				type: "run_finished",
				operationId: id(source.operationId, `${path}.operationId`),
				finishedAt: timestamp(source.finishedAt, `${path}.finishedAt`),
				outcome: oneOf(source.outcome, ["completed", "failed", "cancelled"], `${path}.outcome`),
				...optionalProperty("detail", detail.present ? detail.value : undefined),
			};
		}
		case "queue_added":
			exactKeys(source, path, ["type", "branchId", "entryId", "targetNodeId", "kind", "addedAt", "message"]);
			return {
				type: "queue_added",
				branchId: literal(source.branchId, "main", `${path}.branchId`),
				entryId: id(source.entryId, `${path}.entryId`),
				targetNodeId: id(source.targetNodeId, `${path}.targetNodeId`),
				kind: oneOf(source.kind, ["steering", "follow_up", "next_run"], `${path}.kind`),
				addedAt: timestamp(source.addedAt, `${path}.addedAt`),
				message: jsonValue(source.message, `${path}.message`),
			};
		case "queue_claimed":
			exactKeys(source, path, ["type", "branchId", "entryId", "operationId", "claimedAt"]);
			return {
				type: "queue_claimed",
				branchId: literal(source.branchId, "main", `${path}.branchId`),
				entryId: id(source.entryId, `${path}.entryId`),
				operationId: id(source.operationId, `${path}.operationId`),
				claimedAt: timestamp(source.claimedAt, `${path}.claimedAt`),
			};
		case "queue_finished":
			exactKeys(source, path, ["type", "branchId", "entryId", "finishedAt", "outcome"]);
			return {
				type: "queue_finished",
				branchId: literal(source.branchId, "main", `${path}.branchId`),
				entryId: id(source.entryId, `${path}.entryId`),
				finishedAt: timestamp(source.finishedAt, `${path}.finishedAt`),
				outcome: oneOf(source.outcome, ["consumed", "cancelled"], `${path}.outcome`),
			};
		case "tool_effect_prepared":
			exactKeys(source, path, [
				"type",
				"effectId",
				"operationId",
				"invocationId",
				"callId",
				"toolName",
				"policy",
				"effectiveInput",
				"inputHash",
				"resultNodeId",
				"step",
				"index",
				"assistantNodeId",
				"toolsetFingerprint",
				"preparedAt",
			]);
			return {
				type: "tool_effect_prepared",
				effectId: id(source.effectId, `${path}.effectId`),
				operationId: id(source.operationId, `${path}.operationId`),
				invocationId: id(source.invocationId, `${path}.invocationId`),
				callId: boundedUtf8String(source.callId, `${path}.callId`, 1_024),
				toolName: text(source.toolName, `${path}.toolName`, 256),
				policy: oneOf(source.policy, ["repeatable", "reconcile", "never_repeat"], `${path}.policy`),
				effectiveInput: jsonValue(source.effectiveInput, `${path}.effectiveInput`),
				inputHash: text(source.inputHash, `${path}.inputHash`, 512),
				resultNodeId: id(source.resultNodeId, `${path}.resultNodeId`),
				step: integer(source.step, `${path}.step`, 0),
				index: integer(source.index, `${path}.index`, 0),
				assistantNodeId: id(source.assistantNodeId, `${path}.assistantNodeId`),
				toolsetFingerprint: text(source.toolsetFingerprint, `${path}.toolsetFingerprint`, 512),
				preparedAt: timestamp(source.preparedAt, `${path}.preparedAt`),
			};
		case "tool_effect_dispatched":
			exactKeys(source, path, ["type", "effectId", "dispatchId", "dispatchedAt"]);
			return {
				type: "tool_effect_dispatched",
				effectId: id(source.effectId, `${path}.effectId`),
				dispatchId: id(source.dispatchId, `${path}.dispatchId`),
				dispatchedAt: timestamp(source.dispatchedAt, `${path}.dispatchedAt`),
			};
		case "tool_effect_in_doubt": {
			exactKeys(source, path, ["type", "effectId", "noticedAt"], ["detail"]);
			const detail = optionalJson(source, "detail", path);
			return {
				type: "tool_effect_in_doubt",
				effectId: id(source.effectId, `${path}.effectId`),
				noticedAt: timestamp(source.noticedAt, `${path}.noticedAt`),
				...optionalProperty("detail", detail.present ? detail.value : undefined),
			};
		}
		case "tool_effect_recovery_started":
			exactKeys(source, path, ["type", "effectId", "recoveryId", "startedAt"]);
			return {
				type: "tool_effect_recovery_started",
				effectId: id(source.effectId, `${path}.effectId`),
				recoveryId: id(source.recoveryId, `${path}.recoveryId`),
				startedAt: timestamp(source.startedAt, `${path}.startedAt`),
			};
		case "tool_effect_finished": {
			exactKeys(source, path, ["type", "effectId", "finishedAt", "outcome"], ["result"]);
			const result = optionalJson(source, "result", path);
			return {
				type: "tool_effect_finished",
				effectId: id(source.effectId, `${path}.effectId`),
				finishedAt: timestamp(source.finishedAt, `${path}.finishedAt`),
				outcome: oneOf(source.outcome, ["succeeded", "failed"], `${path}.outcome`),
				...optionalProperty("result", result.present ? result.value : undefined),
			};
		}
		case "tool_effect_reconciled": {
			exactKeys(source, path, ["type", "effectId", "reconciliationId", "resolvedAt", "outcome"], ["result"]);
			const result = optionalJson(source, "result", path);
			return {
				type: "tool_effect_reconciled",
				effectId: id(source.effectId, `${path}.effectId`),
				reconciliationId: id(source.reconciliationId, `${path}.reconciliationId`),
				resolvedAt: timestamp(source.resolvedAt, `${path}.resolvedAt`),
				outcome: oneOf(source.outcome, ["succeeded", "failed", "not_applied"], `${path}.outcome`),
				...optionalProperty("result", result.present ? result.value : undefined),
			};
		}
		case "tool_effect_manually_resolved": {
			exactKeys(source, path, ["type", "effectId", "resolutionId", "resolvedAt", "outcome"], ["result"]);
			const result = optionalJson(source, "result", path);
			return {
				type: "tool_effect_manually_resolved",
				effectId: id(source.effectId, `${path}.effectId`),
				resolutionId: id(source.resolutionId, `${path}.resolutionId`),
				resolvedAt: timestamp(source.resolvedAt, `${path}.resolvedAt`),
				outcome: oneOf(source.outcome, ["succeeded", "failed", "abandoned"], `${path}.outcome`),
				...optionalProperty("result", result.present ? result.value : undefined),
			};
		}
		default:
			return fail(`${path}.type`, "is not recognized");
	}
}

function parseChanges<Value>(value: Value, path: string): SessionV4Changes {
	if (!Array.isArray(value)) fail(path, "must be an array");
	if (value.length === 0) fail(path, "must not be empty");
	const first = parseChange(value[0], `${path}[0]`);
	const rest = value.slice(1).map((change, index) => parseChange(change, `${path}[${index + 1}]`));
	return [first, ...rest];
}

export function parseSessionV4Commit<Value>(value: Value, path = "commit"): SessionV4Commit {
	assertJsonBounds(value, path);
	const source = record(value, path);
	exactKeys(source, path, ["record", "sequence", "commitId", "committedAt", "changes"]);
	const sequence = integer(source.sequence, `${path}.sequence`, 1);
	return {
		record: literal(source.record, "commit", `${path}.record`),
		sequence,
		commitId: id(source.commitId, `${path}.commitId`),
		committedAt: timestamp(source.committedAt, `${path}.committedAt`),
		changes: parseChanges(source.changes, `${path}.changes`),
	};
}

export function parseSessionV4CommitDraft<Value>(value: Value): SessionV4CommitDraft {
	assertJsonBounds(value, "commit");
	const source = record(value, "commit");
	exactKeys(source, "commit", ["commitId", "committedAt", "changes"]);
	return {
		commitId: id(source.commitId, "commit.commitId"),
		committedAt: timestamp(source.committedAt, "commit.committedAt"),
		changes: parseChanges(source.changes, "commit.changes"),
	};
}
