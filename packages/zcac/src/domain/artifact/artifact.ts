/**
 * ZCAC-0006 — Artifact(domain):Agent 间正式通信媒介。
 * 内容不可变;checksum = sha256(canonical JSON)。
 */

import { createHash } from "node:crypto";
import type { AgentId, RunId, TaskId } from "../task/task.js";

export type ArtifactType =
  | "report"
  | "finding"
  | "patch"
  | "diff"
  | "test_result"
  | "review"
  | "plan"
  | "log";

export interface Artifact {
  id: string;
  runId: RunId;
  taskId: TaskId;
  agentId?: AgentId;
  type: ArtifactType;
  content: unknown;
  checksum: string;
  createdAt: number;
}

export function artifactChecksum(content: unknown): string {
  const json = JSON.stringify(content, null, 0);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

export interface CreateArtifactInput {
  runId: RunId;
  taskId: TaskId;
  agentId?: AgentId;
  type: ArtifactType;
  content: unknown;
}

export function createArtifact(input: CreateArtifactInput, now: number): Artifact {
  return {
    id: `artifact_${crypto.randomUUID()}`,
    runId: input.runId,
    taskId: input.taskId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    type: input.type,
    content: input.content,
    checksum: artifactChecksum(input.content),
    createdAt: now,
  };
}
