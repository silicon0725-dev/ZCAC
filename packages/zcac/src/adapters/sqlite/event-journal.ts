/**
 * ZCAC-0005/0009 — Event Journal(SQLite)。
 *
 * append 必须在 TransactionRunner 事务内调用:
 * sequence 从 zcac_runs.event_sequence 读取+写回,与状态变更同事务提交,
 * 保证 journal-first(先 durable,后 live emit)。
 */

import type { ClusterEvent, AppendEventInput } from "../../domain/event/cluster-event.js";
import type { ClusterEventType } from "../../domain/event/event-types.js";
import type { EventJournal } from "../../ports/event-journal.js";
import type { SqliteDatabase } from "./database.js";

interface EventRow {
  id: string;
  run_id: string;
  sequence: number;
  type: string;
  task_id: string | null;
  agent_id: string | null;
  timestamp: number;
  payload_json: string;
}

function rowToEvent(row: EventRow): ClusterEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type as ClusterEventType,
    timestamp: row.timestamp,
    taskId: row.task_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    payload: JSON.parse(row.payload_json) as unknown,
  };
}

export class SqliteEventJournal implements EventJournal {
  constructor(private readonly database: SqliteDatabase) {}

  append(input: AppendEventInput): ClusterEvent {
    if (!this.database.inTransaction) {
      throw new Error(
        "EventJournal.append must be called inside a transaction (journal-first)",
      );
    }
    const sequence = this.nextSequence(input.runId);
    const id = `event_${crypto.randomUUID()}`;
    this.database.db
      .prepare(
        `INSERT INTO zcac_events
           (id, run_id, sequence, type, task_id, agent_id, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        sequence,
        input.type,
        input.taskId ?? null,
        input.agentId ?? null,
        input.timestamp,
        JSON.stringify(input.payload ?? {}),
      );
    this.database.db
      .prepare("UPDATE zcac_runs SET event_sequence = ? WHERE id = ?")
      .run(sequence, input.runId);
    return {
      id,
      runId: input.runId,
      sequence,
      type: input.type,
      timestamp: input.timestamp,
      taskId: input.taskId,
      agentId: input.agentId,
      payload: input.payload ?? {},
    };
  }

  nextSequence(runId: string): number {
    const run = this.database.db
      .prepare("SELECT event_sequence FROM zcac_runs WHERE id = ?")
      .get(runId) as { event_sequence: number } | undefined;
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run.event_sequence + 1;
  }

  listByRun(runId: string, afterSequence?: number): ClusterEvent[] {
    const rows =
      afterSequence === undefined
        ? (this.database.db
            .prepare("SELECT * FROM zcac_events WHERE run_id = ? ORDER BY sequence ASC")
            .all(runId) as unknown as EventRow[])
        : (this.database.db
            .prepare(
              "SELECT * FROM zcac_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC",
            )
            .all(runId, afterSequence) as unknown as EventRow[]);
    return rows.map(rowToEvent);
  }
}
