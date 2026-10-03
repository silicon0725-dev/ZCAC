/**
 * ZCAC-0013 — Message 仓储端口。
 */

import type { AgentMessage } from "../domain/message/agent-message.js";

export interface MessageRepository {
  insert(message: AgentMessage): void;
  get(messageId: string): AgentMessage | undefined;
  /** 仅 runId 参数化检索;可选过滤由调用方在内存执行。 */
  getByRun(runId: string): AgentMessage[];
  getByThread(threadId: string): AgentMessage[];
  countByRunAndTask(runId: string, taskId: string): number;
}
