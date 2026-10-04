/**
 * ZCAC-0011 — Agent Message 域模型(domain)。
 *
 * Message ≠ Event:
 *   Event  = 观察事实("发生了什么") → Event Journal
 *   Message = 通信意图("我希望另一个 Agent 做什么/知道什么") → Message Bus
 *
 * 所有 Message 带 threadId 支持会话链;replyTo 关联前一条。
 */

import type { AgentId, RunId, TaskId } from "../task/task.js";

export type AgentMessageType =
  | "question"    // 发送方需要接收方的专业判断
  | "finding"     // 发送方主动共享发现
  | "request"     // 发送方请求接收方执行某动作
  | "handoff"     // 任务完成时向上游传递上下文
  | "broadcast";  // 定向广播(受 policy 控制)

export interface AgentMessage {
  id: string;
  runId: RunId;
  /** 会话线程 ID;同一 thread 内的消息按时间形成对话链。 */
  threadId: string;
  fromAgent: string;      // role name or agentId
  toAgent: string;        // role name or agentId ("*" for broadcast)
  type: AgentMessageType;
  content: string;
  taskId?: TaskId;
  replyTo?: string;       // 前一条消息的 id
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ZCAC-0012 — Communication Policy
// ---------------------------------------------------------------------------

export interface RoleCommunicationPolicy {
  /** 允许发送的目标角色列表;"*" 表示任意。 */
  canSendTo: readonly string[];
  canBroadcast: boolean;
  maxMessagesPerTask: number;
}

export type CommunicationPolicy = Readonly<Record<string, RoleCommunicationPolicy>>;

export const DEFAULT_COMMUNICATION_POLICY: CommunicationPolicy = {
  coder:     { canSendTo: ["explorer", "tester", "planner", "backend-coder", "frontend-coder", "ux-designer"], canBroadcast: false, maxMessagesPerTask: 10 },
  planner:   { canSendTo: ["*"], canBroadcast: true,  maxMessagesPerTask: 20 },
  explorer:  { canSendTo: ["coder", "planner", "backend-coder", "frontend-coder", "market-researcher"], canBroadcast: false, maxMessagesPerTask: 10 },
  tester:    { canSendTo: ["coder", "reviewer", "integration-tester"], canBroadcast: false, maxMessagesPerTask: 10 },
  reviewer:  { canSendTo: ["supervisor"], canBroadcast: true, maxMessagesPerTask: 5 },
  supervisor:{ canSendTo: ["*"], canBroadcast: true,  maxMessagesPerTask: 30 },
  "frontend-coder":  { canSendTo: ["ux-designer", "ui-designer", "reviewer", "planner", "explorer"], canBroadcast: false, maxMessagesPerTask: 10 },
  "backend-coder":   { canSendTo: ["explorer", "reviewer", "planner", "devops"], canBroadcast: false, maxMessagesPerTask: 10 },
  "ux-designer":     { canSendTo: ["ui-designer", "frontend-coder", "planner"], canBroadcast: false, maxMessagesPerTask: 10 },
  "ui-designer":     { canSendTo: ["ux-designer", "frontend-coder", "planner"], canBroadcast: false, maxMessagesPerTask: 10 },
  "integration-tester": { canSendTo: ["coder", "reviewer", "tester"], canBroadcast: false, maxMessagesPerTask: 10 },
  "devops":          { canSendTo: ["planner", "backend-coder"], canBroadcast: false, maxMessagesPerTask: 10 },
  "market-researcher": { canSendTo: ["planner", "explorer"], canBroadcast: false, maxMessagesPerTask: 10 },
};

export class CommunicationDeniedError extends Error {
  constructor(
    readonly fromAgent: string,
    readonly toAgent: string,
    reason: string,
  ) {
    super(`Communication denied ${fromAgent} → ${toAgent}: ${reason}`);
    this.name = "CommunicationDeniedError";
  }
}

export function isSendAllowed(
  policy: CommunicationPolicy,
  fromAgent: string,
  toAgent: string,
): boolean {
  const rolePolicy = policy[fromAgent];
  if (!rolePolicy) return false;
  if (toAgent === "*") return rolePolicy.canBroadcast;
  return rolePolicy.canSendTo.includes("*") || rolePolicy.canSendTo.includes(toAgent);
}
