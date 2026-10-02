/**
 * ZCAC — Run (domain)。一次集群执行:持有 Task Graph 与事件序列。
 */

import type { RunId } from "../task/task.js";

export type RunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  id: RunId;
  status: RunStatus;
  rootTaskId?: string;
  createdAt: number;
  updatedAt: number;
  /** Journal 已分配到的最大事件序号(每 Run 单调递增,replay 依据)。 */
  eventSequence: number;
  metadata?: Record<string, unknown>;
}

export interface CreateRunInput {
  id?: RunId;
  rootTaskId?: string;
  metadata?: Record<string, unknown>;
}

export function createRun(input: CreateRunInput, now: number): Run {
  return {
    id: input.id ?? `run_${crypto.randomUUID()}`,
    status: "created",
    rootTaskId: input.rootTaskId,
    createdAt: now,
    updatedAt: now,
    eventSequence: 0,
    metadata: input.metadata,
  };
}
