/**
 * ZCAC-0009 — Run 仓储(SQLite)。
 */

import type { Run, RunStatus } from "../../domain/run/run.js";
import type { RunRepository } from "../../ports/run-repository.js";
import type { SqliteDatabase } from "./database.js";

function rowToRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as string,
    status: row.status as RunStatus,
    rootTaskId: (row.root_task_id as string | null) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    eventSequence: row.event_sequence as number,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json as string) as Record<string, unknown>)
      : undefined,
  };
}

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(run: Run): void {
    this.database.db
      .prepare(
        `INSERT INTO zcac_runs
           (id, status, root_task_id, created_at, updated_at, event_sequence, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.status,
        run.rootTaskId ?? null,
        run.createdAt,
        run.updatedAt,
        run.eventSequence,
        run.metadata === undefined ? null : JSON.stringify(run.metadata),
      );
  }

  update(run: Run): void {
    this.database.db
      .prepare(
        `UPDATE zcac_runs
         SET status = ?, root_task_id = ?, updated_at = ?, event_sequence = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.rootTaskId ?? null,
        run.updatedAt,
        run.eventSequence,
        run.metadata === undefined ? null : JSON.stringify(run.metadata),
        run.id,
      );
  }

  get(runId: string): Run | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM zcac_runs WHERE id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : undefined;
  }
}
