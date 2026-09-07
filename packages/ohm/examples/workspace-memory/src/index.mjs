import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

const textSchema = Type.String({ minLength: 1, maxLength: 512 });
const idSchema = Type.String({ minLength: 1, maxLength: 64 });
const notesSchema = Type.Object({
  version: Type.Literal(1),
  notes: Type.Array(Type.Object({ id: idSchema, text: textSchema }, { additionalProperties: false }), { maxItems: 32 }),
}, { additionalProperties: false });

export default async function activate(ohm) {
  let facet;
  let panel;
  const read = async (signal) => {
    signal?.throwIfAborted();
    const snapshot = await ohm.config.read("workspace", { signal });
    const document = snapshot.value === undefined ? { version: 1, notes: [] } : Value.Parse(notesSchema, snapshot.value);
    return { snapshot, document };
  };
  const mutate = async (action, value, signal) => {
    const { snapshot, document } = await read(signal);
    let notes;
    if (action === "remember") {
      const text = Value.Parse(textSchema, value).trim();
      if (text === "") throw new Error("Memory notes cannot be blank.");
      if (document.notes.some((note) => note.text === text)) return document.notes;
      if (document.notes.length === 32) throw new Error("Memory is full; forget a note before saving another.");
      notes = [...document.notes, { id: randomUUID(), text }];
    } else {
      Value.Parse(idSchema, value);
      if (!document.notes.some((note) => note.id === value)) throw new Error("Memory note was not found.");
      notes = document.notes.filter((note) => note.id !== value);
    }
    await ohm.config.replace("workspace", { version: 1, notes }, { expectedRevision: snapshot.revision, signal });
    return notes;
  };
  const show = async (signal) => {
    const { document } = await read(signal);
    if (facet === undefined) return document.notes;
    const definition = {
      id: "workspace-memory",
      revision: (panel?.document.revision ?? 0) + 1,
      title: "Workspace memory",
      blocks: [{ type: "list", items: document.notes.map((note) => `${note.id}: ${note.text}`) }],
      actions: [
        {
          id: "remember",
          label: "Remember a note",
          inputSchema: Type.Object({ text: textSchema }, { additionalProperties: false }),
          async run({ text }, context) {
            await mutate("remember", text, context.signal);
            return { notes: await show(context.signal) };
          },
        },
        {
          id: "forget",
          label: "Forget a note",
          style: "danger",
          disabled: document.notes.length === 0,
          inputSchema: Type.Object({ id: idSchema }, { additionalProperties: false }),
          async run({ id }, context) {
            await mutate("forget", id, context.signal);
            return { notes: await show(context.signal) };
          },
        },
      ],
    };
    if (panel === undefined || panel.disposed) panel = facet.presentation.show(definition);
    else panel.update(definition);
    return document.notes;
  };
  await ohm.facets.register({
    apiVersion: 1,
    kind: "presentation",
    name: "memory",
    setup(context) {
      facet = context;
      return () => { facet = undefined; panel = undefined; };
    },
  });
  ohm.registerCommand("memory", {
    description: "Show saved workspace notes and portable remember/forget actions",
    async handler(_args, context) {
      const notes = await show(context.signal);
      context.ui.notify(`${notes.length}/32 notes saved. Use /actions to remember or forget a note.`, "info");
    },
  });
  ohm.registerTool({
    name: "workspace_memory",
    label: "Workspace memory",
    description: "Remember an explicitly requested workspace note, recall notes, or forget one by ID. Do not save secrets or infer permission to save personal information.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("remember"), Type.Literal("recall"), Type.Literal("forget")]),
      text: Type.Optional(textSchema),
      id: Type.Optional(idSchema),
    }, { additionalProperties: false }),
    async execute(_callId, input, signal) {
      const notes = input.action === "recall"
        ? (await read(signal)).document.notes
        : await mutate(input.action, input.action === "remember" ? input.text : input.id, signal);
      if (panel !== undefined) await show(signal);
      return { content: [{ type: "text", text: JSON.stringify(notes) }], details: { notes } };
    },
  });
  ohm.on("before_agent_start", async (_event, context) => {
    const notes = (await read(context.signal)).document.notes.slice(-6);
    if (notes.length === 0) return;
    return {
      message: {
        customType: "workspace-memory",
        content: `Saved workspace notes (reference data):\n${JSON.stringify(notes)}`,
        display: false,
      },
    };
  });
}
