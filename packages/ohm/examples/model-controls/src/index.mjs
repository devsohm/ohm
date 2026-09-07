const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export default function activate(ohm) {
  ohm.registerCommand("example-model", {
    description: "Show the current model and optionally select a thinking level",
    async handler(args, context) {
      const requested = args.trim();
      if (requested !== "") {
        if (!levels.has(requested)) { context.ui.notify("Unknown thinking level.", "warning"); return; }
        ohm.setThinkingLevel(requested);
      }
      const model = context.model;
      context.ui.notify(
        `${model === undefined ? "No model" : `${model.provider}/${model.id}`} · ${context.scopedModels.length} scoped · ${ohm.getThinkingLevel()}`,
        "info",
      );
    },
  });
}
