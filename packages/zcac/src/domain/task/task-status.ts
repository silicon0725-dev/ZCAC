/**
 * ZCAC-0001 — Task 状态机 (domain)
 *
 *   pending ──(deps satisfied)──▶ ready ──(claim)──▶ running ──▶ succeeded
 *      │                            ▲                   │
 *      │ (deps unmet)               │                   ├──▶ failed
 *      ▼                            │                   │
 *   blocked ──(deps satisfied)──────┘                   ▼
 *                                                retry_wait ──(backoff elapsed)──▶ ready
 *
 *   任意非终态 ──▶ cancelled(Phase 1 由外部调用)
 *   running(崩溃遗留)──▶ interrupted ──▶ ready | failed (Recovery, Phase 1)
 */

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "retry_wait"
  | "cancelled"
  | "interrupted";

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** 合法迁移表。key = from, value = 允许的 to 集合。 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled", "pending"],
  running: ["succeeded", "failed", "retry_wait", "cancelled", "interrupted"],
  blocked: ["ready", "cancelled", "pending"],
  retry_wait: ["ready", "failed", "cancelled"],
  interrupted: ["ready", "failed", "cancelled"],
  succeeded: [],
  failed: ["retry_wait"],
  cancelled: [],
};

export class InvalidTaskTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task transition ${from} → ${to} for task ${taskId}`);
    this.name = "InvalidTaskTransitionError";
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(taskId: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTaskTransitionError(taskId, from, to);
  }
}
