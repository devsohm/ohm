import { Type } from "typebox";

import type { PluginAPI } from "ohm/plugins";

const textLengthParameters = Type.Object({
  text: Type.String({ maxLength: 4096 }),
}, { additionalProperties: false });

export default function activate(ohm: PluginAPI): void {
  ohm.registerCommand("example-hello", {
    description: "Show a greeting from the starter plugin",
    async handler(args, context) {
      const name = args.trim() || "developer";
      context.ui.notify(`Hello, ${name}.`, "info");
    },
  });

  ohm.registerTool({
    name: "example_text_length",
    label: "Text length",
    description: "Count Unicode code points in a short text value.",
    parameters: textLengthParameters,
    async execute(_callId, input) {
      const count = [...input.text].length;
      return {
        content: [{ type: "text", text: JSON.stringify({ codePoints: count }) }],
        details: { codePoints: count },
      };
    },
  });
}
