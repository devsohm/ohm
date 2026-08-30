import type { JsonValue } from "./json.js";

export type EventHandler = (value: JsonValue) => void | Promise<void>;

export interface EventBus {
  on(topic: string, handler: EventHandler): () => void;
  emit(topic: string, value: JsonValue): void;
}

export interface EventBusController extends EventBus {
  clear(): void;
}

export function createEventBus(): EventBusController {
  const topics = new Map<string, Set<EventHandler>>();
  return {
    on(topic, handler) {
      const handlers = topics.get(topic) ?? new Set<EventHandler>();
      handlers.add(handler);
      topics.set(topic, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) topics.delete(topic);
      };
    },
    emit(topic, value) {
      for (const handler of Array.from(topics.get(topic) ?? [])) {
        try {
          void Promise.resolve(handler(value)).catch(() => { console.error("Event handler failed"); });
        } catch {
          console.error("Event handler failed");
        }
      }
    },
    clear() { topics.clear(); },
  };
}
