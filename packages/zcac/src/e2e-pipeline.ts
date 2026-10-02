/**
 * ZCAC Phase 6 E2E(真实 GLM,pipeline 模式):
 *
 *   cluster_create(mode=pipeline) "greet 模块 + 测试"
 *     → Planner(真实分解,期望 ≥2 任务)
 *     → [PipelineService 动态注入] implement×N → test → review(autoReview)
 *     → RUN_COMPLETED
 *
 * 断言:plan 任务 succeeded 且产出了 ≥2 条计划;注入任务按依赖执行
 * (test 在全部 implement 之后);run completed;greet.js 真实存在。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac } from "./application/build.js";
import type { ClusterEvent } from "./domain/event/cluster-event.js";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";
import { buildPlanPrompt } from "./application/pipeline.js";

const TASK = [
  "Create a tiny Node.js module in the current working directory:",
  "- greet.js exporting `function greet(name)` that returns exactly `Hello, <name>!`",
  "- greet.test.js with tests for greet using node:test",
  "Keep both files minimal.",
].join("\n");

async function main(): Promise<void> {
  const model =
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length) ??
    "bigmodel-api/GLM-5.3-Flash@low";

  const sandbox = join(tmpdir(), `zcac-e2e6-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: join(sandbox, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: sandbox,
    maxConcurrentTasks: 2,
  });

  const events: ClusterEvent[] = [];
  app.bus.subscribe((event) => {
    events.push(event);
    const tag = event.taskId ? ` task=${event.taskId.slice(0, 13)}…` : "";
    console.log(`  [event #${event.sequence}] ${event.type}${tag}`);
  });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? "failed"}`}`);
    if (!ok) pass = false;
  };

  try {
    console.log(`[e2e6] sandbox: ${sandbox}`);
    console.log(`[e2e6] model  : ${model}`);

    const run = app.taskService.createRun({ metadata: { phase: "6", mode: "pipeline" } });
    app.taskService.createTask({
      runId: run.id,
      kind: "plan",
      input: {
        prompt: buildPlanPrompt(TASK),
        role: "planner",
        model,
        workspacePath: sandbox,
        metadata: { targetPrompt: TASK },
      },
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
    });

    const startedAt = Date.now();
    await app.scheduler.drain(run.id, { timeoutMs: 900_000 });
    const wallMs = Date.now() - startedAt;

    const runAfter = app.runs.get(run.id);
    const tasks = app.tasks.listByRun(run.id);
    const plan = tasks.find((t) => t.kind === "plan");
    const implements_ = tasks.filter((t) => t.kind === "implement");
    const test = tasks.find((t) => t.kind === "test");
    const reviews = tasks.filter((t) => t.kind === "review");

    console.log(`\n[e2e6] wall: ${(wallMs / 1000).toFixed(1)}s, tasks: ${tasks.length}`);
    console.log("[e2e6] assertions:");
    check("run completed", runAfter?.status === "completed", runAfter?.status);
    check("plan succeeded", plan?.status === "succeeded");
    check("planner produced >=2 tasks", (implements_.length + (test ? 1 : 0)) >= 2,
      `implement=${implements_.length} test=${test ? 1 : 0}`);
    check("all tasks succeeded", tasks.every((t) => t.status === "succeeded"),
      tasks.map((t) => `${t.kind}:${t.status}`).join(","));

    // 依赖序:test 的 TASK_STARTED 晚于全部 implement 的 TASK_STARTED
    const seqOf = (pred: (e: ClusterEvent) => boolean) => events.find(pred)?.sequence;
    if (test && implements_.length > 0) {
      const testStart = seqOf((e) => e.type === "TASK_STARTED" && e.taskId === test.id);
      const implStarts = implements_.map(
        (impl) => seqOf((e) => e.type === "TASK_STARTED" && e.taskId === impl.id) ?? Infinity,
      );
      check(
        "test started after all implements",
        testStart !== undefined && implStarts.every((s) => s < testStart),
        `test=${testStart} impls=${implStarts.join(",")}`,
      );
      check(
        "test depends on at least one implement",
        test.dependencies.some((depId) => implements_.some((impl) => impl.id === depId)),
        `test deps=${test.dependencies.join(",")}`,
      );
    } else {
      check("test task exists with dependencies", false, "missing test task");
    }

    // autoReview 注入的终审存在且通过(或 ReviewLoop 循环后通过)
    check("final review exists and passed", reviews.length >= 1 &&
      (reviews[reviews.length - 1]!.output?.response ?? "").includes("REVIEW_VERDICT: PASS"));

    // 真实产物
    const greet = await readFile(join(sandbox, "greet.js"), "utf8").catch(() => undefined);
    check("greet.js exists", greet !== undefined);
    check("greet.js exports greet", greet?.includes("greet") ?? false);

    const totalTokens = tasks.reduce((sum, t) => sum + (t.output?.usage?.totalTokens ?? 0), 0);
    console.log(`[e2e6] total tokens: ${totalTokens}`);
    console.log(`[e2e6] plan:\n${(plan?.output?.response ?? "").split("PLAN_BEGIN")[1]?.split("PLAN_END")[0]?.trim() ?? "<none>"}`);

    console.log(pass ? "\n[e2e6] PASS ✅" : "\n[e2e6] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } finally {
    app.close();
    await Promise.race([
      executor.dispose(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((error: unknown) => {
  console.error("[e2e6] fatal:", error);
  process.exitCode = 1;
});
