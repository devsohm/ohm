export default function activate(ohm) {
  ohm.registerCommand("example-runtime-catalog", {
    description: "Inspect tools, commands, prompts, and skills available to this generation",
    async handler(_args, context) {
      const discovery = await ohm.getDiscoveryView(context.signal);
      context.ui.notify(JSON.stringify({
        activeTools: ohm.getActiveTools(),
        allTools: ohm.getAllTools().map((tool) => tool.name),
        commands: ohm.getCommands().map((command) => command.name),
        resources: discovery.resources.map((resource) => `${resource.kind}:${resource.name}`),
        truncated: discovery.truncated,
      }), "info");
    },
  });

  ohm.registerCommand("example-runtime-select", {
    description: "Select one tool and the current model, then queue a follow-up user message",
    async handler(_args, context) {
      const tool = ohm.getAllTools()[0];
      if (tool !== undefined) ohm.setActiveTools([tool.name]);
      if (context.model !== undefined) await ohm.setModel(context.model);
      ohm.sendUserMessage("Review the updated runtime selection.", { deliverAs: "followUp" });
    },
  });
}
