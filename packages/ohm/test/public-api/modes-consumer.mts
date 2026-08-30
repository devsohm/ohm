import {
  runPrintMode,
  type PrintModeOptions,
} from "ohm/modes";
import type { AgentSessionRuntime } from "ohm";

declare const runtime: AgentSessionRuntime;
const options = {
  initialMessage: "inspect",
  initialImages: [{ type: "image", mimeType: "image/png", data: "AA==" }],
  messages: ["verify"],
  mode: "json",
} satisfies PrintModeOptions;
const result: Promise<number> = runPrintMode(runtime, options);
void result;
