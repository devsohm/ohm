import assert from "node:assert/strict";
import test from "node:test";
import { isObjectValue } from "../../src/internal/value-schemas.js";
import {
	applySessionV4CommitOwned,
	cloneSessionV4State,
	createSessionV4ReducerState,
	createSessionV4State,
	sessionV4ToolInputHash,
	validateSessionV4CommitTransition,
	type SessionV4Change,
	type SessionV4CheckpointState,
	type SessionV4Commit,
	type SessionV4ConversationNode,
	type SessionV4Header,
	type SessionV4OperationState,
	type SessionV4QueueEntryState,
	type SessionV4RecordCollection,
	type SessionV4RunSelection,
	type SessionV4ToolEffectState,
} from "../../src/session-v4/index.js";

function deepFreeze<Value>(value: Value): Value {
	if (isObjectValue(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** No shared read aliases: every access behaves like decoding a stored record. */
class DetachedRecords<Value extends object> implements SessionV4RecordCollection<Value> {
	readonly #records = new Map<string, Value>();
	get size(): number { return this.#records.size; }
	has(id: string): boolean { return this.#records.has(id); }
	get(id: string): Value | undefined {
		const value = this.#records.get(id);
		return value === undefined ? undefined : deepFreeze(structuredClone(value));
	}
	set(id: string, value: Value): void { this.#records.set(id, structuredClone(value)); }
	delete(id: string): boolean { return this.#records.delete(id); }
	keys(): IterableIterator<string> { return this.#records.keys(); }
	*entries(): IterableIterator<[string, Value]> {
		for (const [id, value] of this.#records) yield [id, deepFreeze(structuredClone(value))];
	}
	*values(): IterableIterator<Value> { for (const [, value] of this.entries()) yield value; }
	[Symbol.iterator](): IterableIterator<[string, Value]> { return this.entries(); }
}

const TIME = "2026-09-06T12:00:00.000Z";
const HEADER: SessionV4Header = {
	record: "session", version: 4, sessionId: "detached-records", createdAt: TIME,
	workspace: "/workspace", cwd: "/workspace/project",
};
const SELECTION: SessionV4RunSelection = {
	provider: "provider", model: "model", api: null, thinkingLevel: "high",
	toolNames: ["read"], toolsetFingerprint: "tools",
};

function message(id: string, parentId: string | null, role: "system" | "user" | "assistant" | "tool"): SessionV4Change {
	const node: SessionV4ConversationNode = {
		id, parentId, nodeType: "message", role, content: { text: id }, createdAt: TIME,
	};
	if (role !== "system") node.operationId = "operation";
	return { type: "conversation_node", node };
}

test("replace-only collections match Map replay and rollback without mutable read aliases", () => {
	const plain = createSessionV4State(HEADER);
	const owned = createSessionV4ReducerState(HEADER, {
		nodes: new DetachedRecords<SessionV4ConversationNode>(),
		operations: new DetachedRecords<SessionV4OperationState>(),
		checkpoints: new DetachedRecords<SessionV4CheckpointState>(),
		queue: new DetachedRecords<SessionV4QueueEntryState>(),
		toolEffects: new DetachedRecords<SessionV4ToolEffectState>(),
		commits: new DetachedRecords<SessionV4Commit>(),
	});
	const commitIterator = owned.commits.values();
	const apply = (first: SessionV4Change, ...rest: SessionV4Change[]): void => {
		const commit: SessionV4Commit = {
			record: "commit", commitId: `commit-${plain.sequence + 1}`, sequence: plain.sequence + 1,
			committedAt: TIME, changes: [first, ...rest],
		};
		const before = cloneSessionV4State(owned);
		validateSessionV4CommitTransition(owned, commit);
		assert.deepEqual(cloneSessionV4State(owned), before, "validation must leave no retained mutation");
		assert.throws(() => applySessionV4CommitOwned(owned, {
			...commit, commitId: `invalid-${commit.commitId}`,
			changes: [...commit.changes, { type: "head", branchId: "main", nodeId: "missing-node" }],
		}), /unknown node/u);
		assert.deepEqual(cloneSessionV4State(owned), before, "a late invalid change must undo earlier replacements");
		assert.equal(applySessionV4CommitOwned(plain, commit), true);
		assert.equal(applySessionV4CommitOwned(owned, commit), true);
		assert.deepEqual(cloneSessionV4State(owned), plain, commit.commitId);
		assert.equal(applySessionV4CommitOwned(owned, commit), false, "accepted commits remain idempotent");
		assert.deepEqual(commitIterator.next().value, commit, "paused commit iterators see later inserts");
	};

	apply(message("root", null, "system"), { type: "head", branchId: "main", nodeId: "root" });
	apply({
		type: "queue_added", branchId: "main", entryId: "queue", targetNodeId: "prompt",
		kind: "next_run", addedAt: TIME, message: { text: "work" },
	});
	apply({
		type: "run_accepted", branchId: "main", operationId: "operation", promptNodeId: "prompt",
		sourceHeadId: "root", acceptedAt: TIME, request: { text: "work" }, selection: SELECTION,
	}, { type: "queue_claimed", branchId: "main", entryId: "queue", operationId: "operation", claimedAt: TIME });
	apply(message("prompt", "root", "user"), { type: "head", branchId: "main", nodeId: "prompt" });
	apply({ type: "run_step_selected", operationId: "operation", step: 0, selectedAt: TIME, selection: SELECTION }, {
		type: "run_attempt", operationId: "operation", attemptId: "attempt-0-1", step: 0, attempt: 1,
		task: "model", startedAt: TIME,
	});
	apply({
		type: "run_attempt", operationId: "operation", attemptId: "attempt-0-2", step: 0, attempt: 2,
		task: "retry", startedAt: TIME,
	});
	apply({ type: "run_step_selected", operationId: "operation", step: 1, selectedAt: TIME, selection: SELECTION }, {
		type: "run_attempt", operationId: "operation", attemptId: "attempt-1-1", step: 1, attempt: 1,
		task: "model", startedAt: TIME,
	});
	apply({ type: "run_checkpoint", operationId: "operation", checkpointId: "checkpoint", createdAt: TIME, data: { messages: ["work"] } });
	apply(message("assistant", "prompt", "assistant"), { type: "head", branchId: "main", nodeId: "assistant" });
	const policies = ["repeatable", "reconcile", "never_repeat", "repeatable"] as const;
	for (const [index, policy] of policies.entries()) {
		const effectiveInput = { path: `file-${index}` };
		apply({
			type: "tool_effect_prepared", effectId: `effect-${index}`, operationId: "operation",
			invocationId: `invocation-${index}`, callId: `call-${index}`, toolName: "read", policy,
			effectiveInput, inputHash: sessionV4ToolInputHash(effectiveInput), resultNodeId: `result-${index}`,
			step: 1, index, assistantNodeId: "assistant", toolsetFingerprint: "tools", preparedAt: TIME,
		});
		if (index === 3) continue;
		apply({ type: "tool_effect_dispatched", effectId: `effect-${index}`, dispatchId: `dispatch-${index}`, dispatchedAt: TIME });
		apply({ type: "tool_effect_in_doubt", effectId: `effect-${index}`, noticedAt: TIME, detail: { reason: "interrupted" } });
	}
	apply({ type: "tool_effect_dispatched", effectId: "effect-0", dispatchId: "retry-0", dispatchedAt: TIME }, {
		type: "tool_effect_finished", effectId: "effect-0", finishedAt: TIME, outcome: "succeeded", result: { text: "done" },
	});
	apply({ type: "tool_effect_recovery_started", effectId: "effect-1", recoveryId: "recovery-1", startedAt: TIME }, {
		type: "tool_effect_reconciled", effectId: "effect-1", reconciliationId: "recovery-1", resolvedAt: TIME, outcome: "not_applied",
	});
	apply({ type: "tool_effect_manually_resolved", effectId: "effect-2", resolutionId: "manual-2", resolvedAt: TIME, outcome: "abandoned" });
	apply({ type: "run_cancel", operationId: "operation", cancelId: "cancel", requestedAt: TIME, reason: "stop" });
	for (let index = 0; index < policies.length; index += 1) {
		apply(message(`result-${index}`, index === 0 ? "assistant" : `result-${index - 1}`, "tool"), {
			type: "head", branchId: "main", nodeId: `result-${index}`,
		});
	}
	apply({
		type: "queue_added", branchId: "main", entryId: "cancelled-queue", targetNodeId: "cancelled-prompt",
		kind: "follow_up", addedAt: TIME, message: { text: "later" },
	});
	apply({ type: "queue_finished", branchId: "main", entryId: "cancelled-queue", finishedAt: TIME, outcome: "cancelled" });
	apply({ type: "queue_finished", branchId: "main", entryId: "queue", finishedAt: TIME, outcome: "consumed" });
	apply({ type: "run_finished", operationId: "operation", finishedAt: TIME, outcome: "cancelled", detail: { reason: "user" } });
	apply({ type: "node_label", nodeId: "root", label: "start" });
	apply({ type: "node_label", nodeId: "root", label: null }, { type: "session_name", name: "detached replay" });

	const snapshot = cloneSessionV4State(owned);
	for (const key of ["nodes", "operations", "checkpoints", "queue", "toolEffects", "commits"] as const) {
		assert.ok(snapshot[key] instanceof Map, `${key} snapshot is a real Map`);
	}
	const operation = owned.operations.get("operation")!;
	assert.notEqual(operation, owned.operations.get("operation"));
	assert.ok(Object.isFrozen(operation.stepSelections[0]!.selection.toolNames));
	snapshot.operations.get("operation")!.stepSelections[0]!.selection.toolNames.push("snapshot-only");
	assert.deepEqual(cloneSessionV4State(owned), plain, "public snapshot mutations cannot reach owned records");
});
