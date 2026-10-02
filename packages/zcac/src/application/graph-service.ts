/**
 * ZCAC Application — GraphService。
 *
 * 持有运行中的 TaskGraph,负责:
 *   - 依赖边变更(先环检测,后持久化;非法图不落库,规范 §12)
 *   - readiness 重算(pending/blocked → ready/blocked,规范 §13)
 *   - Run 聚合状态(created→running;全终态→completed/failed)
 */

import type { RunStatus } from "../domain/run/run.js";
import type { TaskGraph } from "../domain/graph/task-graph.js";
import type { Task, TaskId } from "../domain/task/task.js";
import { isTerminalTaskStatus } from "../domain/task/task-status.js";
import type { Clock, TransactionRunner } from "../ports/clock.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { TaskService } from "./task-service.js";

export interface GraphServiceDeps {
  graph: TaskGraph;
  tasks: TaskRepository;
  runs: RunRepository;
  tx: TransactionRunner;
  clock: Clock;
  taskService: TaskService;
}

export class GraphService {
  constructor(private readonly deps: GraphServiceDeps) {}

  /** 从持久层重建图(恢复/多进程接管用)。 */
  loadRun(runId: string): void {
    for (const task of this.deps.tasks.listByRun(runId)) {
      this.deps.graph.addTask(task);
    }
  }

  /**
   * 运行时新增依赖边(规范 §14):graph.addDependency 内部先做环检测,
   * 抛 GraphCycleError 时图与数据库都不变更。
   */
  addDependency(taskId: TaskId, dependencyId: TaskId): void {
    this.deps.graph.addDependency(taskId, dependencyId);
    const updated = this.deps.graph.getTask(taskId)!;
    this.deps.tx.run(() => this.deps.tasks.update(updated));
    this.refreshReadiness(updated.runId);
  }

  removeDependency(taskId: TaskId, dependencyId: TaskId): void {
    this.deps.graph.removeDependency(taskId, dependencyId);
    const updated = this.deps.graph.getTask(taskId)!;
    this.deps.tx.run(() => this.deps.tasks.update(updated));
    this.refreshReadiness(updated.runId);
  }

  /** 重算 run 内 readiness;返回发生迁移的任务。 */
  refreshReadiness(runId: string): Task[] {
    const changes = this.deps.graph.recomputeReadiness();
    for (const change of changes) {
      this.deps.taskService.applyReadinessChange(change.task.id, change.to);
    }
    return changes.map((change) => change.task);
  }

  /** Run 首次被调度时置 running(幂等,与事件同事务)。 */
  markRunStarted(runId: string): void {
    const run = this.deps.runs.get(runId);
    if (!run || run.status !== "created") return;
    this.deps.taskService.updateRunWithEvent(
      runId,
      { status: "running" },
      "RUN_STARTED",
      { status: "running" },
    );
  }

  /**
   * 聚合判定(幂等):
   *   - 全部任务 succeeded → completed
   *   - 存在 failed/cancelled 且无任何可推进任务(无 pending/ready/running/
   *     retry_wait/interrupted)→ failed(下游 blocked 任务因依赖失败永久滞留)
   *   - 否则维持现状
   */
  refreshRunStatus(runId: string): RunStatus {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "running" && run.status !== "created") return run.status;
    const tasks = this.deps.tasks.listByRun(runId);
    if (tasks.length === 0) return run.status;

    const failedCount = tasks.filter(
      (t) => t.status === "failed" || t.status === "cancelled",
    ).length;
    const succeededCount = tasks.filter((t) => t.status === "succeeded").length;
    const progressing = tasks.some(
      (t) =>
        t.status === "pending" ||
        t.status === "ready" ||
        t.status === "running" ||
        t.status === "retry_wait" ||
        t.status === "interrupted",
    );

    let next: RunStatus;
    if (failedCount === 0 && succeededCount === tasks.length) {
      next = "completed";
    } else if (failedCount > 0 && !progressing) {
      next = "failed";
    } else {
      return run.status;
    }

    this.deps.taskService.updateRunWithEvent(
      runId,
      { status: next },
      next === "completed" ? "RUN_COMPLETED" : "RUN_FAILED",
      {
        status: next,
        tasks: tasks.length,
        succeeded: succeededCount,
        failed: failedCount,
      },
    );
    return next;
  }
}
