/**
 * ZCAC-0008 — Worktree 仓储(SQLite)。
 */

import type { Worktree, WorktreeStatus } from "../../domain/worktree/worktree.js";
import type { WorktreeRepository } from "../../ports/worktree-repository.js";
import type { SqliteDatabase } from "./database.js";

interface WorktreeRow {
  id: string;
  run_id: string;
  task_id: string;
  path: string;
  branch: string;
  base_ref: string;
  status: string;
  commit_sha: string | null;
  created_at: number;
  updated_at: number;
}

function rowToWorktree(row: WorktreeRow): Worktree {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    status: row.status as WorktreeStatus,
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteWorktreeRepository implements WorktreeRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(worktree: Worktree): void {
    this.database.db
      .prepare(
        `INSERT INTO zcac_worktrees
           (id, run_id, task_id, path, branch, base_ref, status, commit_sha,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worktree.id,
        worktree.runId,
        worktree.taskId,
        worktree.path,
        worktree.branch,
        worktree.baseRef,
        worktree.status,
        worktree.commitSha ?? null,
        worktree.createdAt,
        worktree.updatedAt,
      );
  }

  update(worktree: Worktree): void {
    this.database.db
      .prepare(
        `UPDATE zcac_worktrees
         SET status = ?, commit_sha = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(worktree.status, worktree.commitSha ?? null, worktree.updatedAt, worktree.id);
  }

  get(worktreeId: string): Worktree | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM zcac_worktrees WHERE id = ?")
      .get(worktreeId) as unknown as WorktreeRow | undefined;
    return row ? rowToWorktree(row) : undefined;
  }

  findByTask(taskId: string): Worktree | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM zcac_worktrees WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as unknown as WorktreeRow | undefined;
    return row ? rowToWorktree(row) : undefined;
  }

  listByRun(runId: string): Worktree[] {
    const rows = this.database.db
      .prepare("SELECT * FROM zcac_worktrees WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as unknown as WorktreeRow[];
    return rows.map(rowToWorktree);
  }
}
