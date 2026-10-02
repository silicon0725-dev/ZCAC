/**
 * ZCAC-0005 — Cluster Event 类型 (domain)。
 * 事件粒度围绕:状态变化、资源分配、持久化对象变化。不要滥加类型。
 */

export type ClusterEventType =
  | "RUN_CREATED"
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"

  | "TASK_CREATED"
  | "TASK_READY"
  | "TASK_STARTED"
  | "TASK_SUCCEEDED"
  | "TASK_FAILED"
  | "TASK_RETRY"
  | "TASK_BLOCKED"

  | "AGENT_ASSIGNED"
  | "AGENT_RELEASED"

  | "ARTIFACT_CREATED"

  | "WORKTREE_CREATED"
  | "WORKTREE_REMOVED"
  | "MERGE_STARTED"
  | "MERGE_COMPLETED"
  | "MERGE_CONFLICT"

  | "SUPERVISOR_DECISION"

  | "ERROR";
