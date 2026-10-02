/**
 * ZCAC Ports — Task 仓储。
 */

import type { Task, TaskId } from "../domain/task/task.js";
import type { TaskStatus } from "../domain/task/task-status.js";

export interface TaskRepository {
  insert(task: Task): void;

  /** 整行替换(乐观并发由 SQLite 事务保证)。 */
  update(task: Task): void;

  get(taskId: TaskId): Task | undefined;

  listByRun(runId: string): Task[];

  listByRunAndStatus(runId: string, status: TaskStatus): Task[];

  /**
   * 原子认领(规范 §26 + ZCAC-0004 lease):
   * UPDATE ... SET status='running', attempt=attempt+1, started_at=?,
   *        lease_until=?, ...
   * WHERE id=? AND status='ready'
   * 返回 claim 成功后的最新 Task;被抢先/状态不符返回 undefined。
   */
  claim(taskId: TaskId, now: number, leaseUntil: number): Task | undefined;

  /** 执行期间续约:仅对 running 态生效(幂等,任务已终态则忽略)。 */
  heartbeat(taskId: TaskId, now: number, leaseUntil: number): boolean;
}
