import type { ImageContent } from "@ohm/kernel";
import type { Api, Model } from "@ohm/models";

import type { ThinkingLevel } from "../../../../core/settings-manager.js";
import type { BashOperations } from "../../../../tools/builtins/shell.js";
import type { InputSource, ModelSelectSource } from "../../host.js";

export interface ModelSelectEvent {
  type: "model_select";
  model: Model<Api>;
  previousModel?: Model<Api>;
  source: ModelSelectSource;
}

export interface ThinkingLevelSelectEvent {
  type: "thinking_level_select";
  level: ThinkingLevel;
  previousLevel: ThinkingLevel;
}

interface InputEventContent {
  text: string;
  images?: ImageContent[];
}

interface InputEventDelivery {
  source: InputSource;
  streamingBehavior?: "steer" | "followUp";
}

export interface InputEvent extends InputEventContent, InputEventDelivery {
  type: "input";
}

export type InputEventResult =
  | { action: "continue" }
  | { action: "handled" }
  | { action: "transform"; text: string; images?: ImageContent[] };

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

interface UIPromptEvent<Type extends "ui_prompt_start" | "ui_prompt_end"> {
  type: Type;
  reason: "ui_prompt";
  kind: UIPromptKind;
  title?: string;
}

export interface UIPromptStartEvent extends UIPromptEvent<"ui_prompt_start"> {}

export interface UIPromptEndEvent extends UIPromptEvent<"ui_prompt_end"> {}

export interface UserBashEvent {
  type: "user_bash";
  command: string;
  excludeFromContext: boolean;
  cwd: string;
}

export interface UserBashEventResult {
  /** Effective command selected by a native before-user-shell adapter. */
  command?: string;
  /** Effective working directory selected by a native before-user-shell adapter. */
  cwd?: string;
  operations?: BashOperations;
  result?: {
    output: string;
    exitCode?: number;
    isError?: boolean;
    cancelled: boolean;
    timedOut?: boolean;
    signal?: string;
    truncated: boolean;
    fullOutputPath?: string;
  };
}

export interface InteractionEventMap {
  model_select: ModelSelectEvent;
  thinking_level_select: ThinkingLevelSelectEvent;
  input: InputEvent;
  ui_prompt_start: UIPromptStartEvent;
  ui_prompt_end: UIPromptEndEvent;
  user_bash: UserBashEvent;
}

export interface InteractionEventResultMap {
  model_select: void;
  thinking_level_select: void;
  input: InputEventResult | void;
  ui_prompt_start: void;
  ui_prompt_end: void;
  user_bash: UserBashEventResult | void;
}
