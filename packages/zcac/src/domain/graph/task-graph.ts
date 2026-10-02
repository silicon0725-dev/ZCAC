/**
 * ZCAC-0002 — Runtime Mutable Task Graph (domain)
 *
 * 与 dwf 静态脚本图的核心差异:Graph 允许运行时 addTask / addDependency,
 * 每次依赖边变更先做环检测(GraphCycleError),非法图不允许进入持久层。
 *
 * 本类是纯内存结构;持久化由 application 层在事务中镜像到 SQLite。
 */

import type { Task, TaskId } from "../task/task.js";
import { isTerminalTaskStatus } from "../task/task-status.js";
import type { GraphIssue, GraphValidationResult } from "./graph-validation.js";

export class GraphCycleError extends Error {
  constructor(
    readonly taskId: TaskId,
    readonly dependencyId: TaskId,
    readonly path: TaskId[],
  ) {
    super(
      `Adding dependency ${taskId} → ${dependencyId} would create a cycle: ${[...path, taskId].join(" → ")}`,
    );
    this.name = "GraphCycleError";
  }
}

export class UnknownTaskError extends Error {
  constructor(readonly taskId: TaskId) {
    super(`Task not found in graph: ${taskId}`);
    this.name = "UnknownTaskError";
  }
}

/** readiness 重算产生的状态迁移(from → to)。 */
export interface ReadinessChange {
  task: Task;
  from: Task["status"];
  to: "ready" | "blocked";
}

export class TaskGraph {
  readonly #tasks = new Map<TaskId, Task>();

  addTask(task: Task): void {
    this.#tasks.set(task.id, { ...task });
  }

  updateTask(task: Task): void {
    if (!this.#tasks.has(task.id)) throw new UnknownTaskError(task.id);
    this.#tasks.set(task.id, { ...task });
  }

  removeTask(taskId: TaskId): void {
    this.#tasks.delete(taskId);
    for (const task of this.#tasks.values()) {
      if (task.dependencies.includes(taskId)) {
        throw new Error(
          `Cannot remove task ${taskId}: still a dependency of ${task.id} (remove the edge first)`,
        );
      }
    }
  }

  getTask(taskId: TaskId): Task | undefined {
    const task = this.#tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  listTasks(): Task[] {
    return [...this.#tasks.values()].map((t) => ({ ...t }));
  }

  /**
   * 新增依赖边 task → dependency(task 依赖 dependency)。
   * 先校验存在性、自依赖、跨 Run、再检测环;非法即抛错,图保持不变。
   */
  addDependency(taskId: TaskId, dependencyId: TaskId): void {
    const task = this.#tasks.get(taskId);
    if (!task) throw new UnknownTaskError(taskId);
    const dependency = this.#tasks.get(dependencyId);
    if (!dependency) throw new UnknownTaskError(dependencyId);
    if (taskId === dependencyId) {
      throw new GraphCycleError(taskId, dependencyId, [taskId]);
    }
    if (dependency.runId !== task.runId) {
      throw new Error(
        `Cross-run dependency is not allowed: ${taskId} (run ${task.runId}) → ${dependencyId} (run ${dependency.runId})`,
      );
    }
    if (task.dependencies.includes(dependencyId)) return; // 幂等
    // 新边 taskId→dependencyId 成环 ⟺ 从 dependencyId 沿依赖方向可达 taskId
    if (this.#reaches(dependencyId, taskId)) {
      const path = this.#pathBetween(dependencyId, taskId);
      throw new GraphCycleError(taskId, dependencyId, path);
    }
    task.dependencies = [...task.dependencies, dependencyId];
  }

  removeDependency(taskId: TaskId, dependencyId: TaskId): void {
    const task = this.#tasks.get(taskId);
    if (!task) throw new UnknownTaskError(taskId);
    task.dependencies = task.dependencies.filter((id) => id !== dependencyId);
  }

  getDependencies(taskId: TaskId): TaskId[] {
    const task = this.#tasks.get(taskId);
    if (!task) throw new UnknownTaskError(taskId);
    return [...task.dependencies];
  }

  getDependents(taskId: TaskId): TaskId[] {
    const dependents: TaskId[] = [];
    for (const task of this.#tasks.values()) {
      if (task.dependencies.includes(taskId)) dependents.push(task.id);
    }
    return dependents;
  }

  /**
   * Ready 集合:status === "ready"(由 recomputeReadiness / applyReadinessChange 维护)。
   * 排序:priority DESC → createdAt ASC → id ASC(确定性)。
   */
  getReadyTasks(): TaskId[] {
    return this.listTasks()
      .filter((task) => task.status === "ready")
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt - b.createdAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((task) => task.id);
  }

  getBlockedTasks(): TaskId[] {
    return this.listTasks()
      .filter((task) => task.status === "blocked")
      .map((task) => task.id);
  }

  /**
   * 重算 readiness:pending/blocked 任务按依赖状态迁移到 ready / blocked。
   * 只返回实际发生迁移的任务;不修改终态任务。
   */
  recomputeReadiness(): ReadinessChange[] {
    const changes: ReadinessChange[] = [];
    for (const task of this.#tasks.values()) {
      if (task.status !== "pending" && task.status !== "blocked") continue;
      const next = this.evaluateStatus(task);
      if (next !== task.status) {
        const from = task.status;
        task.status = next;
        changes.push({ task: { ...task }, from, to: next });
      }
    }
    return changes;
  }

  validate(): GraphValidationResult {
    const issues: GraphIssue[] = [];
    for (const task of this.#tasks.values()) {
      if (task.dependencies.includes(task.id)) {
        issues.push({
          code: "self_dependency",
          message: `Task ${task.id} depends on itself`,
          taskId: task.id,
          dependencyId: task.id,
        });
      }
      for (const dependencyId of task.dependencies) {
        const dependency = this.#tasks.get(dependencyId);
        if (!dependency) {
          issues.push({
            code: "missing_dependency",
            message: `Task ${task.id} depends on missing task ${dependencyId}`,
            taskId: task.id,
            dependencyId,
          });
        } else if (dependency.runId !== task.runId) {
          issues.push({
            code: "cross_run_dependency",
            message: `Task ${task.id} depends on task ${dependencyId} of another run`,
            taskId: task.id,
            dependencyId,
          });
        }
      }
    }
    for (const cycle of this.#findCycles()) {
      issues.push({
        code: "cycle",
        message: `Dependency cycle: ${cycle.join(" → ")}`,
        path: cycle,
      });
    }
    return { ok: issues.length === 0, issues };
  }

  private evaluateStatus(task: Task): "ready" | "blocked" {
    let unmet = false;
    for (const dependencyId of task.dependencies) {
      const dependency = this.#tasks.get(dependencyId);
      // 缺失依赖按 validate() 报错;readiness 视角一律视为未满足。
      if (!dependency || !isTerminalTaskStatus(dependency.status)) {
        unmet = true;
        continue;
      }
      if (dependency.status !== "succeeded") {
        // 依赖终态但非 succeeded(failed/cancelled):Phase 1 默认整体 BLOCKED。
        return "blocked";
      }
    }
    return unmet ? "blocked" : "ready";
  }

  /** DFS:from 沿「依赖于」方向是否可达 to。 */
  #reaches(from: TaskId, to: TaskId, visited = new Set<TaskId>()): boolean {
    if (from === to) return true;
    visited.add(from);
    const task = this.#tasks.get(from);
    if (!task) return false;
    for (const next of task.dependencies) {
      if (visited.has(next)) continue;
      if (this.#reaches(next, to, visited)) return true;
    }
    return false;
  }

  #pathBetween(from: TaskId, to: TaskId): TaskId[] {
    const queue: TaskId[][] = [[from]];
    while (queue.length > 0) {
      const path = queue.shift()!;
      const tail = path[path.length - 1]!;
      if (tail === to) return path;
      const task = this.#tasks.get(tail);
      for (const next of task?.dependencies ?? []) {
        if (!path.includes(next)) queue.push([...path, next]);
      }
    }
    return [from];
  }

  /** 全图环检测(基于依赖方向的 DFS 三色标记)。 */
  #findCycles(): TaskId[][] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<TaskId, number>();
    const stack: TaskId[] = [];
    const cycles: TaskId[][] = [];

    const visit = (taskId: TaskId): void => {
      const state = color.get(taskId) ?? WHITE;
      if (state === GRAY) {
        const start = stack.indexOf(taskId);
        cycles.push([...stack.slice(start), taskId]);
        return;
      }
      if (state === BLACK) return;
      color.set(taskId, GRAY);
      stack.push(taskId);
      const task = this.#tasks.get(taskId);
      for (const next of task?.dependencies ?? []) visit(next);
      stack.pop();
      color.set(taskId, BLACK);
    };

    for (const taskId of this.#tasks.keys()) visit(taskId);
    return cycles;
  }
}
