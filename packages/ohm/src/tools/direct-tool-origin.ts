import type { TSchema } from "typebox";

import type { ToolDefinition } from "../plugins/capabilities/tools.js";
import type { HarnessTool } from "./types.js";

type DirectToolDelegate = Pick<ToolDefinition, "execute" | "prepareArguments">;
const origins = new WeakMap<HarnessTool, { definition: ToolDefinition; delegate: DirectToolDelegate }>();
// The callback is used only as an identity key; its return value is never consumed here.
type DirectToolCallback = (...args: never[]) => void;
const implementations = new WeakMap<DirectToolCallback, HarnessTool>();

/** Preserve coordinated delegate identity, including plugin generation guards. */
export function getDirectToolImplementation(callback: DirectToolCallback): HarnessTool | undefined {
  return implementations.get(callback);
}

export function setDirectToolImplementation(callback: DirectToolCallback, tool: HarnessTool): void {
  implementations.set(callback, tool);
}

/** Internal authoring metadata; callers must retain coordinated execution wrappers. */
export function getDirectToolOrigin(tool: HarnessTool): ToolDefinition | undefined {
  return origins.get(tool)?.definition;
}

export function getDirectToolDelegate(tool: HarnessTool): DirectToolDelegate | undefined {
  return origins.get(tool)?.delegate;
}

export function setDirectToolOrigin<TParameters extends TSchema, TDetails, TState>(
  tool: HarnessTool,
  definition: ToolDefinition<TParameters, TDetails, TState>,
): void {
  // SAFETY: this identity-keyed catalog retains the exact definition; its concrete schema/details/state types are erased only for inspection.
  const erased = definition as ToolDefinition;
  const delegate: DirectToolDelegate = { execute: erased.execute };
  if (erased.prepareArguments !== undefined) delegate.prepareArguments = erased.prepareArguments;
  origins.set(tool, { definition: erased, delegate: Object.freeze(delegate) });
}
