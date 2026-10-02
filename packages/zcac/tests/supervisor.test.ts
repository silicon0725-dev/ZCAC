/**
 * ZCAC Phase 8 — Supervisor 决策循环单测。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";
// Windows 上并发测试的 git worktree 操作较慢,放宽等待上限
const waitFor = (condition: () => boolean, timeoutMs = 20_000) => waitForDefault(condition, timeoutMs);

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

async function createGitRepo(): Promise<{ repoRoot: string; dbPath: () => string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "zcac-sup-"));
  const repoRoot = join(dir, "repo");
  await mkdir(repoRoot);
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "t@t"], repoRoot);
  await git(["config", "user.name", "t"], repoRoot);
  await writeFile(join(repoRoot, "same.txt"), "original\n", "utf8");
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", "init"], repoRoot);
  return {
    repoRoot,
    dbPath: () => join(dir, `zcac-${crypto.randomUUID().slice(0, 8)}.sqlite`),
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}

describe("supervisor: merge_conflict → rebase redo", () => {
  it("conflicting task triggers a redo task on the new baseline; run completes", async (t) => {
    const { repoRoot, dbPath, cleanup } = await createGitRepo();
    t.after(() => cleanup());

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: dbPath(),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      // 并行:两个 worktree 都基于 init → 后合并者真冲突。
      // (串行会让第二个 worktree 基于新 HEAD —— 冲突自然消解,Phase 7 路径 b)
      maxConcurrentTasks: 2,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: "overwrite same.txt first line with: resolved by A",
        role: "coder",
        workspacePath: repoRoot,
      },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: "overwrite same.txt first line with: resolved by B",
        role: "coder",
        workspacePath: repoRoot,
      },
    });

    const draining = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);
    // 串行:A 在自己的 worktree 写 X → merge;B 的 worktree 仍基于 init(旧基线)
    //   写 Y → merge 冲突 → failTask(merge_conflict) → Supervisor 注入 redo
    await waitFor(() => fake.launches.length >= 1);
    await writeFile(join(fake.launches[0]!.workingDirectory, "same.txt"), "resolved by A\n", "utf8");
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 2);
    await writeFile(join(fake.launches[1]!.workingDirectory, "same.txt"), "resolved by B\n", "utf8");
    fake.complete(fake.agentIdOfLaunch(2));

    // Supervisor 注入 redo(coder,在新基线上重做)
    await waitFor(() => fake.launches.length >= 3);
    const redoPrompt = fake.launches[2]!.prompt;
    assert.ok(redoPrompt.includes("Re-implement your change"), redoPrompt.slice(0, 80));
    assert.ok(redoPrompt.includes("resolved by B"), "redo 携带原任务意图");
    // redo 的 worktree 基于新 HEAD(含 A)→ 直接写终值可无冲突合并
    await writeFile(join(fake.launches[2]!.workingDirectory, "same.txt"), "resolved by B (redo)\n", "utf8");
    fake.complete(fake.agentIdOfLaunch(3));
    // run 诚实判 failed:冲突任务的终态失败不可变;但补救已在新基线产出正确终态。
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    // 决策被记录;补救产物落地(redo 在含 A 的新基线上写入终值)
    const decisions = app.journal
      .listByRun(run.id)
      .filter((e) => e.type === "SUPERVISOR_DECISION");
    assert.equal(decisions.length, 1);
    const payload = decisions[0]!.payload as { trigger: string; action: string };
    assert.equal(payload.trigger, "merge_conflict");
    assert.equal(payload.action, "rebase_redo");
    const tasks = app.tasks.listByRun(run.id);
    const conflicted = tasks.find((t) => t.error?.code === "merge_conflict");
    const redo = tasks.find((t) => t.input.metadata?.redoOf === conflicted?.id);
    assert.ok(conflicted && redo && redo.status === "succeeded");
    assert.equal((await readFile(join(repoRoot, "same.txt"), "utf8")).trim(), "resolved by B (redo)");
    app.close();
  });

  it("budget exhausted → no redo, run stays failed", async (t) => {
    const { repoRoot, dbPath, cleanup } = await createGitRepo();
    t.after(() => cleanup());

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: dbPath(),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      maxConcurrentTasks: 2,
      supervisorMaxDecisions: 0, // 决策预算 0 → 全部终态
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "write A", role: "coder", workspacePath: repoRoot },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "write B", role: "coder", workspacePath: repoRoot },
    });

    const draining = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);
    // 等 BOTH launch(worktree 均基于 init)再依次完成 —— 保证后合并者真冲突;
    // 若先 complete(1),B 的 worktree 创建会排在 A 的 merge 之后(新基线,不冲突)。
    await waitFor(() => fake.launches.length >= 2);
    await writeFile(join(fake.launches[0]!.workingDirectory, "same.txt"), "A\n", "utf8");
    await writeFile(join(fake.launches[1]!.workingDirectory, "same.txt"), "B\n", "utf8");
    fake.complete(fake.agentIdOfLaunch(1));
    fake.complete(fake.agentIdOfLaunch(2));
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    // 无 redo 注入;决策事件记录 terminal
    assert.equal(fake.launches.length, 2);
    const decisions = app.journal
      .listByRun(run.id)
      .filter((e) => e.type === "SUPERVISOR_DECISION");
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0]!.payload as { action: string }).action, "terminal");
    app.close();
  });
});

describe("supervisor: plan failure → re-plan", () => {
  it("first unparseable plan triggers re-plan; second failure (budget) fails the run", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-replan-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 1,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "plan",
      input: { prompt: "plan it", role: "planner", metadata: { targetPrompt: "build the thing" } },
    });

    const draining = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);
    // 第一次 plan:格式坏 → re-plan 注入
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1), "I cannot plan this.");
    await waitFor(() => fake.launches.length >= 2);
    const replanPrompt = fake.launches[1]!.prompt;
    assert.ok(replanPrompt.includes("rejected"), replanPrompt.slice(0, 60));
    // 第二次 plan:成功 → 注入任务链
    fake.complete(
      fake.agentIdOfLaunch(2),
      ["PLAN_BEGIN", "1. [implement] do the thing", "PLAN_END"].join("\n"),
    );
    await waitFor(() => fake.launches.length >= 3); // implement
    fake.complete(fake.agentIdOfLaunch(3));
    await waitFor(() => fake.launches.length >= 4); // autoReview
    fake.complete(fake.agentIdOfLaunch(4), "REVIEW_VERDICT: PASS");
    await waitFor(() => app.runs.get(run.id)?.status === "completed");
    await draining;

    const decisions = app.journal
      .listByRun(run.id)
      .filter((e) => e.type === "SUPERVISOR_DECISION")
      .map((e) => (e.payload as { action: string }).action);
    assert.deepEqual(decisions, ["replan"]);
    app.close();
  });

  it("second unparseable plan exhausts budget → run failed", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-replan2-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 1,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "plan",
      input: { prompt: "plan it", role: "planner", metadata: { targetPrompt: "build" } },
    });

    const draining = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1), "no plan");
    await waitFor(() => fake.launches.length >= 2); // re-plan 注入
    fake.complete(fake.agentIdOfLaunch(2), "still no plan");
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    const failEvent = app.journal.listByRun(run.id).find((e) => e.type === "RUN_FAILED");
    assert.equal((failEvent?.payload as { reason?: string }).reason, "plan_unparseable");
    const decisions = app.journal
      .listByRun(run.id)
      .filter((e) => e.type === "SUPERVISOR_DECISION")
      .map((e) => (e.payload as { action: string }).action);
    assert.deepEqual(decisions, ["replan", "terminal"]);
    app.close();
  });
});
