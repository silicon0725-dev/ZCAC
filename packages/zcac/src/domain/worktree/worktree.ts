/**
 * ZCAC-0008 — Worktree 领域模型(domain)。
 *
 * 写入型 Agent 的隔离边界(规范 §27-§30):
 *   Task claimed → create worktree → AgentRuntime(在 worktree 内工作)
 *   → commit → Review → PASS → merge 回主分支
 *
 * 状态机:created → committed → merged | conflict | abandoned
 */

import type { RunId, TaskId } from "../task/task.js";

export type WorktreeStatus =
  | "created"
  | "committed"
  | "merged"
  | "conflict"
  | "abandoned";

export interface Worktree {
  id: string;
  runId: RunId;
  taskId: TaskId;
  /** worktree 检出目录(绝对路径)。 */
  path: string;
  /** worktree 上的分支名(如 zcac/<taskId>)。 */
  branch: string;
  /** 创建时的基线(ref,通常是 HEAD)。 */
  baseRef: string;
  status: WorktreeStatus;
  /** commit 成功后的 SHA。 */
  commitSha?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommitResult {
  sha?: string;
  /** 没有可提交变更时为 true。 */
  empty: boolean;
  message: string;
}

export type MergeStatus = "merged" | "conflict" | "noop";

export interface MergeResult {
  worktreeId: string;
  branch: string;
  target: string;
  status: MergeStatus;
  /** 冲突文件列表(status=conflict 时)。 */
  conflictFiles: string[];
}
