import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionRegistrationHandle } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

interface CallbackService {
  calls: number;
  invoke(value: string): string;
}

type NumberService = (value: number) => number;

async function workspace(context: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

test("trusted services publish exact callback-bearing references only after activation commits", async (context) => {
  const root = await workspace(context, "ohm-extension-services-");
  let reader: ExtensionAPI | undefined;
  let service: CallbackService | undefined;
  let functionService: NumberService | undefined;
  let consumed: CallbackService | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      {
        name: "service-reader",
        factory(ohm) {
          reader = ohm;
        },
      },
      {
        name: "service-owner",
        factory(ohm) {
          const value: CallbackService = {
            calls: 0,
            invoke(input) {
              this.calls += 1;
              return input.toUpperCase();
            },
          };
          const callback = (input: number): number => input + 1;
          service = value;
          functionService = callback;
          ohm.services.register("example.callback-service", value);
          ohm.services.register("example.callback-function", callback);
          assert.strictEqual(ohm.services.get<CallbackService>("example.callback-service"), value);
          assert.strictEqual(ohm.services.get("example.callback-function"), callback);
          assert.equal(reader?.services.get("example.callback-service"), undefined);
        },
      },
      {
        name: "service-consumer",
        factory(ohm) {
          consumed = ohm.services.get<CallbackService>("example.callback-service");
          assert.strictEqual(consumed, service);
          assert.equal(consumed?.invoke("ready"), "READY");
          const callback = ohm.services.get<NumberService>("example.callback-function");
          assert.strictEqual(callback, functionService);
          assert.equal(callback?.(1), 2);
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.strictEqual(consumed, service);
  assert.equal(service?.calls, 1);
});

test("failed service owners publish nothing", async (context) => {
  const root = await workspace(context, "ohm-extension-service-rollback-");
  let reader: ExtensionAPI | undefined;
  let observed: object | undefined;
  let rolledBackHandle: ExtensionRegistrationHandle | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    inlineExtensions: [
      {
        name: "rollback-reader",
        factory(ohm) {
          reader = ohm;
        },
      },
      {
        name: "failed-service-owner",
        async factory(ohm) {
          rolledBackHandle = ohm.services.register("example.rolled-back", { ready: true });
          assert.equal(reader?.services.get("example.rolled-back"), undefined);
          await Promise.resolve();
          throw new Error("service owner failed");
        },
      },
      {
        name: "rollback-observer",
        factory(ohm) {
          observed = ohm.services.get("example.rolled-back");
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.equal(observed, undefined);
  assert.equal(rolledBackHandle?.disposed, true);
  assert.equal(host.diagnostics().some((entry) => /service owner failed/u.test(entry.message)), true);
});

test("service names have one owner and exact handles control live registration", async (context) => {
  const root = await workspace(context, "ohm-extension-service-ownership-");
  const original: CallbackService = {
    calls: 0,
    invoke(value) { return value; },
  };
  let ownerHandle: ExtensionRegistrationHandle | undefined;
  let owner: ExtensionAPI | undefined;
  let consumer: ExtensionAPI | undefined;
  let retainedOriginal: CallbackService | undefined;
  let conflictingServiceVisible = false;
  const host = await loadDirectExtensions([], {
    workspace: root,
    inlineExtensions: [
      {
        name: "first-service-owner",
        factory(ohm) {
          owner = ohm;
          ownerHandle = ohm.services.register("example.owned", original);
        },
      },
      {
        name: "conflicting-service-owner",
        factory(ohm) {
          ohm.services.register("example.conflict-side-effect", { ready: false });
          ohm.services.register("example.owned", { replacement: false });
        },
      },
      {
        name: "service-live-consumer",
        factory(ohm) {
          consumer = ohm;
          retainedOriginal = ohm.services.get<CallbackService>("example.owned");
          assert.strictEqual(retainedOriginal, original);
          conflictingServiceVisible = ohm.services.get("example.conflict-side-effect") !== undefined;
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.equal(conflictingServiceVisible, false);
  assert.equal(host.diagnostics().some((entry) => /example\.owned.*already registered/u.test(entry.message)), true);
  assert.equal(ownerHandle?.disposed, false);
  await ownerHandle?.dispose();
  assert.equal(ownerHandle?.disposed, true);
  assert.equal(owner?.services.get("example.owned"), undefined);
  assert.equal(consumer?.services.get("example.owned"), undefined);
  assert.equal(retainedOriginal?.invoke("retained"), "retained");

  const replacement = { value: 1 };
  const replacementHandle = consumer?.services.register("example.owned", replacement);
  assert.strictEqual(owner?.services.get("example.owned"), replacement);
  assert.strictEqual(consumer?.services.get("example.owned"), replacement);
  await ownerHandle?.dispose();
  assert.strictEqual(consumer?.services.get("example.owned"), replacement);

  await host.close();
  assert.equal(replacementHandle?.disposed, true);
  assert.throws(() => consumer?.services.get("example.owned"), /no longer active/u);
  replacement.value = 2;
  assert.equal(replacement.value, 2, "teardown cannot revoke references retained by consumers");
});

test("service values and registry size are bounded while safe events remain JSON-only", async (context) => {
  const root = await workspace(context, "ohm-extension-service-bounds-");
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "bounded-services",
      factory(ohm) {
        assert.throws(
          () => ohm.services.register("1invalid", {}),
          /service name is invalid/iu,
        );
        assert.throws(
          () => ohm.services.register(`a${"x".repeat(128)}`, {}),
          /service name is invalid/iu,
        );
        // SAFETY: this negative test bypasses the static object constraint to exercise runtime admission.
        assert.throws(
          () => ohm.services.register("example.primitive", 1 as never),
          /service value must be an object or function/iu,
        );
        for (let index = 0; index < 256; index += 1) {
          ohm.services.register(`example.bounded-${index}`, {});
        }
        assert.throws(
          () => ohm.services.register("example.one-too-many", {}),
          /services exceed 256/iu,
        );
        assert.throws(
          () => ohm.events.emit("example.safe-event", { callback() {} }),
          /function|JSON-safe|JSON values|serializ/iu,
        );
      },
    }],
  });
  context.after(async () => await host.close());
});
