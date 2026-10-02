/**
 * ZCAC-0003 — Agent Pool 领域模型(domain)。
 *
 * Pool 是逻辑层:名册/配额/能力元数据/任务绑定;不是物理进程池(v0.1 Principle 9)。
 * 工具白名单与 persona 属于执行平面,留在 ZCode adapter;这里只有调度事实。
 */

import type { TaskId } from "../task/task.js";

export interface AgentSlot {
  id: string;
  role: string;
  status: "idle" | "busy";
  currentTaskId?: TaskId;
  acquiredAt: number;
  releasedAt?: number;
  /** 该 slot 历史绑定任务数(idle 复用计数)。 */
  totalTasks: number;
}

export interface RoleDefinition {
  role: string;
  /** 该角色具备的能力标识(code.write / test.execute / code.review / ...)。 */
  capabilities: readonly string[];
  /** 该角色最大并发 slot 数。 */
  defaultQuota: number;
}

export class UnknownRoleError extends Error {
  constructor(readonly role: string, readonly known: readonly string[]) {
    super(
      `Unknown ZCAC agent role "${role}". Known roles: ${known.join(", ")}`,
    );
    this.name = "UnknownRoleError";
  }
}

/** role → 能力/配额元数据;createTask 时校验,Scheduler 准入时引用。 */
export class AgentCapabilityRegistry {
  readonly #roles = new Map<string, RoleDefinition>();

  register(def: RoleDefinition): void {
    this.#roles.set(def.role, { ...def });
  }

  get(role: string): RoleDefinition | undefined {
    return this.#roles.get(role);
  }

  requireRole(role: string): RoleDefinition {
    const def = this.#roles.get(role);
    if (!def) throw new UnknownRoleError(role, [...this.#roles.keys()]);
    return def;
  }

  list(): RoleDefinition[] {
    return [...this.#roles.values()].map((def) => ({ ...def }));
  }
}

/** 默认角色集(与 v0.1 Spec §5 一致;工具面由 ZCode adapter 定义)。 */
export function createDefaultCapabilityRegistry(): AgentCapabilityRegistry {
  const registry = new AgentCapabilityRegistry();
  registry.register({
    role: "coder",
    capabilities: ["code.write", "code.edit", "shell.execute"],
    defaultQuota: 2,
  });
  registry.register({
    role: "explorer",
    capabilities: ["code.read", "repo.analysis"],
    defaultQuota: 2,
  });
  registry.register({
    role: "planner",
    capabilities: ["code.read", "plan.authoring"],
    defaultQuota: 1,
  });
  registry.register({
    role: "tester",
    capabilities: ["test.execute", "shell.execute"],
    defaultQuota: 1,
  });
  registry.register({
    role: "reviewer",
    capabilities: ["code.read", "code.review"],
    defaultQuota: 1,
  });
  return registry;
}
