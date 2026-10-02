/**
 * ZCAC-0003 — Agent Pool(application)。
 *
 * 逻辑名册:idle slot 复用优先;受 per-role quota 与全局上限约束。
 * acquire 失败(undefined)表示该角色当前无容量,Scheduler 应跳过该任务
 * 而不是阻塞其他角色。
 */

import type { AgentSlot } from "../domain/agent/agent-pool.js";
import type { AgentCapabilityRegistry } from "../domain/agent/agent-pool.js";
import type { TaskId } from "../domain/task/task.js";

export interface AgentPoolOptions {
  registry: AgentCapabilityRegistry;
  /** 覆盖角色的 defaultQuota(测试/配置用)。 */
  quotas?: Record<string, number>;
  /** 全局并发上限(所有角色之和)。 */
  globalMax?: number;
}

export class AgentPool {
  readonly #slots = new Map<string, AgentSlot>();
  readonly #registry: AgentCapabilityRegistry;
  readonly #quotas: Record<string, number>;
  readonly #globalMax: number;
  #seq = 0;

  constructor(options: AgentPoolOptions) {
    this.#registry = options.registry;
    this.#quotas = { ...options.quotas };
    this.#globalMax = options.globalMax ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * 申请一个 role 的 slot:idle 复用优先;quota/全局上限满时返回 undefined
   * (调用方应跳过该任务,而不是阻塞其他角色)。
   * 未知角色直接抛 UnknownRoleError(配置错误应尽早暴露)。
   */
  acquire(role: string, now: number, taskId: TaskId): AgentSlot | undefined {
    const definition = this.#registry.requireRole(role);
    if (!this.hasCapacity(role)) return undefined;
    const idle = [...this.#slots.values()].find(
      (slot) => slot.role === role && slot.status === "idle",
    );
    const slot: AgentSlot = idle
      ? {
          ...idle,
          status: "busy",
          currentTaskId: taskId,
          acquiredAt: now,
          releasedAt: undefined,
          totalTasks: idle.totalTasks + 1,
        }
      : {
          id: `slot_${crypto.randomUUID()}`,
          role,
          status: "busy",
          currentTaskId: taskId,
          acquiredAt: now,
          totalTasks: 1,
        };
    this.#slots.set(slot.id, slot);
    return { ...slot };
  }

  /** 该角色当前是否还有容量(不产生副作用)。 */
  hasCapacity(role: string): boolean {
    const definition = this.#registry.get(role);
    if (!definition) return false;
    return this.busyCount(role) < this.quotaOf(role) && this.busyTotal() < this.#globalMax;
  }

  release(slotId: string, now: number): AgentSlot | undefined {
    const slot = this.#slots.get(slotId);
    if (!slot || slot.status !== "busy") return undefined;
    const released: AgentSlot = {
      ...slot,
      status: "idle",
      currentTaskId: undefined,
      releasedAt: now,
    };
    this.#slots.set(slotId, released);
    return { ...released };
  }

  get(slotId: string): AgentSlot | undefined {
    const slot = this.#slots.get(slotId);
    return slot ? { ...slot } : undefined;
  }

  snapshot(): AgentSlot[] {
    return [...this.#slots.values()].map((slot) => ({ ...slot }));
  }

  busyCount(role: string): number {
    let count = 0;
    for (const slot of this.#slots.values()) {
      if (slot.role === role && slot.status === "busy") count += 1;
    }
    return count;
  }

  busyTotal(): number {
    let count = 0;
    for (const slot of this.#slots.values()) {
      if (slot.status === "busy") count += 1;
    }
    return count;
  }

  private quotaOf(role: string): number {
    return this.#quotas[role] ?? this.#registry.get(role)?.defaultQuota ?? 1;
  }
}
