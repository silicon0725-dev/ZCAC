/**
 * ZCAC Ports — Event Journal。
 *
 * append 必须在 TransactionRunner 事务内调用(与状态迁移同事务提交),
 * 以保证 journal-first:COMMIT 之前事件绝不可见,live emit 必须在 COMMIT 之后。
 */

import type { AppendEventInput, ClusterEvent } from "../domain/event/cluster-event.js";

export interface EventJournal {
  /** 分配 run 内单调 sequence 并插入;返回完整事件(含 sequence 与生成的 id)。 */
  append(input: AppendEventInput): ClusterEvent;

  listByRun(runId: string, afterSequence?: number): ClusterEvent[];

  nextSequence(runId: string): number;
}
