/**
 * ZCAC-0001 — Task model 单元测试:状态机、RetryPolicy、默认值。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldRetry } from "../src/domain/task/retry-policy.js";
import {
  assertTransition,
  canTransition,
  InvalidTaskTransitionError,
  isTerminalTaskStatus,
} from "../src/domain/task/task-status.js";
import { createTask } from "../src/domain/task/task.js";
import { createRun } from "../src/domain/run/run.js";

describe("task status machine", () => {
  it("allows the documented happy path", () => {
    assert.ok(canTransition("pending", "ready"));
    assert.ok(canTransition("ready", "running"));
    assert.ok(canTransition("running", "succeeded"));
    assert.ok(canTransition("running", "failed"));
    assert.ok(canTransition("failed", "retry_wait"));
    assert.ok(canTransition("retry_wait", "ready"));
    assert.ok(canTransition("running", "interrupted"));
    assert.ok(canTransition("interrupted", "ready"));
  });

  it("rejects illegal transitions", () => {
    assert.ok(!canTransition("succeeded", "running"));
    assert.ok(!canTransition("pending", "running"));
    assert.ok(!canTransition("cancelled", "ready"));
    assert.throws(
      () => assertTransition("t1", "succeeded", "running"),
      InvalidTaskTransitionError,
    );
  });

  it("marks terminal statuses", () => {
    assert.ok(isTerminalTaskStatus("succeeded"));
    assert.ok(isTerminalTaskStatus("failed"));
    assert.ok(isTerminalTaskStatus("cancelled"));
    assert.ok(!isTerminalTaskStatus("retry_wait"));
    assert.ok(!isTerminalTaskStatus("interrupted"));
  });
});

describe("retry policy", () => {
  it("retries while attempts remain and error is retryable", () => {
    assert.ok(shouldRetry(1, { maxAttempts: 2, backoffMs: 1 }, { retryable: true }));
    assert.ok(!shouldRetry(2, { maxAttempts: 2, backoffMs: 1 }, { retryable: true }));
    assert.ok(!shouldRetry(1, { maxAttempts: 3, backoffMs: 1 }, { retryable: false }));
  });

  it("honors retryOn conditions", () => {
    const policy = { maxAttempts: 3, backoffMs: 1, retryOn: ["interrupted"] as const };
    assert.ok(shouldRetry(1, policy, { retryable: true, condition: "interrupted" }));
    assert.ok(!shouldRetry(1, policy, { retryable: true, condition: "timeout" }));
  });
});

describe("task/run factories", () => {
  it("createTask assigns ids, defaults and pending status", () => {
    const task = createTask(
      { runId: "run_x", kind: "implement", input: { prompt: "p" } },
      1_000,
    );
    assert.ok(task.id.startsWith("task_"));
    assert.equal(task.status, "pending");
    assert.equal(task.attempt, 0);
    assert.equal(task.priority, 0);
    assert.deepEqual(task.dependencies, []);
    assert.equal(task.retryPolicy.maxAttempts, 1);
    assert.equal(task.createdAt, 1_000);
  });

  it("createRun defaults to created with zero sequence", () => {
    const run = createRun({}, 5_000);
    assert.ok(run.id.startsWith("run_"));
    assert.equal(run.status, "created");
    assert.equal(run.eventSequence, 0);
  });
});
