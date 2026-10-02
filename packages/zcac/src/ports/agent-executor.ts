/**
 * ZCAC Ports — AgentExecutor 端口(规范 §27/§42)。
 *
 * Scheduler/Application 只依赖此接口;不允许知道
 * createZCodeApp / AgentRuntime / SubagentPort。
 * `model` 是 ZCAC 逻辑模型标识("provider/model[@level]"),由 adapter 解析。
 */

import type { AgentId } from "../domain/task/task.js";
import type { UsageSummary } from "../domain/task/task-input.js";

export interface AgentLaunchRequest {
  role: string;
  prompt: string;
  description?: string;
  workingDirectory: string;
  tools?: readonly string[];
  agentPrompt?: string;
  /** ZCAC 逻辑模型标识,如 "bigmodel-api/GLM-5.3-Flash@low"。 */
  model?: string;
  maxTurns?: number;
  metadata?: { runId: string; taskId: string };
}

export interface AgentHandle {
  agentId: AgentId;
  role: string;
  sessionId: string;
  model: string;
  metadata?: { runId: string; taskId: string };
}

export interface AgentResult {
  status: "completed" | "failed" | "cancelled";
  agentId: AgentId;
  role: string;
  sessionId: string;
  model: string;
  response: string;
  usage?: UsageSummary;
  durationMs: number;
  error?: string;
  metadata?: { runId: string; taskId: string };
}

export interface AgentExecutor {
  launch(request: AgentLaunchRequest): Promise<AgentHandle>;

  send(handle: AgentHandle, message: string): Promise<void>;

  wait(handle: AgentHandle): Promise<AgentResult>;

  stop(handle: AgentHandle): Promise<void>;

  /** 释放单个 handle 的资源;无参时释放整个 executor。 */
  dispose(handle?: AgentHandle): Promise<void>;
}
