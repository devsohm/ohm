/** A small role gutter shared by plain text and Markdown transcript rows. */
export function turnPrefix(kind: "user" | "assistant", columns: number, unicode = true): string {
  if (columns >= 16) return kind === "user" ? "YOU   " : "ohm   ";
  if (columns >= 4) return kind === "user" ? `${unicode ? "›" : ">"} ` : `${unicode ? "·" : "o"} `;
  return "";
}
