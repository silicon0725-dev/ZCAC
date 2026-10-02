/**
 * ZCAC-0006 — Artifact 仓储(SQLite)。
 */

import type { Artifact, ArtifactType } from "../../domain/artifact/artifact.js";
import type { ArtifactRepository } from "../../ports/artifact-repository.js";
import type { SqliteDatabase } from "./database.js";

interface ArtifactRow {
  id: string;
  run_id: string;
  task_id: string;
  agent_id: string | null;
  type: string;
  content_json: string;
  checksum: string;
  created_at: number;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    type: row.type as ArtifactType,
    content: JSON.parse(row.content_json) as unknown,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(artifact: Artifact): void {
    this.database.db
      .prepare(
        `INSERT INTO zcac_artifacts
           (id, run_id, task_id, agent_id, type, content_json, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.taskId,
        artifact.agentId ?? null,
        artifact.type,
        JSON.stringify(artifact.content),
        artifact.checksum,
        artifact.createdAt,
      );
  }

  get(artifactId: string): Artifact | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM zcac_artifacts WHERE id = ?")
      .get(artifactId) as unknown as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  listByTask(taskId: string): Artifact[] {
    const rows = this.database.db
      .prepare("SELECT * FROM zcac_artifacts WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as unknown as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  listByRun(runId: string): Artifact[] {
    const rows = this.database.db
      .prepare("SELECT * FROM zcac_artifacts WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as unknown as ArtifactRow[];
    return rows.map(rowToArtifact);
  }
}
