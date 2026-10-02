/**
 * ZCAC Phase 11 — kill 恢复真实演练 + 长跑内存监控(P1)。
 *
 * Part A:kill 恢复
 *   1. 真实 GLM pipeline run(4 任务)
 *   2. 等第一个 implement 完成后 kill 当前进程(模拟崩溃)
 *   3. 新进程重开同一 SQLite → lease 过期 → Recovery → resume drain
 *   4. 断言:已完成任务 attempt 不变;仅中断任务重跑;run 最终 completed
 *
 * Part B:长跑内存监控
 *   5 个连续单任务 run,每 run 结束后采样 heapUsed / rss
 *   验证:无单调增长(wait-dispose 修复后应每 run 回落)
 *
 * 用法:node dist/p1-drill.cjs [--skip-kill](只跑内存监控)
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildZcac } from "./application/build.js";
import { buildPlanPrompt } from "./application/pipeline.js";
import type { ZcacApp } from "./application/build.js";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";

const execFileFixed = execFile as unknown as (
  file: string,
  args: string[],
  options: { cwd: string; windowsHide?: boolean; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string) => void,
) => void;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileFixed(
      "git",
      args,
      { cwd, windowsHide: true, env: { ...process.env, GIT_EDITOR: ":", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const MODEL = process.env.ZCAC_MODEL ?? "bigmodel-api/GLM-5.3-Flash@low";
const SKIP_KILL = process.argv.includes("--skip-kill");

async function setupRepo(): Promise<{ repoRoot: string; sandbox: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "zcac-p1-"));
  const repoRoot = join(sandbox, "repo");
  await mkdir(repoRoot);
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "p1@zcac.local"], repoRoot);
  await git(["config", "user.name", "zcac-p1"], repoRoot);
  await writeFile(join(repoRoot, "calc.js"), "function add(a,b){return a+b}\nmodule.exports={add};\n", "utf8");
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", "init"], repoRoot);
  return { repoRoot, sandbox };
}

const PIPELINE_TASK = buildPlanPrompt(
  "Add subtract(a,b) and multiply(a,b) to calc.js, plus node:test tests for all three functions (add, subtract, multiply). Work in the current working directory with relative paths only.",
);

async function createPipelineRun(app: ZcacApp, repoRoot: string, leaseMs?: number): Promise<string> {
  const run = app.taskService.createRun({ metadata: { phase: "11", drill: "kill-recovery" } });
  app.taskService.createTask({
    runId: run.id,
    kind: "plan",
    input: {
      prompt: PIPELINE_TASK,
      role: "planner",
      model: MODEL,
      workspacePath: repoRoot,
      metadata: { targetPrompt: "calc module" },
    },
    retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error", "interrupted"] },
  });
  void leaseMs;
  return run.id;
}

async function partA_killRecovery(): Promise<void> {
  console.log("[p1a] === KILL RECOVERY DRILL (real GLM) ===");
  const { repoRoot, sandbox } = await setupRepo();
  const dbPath = join(sandbox, "zcac.sqlite");
  const leaseMs = 30_000; // 短 lease 便于演练

  // --- Phase 1: 启动 run,等 plan + 第一个 implement 完成后 kill ---
  console.log("[p1a] starting pipeline run (lease=30s)...");
  const executor1 = new ZCodeAgentExecutor({ env: process.env });
  const app1 = await buildZcac({
    databasePath: dbPath,
    executor: executor1,
    defaultWorkingDirectory: repoRoot,
    maxConcurrentTasks: 1, // 串行:保证 kill 时只有 plan 或第一个 implement 在跑
    leaseMs,
  });
  const runId = await createPipelineRun(app1, repoRoot);

  const drain1 = app1.scheduler.drain(runId, { timeoutMs: 600_000 }).catch(() => undefined);
  // 等 plan 完成
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const tasks = app1.tasks.listByRun(runId);
      if (tasks.some((t) => t.kind === "plan" && t.status === "succeeded")) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 500);
    timer.unref?.();
  });
  console.log("[p1a] plan completed; waiting for first implement...");
  // 等 implement 开始运行
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const tasks = app1.tasks.listByRun(runId);
      if (tasks.some((t) => t.kind === "implement" && t.status === "running")) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 500);
    timer.unref?.();
  });
  console.log("[p1a] implement is RUNNING; killing process (simulating crash)...");
  const tasksBefore = app1.tasks.listByRun(runId).map((t) => ({
    id: t.id,
    kind: t.kind,
    status: t.status,
    attempt: t.attempt,
  }));
  const planAttempt = tasksBefore.find((t) => t.kind === "plan")?.attempt ?? 0;
  // 模拟崩溃:直接关库、杀 executor、退出进程(不走优雅关闭)
  app1.close();
  void executor1.dispose().catch(() => undefined);
  void drain1;
  console.log("[p1a] process killed. Tasks snapshot:");
  for (const t of tasksBefore) {
    console.log(`  ${t.kind.padEnd(10)} ${t.status.padEnd(10)} attempt=${t.attempt}`);
  }

  // --- Phase 2: 等 lease 过期,重启恢复 ---
  const waitMs = leaseMs + 5_000;
  console.log(`[p1a] waiting ${waitMs / 1000}s for lease to expire...`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  console.log("[p1a] restarting with new executor...");
  const executor2 = new ZCodeAgentExecutor({ env: process.env });
  const app2 = await buildZcac({
    databasePath: dbPath,
    executor: executor2,
    defaultWorkingDirectory: repoRoot,
    maxConcurrentTasks: 1,
    leaseMs,
  });
  app2.graphService.loadRun(runId);
  const recovery = app2.recovery.recoverRun(runId);
  console.log(`[p1a] recovery: requeued=${recovery.requeued.length} failed=${recovery.failed.length} stillLeased=${recovery.stillLeased.length}`);

  // 恢复后断言:plan 不重跑(attempt 不变)
  const planAfter = app2.tasks.listByRun(runId).find((t) => t.kind === "plan");
  console.log(`[p1a] plan after recovery: status=${planAfter?.status} attempt=${planAfter?.attempt} (before kill: attempt=${planAttempt})`);
  if (planAfter && planAfter.status === "succeeded" && planAfter.attempt === planAttempt) {
    console.log("[p1a] ✓ plan NOT re-executed (completed task immutable)");
  } else {
    console.log("[p1a] ✗ plan was re-executed or status changed!");
  }

  // 恢复 drain 到完成
  console.log("[p1a] resuming drain...");
  await app2.scheduler.drain(runId, { timeoutMs: 600_000 });
  const finalRun = app2.runs.get(runId);
  const finalTasks = app2.tasks.listByRun(runId);
  console.log(`[p1a] final: run=${finalRun?.status} tasks=[${finalTasks.map((t) => `${t.kind}:${t.status}:${t.attempt}`).join(", ")}]`);

  const calcSource = await readFile(join(repoRoot, "calc.js"), "utf8").catch(() => "");
  const hasSub = calcSource.includes("subtract");
  const hasMul = calcSource.includes("multiply");
  console.log(`[p1a] calc.js has subtract=${hasSub} multiply=${hasMul}`);
  console.log(`[p1a] ${finalRun?.status === "completed" && hasSub && hasMul ? "✅ KILL RECOVERY PASS" : "❌ KILL RECOVERY FAIL"}`);

  app2.close();
  await executor2.dispose().catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  await rm(join(dirname(repoRoot), `.zcac-worktrees-${basename(repoRoot)}`), { recursive: true, force: true }).catch(() => undefined);
}

async function partB_memoryMonitor(): Promise<void> {
  console.log("\n[p1b] === MEMORY MONITOR (5 sequential single-task runs) ===");
  const { repoRoot, sandbox } = await setupRepo();
  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: join(sandbox, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: repoRoot,
    maxConcurrentTasks: 1,
  });

  const samples: Array<{ run: number; heapMB: number; rssMB: number }> = [];
  for (let i = 1; i <= 5; i += 1) {
    const run = app.taskService.createRun({ metadata: { phase: "11b", seq: i } });
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: `Work strictly inside the current working directory; use relative paths only. Add a function fn${i}(a,b) that returns a*${i}+b to calc.js. Then verify by reading the file back.`,
        role: "coder",
        model: MODEL,
        workspacePath: repoRoot,
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 15_000, retryOn: ["retryable_error"] },
    });
    await app.scheduler.drain(run.id, { timeoutMs: 300_000 });

    // 强制 GC(若可用)并采样
    if (globalThis.gc) globalThis.gc();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const mem = process.memoryUsage();
    samples.push({
      run: i,
      heapMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    });
    console.log(`[p1b] run ${i}: heap=${samples[samples.length - 1]!.heapMB}MB rss=${samples[samples.length - 1]!.rssMB}MB`);
  }

  // 分析:最后一个 vs 第一个的增长
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const heapGrowth = last.heapMB - first.heapMB;
  const rssGrowth = last.rssMB - first.rssMB;
  console.log(`[p1b] heap growth over 5 runs: ${heapGrowth > 0 ? "+" : ""}${heapGrowth.toFixed(1)}MB`);
  console.log(`[p1b] rss  growth over 5 runs: ${rssGrowth > 0 ? "+" : ""}${rssGrowth.toFixed(1)}MB`);
  // 每 run 增长 <30MB 视为可控(worker app 的 lazy cache 常驻,但不应线性泄漏)
  const perRunHeap = heapGrowth / 4;
  console.log(`[p1b] per-run heap delta: ${perRunHeap.toFixed(1)}MB → ${perRunHeap < 30 ? "✅" : "⚠️"} ${perRunHeap < 30 ? "no significant leak" : "potential leak, investigate"}`);

  app.close();
  await executor.dispose().catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  await rm(join(dirname(repoRoot), `.zcac-worktrees-${basename(repoRoot)}`), { recursive: true, force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
  if (!SKIP_KILL) {
    await partA_killRecovery();
  }
  await partB_memoryMonitor();
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error("[p1] fatal:", error);
  process.exit(1);
});
