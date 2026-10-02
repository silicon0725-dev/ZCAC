/**
 * ZCAC-0003 — Agent Pool / lease 单元测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentCapabilityRegistry,
  UnknownRoleError,
  createDefaultCapabilityRegistry,
} from "../src/domain/agent/agent-pool.js";
import { AgentPool } from "../src/application/agent-pool.js";
import { FakeClock } from "../src/ports/clock.js";
import { createTestContext, waitFor } from "./helpers.js";

describe("AgentCapabilityRegistry", () => {
  it("registers defaults and rejects unknown roles at createTask time", async (t) => {
    const ctx = await createTestContext();
    t.after(() => ctx.cleanup());
    const run = ctx.app.taskService.createRun();
    assert.throws(
      () =>
        ctx.app.taskService.createTask({
          runId: run.id,
          kind: "custom",
          input: { prompt: "x", role: "does-not-exist" },
        }),
      UnknownRoleError,
    );
    // 合法角色可用
    const task = ctx.app.taskService.createTask({
      runId: run.id,
      kind: "custom",
      input: { prompt: "x", role: "reviewer" },
    });
    assert.equal(task.input.role, "reviewer");
  });

  it("default registry contains the five roles with quotas", () => {
    const registry = createDefaultCapabilityRegistry();
    assert.deepEqual(
      registry.list().map((def) => [def.role, def.defaultQuota]),
      [
        ["coder", 2],
        ["explorer", 2],
        ["planner", 1],
        ["tester", 1],
        ["reviewer", 1],
      ],
    );
  });
});

describe("AgentPool", () => {
  function makePool(quotas?: Record<string, number>, globalMax?: number) {
    const registry = createDefaultCapabilityRegistry();
    registry.register({ role: "solo", capabilities: [], defaultQuota: 1 });
    return {
      pool: new AgentPool({ registry, ...(quotas ? { quotas } : {}), ...(globalMax ? { globalMax } : {}) }),
      registry,
    };
  }

  it("enforces per-role quota and reuses idle slots", () => {
    const { pool } = makePool();
    const s1 = pool.acquire("coder", 1, "t1");
    const s2 = pool.acquire("coder", 2, "t2");
    assert.ok(s1 && s2);
    assert.equal(pool.acquire("coder", 3, "t3"), undefined); // quota=2 满
    assert.equal(pool.busyCount("coder"), 2);

    const released = pool.release(s1!.id, 10);
    assert.equal(released?.status, "idle");
    const s3 = pool.acquire("coder", 20, "t4");
    assert.ok(s3);
    assert.equal(s3!.id, s1!.id); // idle 复用
    assert.equal(s3!.totalTasks, 2);
  });

  it("global max caps across roles", () => {
    const { pool } = makePool(undefined, 2);
    assert.ok(pool.acquire("coder", 1, "t1"));
    assert.ok(pool.acquire("tester", 2, "t2"));
    assert.equal(pool.acquire("explorer", 3, "t3"), undefined); // 全局满
  });

  it("different roles have independent quotas", () => {
    const { pool } = makePool();
    assert.ok(pool.acquire("coder", 1, "t1"));
    assert.ok(pool.acquire("coder", 1, "t1b"));
    assert.ok(pool.acquire("tester", 2, "t2")); // coder 满不影响 tester
  });

  it("acquire of unknown role throws", () => {
    const { pool } = makePool();
    assert.throws(() => pool.acquire("ghost", 1, "t1"), UnknownRoleError);
  });
});

describe("lease / heartbeat / recovery (ZCAC-0004)", () => {
  it("claim writes leaseUntil; heartbeat extends it", async (t) => {
    const ctx = await createTestContext({ leaseMs: 1_000 });
    t.after(() => ctx.cleanup());
    const { app } = ctx;
    const run = app.taskService.createRun();
    const task = app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    app.graphService.refreshReadiness(run.id);
    const claimed = app.taskService.claimTask(task.id);
    assert.ok(claimed);
    assert.ok(claimed.leaseUntil !== undefined && claimed.leaseUntil > claimed.startedAt!);
    const before = claimed.leaseUntil;
    assert.ok(app.taskService.heartbeatTask(task.id));
    const after = app.tasks.get(task.id)?.leaseUntil;
    assert.ok(after !== undefined && after >= before);
  });

  it("recovery respects lease: unexpired stays running, expired is recovered", async (t) => {
    const ctx = await createTestContext({ leaseMs: 60_000 });
    t.after(() => ctx.cleanup());
    const { app } = ctx;
    const run = app.taskService.createRun();
    const taskA = app.taskService.createTask({
      runId: run.id,
      kind: "a",
      input: { prompt: "A" },
      retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["interrupted"] },
    });
    app.graphService.refreshReadiness(run.id);
    app.graphService.markRunStarted(run.id);
    app.taskService.claimTask(taskA.id); // lease = now + 60s

    // lease 未过期:恢复不动它
    const fresh = app.recovery.recoverRun(run.id);
    assert.deepEqual(fresh.stillLeased, [taskA.id]);
    assert.deepEqual(fresh.requeued, []);

    // 用 SQL 模拟时间流逝(lease 过期)
    app.database.db
      .prepare("UPDATE zcac_tasks SET lease_until = lease_until - 120_000 WHERE id = ?")
      .run(taskA.id);
    const expired = app.recovery.recoverRun(run.id);
    assert.deepEqual(expired.requeued, [taskA.id]);
    assert.equal(app.tasks.get(taskA.id)?.status, "ready");
  });

  it("parallelism is bounded by role quota even with higher global limit", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 4, roleQuotas: { coder: 1 } });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    app.taskService.createTask({ runId: run.id, kind: "b", input: { prompt: "B" } });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    // coder quota=1:第二个任务不能启动
    assert.equal(fake.launches.length, 1);
    assert.equal(app.scheduler.inFlightCount, 1);
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(fake.agentIdOfLaunch(2));
    await draining;
    assert.equal(app.runs.get(run.id)?.status, "completed");
  });

  it("two coders run concurrently with quota 2", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 4, roleQuotas: { coder: 2 } });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    app.taskService.createTask({ runId: run.id, kind: "b", input: { prompt: "B" } });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 2);
    assert.equal(app.scheduler.inFlightCount, 2);
    fake.complete(fake.agentIdOfLaunch(1));
    fake.complete(fake.agentIdOfLaunch(2));
    await draining;
    assert.equal(app.runs.get(run.id)?.status, "completed");
  });
});
