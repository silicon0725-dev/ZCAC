/**
 * ZCAC Phase 6 — Pipeline Mode 单元测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPlanPrompt,
  parsePlan,
  topologicalOrder,
} from "../src/application/pipeline.js";
import { createTestContext, waitFor } from "./helpers.js";

function planResponse(
  items: Array<{ seq: number; kind: string; text: string; depends?: number[] }>,
): string {
  const lines = items.map(
    (item) =>
      `${item.seq}. [${item.kind}] ${item.text}${item.depends?.length ? ` (depends: ${item.depends.join(", ")})` : ""}`,
  );
  return ["Sure, here is the plan:", "", "PLAN_BEGIN", ...lines, "PLAN_END"].join("\n");
}

describe("parsePlan", () => {
  it("parses kinds, descriptions and dependencies", () => {
    const plan = parsePlan(
      planResponse([
        { seq: 1, kind: "implement", text: "Create greet.js exporting greet(name)" },
        { seq: 2, kind: "implement", text: "Create auth.js", depends: [1] },
        { seq: 3, kind: "test", text: "Unit tests for greet and auth", depends: [1, 2] },
      ]),
    );
    assert.equal(plan?.length, 3);
    assert.deepEqual(plan?.[0], { seq: 1, kind: "implement", description: "Create greet.js exporting greet(name)", dependsOn: [] });
    assert.deepEqual(plan?.[2]?.dependsOn, [1, 2]);
  });

  it("returns undefined without markers or with dangling dependencies", () => {
    assert.equal(parsePlan("1. [implement] no markers"), undefined);
    assert.equal(parsePlan("PLAN_BEGIN\n1. [implement] a\n2. [test] b (depends: 9)\nPLAN_END"), undefined);
  });

  it("topological order handles out-of-order seqs and detects cycles", () => {
    const ordered = topologicalOrder([
      { seq: 2, kind: "test", description: "t", dependsOn: [1] },
      { seq: 1, kind: "implement", description: "i", dependsOn: [] },
    ]);
    assert.deepEqual(ordered?.map((item) => item.seq), [1, 2]);
    assert.equal(
      topologicalOrder([
        { seq: 1, kind: "implement", description: "a", dependsOn: [2] },
        { seq: 2, kind: "implement", description: "b", dependsOn: [1] },
      ]),
      undefined,
    );
  });

  it("buildPlanPrompt embeds the format contract", () => {
    const prompt = buildPlanPrompt("do the thing");
    assert.ok(prompt.includes("PLAN_BEGIN"));
    assert.ok(prompt.includes("do the thing"));
  });
});

describe("pipeline injection (event-driven)", () => {
  it("plan success injects the task chain with mapped dependencies + autoReview", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 2 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "plan",
      input: { prompt: "plan the greet module", role: "planner", metadata: { targetPrompt: "greet module" } },
    });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    // planner 的计划:两个 implement(1 并行,2 依赖 1)+ test(依赖 1,2)
    fake.complete(
      fake.agentIdOfLaunch(1),
      planResponse([
        { seq: 1, kind: "implement", text: "create greet.js" },
        { seq: 2, kind: "implement", text: "create auth.js", depends: [1] },
        { seq: 3, kind: "test", text: "test both", depends: [1, 2] },
      ]),
    );

    // 注入完成:plan + 3 计划任务 + autoReview = 5 个任务
    await waitFor(() => app.tasks.listByRun(run.id).length >= 5);
    const tasks = app.tasks.listByRun(run.id);
    assert.equal(tasks.filter((task) => task.kind === "plan").length, 1);
    const implements_ = tasks.filter((task) => task.kind === "implement");
    const test = tasks.find((task) => task.kind === "test");
    const review = tasks.find((task) => task.kind === "review");
    assert.equal(implements_.length, 2);
    assert.ok(test && review, "autoReview task injected");

    // 依赖映射:seq→taskId
    const bySeq = new Map(
      [...implements_, test!].map((task) => [
        task.input.metadata?.planSeq as number,
        task.id,
      ]),
    );
    assert.deepEqual(test!.dependencies.sort(), [bySeq.get(1), bySeq.get(2)].sort());
    assert.deepEqual(implements_.find((task) => task.input.metadata?.planSeq === 2)!.dependencies, [bySeq.get(1)]);
    // autoReview 依赖全部计划任务
    assert.equal(review!.dependencies.length, 3);
    // 注入任务带重试预算
    assert.equal(test!.retryPolicy.maxAttempts, 3);

    // 驱动完成:impl1 → impl2(依赖1) → test(依赖1,2) → review(autoReview)
    await waitFor(() => fake.launches.length >= 2); // plan + impl1
    fake.complete(fake.agentIdOfLaunch(2));
    await waitFor(() => fake.launches.length >= 3); // impl2
    fake.complete(fake.agentIdOfLaunch(3));
    await waitFor(() => fake.launches.length >= 4); // test
    fake.complete(fake.agentIdOfLaunch(4), "VERDICT_PASS");
    await waitFor(() => fake.launches.length >= 5); // review
    fake.complete(fake.agentIdOfLaunch(5), "REVIEW_VERDICT: PASS");
    await draining;

    assert.equal(app.runs.get(run.id)?.status, "completed");
    assert.equal(app.tasks.listByRun(run.id).filter((task) => task.status === "succeeded").length, 5);
  });

  it("unparseable plan fails the run with plan_unparseable", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "plan",
      input: { prompt: "plan it", role: "planner" },
    });
    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1), "I could not produce a plan.");
    // Supervisor(默认装配)先 re-plan 一次;第二次仍失败才 failRun
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(fake.agentIdOfLaunch(2), "Still no plan.");
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;
    const failEvent = app.journal.listByRun(run.id).find((e) => e.type === "RUN_FAILED");
    assert.equal((failEvent?.payload as { reason?: string }).reason, "plan_unparseable");
  });

  it("cyclic plan fails the run with plan_cyclic", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "plan",
      input: { prompt: "plan it", role: "planner" },
    });
    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    const cyclicPlan = () =>
      planResponse([
        { seq: 1, kind: "implement", text: "a", depends: [2] },
        { seq: 2, kind: "implement", text: "b", depends: [1] },
      ]);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1), cyclicPlan());
    await waitFor(() => fake.launches.length >= 2); // Supervisor re-plan
    fake.complete(fake.agentIdOfLaunch(2), cyclicPlan());
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;
    const failEvent = app.journal.listByRun(run.id).find((e) => e.type === "RUN_FAILED");
    assert.equal((failEvent?.payload as { reason?: string }).reason, "plan_cyclic");
  });
});
