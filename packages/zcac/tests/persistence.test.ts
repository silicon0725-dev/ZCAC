/**
 * ZCAC-0009 — Persistence 单元测试(规范 §32):重开后状态与 sequence 不变、续号。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac } from "../src/application/build.js";
import { FakeClock } from "../src/ports/clock.js";
import { FakeExecutor } from "./helpers.js";

async function tempDbPath(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "zcac-persist-"));
  return {
    path: join(dir, "zcac.sqlite"),
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}

describe("sqlite persistence", () => {
  it("preserves run/task/dependencies/events across reopen", async (t) => {
    const { path, cleanup } = await tempDbPath();
    t.after(() => cleanup());

    const first = await buildZcac({
      databasePath: path,
      executor: new FakeExecutor(),
      defaultWorkingDirectory: process.cwd(),
    });
    const run = first.taskService.createRun({ metadata: { env: "test" } });
    const taskA = first.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "A", role: "coder", model: "prov/model@low" },
      dependencies: [],
    });
    const taskB = first.taskService.createTask({
      runId: run.id,
      kind: "test",
      input: { prompt: "B" },
      dependencies: [taskA.id],
    });
    first.graphService.refreshReadiness(run.id); // A → ready + TASK_READY 事件
    first.close();

    const second = await buildZcac({
      databasePath: path,
      executor: new FakeExecutor(),
      defaultWorkingDirectory: process.cwd(),
    });
    const runAfter = second.runs.get(run.id);
    const taskAAfter = second.tasks.get(taskA.id);
    const taskBAfter = second.tasks.get(taskB.id);
    const events = second.journal.listByRun(run.id);

    assert.equal(runAfter?.status, "created");
    assert.equal(runAfter?.metadata?.env, "test");
    assert.equal(taskAAfter?.status, "ready");
    assert.equal(taskAAfter?.input.model, "prov/model@low");
    assert.equal(taskBAfter?.status, "blocked");
    assert.deepEqual(taskBAfter?.dependencies, [taskA.id]);
    assert.ok(events.length >= 3);
    assert.deepEqual(
      events.map((e) => e.sequence),
      events.map((e, i) => i + 1),
    );

    // 重开后继续写入:sequence 从 4 开始,而不是重新从 1
    second.taskService.emitRunEvent(run.id, "ERROR", { probe: true });
    const after = second.journal.listByRun(run.id);
    assert.equal(after.length, events.length + 1);
    assert.equal(after[after.length - 1]?.sequence, events.length + 1);
    second.close();
  });

  it("graph reload + recovery requeue after reopen (crash mid-run)", async (t) => {
    const { path, cleanup } = await tempDbPath();
    t.after(() => cleanup());
    const clock = new FakeClock();

    // 实例 1:claim 后"崩溃"(无结果写入)
    const first = await buildZcac({
      databasePath: path,
      executor: new FakeExecutor(),
      defaultWorkingDirectory: process.cwd(),
      clock,
      leaseMs: 60_000,
    });
    const run = first.taskService.createRun();
    const task = first.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "A" },
      retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["interrupted"] },
    });
    first.graphService.refreshReadiness(run.id);
    first.graphService.markRunStarted(run.id);
    const claimed = first.taskService.claimTask(task.id);
    assert.ok(claimed);
    assert.equal(claimed.attempt, 1);
    first.close(); // 模拟进程死亡:状态停留在 running

    // 实例 2:lease 尚未过期 → 保持 running(可能被其他进程持有)
    clock.advance(1_000);
    const second = await buildZcac({
      databasePath: path,
      executor: new FakeExecutor(),
      defaultWorkingDirectory: process.cwd(),
      clock,
      leaseMs: 60_000,
    });
    second.graphService.loadRun(run.id);
    assert.deepEqual(second.recovery.recoverRun(run.id).stillLeased, [task.id]);
    second.close();

    // 实例 3:lease 过期 → requeue
    clock.advance(120_000);
    const third = await buildZcac({
      databasePath: path,
      executor: new FakeExecutor(),
      defaultWorkingDirectory: process.cwd(),
      clock,
      leaseMs: 60_000,
    });
    third.graphService.loadRun(run.id);
    const result3 = third.recovery.recoverRun(run.id);
    assert.deepEqual(result3.requeued, [task.id]);
    assert.equal(third.tasks.get(task.id)?.status, "ready");

    // attempt 用尽时不重排队而判 failed
    third.taskService.claimTask(task.id); // attempt=2(最后一次)
    third.close();
    clock.advance(120_000);
    const fourth = await buildZcac({
      databasePath: path,
      executor: new FakeExecutor(),
      defaultWorkingDirectory: process.cwd(),
      clock,
      leaseMs: 60_000,
    });
    fourth.graphService.loadRun(run.id);
    const result4 = fourth.recovery.recoverRun(run.id);
    assert.deepEqual(result4.failed, [task.id]);
    assert.equal(fourth.tasks.get(task.id)?.status, "failed");
    fourth.close();
  });
});
