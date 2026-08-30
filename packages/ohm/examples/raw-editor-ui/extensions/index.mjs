import { Editor } from "ohm/tui";

class LabeledEditor extends Editor {
  render(width) {
    return ["example editor", ...super.render(width)];
  }
}

export default function activate(ohm) {
  ohm.registerCommand("example-editor-enable", {
    description: "Replace the primary editor for this extension generation",
    async handler(_args, context) {
      if (context.ui.capabilities?.editorReplacement !== true) {
        if (context.ui.capabilities?.notifications === true) {
          context.ui.notify("This command requires terminal editor replacement.", "warning");
        }
        return;
      }
      context.ui.setEditorComponent((tui, theme) => new LabeledEditor(tui, theme, { paddingX: 1 }));
      if (context.ui.capabilities.notifications) context.ui.notify("Example editor enabled.", "info");
    },
  });
  ohm.registerCommand("example-editor-disable", {
    description: "Restore the host editor",
    async handler(_args, context) {
      if (context.ui.capabilities?.editorReplacement !== true) return;
      context.ui.setEditorComponent(undefined);
      if (context.ui.capabilities.notifications) context.ui.notify("Host editor restored.", "info");
    },
  });
}
