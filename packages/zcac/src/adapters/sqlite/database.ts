/**
 * ZCAC-0009 — SQLite 基础设施(node:sqlite,与 ZCode 自身存储层同驱动)。
 *
 * 最小三表(规范 §20-§23):
 *   zcac_runs / zcac_tasks / zcac_events
 * tasks 表在规范 schema 上增加 retry_not_before 列(retry_wait 的入队时间)。
 */

import { DatabaseSync } from "node:sqlite";
import type { TransactionRunner } from "../../ports/clock.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS zcac_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    root_task_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    event_sequence INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS zcac_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    input_json TEXT NOT NULL,
    output_json TEXT,
    dependencies_json TEXT NOT NULL,
    assigned_agent_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    retry_policy_json TEXT NOT NULL,
    retry_not_before INTEGER,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    error_json TEXT,
    FOREIGN KEY(run_id) REFERENCES zcac_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_zcac_tasks_run_status
    ON zcac_tasks(run_id, status);

CREATE TABLE IF NOT EXISTS zcac_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    task_id TEXT,
    agent_id TEXT,
    timestamp INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(run_id, sequence),
    FOREIGN KEY(run_id) REFERENCES zcac_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_zcac_events_run_seq
    ON zcac_events(run_id, sequence);

CREATE TABLE IF NOT EXISTS zcac_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    agent_id TEXT,
    type TEXT NOT NULL,
    content_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES zcac_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_zcac_artifacts_run
    ON zcac_artifacts(run_id);

CREATE TABLE IF NOT EXISTS zcac_worktrees (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    commit_sha TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES zcac_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_zcac_worktrees_run
    ON zcac_worktrees(run_id);

CREATE TABLE IF NOT EXISTS zcac_messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    task_id TEXT,
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY(run_id) REFERENCES zcac_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_zcac_messages_run_thread
    ON zcac_messages(run_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_zcac_messages_run_task
    ON zcac_messages(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_zcac_messages_run_to
    ON zcac_messages(run_id, to_agent);
`;

export class SqliteDatabase implements TransactionRunner {
  readonly db: DatabaseSync;
  #inTransaction = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 轻量幂等迁移:老库补列(新库 CREATE TABLE 已含)。 */
  private migrate(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(zcac_tasks)")
      .all() as unknown as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("lease_until")) {
      this.db.exec("ALTER TABLE zcac_tasks ADD COLUMN lease_until INTEGER;");
    }
  }

  get inTransaction(): boolean {
    return this.#inTransaction;
  }

  /**
   * 嵌套调用复用外层事务;最外层 BEGIN IMMEDIATE。
   * journal-first 语义依赖本方法:fn 内的写入 + 事件 append 原子提交。
   */
  run<T>(fn: () => T): T {
    if (this.#inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE;");
    this.#inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      this.#inTransaction = false;
      return result;
    } catch (error) {
      this.#inTransaction = false;
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // 连接已坏时 ROLLBACK 可能失败,吞掉以保留原始错误。
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
