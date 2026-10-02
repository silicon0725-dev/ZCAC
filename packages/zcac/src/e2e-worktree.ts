/**
 * ZCAC Phase 4 E2E(v0.1 Spec §53 场景,真实 GLM):
 *
 * 幕一(隔离 + 合并):
 *   repo(temp git init)
 *   ├─ Coder A → worktree/zcac/<taskA> 写 alpha.txt ─┐
 *   └─ Coder B → worktree/zcac/<taskB> 写 beta.txt ──┤ 互不可见
 *   drain → 双双 commit → mergeRun → 主分支同时含两文件,无冲突
 *
 * 幕二(冲突检测):
 *   Coder X 与 Coder Y 分别在自己的 worktree 改 same.txt 第一行
 *   → 先合并者 merged;后合并者 MERGE_CONFLICT(conflictFiles=[same.txt]),
 *     主区 git status 保持干净(merge --abort),内容保持 X 的版本。
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildZcac } from "./application/build.js";
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

async function main(): Promise<void> {
  const model =
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length) ??
    "bigmodel-api/GLM-5.3-Flash@low";

  const sandbox = await mkdtemp(join(tmpdir(), "zcac-e2e4-"));
  const repoRoot = join(sandbox, "repo");
  await mkdir(repoRoot);
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "zcac@test.local"], repoRoot);
  await git(["config", "user.name", "zcac-e2e"], repoRoot);
  await writeFile(join(repoRoot, "same.txt"), "original line\n", "utf8");
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
    console.log(`[e2e4] repo: ${repoRoot}`);
    console.log(`[e2e4] model: ${model}`);

    // ---------------- 幕一:不同文件,隔离 + 合并 ----------------
    console.log("\n[e2e4] act 1: isolated writes + clean merge");
    const run1 = app.taskService.createRun({ metadata: { phase: "4a", model } });
    app.taskService.createTask({
      runId: run1.id,
      kind: "implement",
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
      input: {
        prompt: "Create a file named alpha.txt in the current working directory containing exactly one line: alpha from worktree A. Then read it back to verify.",
        role: "coder", model, workspacePath: repoRoot,
      },
    });
    app.taskService.createTask({
      runId: run1.id,
      kind: "implement",
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
      input: {
        prompt: "Create a file named beta.txt in the current working directory containing exactly one line: beta from worktree B. Then read it back to verify.",
        role: "coder", model, workspacePath: repoRoot,
      },
    });

    await app.scheduler.drain(run1.id, { timeoutMs: 900_000 });
    check("act1 run completed", app.runs.get(run1.id)?.status === "completed");

    // Phase 7 语义:implement 成功即 commit+merge。retry 留下 abandoned 记录,
    // 断言只看最终 merged 的 worktree。
    const allWorktrees1 = app.worktreeRepo.listByRun(run1.id);
    const worktrees1 = allWorktrees1.filter((wt) => wt.status === "merged");
    check(
      "act1 two merged worktrees (merge-on-success)",
      worktrees1.length === 2,
      `merged=${worktrees1.length}/total=${allWorktrees1.length}`,
    );
    check("act1 distinct worktree paths", worktrees1.length === 2 && worktrees1[0]!.path !== worktrees1[1]!.path);
    check("act1 commits have sha", worktrees1.every((wt) => wt.commitSha !== undefined));

    // mergeRun 兜底:任务级已合并,返回空
    const merges1 = await app.worktrees!.mergeRun(run1.id);
    check("act1 mergeRun fallback empty", merges1.length === 0);
    check(
      "act1 main has alpha+beta",
      (await readFile(join(repoRoot, "alpha.txt"), "utf8").catch(() => "")).trim() === "alpha from worktree A" &&
        (await readFile(join(repoRoot, "beta.txt"), "utf8").catch(() => "")).trim() === "beta from worktree B",
    );
    const status1 = await git(["status", "--porcelain"], repoRoot);
    check("act1 main tree clean", status1.trim().length === 0, JSON.stringify(status1));

    // ---------------- 幕二:同文件同行,冲突检测 ----------------
    console.log("\n[e2e4] act 2: same-file conflict detection");
    const run2 = app.taskService.createRun({ metadata: { phase: "4b", model } });
    app.taskService.createTask({
      runId: run2.id,
      kind: "implement",
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
      input: {
        prompt: "Overwrite the entire content of same.txt in the current working directory with exactly one line: resolved by X. Then read it back to verify.",
        role: "coder", model, workspacePath: repoRoot,
      },
    });
    app.taskService.createTask({
      runId: run2.id,
      kind: "implement",
      retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
      input: {
        prompt: "Overwrite the entire content of same.txt in the current working directory with exactly one line: resolved by Y. Then read it back to verify.",
        role: "coder", model, workspacePath: repoRoot,
      },
    });

    await app.scheduler.drain(run2.id, { timeoutMs: 900_000 });
    // 真实限流环境下 act2 有多条合法路径(任务级冲突语义由单测确定性覆盖):
    //  (a) 后合并者 merge_conflict → 任务失败 → run failed
    //  (b) retry 后 worktree 基于已含首个提交的 HEAD 重建 → 自然合并无冲突
    //  (c) 限流耗尽重试预算 → 普通 executor 失败 → run failed
    // E2E 断言系统不变量:任意路径下主区必须干净、run 到达一致终态。
    const tasks2 = app.tasks.listByRun(run2.id);
    const failedTask = tasks2.find((task) => task.status === "failed");
    const conflictHappened = failedTask?.error?.code === "merge_conflict";
    const run2Status = app.runs.get(run2.id)?.status;
    check(
      "act2 run reaches a consistent terminal state",
      run2Status === "completed" || run2Status === "failed",
      String(run2Status),
    );
    check(
      "act2 every failed task has an explicit error code",
      tasks2.filter((t) => t.status === "failed").every((t) => (t.error?.code ?? "").length > 0),
      JSON.stringify(tasks2.filter((t) => t.status === "failed").map((t) => t.error?.code)),
    );
    if (conflictHappened) {
      check("act2 conflict is non-retryable", failedTask!.error?.retryable === false);
    }
    if (run2Status === "completed") {
      check(
        "act2 same.txt reaches a resolved terminal state",
        (await readFile(join(repoRoot, "same.txt"), "utf8")).trim().startsWith("resolved by"),
      );
    }

    const status2 = await git(["status", "--porcelain"], repoRoot);
    check("act2 main tree clean (invariant)", status2.trim().length === 0, JSON.stringify(status2));

    const types = events.map((e) => e.type);
    // retry 会产生额外的 WORKTREE_CREATED/REMOVED 对;下限断言即可。
    check("events include WORKTREE_CREATED >=4", types.filter((x) => x === "WORKTREE_CREATED").length >= 4);
    check(
      "events include MERGE_COMPLETED >=3",
      types.filter((x) => x === "MERGE_COMPLETED").length >= 3,
      String(types.filter((x) => x === "MERGE_COMPLETED").length),
    );
    check("events include MERGE_CONFLICT <=1", types.filter((x) => x === "MERGE_CONFLICT").length <= 1);

    console.log(pass ? "\n[e2e4] PASS ✅" : "\n[e2e4] FAIL ❌");
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
  console.error("[e2e4] fatal:", error);
  process.exitCode = 1;
});
