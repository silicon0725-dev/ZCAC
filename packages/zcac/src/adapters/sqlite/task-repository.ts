/**
 * ZCAC-0009 — Task 仓储(SQLite)。
 */

import type { Task, TaskError, TaskId } from "../../domain/task/task.js";
import type { TaskStatus } from "../../domain/task/task-status.js";
import type { TaskInput, TaskOutput } from "../../domain/task/task-input.js";
import type { RetryPolicy } from "../../domain/task/retry-policy.js";
import type { TaskRepository } from "../../ports/task-repository.js";
import type { SqliteDatabase } from "./database.js";

interface TaskRow {
  id: string;
  run_id: string;
  kind: string;
  status: string;
  priority: number;
  input_json: string;
  output_json: string | null;
  dependencies_json: string;
  assigned_agent_id: string | null;
  attempt: number;
  retry_policy_json: string;
  retry_not_before: number | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_json: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status as TaskStatus,
    priority: row.priority,
    input: JSON.parse(row.input_json) as TaskInput,
    output: row.output_json ? (JSON.parse(row.output_json) as TaskOutput) : undefined,
    dependencies: JSON.parse(row.dependencies_json) as TaskId[],
    assignedAgentId: row.assigned_agent_id ?? undefined,
    attempt: row.attempt,
    retryPolicy: JSON.parse(row.retry_policy_json) as RetryPolicy,
    retryNotBefore: row.retry_not_before ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error_json ? (JSON.parse(row.error_json) as TaskError) : undefined,
  };
}

const ALL_COLUMNS =
  "id, run_id, kind, status, priority, input_json, output_json, dependencies_json, " +
  "assigned_agent_id, attempt, retry_policy_json, retry_not_before, lease_until, " +
  "created_at, updated_at, started_at, completed_at, error_json";

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(task: Task): void {
    this.database.db
      .prepare(
        `INSERT INTO zcac_tasks
           (id, run_id, kind, status, priority, input_json, output_json,
            dependencies_json, assigned_agent_id, attempt, retry_policy_json,
            retry_not_before, created_at, updated_at, started_at, completed_at, error_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.runId,
        task.kind,
        task.status,
        task.priority,
        JSON.stringify(task.input),
        task.output === undefined ? null : JSON.stringify(task.output),
        JSON.stringify(task.dependencies),
        task.assignedAgentId ?? null,
        task.attempt,
        JSON.stringify(task.retryPolicy),
        task.retryNotBefore ?? null,
        task.createdAt,
        task.updatedAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.error === undefined ? null : JSON.stringify(task.error),
      );
  }

  update(task: Task): void {
    this.database.db
      .prepare(
        `UPDATE zcac_tasks
         SET status = ?, priority = ?, output_json = ?, dependencies_json = ?,
             assigned_agent_id = ?, attempt = ?, retry_policy_json = ?,
             retry_not_before = ?, updated_at = ?, started_at = ?, completed_at = ?,
             error_json = ?
         WHERE id = ?`,
      )
      .run(
        task.status,
        task.priority,
        task.output === undefined ? null : JSON.stringify(task.output),
        JSON.stringify(task.dependencies),
        task.assignedAgentId ?? null,
        task.attempt,
        JSON.stringify(task.retryPolicy),
        task.retryNotBefore ?? null,
        task.updatedAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.error === undefined ? null : JSON.stringify(task.error),
        task.id,
      );
  }

  get(taskId: TaskId): Task | undefined {
    const row = this.database.db
      .prepare(`SELECT ${ALL_COLUMNS} FROM zcac_tasks WHERE id = ?`)
      .get(taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listByRun(runId: string): Task[] {
    const rows = this.database.db
      .prepare(`SELECT ${ALL_COLUMNS} FROM zcac_tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
      .all(runId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  listByRunAndStatus(runId: string, status: TaskStatus): Task[] {
    const rows = this.database.db
      .prepare(
        `SELECT ${ALL_COLUMNS} FROM zcac_tasks
         WHERE run_id = ? AND status = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(runId, status) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * 原子认领(规范 §26 + lease):单条 UPDATE 的原子性保证同一 Task 只有一个
   * claimer 拿到 affectedRows === 1。attempt 在此 +1,从 1 开始计数;
   * lease_until 一并写入(ZCAC-0004)。
   */
  claim(taskId: TaskId, now: number, leaseUntil: number): Task | undefined {
    const result = this.database.db
      .prepare(
        `UPDATE zcac_tasks
         SET status = 'running', attempt = attempt + 1, started_at = ?,
             updated_at = ?, lease_until = ?
         WHERE id = ? AND status = 'ready'`,
      )
      .run(now, now, leaseUntil, taskId);
    if (result.changes !== 1) return undefined;
    return this.get(taskId);
  }

  /** 执行期间续约:仅对 running 态生效;返回是否续约成功。 */
  heartbeat(taskId: TaskId, now: number, leaseUntil: number): boolean {
    const result = this.database.db
      .prepare(
        `UPDATE zcac_tasks
         SET lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(leaseUntil, now, taskId);
    return result.changes === 1;
  }
}
