/**
 * ZCAC-0005 — Live Event Bus (domain)。
 *
 * EventBus = observation;Journal = source of truth。
 * 丢事件不影响恢复;重连时以 lastSequence 从 Journal replay 再接 live。
 * Phase 1 用同步简单订阅;cursor subscription 后续再加。
 */

import type { ClusterEvent } from "./cluster-event.js";

export type EventHandler = (event: ClusterEvent) => void;

export class ClusterEventBus {
  readonly #handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** handler 抛错不允许影响发布方(观察面故障不回传控制面)。 */
  publish(event: ClusterEvent): void {
    for (const handler of [...this.#handlers]) {
      try {
        handler(event);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[zcac] event handler error:", error);
      }
    }
  }
}
