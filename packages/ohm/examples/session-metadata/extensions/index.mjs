import { Text } from "ohm/tui";

export default function activate(ohm) {
  ohm.registerEntryRenderer("example-session-note", (entry) => (
    new Text(`Session note · ${String(entry.data?.note ?? "")}`, 0, 0)
  ));
  ohm.registerCommand("example-session-metadata", {
    description: "Name the session, append a note, and optionally label an entry",
    async handler(args, context) {
      const [name, entryId] = args.trim().split(/\s+/u);
      if (name === undefined || name === "") {
        context.ui.notify("Usage: /example-session-metadata NAME [ENTRY_ID]", "warning");
        return;
      }
      ohm.setSessionName(name);
      ohm.appendEntry("example-session-note", { note: `Named ${name}` });
      if (entryId !== undefined) ohm.setLabel(entryId, `Session ${name}`);
      context.ui.notify(`Session name: ${ohm.getSessionName() ?? name}`, "info");
    },
  });
}
