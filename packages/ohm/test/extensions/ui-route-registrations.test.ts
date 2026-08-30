import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { JsonValue } from "../../src/core/json.js";
import type { RuntimeUiComponentFactory, RuntimeUiComponentHandle } from "../../src/tui/components.js";
import type { ExtensionUIRouteHost } from "../../src/extensions/capabilities/ui-routes.js";
import {
  MAX_EXTENSION_UI_ROUTES_PER_GENERATION,
  RuntimeUIRouteOwnerToken,
  RuntimeUIRouteRegistrations,
  UNAVAILABLE_EXTENSION_UI_ROUTES,
  type RuntimeUIRouteOperationSink,
} from "../../src/extensions/runtime-internal/ui-route-registrations.js";

interface MountedRoute {
  readonly name: string;
  readonly title: string;
  readonly factory: RuntimeUiComponentFactory<void>;
  readonly data: JsonValue | undefined;
  readonly token: RuntimeUIRouteOwnerToken;
  readonly onClosed: () => void;
}

class TestRouteSink implements RuntimeUIRouteOperationSink {
  current: MountedRoute | undefined;
  failClose = false;
  beforeOpen: (() => void) | undefined;

  open(
    name: string,
    title: string,
    factory: RuntimeUiComponentFactory<void>,
    data: JsonValue | undefined,
    token: RuntimeUIRouteOwnerToken,
    onClosed: () => void,
  ): RuntimeUiComponentHandle {
    const beforeOpen = this.beforeOpen;
    this.beforeOpen = undefined;
    beforeOpen?.();
    this.current?.onClosed();
    this.current = { name, title, factory, data, token, onClosed };
    let hidden = false;
    let focused = true;
    return Object.freeze({
      close: () => { this.close(token); },
      hide: () => { hidden = true; },
      setHidden: (value: boolean) => { hidden = value; },
      isHidden: () => hidden,
      focus: () => { focused = true; },
      unfocus: () => { focused = false; },
      isFocused: () => focused,
    });
  }

  close(token: RuntimeUIRouteOwnerToken): void {
    const current = this.current;
    if (current?.token !== token) return;
    if (this.failClose) throw new Error("close failed");
    this.current = undefined;
    current.onClosed();
  }
}

const component = Object.freeze({ render: () => ({ lines: [] }) });
const NESTED_ROUTE_DATA_VALUE = Type.Object({ nested: Type.Object({ count: Type.Number() }) });

test("UI routes replace registrations atomically and stale handles are exact", () => {
  const sink = new TestRouteSink();
  const generation = new AbortController();
  const routes = new RuntimeUIRouteRegistrations(generation.signal, sink).service(true);
  const first = routes.register("review", { title: "Review", render: () => component });

  assert.throws(
    () => routes.register("review", { title: "\u001b[31mbroken", render: () => component }),
    /terminal-safe/u,
  );
  assert.equal(first.disposed, false);
  assert.deepEqual(routes.list(), [{ name: "review", title: "Review" }]);

  first.open();
  sink.failClose = true;
  assert.throws(
    () => routes.register("review", { title: "New review", render: () => component }),
    /close failed/u,
  );
  assert.equal(first.disposed, false);
  assert.equal(routes.current()?.title, "Review");
  sink.failClose = false;
  const second = routes.register("review", { title: "New review", render: () => component });
  assert.equal(first.disposed, true);
  assert.equal(routes.current(), undefined);
  first.dispose();
  assert.deepEqual(routes.list(), [{ name: "review", title: "New review" }]);
  assert.throws(() => first.open(), /no longer active/u);

  second.dispose();
  assert.equal(second.disposed, true);
  assert.deepEqual(routes.list(), []);
});

test("UI route open detaches and freezes data and close notifications are exact", async () => {
  const sink = new TestRouteSink();
  const generation = new AbortController();
  const routes = new RuntimeUIRouteRegistrations(generation.signal, sink).service(true);
  let observedHost: ExtensionUIRouteHost | undefined;
  const registration = routes.register("inspector", {
    title: "Inspector",
    render(host) {
      observedHost = host;
      return component;
    },
  });
  const input = { nested: { count: 1 } };
  const firstHandle = registration.open({ data: input });
  input.nested.count = 2;

  const mounted = sink.current;
  assert.ok(mounted);
  await mounted.factory({
    signal: generation.signal,
    requestRender() {},
    close() { sink.close(mounted.token); },
  });
  const selectedHost = observedHost;
  assert.ok(selectedHost !== undefined);
  assert.equal(selectedHost.name, "inspector");
  assert.deepEqual(selectedHost.data, { nested: { count: 1 } });
  assert.equal(Object.isFrozen(selectedHost.data), true);
  if (!Value.Check(NESTED_ROUTE_DATA_VALUE, selectedHost.data)) {
    throw new Error("Route fixture data is invalid");
  }
  assert.equal(Object.isFrozen(selectedHost.data.nested), true);
  assert.deepEqual(routes.current(), {
    name: "inspector",
    title: "Inspector",
    data: { nested: { count: 1 } },
  });

  const secondHandle = routes.open("inspector", { data: { selected: true } });
  firstHandle.close();
  assert.deepEqual(routes.current(), {
    name: "inspector",
    title: "Inspector",
    data: { selected: true },
  });
  secondHandle.close();
  assert.equal(routes.current(), undefined);
});

test("UI route opening rejects reentrant navigation and cleans a registration disposed by its factory", () => {
  const sink = new TestRouteSink();
  const generation = new AbortController();
  const routes = new RuntimeUIRouteRegistrations(generation.signal, sink).service(true);
  const first = routes.register("first", { title: "First", render: () => component });
  const second = routes.register("second", { title: "Second", render: () => component });

  sink.beforeOpen = () => { second.open(); };
  assert.throws(() => first.open(), /navigation is already in progress/u);
  assert.equal(sink.current, undefined);
  assert.equal(routes.current(), undefined);

  const self = routes.register("self", { title: "Self", render: () => component });
  sink.beforeOpen = () => { self.dispose(); };
  assert.throws(() => self.open(), /registration is no longer active/u);
  assert.equal(self.disposed, true);
  assert.equal(sink.current, undefined);
  assert.equal(routes.current(), undefined);
});

test("UI routes enforce names, titles, registration count, and data bounds", () => {
  const sink = new TestRouteSink();
  const generation = new AbortController();
  const routes = new RuntimeUIRouteRegistrations(generation.signal, sink).service(true);

  assert.throws(() => routes.register("Not-Lower", { title: "No", render: () => component }), /route names/u);
  assert.throws(() => routes.register("unsafe", { title: "two\nlines", render: () => component }), /terminal-safe/u);
  assert.throws(() => routes.register("blank", { title: "   ", render: () => component }), /terminal-safe/u);
  for (let index = 0; index < MAX_EXTENSION_UI_ROUTES_PER_GENERATION; index += 1) {
    routes.register(`route-${index}`, { title: `Route ${index}`, render: () => component });
  }
  assert.throws(
    () => routes.register("overflow", { title: "Overflow", render: () => component }),
    /32 registrations/u,
  );
  assert.throws(
    () => routes.open("route-0", { data: "x".repeat(64 * 1024) }),
    /exceeds 65536 UTF-8 bytes/u,
  );
  assert.equal(sink.current, undefined);
});

test("unavailable and aborted UI route services fail closed and abort cleans mounts", () => {
  const sink = new TestRouteSink();
  const generation = new AbortController();
  const registrations = new RuntimeUIRouteRegistrations(generation.signal, sink);
  const routes = registrations.service(true);
  const registration = routes.register("status", { title: "Status", render: () => component });
  registration.open();

  const unavailable = registrations.service(false);
  assert.throws(
    () => unavailable.register("other", { title: "Other", render: () => component }),
    /full rich TUI/u,
  );
  assert.deepEqual(unavailable.list(), []);
  assert.equal(UNAVAILABLE_EXTENSION_UI_ROUTES.current(), undefined);
  generation.abort(new Error("refresh"));
  assert.equal(registration.disposed, true);
  assert.equal(sink.current, undefined);
  assert.throws(() => routes.list(), /refresh/u);
});
