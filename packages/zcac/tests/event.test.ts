/**
 * ZCAC-0005 — Event 单元测试:bus 订阅、journal sequence、journal-first 守卫。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClusterEventBus } from "../src/domain/event/event-bus.js";
import { SqliteDatabase } from "../src/adapters/sqlite/database.js";
import { SqliteEventJournal } from "../src/adapters/sqlite/event-journal.js";

describe("ClusterEventBus", () => {
  it("delivers events to subscribers until unsubscribed", () => {
    const bus = new ClusterEventBus();
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(event.type));
    bus.publish({ id: "e1", runId: "r", sequence: 1, type: "TASK_CREATED", timestamp: 0, payload: {} });
    off();
    bus.publish({ id: "e2", runId: "r", sequence: 2, type: "TASK_READY", timestamp: 0, payload: {} });
    assert.deepEqual(seen, ["TASK_CREATED"]);
  });

  it("isolates handler failures from the publisher", () => {
    const bus = new ClusterEventBus();
    bus.subscribe(() => {
      throw new Error("handler bug");
    });
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));
    bus.publish({ id: "e1", runId: "r", sequence: 1, type: "ERROR", timestamp: 0, payload: {} });
    assert.deepEqual(seen, ["ERROR"]);
  });
});

describe("SqliteEventJournal", () => {
  function setup(path = ":memory:") {
    const database = new SqliteDatabase(path);
    const journal = new SqliteEventJournal(database);
    database.db
      .prepare(
        "INSERT INTO zcac_runs (id, status, created_at, updated_at, event_sequence) VALUES ('r1', 'created', 0, 0, 0)",
      )
      .run();
    return { database, journal };
  }

  it("rejects append outside a transaction (journal-first guard)", () => {
    const { database, journal } = setup();
    assert.throws(() =>
      journal.append({ runId: "r1", type: "TASK_CREATED", timestamp: 1, payload: {} }),
    );
    database.close();
  });

  it("allocates strictly increasing per-run sequences and persists", () => {
    const { database, journal } = setup();
    const events = [1, 2, 3].map((n) =>
      database.run(() =>
        journal.append({
          runId: "r1",
          type: "TASK_CREATED",
          timestamp: n,
          taskId: `t${n}`,
          payload: { n },
        }),
      ),
    );
    assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3]);
    const stored = journal.listByRun("r1");
    assert.equal(stored.length, 3);
    assert.deepEqual(stored.map((e) => e.sequence), [1, 2, 3]);
    assert.deepEqual(journal.listByRun("r1", 1).map((e) => e.sequence), [2, 3]);
    const runRow = database.db
      .prepare("SELECT event_sequence FROM zcac_runs WHERE id = 'r1'")
      .get() as { event_sequence: number };
    assert.equal(runRow.event_sequence, 3);
    database.close();
  });

  it("rolls back event and sequence together on failure", () => {
    const { database, journal } = setup();
    database.run(() => journal.append({ runId: "r1", type: "RUN_CREATED", timestamp: 1, payload: {} }));
    assert.throws(() =>
      database.run(() => {
        journal.append({ runId: "r1", type: "TASK_CREATED", timestamp: 2, payload: {} });
        throw new Error("state mutation failed");
      }),
    );
    const stored = journal.listByRun("r1");
    assert.equal(stored.length, 1);
    const runRow = database.db
      .prepare("SELECT event_sequence FROM zcac_runs WHERE id = 'r1'")
      .get() as { event_sequence: number };
    assert.equal(runRow.event_sequence, 1);
    database.close();
  });
});
