/**
 * ZCAC-0005 — ClusterEvent (domain)。
 *
 * 同时承担 Journal / Live observation / Recovery replay 三职:
 *   - sequence:每 Run 内单调递增,replay 的唯一排序依据(不依赖 wall-clock);
 *   - 先 durable journal,后 live emit(顺序由 application 层保证)。
 */

import type { AgentId, RunId, TaskId } from "../task/task.js";
import type { ClusterEventType } from "./event-types.js";

export interface ClusterEvent<P = unknown> {
  id: string;
  runId: RunId;
  sequence: number;
  type: ClusterEventType;
  timestamp: number;
  taskId?: TaskId;
  agentId?: AgentId;
  payload: P;
}

export interface AppendEventInput {
  runId: RunId;
  type: ClusterEventType;
  timestamp: number;
  taskId?: TaskId;
  agentId?: AgentId;
  payload: unknown;
}
