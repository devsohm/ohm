import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdownMessageLines } from "../../src/tui/markdown.js";
import { cellWidth } from "../../src/tui/unicode.js";

function visible(source: string, width = 80): string[] {
  return renderMarkdownMessageLines("", source, width, "assistant").map((line) => line.text);
}

test("a complete mermaid fence renders as bounded terminal art", () => {
  const lines = renderMarkdownMessageLines(
    "",
    "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```",
    80,
    "assistant",
  );

  assert.deepEqual(lines.map((line) => line.text), [
    "┌───────┐    ┌──────┐",
    "│ Start ├───▶│ Done │",
    "└───────┘    └──────┘",
  ]);
  assert.ok(lines[0]?.spans.some((span) => span.role === "border"));
  assert.ok(lines[1]?.spans.some((span) => span.role === "accent"));
  assert.doesNotMatch(lines.map((line) => line.text).join("\n"), /```|flowchart/u);
});

test("the terminal renderer handles the supported mermaid diagram families", async (t) => {
  const diagrams = new Map([
    ["state", "stateDiagram-v2\n  [*] --> Ready\n  Ready --> Done"],
    ["sequence", "sequenceDiagram\n  Alice->>Bob: Hello"],
    ["class", "classDiagram\n  Animal <|-- Dog\n  class Animal"],
    ["entity relationship", "erDiagram\n  CUSTOMER ||--o{ ORDER : places"],
  ]);
  for (const [name, diagram] of diagrams) {
    await t.test(name, () => {
      const lines = visible(`\`\`\`mermaid\n${diagram}\n\`\`\``, 120);
      assert.ok(lines.length > 0);
      assert.doesNotMatch(lines.join("\n"), /```|Diagram/u);
      assert.ok(lines.every((line) => cellWidth(line) <= 120));
    });
  }
});

test("invalid, unsupported, unfinished, and over-width mermaid fences stay as source", () => {
  const invalid = visible("```mermaid\nflowchart LR\n  A[Start] -->\n```");
  assert.deepEqual(invalid, ["```mermaid", "flowchart LR", "  A[Start] -->", "```"]);

  const unsupported = visible("```mermaid\npie\n  title Pets\n  \"Dogs\" : 4\n```");
  assert.deepEqual(unsupported, ["```mermaid", "pie", "  title Pets", "  \"Dogs\" : 4", "```"]);

  const unfinished = visible("```mermaid\nflowchart LR\n  A --> B");
  assert.deepEqual(unfinished, ["```mermaid", "flowchart LR", "  A --> B"]);

  const wide = visible(
    "```mermaid\nflowchart LR\n  A --> B --> C --> D --> E --> F --> G --> H\n```",
    30,
  );
  assert.equal(wide[0], "```mermaid");
  assert.ok(wide.includes("flowchart LR"));
  assert.ok(wide.every((line) => cellWidth(line) <= 30));
});

test("mermaid rendering preserves quote containers and does not claim other code fences", () => {
  const quoted = visible("> ```mermaid\n> flowchart LR\n>   A --> B\n> ```");
  assert.ok(quoted.length > 0);
  assert.ok(quoted.every((line) => line.startsWith("> ")));
  assert.match(quoted.join("\n"), /▶/u);

  const ordinary = visible("```mermaid-js\nflowchart LR\n  A --> B\n```");
  assert.deepEqual(ordinary, ["```mermaid-js", "flowchart LR", "  A --> B", "```"]);
});

test("mermaid work is refused before rendering when the source exceeds its statement budget", () => {
  const body = Array.from({ length: 260 }, (_, index) => `  N${index} --> N${index + 1}`).join(";");
  const lines = visible(`\`\`\`mermaid\nflowchart LR\n${body}\n\`\`\``, 120);

  assert.equal(lines[0], "```mermaid");
  assert.ok(lines.includes("flowchart LR"));
  assert.ok(lines.every((line) => cellWidth(line) <= 120));
});
