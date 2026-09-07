export default function activate(ohm) {
  ohm.registerFlag("example-compact-output", {
    description: "Use the compact command response",
    type: "boolean",
    default: false,
  });
  ohm.registerCommand("example-controls", {
    description: "Show the current example flag",
    async handler(_args, context) {
      context.ui.notify(`Compact output: ${String(ohm.getFlag("example-compact-output"))}`, "info");
    },
  });
  ohm.registerShortcut("ctrl+alt+e", {
    description: "Open the example controls notice",
    handler(context) { context.ui.notify("Example shortcut received.", "info"); },
  });
}
