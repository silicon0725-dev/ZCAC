/**
 * ZCAC Phase 7 E2E(真实 GLM):pipeline × worktree 组合。
 *
 *   plan(planner,主区) → implement(coder,独立 worktree,成功即 commit+merge)
 *   → test(tester,主区 —— 必须能看到已合并的 greet.js,组合缺陷的验证点)
 *   → review(autoReview) → RUN_COMPLETED
 *
 * 断言核心:implement 的 worktree 状态 merged(任务级合并);主分支 git log
 * 含 implement 提交;test/review 在主区正常工作;run completed。
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildZcac } from "./application/build.js";
import { buildReviewPrompt } from "./application/review-loop.js";
import type { ClusterEvent } from "./domain/event/cluster-event.js";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";

function git(args: string[], cwd: string): Promise<string> {
  const execFileFixed = execFile as unknown as (
    file: string,
    args: string[],
    options: { cwd: string; windowsHide?: boolean; env: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string) => void,
  ) => void;
  return new Promise((resolve, reject) => {
    execFileFixed(
      "git",
      args,
      { cwd, windowsHide: true, env: { ...process.env, GIT_EDITOR: ":", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const TASK = [
  "Create a tiny Node.js module in the current working directory:",
  "- greet.js exporting `function greet(name)` that returns exactly `Hello, <name>!`",
  "- a test file using node:test that verifies greet('World') returns 'Hello, World!'",
  "Keep both files minimal.",
].join("\n");

async function main(): Promise<void> {
  const model =
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length) ??
    "bigmodel-api/GLM-5.3-Flash@low";

  const sandbox = await mkdtemp(join(tmpdir(), "zcac-e2e7-"));
  const repoRoot = join(sandbox, "repo");
  await mkdir(repoRoot);
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "zcac@test.local"], repoRoot);
  await git(["config", "user.name", "zcac-e2e"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "# e2e7\n", "utf8");
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", "init"], repoRoot);

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: join(sandbox, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: repoRoot,
    isolation: "worktree",
    maxConcurrentTasks: 2,
  });

  const events: ClusterEvent[] = [];
  app.bus.subscribe((event) => {
    events.push(event);
    console.log(`  [event #${event.sequence}] ${event.type}${event.taskId ? ` task=${event.taskId.slice(0, 13)}…` : ""}`);
  });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? "failed"}`}`);
    if (!ok) pass = false;
  };

  try {
    console.log(`[e2e7] repo: ${repoRoot}`);
    console.log(`[e2e7] model: ${model}`);

    // 与 pipeline 注入等价的任务链(implement → test → review)。
    // 不走真实 planner:注入逻辑已由 e2e6 验证,此处专注组合链路的真实 GLM 版。
    const run = app.taskService.createRun({ metadata: { phase: "7", mode: "pipeline+worktree" } });
    const implement = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: [
          "Work strictly inside the current working directory; use relative paths only.",
          "Create greet.js exporting `function greet(name)` that returns exactly `Hello, <name>!` (CommonJS module.exports).",
        ].join("\n"),
        role: "coder",
        model,
        workspacePath: repoRoot,
      },
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
    });
    const test = app.taskService.createTask({
      runId: run.id,
      kind: "test",
      dependencies: [implement.id],
      input: {
        prompt: [
          "In the current working directory, verify greet.js exists and exports a greet(name) function returning exactly `Hello, <name>!`.",
          "Use Read, and Bash with: node -e \"console.log(require('./greet.js').greet('World'))\" to check the output.",
          "Do not modify any files. End your reply with VERDICT_PASS or VERDICT_FAIL.",
        ].join("\n"),
        role: "tester",
        model,
        workspacePath: repoRoot,
      },
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [test.id],
      input: {
        prompt: buildReviewPrompt(TASK),
        role: "reviewer",
        model,
        workspacePath: repoRoot,
        metadata: { targetPrompt: TASK },
      },
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
    });

    const startedAt = Date.now();
    await app.scheduler.drain(run.id, { timeoutMs: 900_000 });
    const wallMs = Date.now() - startedAt;

    const runAfter = app.runs.get(run.id);
    const tasks = app.tasks.listByRun(run.id);
    const implementTask = tasks.find((t) => t.kind === "implement");
    const testTask = tasks.find((t) => t.kind === "test");
    const reviews = tasks.filter((t) => t.kind === "review");

    console.log(`\n[e2e7] wall: ${(wallMs / 1000).toFixed(1)}s, tasks: ${tasks.length}`);
    console.log("[e2e7] assertions:");
    check("run completed", runAfter?.status === "completed", runAfter?.status);
    check("all tasks succeeded", tasks.every((t) => t.status === "succeeded"),
      tasks.map((t) => `${t.kind}:${t.status}`).join(","));

    // 组合核心 1:implement 在独立 worktree 执行且成功即合并
    const implWorktrees = app.worktreeRepo
      .listByRun(run.id)
      .filter((wt) => wt.taskId === implementTask?.id && wt.status === "merged");
    check(
      "implement ran in worktree and merged on success",
      implWorktrees.length === 1 && implWorktrees[0]!.commitSha !== undefined,
      JSON.stringify(app.worktreeRepo.listByRun(run.id).map((wt) => [wt.taskId.slice(0, 9), wt.status])),
    );
    // 只有写入角色(implement/fix)建 worktree;test/review/plan 不建
    // (review FAIL 会注入 fix 任务,fix 也是 coder → 也应有 worktree)
    const writerIds = new Set(
      tasks.filter((t) => t.kind === "implement" || t.kind === "fix").map((t) => t.id),
    );
    const worktreeTaskIds = new Set(app.worktreeRepo.listByRun(run.id).map((wt) => wt.taskId));
    check(
      "only write-role tasks (implement/fix) got worktrees",
      writerIds.size > 0 &&
        worktreeTaskIds.size === writerIds.size &&
        [...worktreeTaskIds].every((id) => writerIds.has(id)),
      `writers=${writerIds.size} worktrees=${worktreeTaskIds.size}`,
    );

    // 组合核心 2:主分支真实包含 implement 提交
    const log = await git(["log", "--oneline"], repoRoot);
    check("main branch contains zcac implement commit", log.includes("zcac(implement)"), log.split("\n").slice(0, 3).join(" | "));

    // 组合核心 3:test 在主区看到已合并成果并真实执行
    const greet = await readFile(join(repoRoot, "greet.js"), "utf8").catch(() => undefined);
    check("greet.js merged into main workspace", greet !== undefined && greet.includes("greet"));
    check(
      "test task worked against merged main",
      testTask !== undefined && testTask.status === "succeeded" && (testTask.output?.response ?? "").length > 0,
    );

    check("final review PASS", reviews.length >= 1 &&
      (reviews[reviews.length - 1]!.output?.response ?? "").includes("REVIEW_VERDICT: PASS"));

    // 事件:implement 的 MERGE_COMPLETED 在 test TASK_STARTED 之前(下游可见性前提)
    if (implementTask && testTask) {
      const seqOf = (pred: (e: ClusterEvent) => boolean) => events.find(pred)?.sequence;
      const mergeDone = seqOf((e) => e.type === "MERGE_COMPLETED" && e.taskId === implementTask.id);
      const testStart = seqOf((e) => e.type === "TASK_STARTED" && e.taskId === testTask.id);
      check(
        "implement merged before test started",
        mergeDone !== undefined && testStart !== undefined && mergeDone < testStart,
        `merge=${mergeDone} testStart=${testStart}`,
      );
    }

    const totalTokens = tasks.reduce((sum, t) => sum + (t.output?.usage?.totalTokens ?? 0), 0);
    console.log(`[e2e7] total tokens: ${totalTokens}`);

    console.log(pass ? "\n[e2e7] PASS ✅" : "\n[e2e7] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } finally {
    app.close();
    await Promise.race([
      executor.dispose(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(dirname(repoRoot), `.zcac-worktrees-${basename(repoRoot)}`), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((error: unknown) => {
  console.error("[e2e7] fatal:", error);
  process.exitCode = 1;
});
