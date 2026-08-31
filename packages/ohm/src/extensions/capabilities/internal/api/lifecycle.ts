import type { ExtensionConfigStore } from "../../../config-store.js";
import type { ExtensionProcessService } from "../../../../process/managed-process.js";
import type { JsonValue } from "../../../../core/json.js";
import type { ExtensionEventMap, ExtensionHandler } from "../../events.js";
import type { ExtensionRegistrationHandle } from "./registration.js";

export interface ExtensionLifecycleCapabilities {
  readonly config: ExtensionConfigStore;
  readonly processes: ExtensionProcessService;
  readonly services: {
    register<Service extends object>(name: string, service: Service): ExtensionRegistrationHandle;
    get<Service extends object = object>(name: string): Service | undefined;
  };
  onDispose(callback: () => void | Promise<void>): ExtensionRegistrationHandle;
  on<K extends keyof ExtensionEventMap>(event: K, handler: ExtensionHandler<K>): ExtensionRegistrationHandle;
  readonly events: {
    on(channel: string, handler: (data: JsonValue) => void | Promise<void>): ExtensionRegistrationHandle;
    emit<T>(channel: string, data: T): void;
  };
}
