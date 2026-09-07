import type { PluginConfigStore } from "../../../config-store.js";
import type { PluginJobService } from "../../../durable-jobs.js";
import type { PluginFacetService } from "../../../facets.js";
import type { PluginProcessService } from "../../../../process/managed-process.js";
import type { JsonValue } from "../../../../core/json.js";
import type { PluginEventMap, PluginHandler } from "../../events.js";
import type { PluginRegistrationHandle } from "./registration.js";

export interface PluginLifecycleCapabilities {
  readonly config: PluginConfigStore;
  readonly facets: PluginFacetService;
  readonly jobs: PluginJobService;
  readonly processes: PluginProcessService;
  readonly services: {
    register<Service extends object>(name: string, service: Service): PluginRegistrationHandle;
    get<Service extends object = object>(name: string): Service | undefined;
  };
  onDispose(callback: () => void | Promise<void>): PluginRegistrationHandle;
  on<K extends keyof PluginEventMap>(event: K, handler: PluginHandler<K>): PluginRegistrationHandle;
  readonly events: {
    on(channel: string, handler: (data: JsonValue) => void | Promise<void>): PluginRegistrationHandle;
    emit<T>(channel: string, data: T): void;
  };
}
