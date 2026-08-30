import { optionalProperties } from "../core/optional-properties.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import type { ResourceClaim, ToolExecutionContext, ToolInvocation } from "./types.js";
import { Check } from "typebox/value";

/** Exact, immutable tool effect presented to the host immediately before dispatch. */
export interface ToolAuthorizationRequest {
  readonly invocation: Readonly<ToolInvocation>;
  readonly resources: readonly Readonly<ResourceClaim>[];
  readonly backendId: string;
  readonly recovered: boolean;
}

export type ToolAuthorizationDecision =
  | { readonly decision: "allow_once" }
  | { readonly decision: "deny"; readonly reason?: string };

export type ToolAuthorizationOwner =
  | { readonly kind: "builtin" }
  | { readonly kind: "host" }
  | {
      readonly kind: "extension";
      readonly extensionId: string;
      readonly sourcePath: string;
      readonly scope?: "builtin" | "user" | "project" | "invocation";
    };

/** Bounded host context for one model-requested tool authorization decision. */
export interface ToolAuthorizationContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly owner: ToolAuthorizationOwner;
  readonly branch?: string;
  readonly step?: number;
}

/** Host-owned, invocation-scoped tool authorization boundary. */
export type ToolAuthorizationHandler = (
  request: ToolAuthorizationRequest,
  context: ToolAuthorizationContext,
) => Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;

function freezeJson(value: JsonValue): JsonValue {
  const selected = structuredClone(value);
  if (!Array.isArray(selected) && !isJsonObject(selected)) return selected;
  const pending: Array<JsonObject | JsonValue[]> = [selected];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if ((Array.isArray(child) || isJsonObject(child)) && !Object.isFrozen(child)) pending.push(child);
    }
    Object.freeze(current);
  }
  return selected;
}

/** @internal Build a callback-safe snapshot without exposing coordinator-owned objects. */
export function toolAuthorizationRequest(
  invocation: ToolInvocation,
  resources: readonly ResourceClaim[],
  backendId: string,
  recovered: boolean,
): ToolAuthorizationRequest {
  const selectedInvocation = Object.freeze({
    ...invocation,
    input: freezeJson(invocation.input),
  });
  const selectedResources = Object.freeze(resources.map((claim) => Object.freeze({ ...claim })));
  return Object.freeze({
    invocation: selectedInvocation,
    resources: selectedResources,
    backendId,
    recovered,
  });
}

/** @internal Project execution state without exposing mutable coordinator services. */
export function toolAuthorizationContext(
  context: ToolExecutionContext,
  owner: ToolAuthorizationOwner,
): ToolAuthorizationContext {
  const selectedOwner = Object.freeze({ ...owner });
  return Object.freeze({
    signal: context.signal,
    workspaceRoot: context.workspace.root,
    runId: context.runId,
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    owner: selectedOwner,
    ...optionalProperties(context.branch === undefined ? undefined : { branch: context.branch }),
    ...optionalProperties(context.step === undefined ? undefined : { step: context.step }),
  });
}

/** @internal Reject malformed host decisions instead of treating them as approval. */
export function validateToolAuthorizationDecision<Input>(value: Input): ToolAuthorizationDecision {
  if (!isJsonObject(value)) {
    throw new Error("Tool authorization returned an invalid decision");
  }
  const decision = value;
  if (decision["decision"] === "allow_once" && Object.keys(decision).length === 1) {
    return Object.freeze({ decision: "allow_once" });
  }
  if (
    decision["decision"] === "deny" &&
    Object.keys(decision).every((key) => key === "decision" || key === "reason") &&
    (decision["reason"] === undefined || Check(STRING_VALUE, decision["reason"]))
  ) {
    const reason = decision["reason"];
    if (Check(STRING_VALUE, reason)) {
      if (reason.includes("\0") || Buffer.byteLength(reason, "utf8") > 4 * 1024) {
        throw new Error("Tool authorization denial reason is invalid");
      }
      return Object.freeze({ decision: "deny", reason });
    }
    return Object.freeze({ decision: "deny" });
  }
  throw new Error("Tool authorization returned an invalid decision");
}
