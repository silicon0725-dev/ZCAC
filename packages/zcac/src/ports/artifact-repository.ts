/**
 * ZCAC-0006 — Artifact 仓储端口。
 */

import type { Artifact } from "../domain/artifact/artifact.js";

export interface ArtifactRepository {
  insert(artifact: Artifact): void;
  get(artifactId: string): Artifact | undefined;
  listByTask(taskId: string): Artifact[];
  listByRun(runId: string): Artifact[];
}
