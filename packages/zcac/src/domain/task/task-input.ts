/**
 * ZCAC-0001 — TaskInput / TaskOutput (domain)
 *
 * TaskInput 必须是结构化对象,而不是一段隐式 prompt。
 * `model` 是 ZCAC 的逻辑模型标识(如 "bigmodel-api/GLM-5.3-Flash@low"),
 * 由 ZCode Adapter 解析为 provider/model + reasoningLevel;
 * Task Core 不需要知道 ZCode ModelSelection 的内部结构。
 */

import type { TaskId } from "./task.js";

/** 对其他任务产物的引用(Phase 4 Artifact System 落地前的轻量形态)。 */
export interface ArtifactReference {
  artifactId: string;
  type?: string;
  path?: string;
}

/** 对集群共享上下文(如上游任务 summary)的引用。 */
export interface TaskContextReference {
  taskId: TaskId;
  summary?: string;
}

export interface TaskInput {
  /** Worker agent 的任务指令。 */
  prompt: string;

  /** 目标角色(coder/explorer/planner/tester/reviewer...)。 */
  role?: string;

  /** ZCAC 逻辑模型标识 "provider/model[@level]"。 */
  model?: string;

  /** 工作目录(Phase 6 前允许缺省,由 Executor 决定)。 */
  workspacePath?: string;

  context?: TaskContextReference[];
  artifacts?: ArtifactReference[];

  metadata?: Record<string, unknown>;
}

export interface UsageSummary {
  modelRequestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

/** Reviewer 等角色的结构化发现(Phase 5 Review Loop 的输入)。 */
export interface Finding {
  severity: "low" | "medium" | "high";
  file?: string;
  line?: number;
  message: string;
}

export interface TaskOutput {
  status: "success" | "failure";
  summary?: string;
  response?: string;
  artifacts: ArtifactReference[];
  findings?: Finding[];
  usage?: UsageSummary;
  metadata?: Record<string, unknown>;
}
