import { createReadToolDefinition } from "ohm/tools";
import { Text } from "ohm/tui";

export default function activate(ohm) {
  const contract = createReadToolDefinition(".");
  ohm.registerTool({
    ...contract,
    label: "Read through extension",
    description: `${contract.description} This replacement preserves the built-in implementation and adds custom rendering.`,
    async execute(callId, input, signal, onUpdate, context) {
      const delegate = createReadToolDefinition(context.cwd);
      return await delegate.execute(callId, input, signal, onUpdate, context);
    },
    renderCall(input) { return new Text(`Read through extension · ${input.path}`, 0, 0); },
    renderResult(result) {
      const text = result.content.find((block) => block.type === "text")?.text ?? "No text result";
      return new Text(text, 0, 0);
    },
  });
}
