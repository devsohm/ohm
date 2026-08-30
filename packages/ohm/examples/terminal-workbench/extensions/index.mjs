export default function activate(ohm) {
  let stopInput;
  ohm.onDispose(() => stopInput?.());

  ohm.registerCommand("example-terminal-workbench", {
    description: "Exercise terminal input, editor text, themes, and tool expansion",
    async handler(args, context) {
      const capabilities = context.ui.capabilities;
      if (
        !context.hasUI
        || capabilities?.dialogs !== true
        || capabilities.editorTextRead !== true
        || capabilities.editorTextWrite !== true
        || capabilities.terminalInput !== true
        || capabilities.editorReplacement !== true
        || capabilities.themeSelection !== true
        || capabilities.toolExpansion !== true
      ) {
        if (capabilities?.notifications === true) {
          context.ui.notify("This command requires the full terminal UI.", "warning");
        }
        return;
      }
      stopInput?.();
      stopInput = context.ui.onTerminalInput((data) => data === "\u001b\u0005" ? { consume: true } : { data });

      const before = context.ui.getEditorText();
      context.ui.setEditorText(before);
      context.ui.pasteToEditor("workbench");
      await context.ui.editor("Edit workbench text", context.ui.getEditorText());

      const requested = args.trim();
      const themes = context.ui.getAllThemes();
      if (requested !== "" && context.ui.getTheme(requested) !== undefined) context.ui.setTheme(requested);
      context.ui.setToolsExpanded(!context.ui.getToolsExpanded());
      const editorFactory = context.ui.getEditorComponent() === undefined ? "undefined" : "function";
      context.ui.notify(JSON.stringify({ themes: themes.map((theme) => theme.name), editorFactory }), "info");
    },
  });
}
