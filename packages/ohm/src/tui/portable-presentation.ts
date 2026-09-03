import type {
  PortablePresentationDocument,
  PortablePresentationRole,
} from "../interfaces/portable-presentation.js";
import { projectPortablePresentationToLines } from "../interfaces/portable-presentation.js";
import type { RuntimeUiBlock } from "./components.js";
import type { ThemeRole } from "./theme.js";

const ROLE: Readonly<Partial<Record<PortablePresentationRole, ThemeRole>>> = Object.freeze({
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
});

/** Rich hosts consume the same safe document; raw terminal components are not serialized. */
export function projectPortablePresentationToRuntimeUiBlock(
  document: PortablePresentationDocument,
): RuntimeUiBlock {
  const lines = projectPortablePresentationToLines(document);
  const titleOffset = document.title === undefined ? 0 : 1;
  const textRoles = new Map<number, ThemeRole>();
  let row = titleOffset;
  for (const block of document.blocks) {
    if (block.type === "text") {
      const role = block.role === undefined ? undefined : ROLE[block.role];
      const count = block.text.split(/\r?\n/u).length;
      if (role !== undefined) {
        for (let index = 0; index < count; index += 1) textRoles.set(row + index, role);
      }
      row += count;
    } else if (block.type === "markdown") row += block.markdown.split(/\r?\n/u).length;
    else if (block.type === "fields") row += block.fields.length;
    else if (block.type === "list") row += block.items.length;
    else row += 1;
  }
  return Object.freeze({
    lines: Object.freeze(lines.map((text, index) => Object.freeze({
      spans: Object.freeze([Object.freeze({
        text,
        ...(index === 0 && document.title !== undefined
          ? { role: "title" as const }
          : textRoles.has(index)
            ? { role: textRoles.get(index)! }
            : {}),
      })]),
    }))),
  });
}
