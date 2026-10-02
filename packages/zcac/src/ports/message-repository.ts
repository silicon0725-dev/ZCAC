/**
 * ZCAC-0013 — Message 仓储端口。
 */

import type { AgentMessage } from "../domain/message/agent-message.js";

export interface MessageRepository {
  insert(message: AgentMessage): void;
  get(messageId: string): AgentMessage | undefined;
  query(filter: {
    runId: string;
    toAgent?: string;
    fromAgent?: string;
    threadId?: string;
    taskId?: string;
  }): AgentMessage[];
  getByThread(threadId: string): AgentMessage[];
  countByRunAndTask(runId: string, taskId: string): number;
}
