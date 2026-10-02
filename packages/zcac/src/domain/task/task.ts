/**
 * ZCAC-0001 — Task Model (domain)
 *
 * Task 描述「需要完成什么工作」;Agent 描述「谁来完成」。
 * 本文件不允许 import 任何 @zcode/* 或 Node 专属 API。
 */

import type { RetryPolicy } from "./retry-policy.js";
import type { TaskStatus } from "./task-status.js";
import type { TaskInput, TaskOutput } from "./task-input.js";

export type TaskId = string;
export type RunId = string;
export type AgentId = string;

/** Task 失败的结构化原因。 */
export interface TaskError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface Task {
  id: TaskId;
  runId: RunId;

  /** 任务种类,如 plan / explore / implement / test / review / fix / integrate / custom。 */
  kind: string;

  status: TaskStatus;

  /** 数值越大越优先;同 priority 按 createdAt ASC (FIFO)。 */
  priority: number;

  input: TaskInput;
  output?: TaskOutput;

  /** 本任务依赖的 TaskId 列表(全部 succeeded 才 READY)。 */
  dependencies: TaskId[];

  assignedAgentId?: AgentId;

  /** 第几次执行;claim 时 +1,从 1 开始。 */
  attempt: number;

  retryPolicy: RetryPolicy;

  createdAt: number;
  updatedAt: number;

  startedAt?: number;
  completedAt?: number;

  error?: TaskError;

  /** retry_wait 状态下最早可重新入队的时间戳(ms)。 */
  retryNotBefore?: number;

  /** claim 时写入的租约到期时间戳(ms);执行期间由 heartbeat 续约(ZCAC-0004)。 */
  leaseUntil?: number;
}

export interface CreateTaskInput {
  id?: TaskId;
  runId: RunId;
  kind: string;
  priority?: number;
  input: TaskInput;
  dependencies?: TaskId[];
  retryPolicy?: RetryPolicy;
}

export function createTask(input: CreateTaskInput, now: number): Task {
  return {
    id: input.id ?? `task_${crypto.randomUUID()}`,
    runId: input.runId,
    kind: input.kind,
    status: "pending",
    priority: input.priority ?? 0,
    input: input.input,
    output: undefined,
    dependencies: [...(input.dependencies ?? [])],
    assignedAgentId: undefined,
    attempt: 0,
    retryPolicy: input.retryPolicy ?? { maxAttempts: 1, backoffMs: 5_000, retryOn: ["retryable_error"] },
    createdAt: now,
    updatedAt: now,
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    retryNotBefore: undefined,
  };
}
