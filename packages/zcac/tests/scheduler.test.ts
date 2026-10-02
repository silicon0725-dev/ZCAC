/**
 * Scheduler 单元测试:依赖顺序、并行度、失败重试、失败传导、优先级。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestContext, waitFor, type TestContext } from "./helpers.js";

function drainSafely(promise: Promise<void>): Promise<void> {
  return promise.catch(() => undefined);
}

describe("scheduler (dependency-aware FIFO)", () => {
  it("executes a linear chain in dependency order", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const taskA = app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    const taskB = app.taskService.createTask({
      runId: run.id, kind: "b", input: { prompt: "B" }, dependencies: [taskA.id],
    });
    const taskC = app.taskService.createTask({
      runId: run.id, kind: "c", input: { prompt: "C" }, dependencies: [taskB.id],
    });

    const draining = drainSafely(app.scheduler.drain(run.id));
    await waitFor(() => fake.launches.length >= 1);
    assert.ok(fake.launches[0]?.prompt.includes("A"));
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 2);
    assert.ok(fake.launches[1]?.prompt.includes("B"));
    fake.complete(fake.agentIdOfLaunch(2));
    await waitFor(() => fake.launches.length >= 3);
    assert.ok(fake.launches[2]?.prompt.includes("C"));
    fake.complete(fake.agentIdOfLaunch(3));
    await draining;

    assert.equal(app.runs.get(run.id)?.status, "completed");
    assert.equal(app.tasks.get(taskC.id)?.status, "succeeded");
    const types = app.journal.listByRun(run.id).map((e) => e.type);
    assert.ok(types.includes("RUN_STARTED"));
    assert.ok(types.includes("RUN_COMPLETED"));
  });

  it("runs independent tasks in parallel up to maxConcurrentTasks", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 2 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    app.taskService.createTask({ runId: run.id, kind: "b", input: { prompt: "B" } });
    app.taskService.createTask({ runId: run.id, kind: "c", input: { prompt: "C" } });

    const draining = drainSafely(app.scheduler.drain(run.id));
    await waitFor(() => fake.launches.length >= 2);
    assert.equal(app.scheduler.inFlightCount, 2);
    assert.equal(fake.launches.length, 2); // 第 3 个因容量等待
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 3);
    fake.complete(fake.agentIdOfLaunch(2));
    fake.complete(fake.agentIdOfLaunch(3));
    await draining;
    assert.equal(app.runs.get(run.id)?.status, "completed");
  });

  it("retries a retryable failure then succeeds", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const task = app.taskService.createTask({
      runId: run.id,
      kind: "flaky",
      input: { prompt: "A" },
      retryPolicy: { maxAttempts: 2, backoffMs: 10, retryOn: ["retryable_error"] },
    });

    const draining = drainSafely(app.scheduler.drain(run.id));
    await waitFor(() => fake.launches.length >= 1);
    fake.fail(fake.agentIdOfLaunch(1), "transient");
    await waitFor(() => fake.launches.length >= 2); // retry re-claimed
    assert.equal(app.tasks.get(task.id)?.attempt, 2);
    fake.complete(fake.agentIdOfLaunch(2));
    await draining;

    const final = app.tasks.get(task.id);
    assert.equal(final?.status, "succeeded");
    assert.equal(final?.attempt, 2);
    const types = app.journal.listByRun(run.id).map((e) => e.type);
    assert.ok(types.includes("TASK_RETRY"));
    assert.equal(app.runs.get(run.id)?.status, "completed");
  });

  it("failed dependency blocks dependents and fails the run", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const taskA = app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    const taskB = app.taskService.createTask({
      runId: run.id, kind: "b", input: { prompt: "B" }, dependencies: [taskA.id],
    });

    const draining = drainSafely(app.scheduler.drain(run.id));
    await waitFor(() => fake.launches.length >= 1);
    fake.fail(fake.agentIdOfLaunch(1), "hard error");
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    assert.equal(app.tasks.get(taskA.id)?.status, "failed");
    assert.equal(app.tasks.get(taskB.id)?.status, "blocked");
    const types = app.journal.listByRun(run.id).map((e) => e.type);
    assert.ok(types.includes("TASK_BLOCKED"));
    assert.ok(types.includes("RUN_FAILED"));
  });

  it("claims are atomic: ready task is claimed exactly once", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app } = ctx;

    const run = app.taskService.createRun();
    const task = app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    app.graphService.refreshReadiness(run.id);

    const first = app.taskService.claimTask(task.id);
    const second = app.taskService.claimTask(task.id);
    assert.ok(first);
    assert.equal(second, undefined);
    assert.equal(first.attempt, 1);
  });

  it("higher priority is launched first within capacity", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "low", input: { prompt: "low" }, priority: 1 });
    app.taskService.createTask({ runId: run.id, kind: "high", input: { prompt: "high" }, priority: 9 });

    const draining = drainSafely(app.scheduler.drain(run.id));
    await waitFor(() => fake.launches.length >= 1);
    assert.ok(fake.launches[0]?.prompt.includes("high"));
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(fake.agentIdOfLaunch(2));
    await draining;
  });
});

export type { TestContext };
