import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { JsonValue } from "../../src/core/json.js";

import {
  PORTABLE_PRESENTATION_PROTOCOL_VERSION,
  createPortablePresentation,
  definePortablePresentationAction,
  portablePresentationRemoveEvent,
  portablePresentationShowEvent,
  projectPortablePresentationToLines,
  validatePortablePresentationActionRequest,
  type PortablePresentationActionDefinition,
  type PortablePresentationDefinition,
} from "../../src/interfaces/portable-presentation.js";
import { projectPortablePresentationToRuntimeUiBlock } from "../../src/tui/portable-presentation.js";

const INPUT = Type.Object({ value: Type.Integer() }, { additionalProperties: false });

function definition(
  run: PortablePresentationActionDefinition<typeof INPUT>["run"] = (input) => ({ accepted: input.value }),
): PortablePresentationDefinition {
  const action = {
    id: "approve",
    label: "Approve",
    inputSchema: INPUT,
    style: "primary" as const,
    run,
  } satisfies PortablePresentationActionDefinition<typeof INPUT>;
  return {
    id: "task_status",
    revision: 3,
    title: "Task status",
    blocks: [
      { type: "text", text: "ready\u001b", role: "accent" },
      { type: "markdown", markdown: "**portable**" },
      { type: "fields", fields: [{ label: "Owner", value: "Ohm" }] },
      { type: "list", ordered: true, items: ["first", "second"] },
      { type: "progress", label: "Build", value: 1, max: 4 },
    ],
    actions: [action],
  };
}

function request(input: JsonValue = { value: 7 }) {
  return {
    protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
    owner: "fixture.extension",
    presentationId: "task_status",
    revision: 3,
    actionId: "approve",
    input,
  } as const;
}

test("portable presentations preserve one versioned JSON contract across rich, line, and accessibility hosts", async () => {
  const controller = createPortablePresentation("fixture.extension", definition());
  assert.equal(JSON.parse(JSON.stringify(controller.document)).protocolVersion, 1);
  assert.deepEqual(projectPortablePresentationToLines(controller.document), [
    "Task status",
    "ready",
    "**portable**",
    "Owner: Ohm",
    "1. first",
    "2. second",
    "Build: 25%",
    "Actions:",
    "- Approve [approve]",
  ]);
  assert.equal(
    projectPortablePresentationToLines(controller.document, { accessible: true }).at(-2),
    "Available actions:",
  );
  const rich = projectPortablePresentationToRuntimeUiBlock(controller.document);
  assert.equal(rich.lines[0]?.spans[0]?.role, "title");
  assert.equal(rich.lines[1]?.spans[0]?.role, "accent");
  assert.deepEqual(await controller.invoke(request()), {
    protocolVersion: 1,
    owner: "fixture.extension",
    presentationId: "task_status",
    revision: 3,
    actionId: "approve",
    result: { accepted: 7 },
  });

  const show = portablePresentationShowEvent("fixture.extension", controller.document);
  const remove = portablePresentationRemoveEvent("fixture.extension", "task_status", 3);
  assert.deepEqual(JSON.parse(JSON.stringify([show, remove])), [show, remove]);
  assert.throws(() => {
    if (show.operation === "show") {
      (show.presentation.blocks[0] as { text: string }).text = "mutated";
    }
  }, /read only|Cannot assign/iu);
});

test("portable presentation actions reject unknown fields, incompatible versions, stale revisions, and invalid input", async () => {
  const controller = createPortablePresentation("fixture.extension", definition());
  assert.throws(
    () => validatePortablePresentationActionRequest({ ...request(), extra: true }),
    /extra is not allowed/u,
  );
  assert.throws(
    () => validatePortablePresentationActionRequest({ ...request(), protocolVersion: 2 }),
    /version is unsupported/u,
  );
  await assert.rejects(controller.invoke({ ...request(), revision: 2 }), /revision is stale/u);
  await assert.rejects(controller.invoke(request({ value: "seven" })), /does not match its schema/u);
  assert.throws(
    () => createPortablePresentation("fixture.extension", {
      ...definition(),
      actions: [{ ...definition().actions![0]!, unexpected: true } as never],
    }),
    /unexpected is not allowed/u,
  );
});

test("portable presentation actions enforce lifecycle and JSON result bounds", async () => {
  const lifecycle = new AbortController();
  const controller = createPortablePresentation("fixture.extension", definition(), {
    signal: lifecycle.signal,
  });
  lifecycle.abort(new Error("generation stopped"));
  await assert.rejects(controller.invoke(request()), /generation stopped/u);

  const circular: { self?: unknown } = {};
  circular.self = circular;
  const invalid = createPortablePresentation("fixture.extension", definition(() => circular as never));
  await assert.rejects(invalid.invoke(request()), /must not contain cycles/u);
});

test("portable presentation admission is detached from later extension schema mutation", async () => {
  const schema = Type.Object({ value: Type.Integer() }, { additionalProperties: false });
  const controller = createPortablePresentation("fixture.extension", {
    id: "task_status",
    revision: 3,
    blocks: [],
    actions: [definePortablePresentationAction({
      id: "approve",
      label: "Approve",
      inputSchema: schema,
      run: (input) => ({ accepted: input.value }),
    })],
  });
  (schema.properties.value as { type: string }).type = "string";
  assert.deepEqual((await controller.invoke(request())).result, { accepted: 7 });
  await assert.rejects(controller.invoke(request({ value: "seven" })), /does not match its schema/u);
  assert.throws(() => {
    (controller.document.actions[0]!.inputSchema as { type: string }).type = "array";
  }, /read only|Cannot assign/iu);
});
