import { optionalProperties } from "../core/optional-properties.js";
import { randomUUID } from "node:crypto";
import { isNativeError } from "node:util/types";

import {
  RPC_EXTENSION_UI_CAPABILITIES,
  type RuntimeDirectUiContext,
  type RuntimeDirectUiDialogOptions,
} from "../extensions/runtime.js";
import { UNAVAILABLE_EXTENSION_UI_SLOTS } from "../extensions/runtime-internal/ui-slot-registrations.js";
import { UNAVAILABLE_EXTENSION_UI_ROUTES } from "../extensions/runtime-internal/ui-route-registrations.js";
import { createTheme } from "../tui/theme.js";
import { boundedRpcErrorMessage, boundedRpcExtensionId } from "./rpc-error.js";
import type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-protocol.js";
import { MAX_RPC_LINE_BYTES } from "./rpc.js";

export type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-protocol.js";
export type RpcExtensionUIRequest = RpcExtensionUiRequest;
export type RpcExtensionUIResponse = RpcExtensionUiResponse;

type RpcExtensionUiRequestBody = RpcExtensionUiRequest extends infer T
  ? T extends RpcExtensionUiRequest ? Omit<T, "type" | "id" | "extensionId"> : never
  : never;

type RpcExtensionUiRequestWithoutOwner = RpcExtensionUiRequest extends infer T
  ? T extends RpcExtensionUiRequest ? Omit<T, "extensionId"> : never
  : never;

export interface RpcExtensionUiBridgeOptions {
  emit(request: RpcExtensionUiRequest): void | Promise<void>;
}

interface PendingRequest {
  complete(response: RpcExtensionUiResponse): void;
  cancel(): void;
}

interface RpcPresentationOwner {
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly bytes: number;
}

interface RpcQueuedUiRequest {
  readonly request: RpcExtensionUiRequest;
  readonly bytes: number;
  readonly lane: "cleanup" | "presentation" | "required";
  readonly coalescingKey: string | undefined;
  readonly completion: {
    resolve(): void;
    reject(error: Error): void;
  } | undefined;
}

interface RpcPreparedUiRequest {
  readonly request: RpcExtensionUiRequest;
  readonly bytes: number;
}

const MAX_PENDING_RPC_EXTENSION_UI_DIALOGS = 64;
const MAX_PENDING_RPC_EXTENSION_UI_BYTES = MAX_RPC_LINE_BYTES;
const MAX_RETAINED_RPC_EXTENSION_UI_OWNERS = 512;
const MAX_RETAINED_RPC_EXTENSION_UI_BYTES = MAX_RPC_LINE_BYTES;
const MAX_QUEUED_RPC_EXTENSION_UI_PRESENTATIONS = 512;
const MAX_QUEUED_RPC_EXTENSION_UI_BYTES = MAX_RPC_LINE_BYTES;
const MAX_QUEUED_RPC_EXTENSION_UI_RECORDS = MAX_QUEUED_RPC_EXTENSION_UI_PRESENTATIONS
  + MAX_PENDING_RPC_EXTENSION_UI_DIALOGS
  + MAX_RETAINED_RPC_EXTENSION_UI_OWNERS;

function errorFromThrown<ErrorType>(error: ErrorType): Error {
  return isNativeError(error) ? error : new Error(boundedRpcErrorMessage(error));
}

function serializedRequestBytes(request: RpcExtensionUiRequest): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

function snapshotRequest(request: RpcExtensionUiRequest): RpcExtensionUiRequest {
  switch (request.method) {
    case "select": return { ...request, options: [...request.options] };
    case "setWidget": return {
      ...request,
      widgetLines: request.widgetLines === undefined ? undefined : [...request.widgetLines],
    };
    default: return request;
  }
}

function prepareRequest(request: RpcExtensionUiRequest): RpcPreparedUiRequest {
  const snapshot = snapshotRequest(request);
  return { request: snapshot, bytes: serializedRequestBytes(snapshot) };
}

function ownedRequest(
  request: RpcExtensionUiRequestWithoutOwner,
  extensionId: string,
): RpcExtensionUiRequest {
  switch (request.method) {
    case "select": return { ...request, extensionId };
    case "confirm": return { ...request, extensionId };
    case "input": return { ...request, extensionId };
    case "editor": return { ...request, extensionId };
    case "notify": return { ...request, extensionId };
    case "setStatus": return { ...request, extensionId };
    case "setWidget": return { ...request, extensionId };
    case "setTitle": return { ...request, extensionId };
    case "paste_editor_text": return { ...request, extensionId };
    case "set_editor_text": return { ...request, extensionId };
  }
}

function requestEnvelope(
  id: string,
  request: RpcExtensionUiRequestBody,
): RpcExtensionUiRequestWithoutOwner {
  switch (request.method) {
    case "select": return { type: "extension_ui_request", id, ...request };
    case "confirm": return { type: "extension_ui_request", id, ...request };
    case "input": return { type: "extension_ui_request", id, ...request };
    case "editor": return { type: "extension_ui_request", id, ...request };
    case "notify": return { type: "extension_ui_request", id, ...request };
    case "setStatus": return { type: "extension_ui_request", id, ...request };
    case "setWidget": return { type: "extension_ui_request", id, ...request };
    case "setTitle": return { type: "extension_ui_request", id, ...request };
    case "paste_editor_text": return { type: "extension_ui_request", id, ...request };
    case "set_editor_text": return { type: "extension_ui_request", id, ...request };
  }
}

function validatedTimeout(options: RuntimeDirectUiDialogOptions | undefined): number | undefined {
  const timeout = options?.timeout;
  if (timeout === undefined) return undefined;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000) {
    throw new RangeError("Extension UI timeout must be from 1 through 3600000 milliseconds");
  }
  return timeout;
}

/** Bridges trusted extension dialogs to the RPC host's request/response records. */
export class RpcExtensionUiBridge {
  readonly #emit: RpcExtensionUiBridgeOptions["emit"];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #statusOwners = new Map<string, RpcPresentationOwner>();
  readonly #widgetOwners = new Map<string, RpcPresentationOwner>();
  readonly #queue: RpcQueuedUiRequest[] = [];
  #editorText = "";
  #editorTextBytes = 0;
  #emitting = false;
  readonly #outputBytes = { cleanup: 0, presentation: 0, required: 0 };
  #pendingBytes = 0;
  #retainedOwnerBytes = 0;
  #closed = false;

  constructor(options: RpcExtensionUiBridgeOptions) {
    this.#emit = options.emit;
  }

  get pendingCount(): number { return this.#pending.size; }

  #coalescedIndex(key: string): number {
    return this.#queue.findIndex((queued) => queued.coalescingKey === key);
  }

  #presentationQueueIndex(
    bytes: number,
    key: string | undefined,
    overflow: "drop" | "throw" | "cleanup",
  ): number | undefined {
    if (this.#closed) return undefined;
    const previous = key === undefined ? -1 : this.#coalescedIndex(key);
    if (previous < 0) {
      const maximumRecords = overflow === "cleanup"
        ? MAX_QUEUED_RPC_EXTENSION_UI_RECORDS
        : MAX_QUEUED_RPC_EXTENSION_UI_PRESENTATIONS;
      if (this.#queue.length >= maximumRecords) {
        if (overflow !== "throw") return undefined;
        throw new RangeError(
          `RPC extension UI presentation queue is limited to ${maximumRecords} records`,
        );
      }
    }
    const replacedBytes = previous < 0 ? 0 : this.#queue[previous]!.bytes;
    const lane = overflow === "cleanup" ? "cleanup" : "presentation";
    const replacedLaneBytes = previous >= 0 && this.#queue[previous]!.lane === lane
      ? replacedBytes
      : 0;
    if (bytes > MAX_QUEUED_RPC_EXTENSION_UI_BYTES - (this.#outputBytes[lane] - replacedLaneBytes)) {
      if (overflow !== "throw") return undefined;
      throw new RangeError(
        `RPC extension UI presentation queue is limited to ${MAX_QUEUED_RPC_EXTENSION_UI_BYTES} bytes`,
      );
    }
    return previous;
  }

  #canQueuePresentation(
    request: RpcExtensionUiRequest,
    key: string | undefined,
    overflow: "drop" | "throw",
  ): RpcPreparedUiRequest | false {
    const prepared = prepareRequest(request);
    return this.#presentationQueueIndex(prepared.bytes, key, overflow) === undefined ? false : prepared;
  }

  #queuePresentation(
    request: RpcExtensionUiRequest,
    key: string | undefined,
    overflow: "drop" | "throw" | "cleanup",
    preparedRequest?: RpcPreparedUiRequest,
  ): boolean {
    let prepared: RpcPreparedUiRequest;
    try {
      prepared = preparedRequest ?? prepareRequest(request);
    } catch (error) {
      if (overflow !== "throw") return false;
      throw error;
    }
    const { bytes } = prepared;
    const previous = this.#presentationQueueIndex(bytes, key, overflow);
    if (previous === undefined) return false;
    if (previous >= 0) {
      const replaced = this.#queue.splice(previous, 1)[0]!;
      this.#outputBytes[replaced.lane] -= replaced.bytes;
    }
    const lane = overflow === "cleanup" ? "cleanup" : "presentation";
    this.#queue.push({ request: prepared.request, bytes, lane, coalescingKey: key, completion: undefined });
    this.#outputBytes[lane] += bytes;
    this.#drain();
    return true;
  }

  #queueRequired(prepared: RpcPreparedUiRequest): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("RPC extension UI bridge is closed"));
    return new Promise<void>((resolve, reject) => {
      const { bytes, request } = prepared;
      if (this.#queue.length >= MAX_QUEUED_RPC_EXTENSION_UI_RECORDS) {
        reject(new RangeError(`RPC extension UI output queue is limited to ${MAX_QUEUED_RPC_EXTENSION_UI_RECORDS} records`));
        return;
      }
      if (bytes > MAX_QUEUED_RPC_EXTENSION_UI_BYTES - this.#outputBytes.required) {
        reject(new RangeError(`RPC extension UI output queue is limited to ${MAX_QUEUED_RPC_EXTENSION_UI_BYTES} bytes`));
        return;
      }
      this.#queue.push({
        request,
        bytes,
        lane: "required",
        coalescingKey: undefined,
        completion: { resolve, reject },
      });
      this.#outputBytes.required += bytes;
      this.#drain();
    });
  }

  #cancelQueuedRequired(id: string): void {
    const index = this.#queue.findIndex((queued) =>
      queued.completion !== undefined && queued.request.id === id);
    if (index < 0) return;
    const queued = this.#queue.splice(index, 1)[0]!;
    this.#outputBytes[queued.lane] -= queued.bytes;
    queued.completion?.resolve();
  }

  #drain(): void {
    if (this.#closed || this.#emitting) return;
    while (!this.#closed) {
      const queued = this.#queue.shift();
      if (queued === undefined) return;
      let result: void | Promise<void>;
      this.#emitting = true;
      try {
        result = this.#emit(queued.request);
      } catch (error) {
        this.#emitting = false;
        this.#outputBytes[queued.lane] -= queued.bytes;
        queued.completion?.reject(errorFromThrown(error));
        continue;
      }
      if (result === undefined) {
        this.#emitting = false;
        this.#outputBytes[queued.lane] -= queued.bytes;
        queued.completion?.resolve();
        continue;
      }
      void Promise.resolve(result).then(
        () => queued.completion?.resolve(),
        (error) => queued.completion?.reject(errorFromThrown(error)),
      ).finally(() => {
        this.#emitting = false;
        this.#outputBytes[queued.lane] -= queued.bytes;
        this.#drain();
      });
      return;
    }
  }

  context(extensionId: string, ownerKey: string, signal: AbortSignal): RuntimeDirectUiContext {
    const boundedExtensionId = boundedRpcExtensionId(extensionId);
    const emitDetached = (
      request: RpcExtensionUiRequestWithoutOwner,
      key?: string,
      overflow: "drop" | "throw" | "cleanup" = "throw",
      preparedRequest?: RpcPreparedUiRequest,
    ): boolean => {
      const selectedRequest = preparedRequest?.request ?? ownedRequest(request, boundedExtensionId);
      return this.#queuePresentation(
        selectedRequest,
        key,
        overflow,
        preparedRequest,
      );
    };
    const canQueuePresentation = (
      request: RpcExtensionUiRequestWithoutOwner,
      key: string | undefined,
    ): RpcPreparedUiRequest | false => {
      return this.#canQueuePresentation(ownedRequest(request, boundedExtensionId), key, "throw");
    };
    const keyed = (key: string): string => `${ownerKey}:${key}`;
    const statusOwners = this.#statusOwners;
    const widgetOwners = this.#widgetOwners;
    const releaseOwner = (owners: Map<string, RpcPresentationOwner>, key: string): void => {
      const previous = owners.get(key);
      if (previous === undefined) return;
      previous.signal.removeEventListener("abort", previous.onAbort);
      owners.delete(key);
      this.#retainedOwnerBytes -= previous.bytes;
    };
    const own = (
      owners: Map<string, RpcPresentationOwner>,
      key: string,
      clear: () => void,
      bytes: number,
    ): void => {
      signal.throwIfAborted();
      const previous = owners.get(key);
      if (
        previous === undefined
        && statusOwners.size + widgetOwners.size >= MAX_RETAINED_RPC_EXTENSION_UI_OWNERS
      ) {
        throw new RangeError(
          `RPC extension UI retains at most ${MAX_RETAINED_RPC_EXTENSION_UI_OWNERS} status and widget owners`,
        );
      }
      const replacedBytes = previous?.bytes ?? 0;
      if (
        bytes > MAX_RETAINED_RPC_EXTENSION_UI_BYTES
          - (
            this.#retainedOwnerBytes
            + this.#editorTextBytes
            + this.#outputBytes.cleanup
            - replacedBytes
          )
      ) {
        throw new RangeError(
          `RPC extension UI retained state is limited to ${MAX_RETAINED_RPC_EXTENSION_UI_BYTES} bytes`,
        );
      }
      releaseOwner(owners, key);
      let owner!: RpcPresentationOwner;
      const onAbort = (): void => {
        if (owners.get(key) !== owner) return;
        owners.delete(key);
        this.#retainedOwnerBytes -= owner.bytes;
        clear();
      };
      owner = { signal, onAbort, bytes };
      owners.set(key, owner);
      this.#retainedOwnerBytes += bytes;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    };
    const dialog = <T>(
      options: RuntimeDirectUiDialogOptions | undefined,
      fallback: T,
      request: RpcExtensionUiRequestBody,
      parse: (response: RpcExtensionUiResponse) => T,
    ): Promise<T> => {
      const timeout = validatedTimeout(options);
      if (this.#closed || signal.aborted || options?.signal?.aborted) return Promise.resolve(fallback);
      if (this.#pending.size >= MAX_PENDING_RPC_EXTENSION_UI_DIALOGS) return Promise.resolve(fallback);
      const id = randomUUID();
      let prepared: RpcPreparedUiRequest;
      try {
        prepared = prepareRequest(ownedRequest(requestEnvelope(id, request), boundedExtensionId));
      } catch {
        return Promise.resolve(fallback);
      }
      const requestBytes = prepared.bytes;
      if (requestBytes > MAX_PENDING_RPC_EXTENSION_UI_BYTES - this.#pendingBytes) {
        return Promise.resolve(fallback);
      }
      return new Promise<T>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const combined = options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          combined.removeEventListener("abort", cancel);
          if (this.#pending.delete(id)) this.#pendingBytes -= requestBytes;
          this.#cancelQueuedRequired(id);
        };
        const cancel = (): void => {
          cleanup();
          resolve(fallback);
        };
        combined.addEventListener("abort", cancel, { once: true });
        if (timeout !== undefined) timer = setTimeout(cancel, timeout);
        this.#pendingBytes += requestBytes;
        this.#pending.set(id, {
          complete(response) {
            cleanup();
            resolve(parse(response));
          },
          cancel,
        });
        void this.#queueRequired(prepared).catch(cancel);
      });
    };
    const mono = createTheme("mono", { color: false, unicode: true });
    const context: RuntimeDirectUiContext = {
      capabilities: RPC_EXTENSION_UI_CAPABILITIES,
      slots: UNAVAILABLE_EXTENSION_UI_SLOTS,
      routes: UNAVAILABLE_EXTENSION_UI_ROUTES,
      async select(title, options, opts) {
        return await dialog(opts, undefined, {
          method: "select",
          title,
          options,
          ...optionalProperties(opts?.timeout === undefined ? undefined : { timeout: opts.timeout }),
        }, (response) => "value" in response ? response.value : undefined);
      },
      async confirm(title, message, opts) {
        return await dialog(opts, false, {
          method: "confirm",
          title,
          message,
          ...optionalProperties(opts?.timeout === undefined ? undefined : { timeout: opts.timeout }),
        }, (response) => "confirmed" in response ? response.confirmed : false);
      },
      async input(title, placeholder, opts) {
        return await dialog(opts, undefined, {
          method: "input",
          title,
          ...optionalProperties(placeholder === undefined ? undefined : { placeholder }),
          ...optionalProperties(opts?.timeout === undefined ? undefined : { timeout: opts.timeout }),
        }, (response) => "value" in response ? response.value : undefined);
      },
      notify(message, type) {
        signal.throwIfAborted();
        emitDetached(
          { type: "extension_ui_request", id: randomUUID(), method: "notify", message, ...optionalProperties(type === undefined ? undefined : { notifyType: type }) },
          undefined,
          "drop",
        );
      },
      onTerminalInput() { return () => undefined; },
      setStatus(key, text) {
        signal.throwIfAborted();
        const statusKey = keyed(key);
        const queueKey = JSON.stringify(["status", statusKey]);
        const request: RpcExtensionUiRequestWithoutOwner = {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey,
          statusText: text,
        };
        const prepared = canQueuePresentation(request, queueKey);
        if (prepared === false) return;
        if (text === undefined) {
          releaseOwner(statusOwners, statusKey);
        } else {
          own(statusOwners, statusKey, () => emitDetached({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setStatus",
            statusKey,
            statusText: undefined,
          }, queueKey, "cleanup"), prepared.bytes);
        }
        emitDetached(request, queueKey, "throw", prepared);
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setBackground() {},
      setWidget(key, content, options) {
        signal.throwIfAborted();
        if (content !== undefined && !Array.isArray(content)) return;
        const widgetKey = keyed(key);
        const queueKey = JSON.stringify(["widget", widgetKey]);
        const request: RpcExtensionUiRequestWithoutOwner = {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey,
          widgetLines: content,
          ...optionalProperties(options?.placement === undefined ? undefined : { widgetPlacement: options.placement }),
        };
        const prepared = canQueuePresentation(request, queueKey);
        if (prepared === false) return;
        if (content === undefined) {
          releaseOwner(widgetOwners, widgetKey);
        } else {
          own(widgetOwners, widgetKey, () => emitDetached({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey,
            widgetLines: undefined,
          }, queueKey, "cleanup"), prepared.bytes);
        }
        emitDetached(request, queueKey, "throw", prepared);
      },
      setFooter() {},
      setHeader() {},
      setTitle(title) {
        signal.throwIfAborted();
        emitDetached(
          { type: "extension_ui_request", id: randomUUID(), method: "setTitle", title },
          "title",
        );
      },
      async custom<T>(): Promise<T | undefined> { return undefined; },
      pasteToEditor: (text) => {
        signal.throwIfAborted();
        emitDetached({ type: "extension_ui_request", id: randomUUID(), method: "paste_editor_text", text });
      },
      setEditorText: (text) => {
        signal.throwIfAborted();
        const request: RpcExtensionUiRequestWithoutOwner = {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        };
        const prepared = canQueuePresentation(request, "editor");
        if (prepared === false) return;
        if (
          prepared.bytes > MAX_RETAINED_RPC_EXTENSION_UI_BYTES
            - (this.#retainedOwnerBytes + this.#outputBytes.cleanup)
        ) {
          throw new RangeError(
            `RPC extension UI retained state is limited to ${MAX_RETAINED_RPC_EXTENSION_UI_BYTES} bytes`,
          );
        }
        this.#editorText = text;
        this.#editorTextBytes = prepared.bytes;
        emitDetached(request, "editor", "throw", prepared);
      },
      getEditorText: () => this.#editorText,
      async editor(title, prefill) {
        return await dialog(undefined, undefined, {
          method: "editor",
          title,
          ...optionalProperties(prefill === undefined ? undefined : { prefill }),
        }, (response) => "value" in response ? response.value : undefined);
      },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() { return undefined; },
      theme: mono,
      getAllThemes() { return []; },
      getTheme() { return undefined; },
      setTheme() { return { success: false, error: "Theme switching is unavailable in RPC mode" }; },
      getToolsExpanded() { return false; },
      setToolsExpanded() {},
    };
    return Object.freeze(context);
  }

  handle(response: RpcExtensionUiResponse): boolean {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return false;
    pending.complete(response);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.cancel();
    this.#pending.clear();
    this.#pendingBytes = 0;
    for (const queued of this.#queue) {
      this.#outputBytes[queued.lane] -= queued.bytes;
      queued.completion?.resolve();
    }
    this.#queue.length = 0;
    for (const owner of this.#statusOwners.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    for (const owner of this.#widgetOwners.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#statusOwners.clear();
    this.#widgetOwners.clear();
    this.#retainedOwnerBytes = 0;
  }
}
