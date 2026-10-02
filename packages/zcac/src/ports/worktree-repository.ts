/**
 * ZCAC-0008 — Worktree 仓储端口。
 */

import type { Worktree } from "../domain/worktree/worktree.js";

export interface WorktreeRepository {
  insert(worktree: Worktree): void;
  update(worktree: Worktree): void;
  get(worktreeId: string): Worktree | undefined;
  findByTask(taskId: string): Worktree | undefined;
  listByRun(runId: string): Worktree[];
}
