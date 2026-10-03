/**
 * ZCAC-0013 — Message 仓储(SQLite)。
 */

import type {
  AgentMessage,
  AgentMessageType,
} from "../../domain/message/agent-message.js";
import type { MessageRepository } from "../../ports/message-repository.js";
import type { SqliteDatabase } from "./database.js";

interface MessageRow {
  id: string;
  run_id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  type: string;
  content: string;
  task_id: string | null;
  reply_to: string | null;
  created_at: number;
  metadata_json: string | null;
}

function rowToMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    runId: row.run_id,
    threadId: row.thread_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    type: row.type as AgentMessageType,
    content: row.content,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    createdAt: row.created_at,
    ...(row.metadata_json
      ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }
      : {}),
  };
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly database: SqliteDatabase) {}

  insert(message: AgentMessage): void {
    this.database.db
      .prepare(
        `INSERT INTO zcac_messages
           (id, run_id, thread_id, from_agent, to_agent, type, content,
            task_id, reply_to, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.runId,
        message.threadId,
        message.fromAgent,
        message.toAgent,
        message.type,
        message.content,
        message.taskId ?? null,
        message.replyTo ?? null,
        message.createdAt,
        message.metadata === undefined ? null : JSON.stringify(message.metadata),
      );
  }

  get(messageId: string): AgentMessage | undefined {
    const row = this.database.db
      .prepare("SELECT * FROM zcac_messages WHERE id = ?")
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  /** 仅 run_id 参数化查询;可选过滤在调用方内存执行。 */
  getByRun(runId: string): AgentMessage[] {
    const rows = this.database.db
      .prepare("SELECT * FROM zcac_messages WHERE run_id = ? ORDER BY created_at ASC, id ASC")
      .all(runId) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  getByThread(threadId: string): AgentMessage[] {
    const rows = this.database.db
      .prepare("SELECT * FROM zcac_messages WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  countByRunAndTask(runId: string, taskId: string): number {
    const row = this.database.db
      .prepare("SELECT COUNT(*) as count FROM zcac_messages WHERE run_id = ? AND task_id = ?")
      .get(runId, taskId) as unknown as { count: number };
    return row.count;
  }
}
