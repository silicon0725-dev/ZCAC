/**
 * ZCAC Phase 3 E2E(v0.1 Spec §51 场景,真实 GLM):
 *
 *   Coder(写 alpha.txt)
 *     → Reviewer r1(文件缺第二行 → 必然 FAIL + finding)
 *       → [ReviewLoop 动态注入] Fix(coder,补第二行)
 *         → Reviewer r2(文件含第二行 → PASS)
 *     → RUN_COMPLETED
 *
 * 这是 ZCAC 相对 dwf 的核心差异——运行时动态 DAG——的第一次真实闭环:
 * fix 与 re-review 两个任务在 run 启动时不存在,由 ReviewLoopService 在
 * r1 完成的事件驱动下创建并注入 Task Graph。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac } from "./application/build.js";
import { buildReviewPrompt } from "./application/review-loop.js";
import type { ClusterEvent } from "./domain/event/cluster-event.js";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";

const LINE1 = "alpha from zcac";
const LINE2 = "# reviewed-by-zcac";

const TARGET = [
  "Create a file named alpha.txt in the current working directory.",
  `Line 1 must be exactly: ${LINE1}`,
].join("\n");

const REVIEW_REQUIREMENT = [
  "Review rule: alpha.txt must contain exactly two lines:",
  `  line 1: ${LINE1}`,
  `  line 2: ${LINE2}`,
  "If the file is missing line 2 (or line 1 does not match), the verdict MUST be FAIL",
  "with a finding pointing at alpha.txt.",
  "If both lines are correct, the verdict MUST be PASS.",
].join("\n");

function parseModelOverride(): string | undefined {
  return (
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length)
  );
}

async function main(): Promise<void> {
  const sandbox = join(tmpdir(), `zcac-e2e3-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const model = parseModelOverride() ?? "bigmodel-api/GLM-5.3-Flash@low";

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: join(sandbox, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: sandbox,
    maxConcurrentTasks: 2,
    reviewMaxRounds: 3,
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
    console.log(`[e2e3] sandbox: ${sandbox}`);
    console.log(`[e2e3] model  : ${model}`);

    const run = app.taskService.createRun({ metadata: { phase: "3", model } });
    const coder = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: TARGET, role: "coder", model, workspacePath: sandbox },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [coder.id],
      input: {
        prompt: buildReviewPrompt(TARGET, REVIEW_REQUIREMENT),
        role: "reviewer",
        model,
        workspacePath: sandbox,
        metadata: { targetPrompt: TARGET },
      },
    });

    const startedAt = Date.now();
    await app.scheduler.drain(run.id, { timeoutMs: 900_000 });
    const wallMs = Date.now() - startedAt;

    const runAfter = app.runs.get(run.id);
    const tasks = app.tasks.listByRun(run.id);
    const reviews = tasks.filter((t) => t.kind === "review");
    const fixes = tasks.filter((t) => t.kind === "fix");
    const artifacts = app.artifacts.listByRun(run.id);

    console.log(`\n[e2e3] wall clock: ${(wallMs / 1000).toFixed(1)}s, tasks: ${tasks.length}`);
    console.log("[e2e3] assertions:");
    check("run.status == completed", runAfter?.status === "completed", runAfter?.status);

    // 动态 DAG:初始只有 2 个任务;FAIL 后注入 fix + re-review
    check("task count == 4 (dynamic injection)", tasks.length === 4, String(tasks.length));
    check("1 fix injected", fixes.length === 1);
    check("2 reviews total", reviews.length === 2);
    const fix = fixes[0];
    const r2 = reviews[1]!;
    check(
      "re-review depends on injected fix",
      fix !== undefined &&
        r2.dependencies.length === 1 &&
        r2.dependencies[0] === fix.id,
    );

    // review 结论链:r1 FAIL(任务本身 succeeded)→ r2 PASS
    const r1 = reviews[0]!;
    check("r1 task succeeded (execution) with FAIL verdict",
      r1.status === "succeeded" && (r1.output?.response ?? "").includes("REVIEW_VERDICT: FAIL"),
      r1.output?.response?.slice(-120));
    check("r2 verdict PASS",
      (r2.output?.response ?? "").includes("REVIEW_VERDICT: PASS"),
      r2.output?.response?.slice(-120));

    // 文件最终状态:两行
    const alpha = await readFile(join(sandbox, "alpha.txt"), "utf8").catch(() => undefined);
    check(
      "alpha.txt has both lines after fix",
      alpha !== undefined &&
        alpha.split("\n").filter((l) => l.length > 0)[0] === LINE1 &&
        alpha.includes(LINE2),
      JSON.stringify(alpha),
    );

    // 事件序:fix/re-review 的 TASK_CREATED 出现在 r1 TASK_SUCCEEDED 之后
    const seqOf = (predicate: (e: ClusterEvent) => boolean) =>
      events.find(predicate)?.sequence;
    const r1Succeeded = seqOf((e) => e.type === "TASK_SUCCEEDED" && e.taskId === r1.id);
    const fixCreated = fix !== undefined
      ? seqOf((e) => e.type === "TASK_CREATED" && e.taskId === fix.id)
      : undefined;
    check(
      "fix injected after r1 verdict",
      r1Succeeded !== undefined && fixCreated !== undefined && fixCreated > r1Succeeded,
      `r1=${r1Succeeded} fixCreated=${fixCreated}`,
    );

    // Artifacts:每任务一个;review 类型含原始 response
    check("artifacts per task (4)", artifacts.length === 4, String(artifacts.length));
    const reviewArtifacts = artifacts.filter((a) => a.type === "review");
    check("2 review artifacts", reviewArtifacts.length === 2);
    check(
      "artifact checksums intact",
      artifacts.every((a) => /^[0-9a-f]{64}$/.test(a.checksum)),
    );

    const totalTokens = tasks.reduce((sum, t) => sum + (t.output?.usage?.totalTokens ?? 0), 0);
    console.log(`[e2e3] total tokens: ${totalTokens}`);

    console.log(pass ? "\n[e2e3] PASS ✅" : "\n[e2e3] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } finally {
    await Promise.race([
      executor.dispose(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((error: unknown) => {
  console.error("[e2e3] fatal:", error);
  process.exitCode = 1;
});
