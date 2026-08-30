import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { RpcExtensionUiBridge } from "../../src/interfaces/rpc-extension-ui.js";
import { createRpcExtensionErrorEvent } from "../../src/interfaces/rpc-error.js";
import type { RpcExtensionUiRequest } from "../../src/interfaces/rpc-protocol.js";
import { MAX_RPC_LINE_BYTES } from "../../src/interfaces/rpc.js";

function capture() {
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({ emit(request) { requests.push(request); } });
  return { bridge, requests };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("RPC extension dialogs use exact request and response records", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("fixture.extension", "extension", new AbortController().signal);
  assert.equal(Object.isFrozen(ui.capabilities), true);
  assert.deepEqual(ui.capabilities, {
    dialogs: true,
    notifications: true,
    status: true,
    workingState: false,
    textWidgets: true,
    title: true,
    editorTextRead: false,
    editorTextWrite: true,
    terminalInput: false,
    components: false,
    overlays: false,
    autocomplete: false,
    editorReplacement: false,
    themeSelection: false,
    toolExpansion: false,
    slots: false,
    routes: false,
  });
  assert.throws(() => ui.slots.set("session.header", "rpc", { lines: ["unsupported"] }), /full rich TUI/u);
  assert.throws(() => ui.routes.open("unsupported"), /full rich TUI/u);

  const selected = ui.select("Choose", ["one", "two"], { timeout: 1_000 });
  assert.deepEqual(requests[0], {
    type: "extension_ui_request",
    id: requests[0]!.id,
    extensionId: "fixture.extension",
    method: "select",
    title: "Choose",
    options: ["one", "two"],
    timeout: 1_000,
  });
  assert.equal(bridge.handle({ type: "extension_ui_response", id: requests[0]!.id, value: "two" }), true);
  assert.equal(await selected, "two");

  const confirmed = ui.confirm("Proceed", "Continue?");
  assert.equal(requests[1]?.method, "confirm");
  bridge.handle({ type: "extension_ui_response", id: requests[1]!.id, confirmed: true });
  assert.equal(await confirmed, true);

  const input = ui.input("Name", "optional");
  assert.equal(requests[2]?.method, "input");
  bridge.handle({ type: "extension_ui_response", id: requests[2]!.id, cancelled: true });
  assert.equal(await input, undefined);

  const editor = ui.editor("Draft", "prefill");
  assert.equal(requests[3]?.method, "editor");
  bridge.handle({ type: "extension_ui_response", id: requests[3]!.id, value: "edited" });
  assert.equal(await editor, "edited");
  assert.equal(bridge.handle({ type: "extension_ui_response", id: "missing", cancelled: true }), false);
  assert.equal(requests.every((request) => request.extensionId === "fixture.extension"), true);
  bridge.close();
});

test("RPC extension presentation emits only the supported structural UI records", () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("fixture.extension", "extension", new AbortController().signal);
  ui.notify("Ready", "warning");
  ui.setStatus("build", "Running");
  ui.setWidget("summary", ["one", "two"], { placement: "belowEditor" });
  ui.setTitle("Workspace");
  ui.setEditorText("draft");
  assert.equal(ui.getEditorText(), "draft");
  assert.deepEqual(requests.map((request) => request.method), [
    "notify", "setStatus", "setWidget", "setTitle", "set_editor_text",
  ]);
  assert.deepEqual(requests[2], {
    type: "extension_ui_request",
    id: requests[2]!.id,
    extensionId: "fixture.extension",
    method: "setWidget",
    widgetKey: "extension:summary",
    widgetLines: ["one", "two"],
    widgetPlacement: "belowEditor",
  });
  assert.equal(ui.setTheme("dark").success, false);
  assert.deepEqual(ui.getAllThemes(), []);
  assert.equal(requests.every((request) => request.extensionId === "fixture.extension"), true);
  bridge.close();
});

test("RPC paste remains cursor-relative without assuming a mirrored client draft", () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("fixture.extension", "extension", new AbortController().signal);
  ui.pasteToEditor(" tail");

  assert.equal(ui.getEditorText(), "");
  assert.deepEqual(requests[0], {
    type: "extension_ui_request",
    id: requests[0]!.id,
    extensionId: "fixture.extension",
    method: "paste_editor_text",
    text: " tail",
  });
  bridge.close();
});

test("RPC no-op callback facades retain no generation listeners and keyed owners stay bounded", () => {
  const { bridge, requests } = capture();
  const generation = new AbortController();
  for (let index = 0; index < 1_000; index += 1) {
    bridge.context("fixture.extension", "extension", generation.signal);
  }
  assert.equal(getEventListeners(generation.signal, "abort").length, 0);

  const first = bridge.context("fixture.extension", "extension", generation.signal);
  first.setStatus("phase", "first");
  assert.equal(getEventListeners(generation.signal, "abort").length, 1);
  first.setStatus("phase", "updated");
  assert.equal(getEventListeners(generation.signal, "abort").length, 1);
  const newer = bridge.context("fixture.extension", "extension", generation.signal);
  newer.setStatus("phase", "newer");
  newer.setWidget("summary", ["visible"]);
  assert.equal(getEventListeners(generation.signal, "abort").length, 2);

  generation.abort(new Error("generation ended"));
  assert.equal(getEventListeners(generation.signal, "abort").length, 0);
  assert.deepEqual(requests.slice(-2).map((request) => request.method === "setStatus"
    ? [request.statusKey, request.statusText]
    : request.method === "setWidget"
      ? [request.widgetKey, request.widgetLines]
      : undefined), [
    ["extension:phase", undefined],
    ["extension:summary", undefined],
  ]);
  bridge.close();
});

test("RPC keyed presentation isolates owners and clears only the ending owner", () => {
  const { bridge, requests } = capture();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = bridge.context("fixture.a", "owner-a", firstGeneration.signal);
  const second = bridge.context("fixture.b", "owner-b", secondGeneration.signal);

  first.setStatus("phase", "first");
  first.setWidget("summary", ["first"]);
  second.setStatus("phase", "second");
  second.setWidget("summary", ["second"]);
  assert.deepEqual(requests.slice(-4).map((request) =>
    request.method === "setStatus" ? request.statusKey : request.method === "setWidget" ? request.widgetKey : undefined), [
    "owner-a:phase",
    "owner-a:summary",
    "owner-b:phase",
    "owner-b:summary",
  ]);

  secondGeneration.abort(new Error("owner-b ended"));
  assert.deepEqual(requests.slice(-2).map((request) => {
    if (request.method === "setStatus") return [request.statusKey, request.statusText];
    if (request.method === "setWidget") return [request.widgetKey, request.widgetLines];
    return undefined;
  }), [
    ["owner-b:phase", undefined],
    ["owner-b:summary", undefined],
  ]);
  assert.equal(requests.some((request) =>
    request.method === "setStatus" && request.statusKey === "owner-a:phase" && request.statusText === undefined), false);
  assert.equal(requests.some((request) =>
    request.method === "setWidget" && request.widgetKey === "owner-a:summary" && request.widgetLines === undefined), false);

  firstGeneration.abort(new Error("owner-a ended"));
  bridge.close();
});

test("RPC cleanup cannot erase a newer context for the same owner", () => {
  const { bridge, requests } = capture();
  const olderGeneration = new AbortController();
  const newerGeneration = new AbortController();
  const older = bridge.context("fixture.extension", "owner", olderGeneration.signal);
  const newer = bridge.context("fixture.extension", "owner", newerGeneration.signal);

  older.setStatus("phase", "old");
  older.setWidget("summary", ["old"]);
  newer.setStatus("phase", "new");
  newer.setWidget("summary", ["new"]);
  assert.equal(getEventListeners(olderGeneration.signal, "abort").length, 0);
  assert.equal(getEventListeners(newerGeneration.signal, "abort").length, 2);
  const beforeOlderAbort = requests.length;
  olderGeneration.abort(new Error("older context ended"));
  assert.equal(requests.length, beforeOlderAbort);
  assert.throws(() => older.setStatus("phase", undefined), /older context ended/u);
  assert.equal(requests.length, beforeOlderAbort);

  newerGeneration.abort(new Error("newer context ended"));
  assert.deepEqual(requests.slice(-2).map((request) => request.method === "setStatus"
    ? [request.statusKey, request.statusText]
    : request.method === "setWidget"
      ? [request.widgetKey, request.widgetLines]
      : undefined), [
    ["owner:phase", undefined],
    ["owner:summary", undefined],
  ]);
  bridge.close();
});

test("RPC extension dialogs resolve to their cancellation defaults on abort and close", async () => {
  const { bridge } = capture();
  const controller = new AbortController();
  const ui = bridge.context("fixture.extension", "extension", controller.signal);
  const input = ui.input("Wait");
  controller.abort();
  assert.equal(await input, undefined);
  assert.equal(bridge.pendingCount, 0);

  const active = new AbortController();
  const confirm = bridge.context("fixture.extension", "extension", active.signal).confirm("Wait", "Still waiting?");
  bridge.close();
  assert.equal(await confirm, false);
  assert.equal(bridge.pendingCount, 0);
});

test("RPC extension dialogs cap unanswered requests and recover capacity after response and abort", async () => {
  let releaseFirst!: () => void;
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      if (requests.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
    },
  });
  const controllers = Array.from({ length: 65 }, () => new AbortController());
  const dialogs = controllers.slice(0, 64).map((controller, index) =>
    bridge.context("fixture.extension", `owner-${index}`, controller.signal).input(`Wait ${index}`));

  assert.equal(bridge.pendingCount, 64);
  assert.equal(requests.length, 1);
  const rejected = bridge.context("fixture.extension", "owner-rejected", controllers[64]!.signal).input("Rejected");
  assert.equal(await rejected, undefined);
  assert.equal(bridge.pendingCount, 64);
  assert.equal(requests.length, 1);

  bridge.handle({ type: "extension_ui_response", id: requests[0]!.id, value: "done" });
  assert.equal(await dialogs[0], "done");
  assert.equal(bridge.pendingCount, 63);
  assert.equal(getEventListeners(controllers[0]!.signal, "abort").length, 0);

  const replacementController = new AbortController();
  const replacement = bridge.context(
    "fixture.extension",
    "owner-replacement",
    replacementController.signal,
  ).confirm("Replacement", "Wait?");
  assert.equal(bridge.pendingCount, 64);
  assert.equal(requests.length, 1);

  for (const controller of controllers.slice(1, 64)) controller.abort();
  replacementController.abort();
  assert.deepEqual(await Promise.all(dialogs.slice(1)), Array.from({ length: 63 }, () => undefined));
  assert.equal(await replacement, false);
  assert.equal(bridge.pendingCount, 0);
  for (const controller of controllers) {
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  assert.equal(getEventListeners(replacementController.signal, "abort").length, 0);

  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  bridge.close();
});

test("RPC extension dialogs bound aggregate pending request bytes and recover after response", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("fixture.extension", "owner", new AbortController().signal);
  const largeTitle = "x".repeat(MAX_RPC_LINE_BYTES / 2);

  try {
    const first = ui.input(largeTitle);
    assert.equal(bridge.pendingCount, 1);
    assert.equal(requests.length, 1);

    const overflow = ui.input(largeTitle);
    assert.equal(bridge.pendingCount, 1);
    assert.equal(requests.length, 1);
    assert.equal(await overflow, undefined);

    assert.equal(bridge.handle({
      type: "extension_ui_response",
      id: requests[0]!.id,
      value: "first",
    }), true);
    assert.equal(await first, "first");

    const recovered = ui.input(largeTitle);
    assert.equal(bridge.pendingCount, 1);
    assert.equal(requests.length, 2);
    assert.equal(bridge.handle({
      type: "extension_ui_response",
      id: requests[1]!.id,
      value: "recovered",
    }), true);
    assert.equal(await recovered, "recovered");
  } finally {
    bridge.close();
  }
});

test("RPC retained status and widget ownership shares one bounded capacity", () => {
  const { bridge } = capture();
  const controllers = Array.from({ length: 513 }, () => new AbortController());
  const contexts = controllers.map((controller, index) =>
    bridge.context("fixture.extension", `owner-${index}`, controller.signal));

  for (let index = 0; index < 256; index += 1) contexts[index]!.setStatus("value", `${index}`);
  for (let index = 256; index < 512; index += 1) contexts[index]!.setWidget("value", [`${index}`]);
  assert.throws(
    () => contexts[512]!.setStatus("value", "overflow"),
    /RPC extension UI retains at most 512 status and widget owners/u,
  );
  assert.equal(getEventListeners(controllers[512]!.signal, "abort").length, 0);

  contexts[0]!.setStatus("value", "replacement");
  assert.equal(getEventListeners(controllers[0]!.signal, "abort").length, 1);
  contexts[0]!.setStatus("value", undefined);
  assert.equal(getEventListeners(controllers[0]!.signal, "abort").length, 0);
  contexts[512]!.setStatus("value", "recovered");
  assert.equal(getEventListeners(controllers[512]!.signal, "abort").length, 1);

  bridge.close();
  for (const controller of controllers) {
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("RPC retained status, widget, and editor state share one byte capacity", () => {
  const { bridge } = capture();
  const statusController = new AbortController();
  const widgetController = new AbortController();
  const editorController = new AbortController();
  const retainedChunk = "x".repeat(Math.floor(MAX_RPC_LINE_BYTES / 3));
  const status = bridge.context("fixture.extension", `${retainedChunk}-status`, statusController.signal);
  const widget = bridge.context("fixture.extension", `${retainedChunk}-widget`, widgetController.signal);
  const editor = bridge.context("fixture.extension", "editor", editorController.signal);

  try {
    status.setStatus("value", "active");
    widget.setWidget("value", ["active"]);
    assert.throws(
      () => editor.setEditorText(retainedChunk),
      /RPC extension UI retained state is limited to 16777216 bytes/u,
    );
    assert.equal(editor.getEditorText(), "");
    assert.equal(getEventListeners(editorController.signal, "abort").length, 0);

    status.setStatus("value", undefined);
    assert.equal(getEventListeners(statusController.signal, "abort").length, 0);
    editor.setEditorText(retainedChunk);
    assert.equal(editor.getEditorText(), retainedChunk);
  } finally {
    bridge.close();
  }
});

test("RPC detached presentation is serial, bounded, and coalesces queued state to its latest value", async () => {
  let releaseFirst!: () => void;
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      if (requests.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
    },
  });
  const ui = bridge.context("fixture.extension", "owner", new AbortController().signal);

  ui.notify("blocked");
  ui.setStatus("phase", "first");
  for (let index = 0; index < 511; index += 1) ui.notify(`queued-${index}`);
  ui.setStatus("phase", "latest");
  ui.notify("dropped");
  assert.throws(
    () => ui.pasteToEditor("not accepted"),
    /RPC extension UI presentation queue is limited to 512 records/u,
  );
  assert.equal(requests.length, 1);

  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 513);
  assert.equal(requests.filter((request) => request.method === "setStatus").length, 1);
  assert.equal(requests.some((request) => request.method === "setStatus" && request.statusText === "first"), false);
  assert.equal(requests.some((request) => request.method === "setStatus" && request.statusText === "latest"), true);
  assert.equal(requests.some((request) => request.method === "notify" && request.message === "dropped"), false);

  ui.notify("capacity recovered");
  const last = requests.at(-1);
  assert.equal(last?.method, "notify");
  assert.equal(last?.method === "notify" ? last.message : undefined, "capacity recovered");
  bridge.close();
});

test("RPC detached presentation bounds serialized bytes under writer backpressure", async () => {
  let releaseFirst!: () => void;
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      if (requests.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
    },
  });
  const ui = bridge.context("fixture.extension", "owner", new AbortController().signal);
  const firstTitle = "x".repeat(MAX_RPC_LINE_BYTES / 2);
  const latestTitle = "y".repeat(MAX_RPC_LINE_BYTES / 2);

  try {
    ui.notify("blocked");
    ui.setTitle(firstTitle);
    ui.setTitle(latestTitle);
    ui.notify(firstTitle);
    assert.throws(
      () => ui.pasteToEditor(firstTitle),
      /RPC extension UI presentation queue is limited to 16777216 bytes/u,
    );
    assert.equal(requests.length, 1);

    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.method, "setTitle");
    assert.equal(requests[1]?.method === "setTitle" ? requests[1].title : undefined, latestTitle);
    assert.equal(requests.some((request) => request.method === "notify" && request.message === firstTitle), false);

    ui.pasteToEditor("capacity recovered");
    assert.equal(requests.at(-1)?.method, "paste_editor_text");
  } finally {
    bridge.close();
  }
});

test("RPC owner cleanup has reserved byte capacity behind a large blocked presentation", async () => {
  const releases: Array<() => void> = [];
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    },
  });
  const ownerKey = "x".repeat(MAX_RPC_LINE_BYTES / 2);
  const firstController = new AbortController();
  const first = bridge.context("fixture.extension", ownerKey, firstController.signal);

  try {
    first.setStatus("phase", "active");
    assert.equal(requests.length, 1);
    firstController.abort();
    assert.equal(getEventListeners(firstController.signal, "abort").length, 0);
    assert.equal(requests.length, 1);

    releases.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.method, "setStatus");
    assert.equal(requests[1]?.method === "setStatus" ? requests[1].statusText : "missing", undefined);

    const replacementController = new AbortController();
    const replacement = bridge.context("fixture.extension", ownerKey, replacementController.signal);
    assert.throws(
      () => replacement.setStatus("phase", "replacement"),
      /RPC extension UI retained state is limited to 16777216 bytes/u,
    );
    assert.equal(getEventListeners(replacementController.signal, "abort").length, 0);

    releases.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    replacement.setStatus("phase", "recovered");
    assert.equal(requests.length, 3);
    replacementController.abort();
    releases.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releases.shift()!();
  } finally {
    for (const release of releases) release();
    bridge.close();
  }
});

test("RPC queued dialog and widget requests detach caller-owned arrays before byte admission", async () => {
  let releaseFirst!: () => void;
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      if (requests.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
    },
  });
  const ui = bridge.context("fixture.extension", "owner", new AbortController().signal);
  const options = ["safe-option"];
  const lines = ["safe-line"];

  try {
    ui.notify("blocked");
    const selected = ui.select("Choose", options);
    ui.setWidget("summary", lines);
    options[0] = "x".repeat(MAX_RPC_LINE_BYTES);
    lines[0] = "x".repeat(MAX_RPC_LINE_BYTES);

    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const selectRequest = requests.find((request) => request.method === "select");
    const widgetRequest = requests.find((request) => request.method === "setWidget");
    assert.deepEqual(selectRequest?.method === "select" ? selectRequest.options : undefined, ["safe-option"]);
    assert.deepEqual(widgetRequest?.method === "setWidget" ? widgetRequest.widgetLines : undefined, ["safe-line"]);
    assert.equal(selectRequest?.method, "select");
    bridge.handle({
      type: "extension_ui_response",
      id: selectRequest.id,
      value: "safe-option",
    });
    assert.equal(await selected, "safe-option");
  } finally {
    bridge.close();
  }
});

test("RPC close drops queued presentation and dialogs and removes every owner listener", async () => {
  let releaseFirst!: () => void;
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      if (requests.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
    },
  });
  const controller = new AbortController();
  const ui = bridge.context("fixture.extension", "owner", controller.signal);

  ui.notify("blocked");
  ui.setStatus("phase", "queued");
  const dialog = ui.input("Also queued");
  assert.equal(getEventListeners(controller.signal, "abort").length, 2);
  assert.equal(bridge.pendingCount, 1);
  assert.equal(requests.length, 1);

  bridge.close();
  assert.equal(await dialog, undefined);
  assert.equal(bridge.pendingCount, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
});

test("RPC owner abort coalesces blocked presentation into cleanup records", async () => {
  let releaseFirst!: () => void;
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    emit(request) {
      requests.push(request);
      if (requests.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
    },
  });
  const controller = new AbortController();
  const ui = bridge.context("fixture.extension", "owner", controller.signal);

  ui.notify("blocked");
  ui.setStatus("phase", "queued");
  ui.setWidget("summary", ["queued"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 2);
  controller.abort();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.slice(1).map((request) => {
    if (request.method === "setStatus") return [request.statusKey, request.statusText];
    if (request.method === "setWidget") return [request.widgetKey, request.widgetLines];
    return undefined;
  }), [
    ["owner:phase", undefined],
    ["owner:summary", undefined],
  ]);
  bridge.close();
});

test("RPC extension dialogs cancel when the async output writer rejects", async () => {
  const bridge = new RpcExtensionUiBridge({
    async emit() { throw new Error("writer failed"); },
  });
  const ui = bridge.context("fixture.extension", "extension", new AbortController().signal);

  assert.equal(await within(ui.input("Wait")), undefined);
  assert.equal(bridge.pendingCount, 0);
  bridge.close();
});

test("RPC extension dialog timeouts accept exact bounds and reject invalid values", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("fixture.extension", "extension", new AbortController().signal);

  for (const timeout of [1, 3_600_000]) {
    const pending = ui.input("Bounded", undefined, { timeout });
    const request = requests.at(-1)!;
    assert.equal(request.method, "input");
    assert.equal("timeout" in request ? request.timeout : undefined, timeout);
    bridge.handle({ type: "extension_ui_response", id: request.id, value: "done" });
    assert.equal(await pending, "done");
  }

  const emitted = requests.length;
  for (const timeout of [0, 3_600_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      ui.input("Invalid", undefined, { timeout }),
      /Extension UI timeout must be from 1 through 3600000 milliseconds/u,
    );
  }
  assert.equal(requests.length, emitted);
  assert.equal(bridge.pendingCount, 0);
  bridge.close();
});

test("RPC extension identity is present and UTF-8 bounded on every emitted request", () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("é".repeat(600), "owner", new AbortController().signal);

  ui.notify("Ready");
  const extensionId = requests[0]?.extensionId;
  assert.notEqual(extensionId, undefined);
  if (extensionId === undefined) assert.fail("Extension request omitted its owner ID");
  assert.equal(Buffer.byteLength(extensionId, "utf8"), 1_024);
  assert.equal(extensionId.endsWith("é"), true);

  const fallback = bridge.context("\0", "fallback", new AbortController().signal);
  fallback.notify("Fallback");
  assert.equal(requests[1]?.extensionId, "runtime");
  bridge.close();
});

test("RPC extension errors are owner-identified and every untrusted field is UTF-8 bounded", () => {
  const event = createRpcExtensionErrorEvent({
    extensionId: "é".repeat(600),
    extensionPath: "é".repeat(3_000),
    event: "é".repeat(600),
    error: "é".repeat(3_000),
  });

  assert.equal(Buffer.byteLength(event.extensionId, "utf8"), 1_024);
  assert.equal(event.extensionId.endsWith("é"), true);
  assert.equal(Buffer.byteLength(event.extensionPath, "utf8"), 4_096);
  assert.equal(Buffer.byteLength(event.event, "utf8"), 1_024);
  assert.equal(Buffer.byteLength(event.error, "utf8"), 4_096);
  assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < 16 * 1_024);
  assert.equal(createRpcExtensionErrorEvent({
    extensionPath: "<runtime>",
    event: "runtime",
    error: "failure",
  }).extensionId, "runtime");
});
