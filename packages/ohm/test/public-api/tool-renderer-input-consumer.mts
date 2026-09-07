import { Type } from "typebox";
import { Check } from "typebox/value";

import { defineTool } from "../../src/plugins/direct.js";

export const partialRenderer = defineTool({
  name: "partial_renderer_types",
  description: "Check the public streamed-argument contract",
  parameters: Type.Object({ items: Type.Array(Type.Object({ label: Type.String() })) }),
  async execute() { return { content: [], details: {} }; },
  renderCall(input) {
    const first = input.items?.[0];
    if (first !== undefined) {
      // @ts-expect-error streamed nested fields require a readiness guard
      const completeLabel: string = first.label;
      void completeLabel;
    }
    const label = first !== undefined && Check(Type.String(), first.label) ? first.label.toUpperCase() : "waiting";
    return { render: () => [label], invalidate() {} };
  },
});
