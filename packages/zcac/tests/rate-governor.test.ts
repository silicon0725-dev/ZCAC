/**
 * ZCAC Phase 9 — 限流退避治理器单测。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ExponentialBackoffGovernor,
  isRateLimitSignal,
} from "../src/application/rate-governor.js";
import { FakeClock } from "../src/ports/clock.js";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";

const waitFor = (condition: () => boolean, timeoutMs = 20_000) =>
  waitForDefault(condition, timeoutMs);

describe("rate limit signal recognition", () => {
  it("matches all observed provider error shapes", () => {
    for (const message of [
      "[1302][您的账户已达到速率限制，请您控制请求频率][req-id]",
      "[1310][您已达到每周/每月使用上限，您的限额将在 2026-10-02 01:14:13 重置。][req]",
      "HTTP 429: too many requests",
      "rate_limit_error: requests per minute exceeded",
    ]) {
      assert.equal(isRateLimitSignal({ code: "agent_failed", message, retryable: true }), true, message);
    }
  });

  it("does not match ordinary failures", () => {
    for (const message of ["turn execution failed", "file not found", "boom 500"]) {
      assert.equal(isRateLimitSignal({ code: "agent_failed", message, retryable: false }), false, message);
    }
  });
});

describe("exponential backoff governor", () => {
  it("grows cooldown exponentially, caps at max, halves on success", () => {
    const clock = new FakeClock(1_000_000);
    const governor = new ExponentialBackoffGovernor({
      baseCooldownMs: 10_000,
      maxCooldownMs: 80_000,
      clock,
    });

    assert.equal(governor.noteTaskFailure({ code: "x", message: "429", retryable: true }), true);
    assert.equal(governor.cooldownUntil(), 1_010_000); // base 10s
    assert.equal(governor.canLaunch(clock.now()), false);
    assert.equal(governor.canLaunch(1_010_000), true);

    clock.advance(10_000);
    governor.noteTaskFailure({ code: "x", message: "429", retryable: true });
    assert.equal(governor.cooldownUntil(), clock.now() + 20_000); // ×2

    clock.advance(20_000);
    governor.noteTaskFailure({ code: "x", message: "429", retryable: true });
    assert.equal(governor.cooldownUntil(), clock.now() + 40_000); // ×4

    clock.advance(40_000);
    governor.noteTaskFailure({ code: "x", message: "429", retryable: true });
    assert.equal(governor.cooldownUntil(), clock.now() + 80_000); // 封顶

    clock.advance(10_000); // 剩余 70s
    governor.noteTaskSuccess();
    assert.equal(governor.cooldownUntil(), clock.now() + 35_000); // 减半
  });

  it("non-rate-limit failures do not trigger cooldown", () => {
    const clock = new FakeClock();
    const governor = new ExponentialBackoffGovernor({ clock });
    governor.noteTaskFailure({ code: "executor_error", message: "boom", retryable: false });
    assert.equal(governor.canLaunch(clock.now()), true);
  });
});

describe("scheduler integration (cooldown gates new claims)", () => {
  it("rate-limited failure pauses new launches until cooldown elapses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-gov-"));
    try {
    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 2,
      governorBaseCooldownMs: 3_000, // 短冷却便于测试
    });
    assert.ok(app.governor);

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "a",
      input: { prompt: "A" },
      retryPolicy: { maxAttempts: 3, backoffMs: 500, retryOn: ["retryable_error"] },
    });
    app.taskService.createTask({ runId: run.id, kind: "b", input: { prompt: "B" } });

    const draining = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 2);
    // A 限流失败 → 冷却启动;B 仍在飞(不受影响)
    fake.fail(fake.agentIdOfLaunch(1), "[1302][您账户已达到速率限制][x]");
    // B 完成(成功衰减冷却)
    fake.complete(fake.agentIdOfLaunch(2), "ok");
    // 冷却(3s)过后 A 重试被 claim → 驱动其第二次执行成功
    await waitFor(() => fake.launches.length >= 3);
    fake.complete(fake.agentIdOfLaunch(3), "recovered after backoff");
    await draining;

    // 两个任务终态:A retry_wait(可重试)→ 冷却过后重新 claim → 第二次成功
    const tasks = app.tasks.listByRun(run.id);
    assert.equal(
      app.runs.get(run.id)?.status,
      "completed",
      tasks.map((x) => `${x.kind}:${x.status}:${x.attempt}`).join(","),
    );
    const taskA = tasks[0]!;
    assert.equal(taskA.attempt, 2, "A 经过一次限流重试后成功");
    app.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
