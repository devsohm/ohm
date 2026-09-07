export default function activate(ohm) {
  ohm.on("resources_discover", () => ({
    skillPaths: ["skills"],
    promptPaths: ["prompts"],
    themePaths: [],
  }));
  ohm.registerCommand("example-dynamic-ready", {
    description: "Confirm that the dynamic package runtime is active",
    async handler(_args, context) {
      context.ui.notify("Dynamic example resources are active.", "info");
    },
  });
}
