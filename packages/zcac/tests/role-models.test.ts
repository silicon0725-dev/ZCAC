/**
 * ZCAC — roleModels 多模型协作单测。
 *
 * 验证 Scheduler 层的模型解析链:
 *   task.input.model(显式)> roleModels[role](角色分配)> executor 默认
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";

const waitFor = (condition: () => boolean, timeoutMs = 20_000) =>
  waitForDefault(condition, timeoutMs);

describe("roleModels (multi-model scheduling)", () => {
  it("assigns different models per role; explicit task model takes precedence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-mm-"));
    try {
      const fake = new FakeExecutor();
      const app = await buildZcac({
        databasePath: join(dir, "zcac.sqlite"),
        executor: fake,
        defaultWorkingDirectory: dir,
        maxConcurrentTasks: 1,
        pipeline: false,
        reviewMaxRounds: 0,
        supervisor: false,
        roleModels: {
          planner: "mimo/mimo-v2.6-pro@high",
          coder: "mimo/mimo-v2.6-flash",
          tester: "bigmodel-api/GLM-5.3-Flash@low",
          // reviewer 未配置 → 回退到 executor 默认(fake 时 model=request.model ?? "fake/model")
        },
      });

      const run = app.taskService.createRun();
      // planner(无显式 model → roleModels)
      app.taskService.createTask({
        runId: run.id,
        kind: "plan",
        input: { prompt: "plan", role: "planner" },
      });
      // coder(无显式 model → roleModels)
      app.taskService.createTask({
        runId: run.id,
        kind: "implement",
        input: { prompt: "code", role: "coder" },
        dependencies: [],
      });
      // coder(有显式 model → 覆盖 roleModels)
      app.taskService.createTask({
        runId: run.id,
        kind: "implement",
        input: { prompt: "override", role: "coder", model: "bigmodel-api/GLM-5.3@low" },
      });
      // tester(无显式 model → roleModels)
      app.taskService.createTask({
        runId: run.id,
        kind: "test",
        input: { prompt: "test", role: "tester" },
      });
      // reviewer(无 roleModels 配置 → executor 默认 = "fake/model")
      app.taskService.createTask({
        runId: run.id,
        kind: "review",
        input: { prompt: "review", role: "reviewer" },
      });

      const drain = app.scheduler.drain(run.id, { timeoutMs: 30_000 }).catch(() => undefined);
      // 逐个驱动完成(FakeExecutor 串行)
      for (let i = 1; i <= 5; i += 1) {
        await waitFor(() => fake.launches.length >= i);
        fake.complete(fake.agentIdOfLaunch(i));
      }
      await drain;

      // 断言模型分配(按 prompt 内容定位,不依赖执行顺序——同 ms 创建时 id 排序不定)
      const byPrompt = (prompt: string) => fake.launches.find((l) => l.prompt === prompt);
      assert.equal(byPrompt("plan")?.model, "mimo/mimo-v2.6-pro@high", "planner gets roleModels");
      assert.equal(byPrompt("code")?.model, "mimo/mimo-v2.6-flash", "coder gets roleModels");
      assert.equal(byPrompt("override")?.model, "bigmodel-api/GLM-5.3@low", "explicit model overrides roleModels");
      assert.equal(byPrompt("test")?.model, "bigmodel-api/GLM-5.3-Flash@low", "tester gets roleModels");
      assert.equal(byPrompt("review")?.model, undefined, "reviewer: no model in launch (falls to executor default)");
      app.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("pipeline-injected tasks inherit role models (no explicit model on injected tasks)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-mm2-"));
    try {
      const fake = new FakeExecutor();
      const app = await buildZcac({
        databasePath: join(dir, "zcac.sqlite"),
        executor: fake,
        defaultWorkingDirectory: dir,
        maxConcurrentTasks: 1,
        reviewMaxRounds: 0, // 禁用 review loop:避免 review 任务触发注入
        supervisor: false,  // 禁用 supervisor:避免 plan 失败触发 re-plan
        roleModels: {
          coder: "mimo/mimo-v2.6-flash",
        },
      });

      // 手动创建 plan 任务(模拟 pipeline 起点);注入的 implement/test 不带 model
      const run = app.taskService.createRun();
      app.taskService.createTask({
        runId: run.id,
        kind: "plan",
        input: { prompt: "plan the thing", role: "planner" },
      });

      const drain = app.scheduler.drain(run.id, { timeoutMs: 30_000 }).catch(() => undefined);
      await waitFor(() => fake.launches.length >= 1);
      // planner 完成 → PipelineService 注入 implement + test + review(均不带 model)
      fake.complete(
        fake.agentIdOfLaunch(1),
        ["PLAN_BEGIN", "1. [implement] do it", "PLAN_END"].join("\n"),
      );
      // implement 注入并 launch
      await waitFor(() => fake.launches.length >= 2);
      // 断言注入的 implement 使用了 roleModels.coder(而非 executor 默认)
      assert.equal(
        fake.launches[1]?.model,
        "mimo/mimo-v2.6-flash",
        "pipeline-injected coder gets roleModels",
      );
      fake.complete(fake.agentIdOfLaunch(2));
      // 驱动完剩余(test + review)
      let launchCount = 2;
      while (launchCount < 5) {
        await waitFor(() => fake.launches.length >= launchCount + 1, 10_000).then(
          () => {
            launchCount += 1;
            fake.complete(fake.agentIdOfLaunch(launchCount), launchCount === 5 ? "REVIEW_VERDICT: PASS" : "done");
          },
          () => {
            // 可能没有更多任务(autoReview 可能只加 1 个 review)
            launchCount = 5;
          },
        );
      }
      await drain;
      app.close();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
