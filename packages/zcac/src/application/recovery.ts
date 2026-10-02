/**
 * ZCAC Application — Recovery(Phase 2:lease 过期判定,规范 §33 + ZCAC-0004)。
 *
 * 进程重启后:遗留 running 态任务按 lease 判定归属:
 *   lease_until <= now  → 本/其他进程已失联 → attempt < maxAttempts 则 READY,
 *                        否则 FAILED(error=interrupted)
 *   lease_until >  now  → 可能仍被其他进程持有,不动(v0.2 多进程的语义预留)
 * Completed Task 不重跑(不可变)。
 */

import type { RunId, TaskId } from "../domain/task/task.js";
import type { Clock } from "../ports/clock.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { TaskService } from "./task-service.js";

export interface RecoveryResult {
  runId: RunId;
  requeued: TaskId[];
  failed: TaskId[];
  /** lease 未过期、保持 running 的任务(留给持有进程)。 */
  stillLeased: TaskId[];
}

export class RecoveryService {
  constructor(
    private readonly deps: { tasks: TaskRepository; taskService: TaskService; clock: Clock },
  ) {}

  recoverRun(runId: RunId): RecoveryResult {
    const result: RecoveryResult = { runId, requeued: [], failed: [], stillLeased: [] };
    const now = this.deps.clock.now();
    for (const task of this.deps.tasks.listByRunAndStatus(runId, "running")) {
      if ((task.leaseUntil ?? 0) > now) {
        result.stillLeased.push(task.id);
        continue;
      }
      const outcome = this.deps.taskService.recoverInterruptedTask(task.id);
      if (outcome === "requeued") result.requeued.push(task.id);
      else if (outcome === "failed") result.failed.push(task.id);
    }
    return result;
  }
}
