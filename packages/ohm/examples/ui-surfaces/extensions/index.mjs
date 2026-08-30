import { Text, uiPanel, uiStack, uiText } from "ohm/tui";

class DismissibleOverlay extends Text {
  constructor(done) { super("Example overlay · press Enter or Escape", 1, 1); this.done = done; }
  handleInput(data) { if (data === "\r" || data === "\x1b") this.done(); }
}

const snippets = [
  { value: "TODO: ", label: ":todo", description: "Insert a task marker" },
  { value: "NOTE: ", label: ":note", description: "Insert a note marker" },
  { value: "REVIEW: ", label: ":review", description: "Insert a review marker" },
];

function isFunctionValue(value) {
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

const isRecordValue = (value) => (
  value !== null
  && Object(value) === value
  && !Array.isArray(value)
  && !isFunctionValue(value)
);
const isStringValue = (value) => (
  Object(value) !== value && Object.prototype.toString.call(value) === "[object String]"
);

function snippetPrefix(lines, cursorLine, cursorCol) {
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
  return before.match(/(?:^|\s)(:[a-z]*)$/u)?.[1];
}

export default function activate(ohm) {
  ohm.on("session_start", (_event, context) => {
    if (!context.hasUI || context.ui.capabilities?.autocomplete !== true) return;
    context.ui.addAutocompleteProvider((current) => {
      const applyWithHostRules = (...args) => current.applyCompletion(...args);
      const keepHostFileTrigger = (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true;
      return {
        triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":"])],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          if (options.signal.aborted) return null;
          const prefix = snippetPrefix(lines, cursorLine, cursorCol);
          if (prefix === undefined) return await current.getSuggestions(lines, cursorLine, cursorCol, options);
          const query = prefix.slice(1);
          const items = snippets.filter((item) => item.label.slice(1).startsWith(query));
          return items.length === 0
            ? await current.getSuggestions(lines, cursorLine, cursorCol, options)
            : { items, prefix };
        },
        applyCompletion: applyWithHostRules,
        shouldTriggerFileCompletion: keepHostFileTrigger,
      };
    });
  });

  ohm.registerCommand("example-ui-panel", {
    description: "Mount a status and ordered session slots",
    async handler(_args, context) {
      const capabilities = context.ui.capabilities;
      if (capabilities?.status === true) context.ui.setStatus("example-ui", "example active");
      if (capabilities?.slots === true) {
        context.ui.slots.set("session.header", "example-header", {
          lines: ["Example extension header"],
          order: 10,
        });
        context.ui.slots.set("session.beforeEditor", "example-summary", {
          lines: ["Example session summary"],
          placement: "prepend",
        });
      }
    },
  });
  ohm.registerCommand("example-ui-overlay", {
    description: "Open a dismissible custom overlay",
    async handler(_args, context) {
      const capabilities = context.ui.capabilities;
      if (!context.hasUI || capabilities?.components !== true || capabilities.overlays !== true) {
        if (capabilities?.notifications === true) {
          context.ui.notify("This command requires terminal component overlays.", "warning");
        }
        return;
      }
      await context.ui.custom((_tui, _theme, _keybindings, done) => new DismissibleOverlay(done), {
        overlay: true,
        overlayOptions: { width: 48, anchor: "center" },
      });
    },
  });
  ohm.registerCommand("example-ui-route", {
    description: "Open a bounded named extension route",
    async handler(_args, context) {
      const capabilities = context.ui.capabilities;
      if (capabilities?.routes !== true) {
        if (capabilities?.notifications === true) {
          context.ui.notify("This command requires the rich terminal viewport.", "warning");
        }
        return;
      }
      const registration = context.ui.routes.register("example-details", {
        title: "Example details",
        render(host) {
          const note = isRecordValue(host.data)
            && isStringValue(host.data.note)
            ? host.data.note
            : "No route data supplied.";
          return uiPanel(uiStack([
            uiText(`Route: ${host.name}`, { role: "accent" }),
            uiText("The composer and status dock remain owned by ohm."),
            uiText(note, { role: "muted" }),
          ], { gap: 1 }), { title: "UI surfaces", maxLines: 12 });
        },
      });
      registration.open({ data: { note: "Press Escape to return to the transcript." } });
    },
  });
}
