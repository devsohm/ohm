import { Text } from "ohm/tui";

export default function activate(ohm) {
  const stop = ohm.events.on("example-message", (payload) => {
    ohm.sendMessage({ customType: "example-note", content: String(payload), display: true });
  });
  ohm.onDispose(stop);
  ohm.registerMarkdownTransformer((markdown) =>
    markdown.replaceAll("[[example-note]]", "**Example note:**"));
  ohm.registerMessageRenderer("example-note", (message) => new Text(String(message.content), 0, 0));
  ohm.registerCommand("example-message", {
    description: "Emit a generation-local event that becomes a custom message",
    async handler(args) { ohm.events.emit("example-message", args.trim() || "Example message"); },
  });
}
