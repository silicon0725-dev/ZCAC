/**
 * ZCAC-0008 — Git Worktree 隔离测试 + §52 崩溃恢复(run 级 resume)。
 * 全部使用真实 git 仓库(临时目录),FakeExecutor 驱动调度。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitWorktreeManager } from "../src/adapters/git/worktree-manager.js";
import { buildZcac } from "../src/application/build.js";
import { FakeClock } from "../src/ports/clock.js";
import { FakeExecutor, waitFor } from "./helpers.js";

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
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** 建一个带初始提交的临时 git 仓库。 */
async function createGitRepo(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "zcac-git-"));
  const repoRoot = join(dir, "repo");
  await mkdir(repoRoot);
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "zcac@test.local"], repoRoot);
  await git(["config", "user.name", "zcac-test"], repoRoot);
  await writeFile(join(repoRoot, "base.txt"), "base\n", "utf8");
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", "init"], repoRoot);
  return {
    repoRoot,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}

describe("GitWorktreeManager (real git)", () => {
  it("creates isolated worktrees; changes in one are invisible in the other", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const manager = new GitWorktreeManager({ repoRoot });

    const a = await manager.create({ taskId: "task_a" });
    const b = await manager.create({ taskId: "task_b" });
    assert.notEqual(a.path, b.path);

    await writeFile(join(a.path, "alpha.txt"), "from A", "utf8");
    assert.equal(await readFile(join(a.path, "alpha.txt"), "utf8"), "from A");
    // B 看不到 A 的未合并变更;主仓库同样看不到
    await assert.rejects(() => readFile(join(b.path, "alpha.txt"), "utf8"));
    await assert.rejects(() => readFile(join(repoRoot, "alpha.txt"), "utf8"));

    // commit A → merge → 主仓库可见
    const commit = await manager.commit(a.path, "add alpha");
    assert.equal(commit.empty, false);
    assert.ok(commit.sha);
    const result = await manager.mergeIntoTarget({ worktreeId: "wt-a", branch: a.branch });
    assert.equal(result.status, "merged");
    assert.equal(await readFile(join(repoRoot, "alpha.txt"), "utf8"), "from A");

    await manager.remove(a.path, a.branch);
    await manager.remove(b.path, b.branch);
  });

  it("merge conflict is detected, files reported, and main tree stays clean", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const manager = new GitWorktreeManager({ repoRoot });

    const a = await manager.create({ taskId: "task_x" });
    const b = await manager.create({ taskId: "task_y" });
    // A 和 B 都改 base.txt 同一行 → 冲突
    await writeFile(join(a.path, "base.txt"), "resolved by A\n", "utf8");
    await writeFile(join(b.path, "base.txt"), "resolved by B\n", "utf8");
    await manager.commit(a.path, "A change");
    await manager.commit(b.path, "B change");

    const first = await manager.mergeIntoTarget({ worktreeId: "wt-x", branch: a.branch });
    assert.equal(first.status, "merged");
    const second = await manager.mergeIntoTarget({ worktreeId: "wt-y", branch: b.branch });
    assert.equal(second.status, "conflict");
    assert.deepEqual(second.conflictFiles, ["base.txt"]);

    // 主区干净(abort 生效),内容仍是 A 的版本
    const status = await git(["status", "--porcelain"], repoRoot);
    assert.equal(status.trim().length, 0);
    // Windows autocrlf 会把检出内容转成 CRLF;比较语义而非字节。
    assert.equal((await readFile(join(repoRoot, "base.txt"), "utf8")).trim(), "resolved by A");

    await manager.remove(a.path, a.branch);
    await manager.remove(b.path, b.branch);
  });

  it("commit with no changes returns empty", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const manager = new GitWorktreeManager({ repoRoot });
    const a = await manager.create({ taskId: "task_z" });
    const commit = await manager.commit(a.path, "nothing");
    assert.equal(commit.empty, true);
    await manager.remove(a.path, a.branch);
  });
});

describe("scheduler + worktree isolation", () => {
  it("write tasks execute in worktrees and merge immediately on success (Phase 7)", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const dbDir = await mkdtemp(join(tmpdir(), "zcac-wt-"));
    t.after(() => rm(dbDir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dbDir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      maxConcurrentTasks: 2,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "A", role: "coder" } });
    app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "B", role: "coder" } });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 2);
    const dirA = fake.launches[0]!.workingDirectory;
    const dirB = fake.launches[1]!.workingDirectory;
    assert.notEqual(dirA, dirB);
    assert.notEqual(dirA, repoRoot);
    assert.notEqual(dirB, repoRoot);

    await writeFile(join(dirA, "alpha.txt"), "from A", "utf8");
    await writeFile(join(dirB, "beta.txt"), "from B", "utf8");
    fake.complete(fake.agentIdOfLaunch(1));
    fake.complete(fake.agentIdOfLaunch(2));
    await draining;

    assert.equal(app.runs.get(run.id)?.status, "completed");
    // 成功即合并:worktree 状态 merged,主区立即可见
    const worktrees = app.worktreeRepo.listByRun(run.id).filter((wt) => wt.status === "merged");
    assert.equal(worktrees.length, 2);
    assert.ok(worktrees.every((wt) => wt.commitSha !== undefined));
    assert.equal(await readFile(join(repoRoot, "alpha.txt"), "utf8"), "from A");
    assert.equal(await readFile(join(repoRoot, "beta.txt"), "utf8"), "from B");
    const types = app.journal.listByRun(run.id).map((e) => e.type);
    assert.equal(types.filter((x) => x === "WORKTREE_CREATED").length, 2);
    assert.equal(types.filter((x) => x === "MERGE_COMPLETED").length, 2);
    // mergeRun 兜底:已合并的分支不再处理(空结果)
    const merges = await app.worktrees!.mergeRun(run.id);
    assert.equal(merges.length, 0);
    app.close();
  });

  it("parallel same-file edits: later merge conflicts at task level (Phase 7)", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const dbDir = await mkdtemp(join(tmpdir(), "zcac-wt-"));
    t.after(() => rm(dbDir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dbDir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      maxConcurrentTasks: 2,
    });

    const run = app.taskService.createRun();
    const taskX = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "X", role: "coder" } });
    const taskY = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "Y", role: "coder" } });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 2);
    await writeFile(join(fake.launches[0]!.workingDirectory, "base.txt"), "resolved by X\n", "utf8");
    await writeFile(join(fake.launches[1]!.workingDirectory, "base.txt"), "resolved by Y\n", "utf8");
    fake.complete(fake.agentIdOfLaunch(1));
    fake.complete(fake.agentIdOfLaunch(2));
    // Supervisor(默认装配)注入 redo(coder);redo 的 worktree 基于新 HEAD,
    // 不写新内容 → commit empty → noop → succeeded。run 仍诚实判 failed
    // (原冲突任务终态失败不可变)。
    await waitFor(() => fake.launches.length >= 3);
    fake.complete(fake.agentIdOfLaunch(3), "redo checked, main already has my change");
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    const tasks = app.tasks.listByRun(run.id);
    const failed = tasks.find((task) => task.status === "failed");
    const succeeded = tasks.find((task) => task.status === "succeeded");
    assert.ok(failed && succeeded, `expect 1 succeeded + 1 failed, got ${tasks.map((t) => t.status).join(",")}`);
    assert.equal(failed!.error?.code, "merge_conflict");
    assert.equal(failed!.error?.retryable, false);
    // 主区干净,保留先合并版本;冲突分支状态 conflict(保留)
    const status = await git(["status", "--porcelain"], repoRoot);
    assert.equal(status.trim().length, 0);
    assert.equal((await readFile(join(repoRoot, "base.txt"), "utf8")).trim().startsWith("resolved by"), true);
    const conflictWt = app.worktreeRepo.listByRun(run.id).find((wt) => wt.status === "conflict");
    assert.ok(conflictWt, "conflicting worktree preserved");
    const types = app.journal.listByRun(run.id).map((e) => e.type);
    assert.equal(types.filter((x) => x === "MERGE_CONFLICT").length, 1);
    void taskX;
    void taskY;
    app.close();
  });

  it("failed task's worktree is abandoned and removed", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const dbDir = await mkdtemp(join(tmpdir(), "zcac-wt-"));
    t.after(() => rm(dbDir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dbDir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      maxConcurrentTasks: 1,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "A", role: "coder" } });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.fail(fake.agentIdOfLaunch(1));
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    const worktree = app.worktreeRepo.listByRun(run.id)[0]!;
    assert.equal(worktree.status, "abandoned");
    const types = app.journal.listByRun(run.id).map((e) => e.type);
    assert.ok(types.includes("WORKTREE_REMOVED"));
    app.close();
  });

  it("read-only roles (reviewer) do not get a worktree", async (t) => {
    const { repoRoot, cleanup } = await createGitRepo();
    t.after(() => cleanup());
    const dbDir = await mkdtemp(join(tmpdir(), "zcac-wt-"));
    t.after(() => rm(dbDir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dbDir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      maxConcurrentTasks: 1,
    });
    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "review", input: { prompt: "r", role: "reviewer" } });
    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    assert.equal(fake.launches[0]!.workingDirectory, repoRoot);
    fake.complete(fake.agentIdOfLaunch(1), "REVIEW_VERDICT: PASS");
    await draining;
    assert.equal(app.worktreeRepo.listByRun(run.id).length, 0);
    app.close();
  });
});

describe("crash recovery at run level (spec §52)", () => {
  it("resume re-runs only the interrupted task (A stays succeeded)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-resume-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const dbPath = join(dir, "zcac.sqlite");
    const clock = new FakeClock();

    const fake1 = new FakeExecutor();
    const app1 = await buildZcac({
      databasePath: dbPath,
      executor: fake1,
      defaultWorkingDirectory: dir,
      clock,
      leaseMs: 60_000,
      maxConcurrentTasks: 1,
    });
    const run = app1.taskService.createRun();
    const taskA = app1.taskService.createTask({ runId: run.id, kind: "a", input: { prompt: "A" } });
    app1.taskService.createTask({
      runId: run.id,
      kind: "b",
      input: { prompt: "B" },
      dependencies: [taskA.id],
      retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["interrupted"] },
    });

    const firstDrain = app1.scheduler
      .drain(run.id, { timeoutMs: 60_000 })
      .catch(() => undefined);
    await waitFor(() => fake1.launches.length >= 1);
    fake1.complete(fake1.agentIdOfLaunch(1)); // A 成功
    await waitFor(() => fake1.launches.length >= 2); // B running
    // 模拟崩溃:B 永不完成;不等 drain,直接关库(drain 遗弃,catch 已兜底)。
    app1.close();
    void firstDrain;

    clock.advance(120_000); // lease 过期

    const fake2 = new FakeExecutor();
    const app2 = await buildZcac({
      databasePath: dbPath,
      executor: fake2,
      defaultWorkingDirectory: dir,
      clock,
      leaseMs: 60_000,
      maxConcurrentTasks: 1,
    });
    app2.graphService.loadRun(run.id);
    const recovered = app2.recovery.recoverRun(run.id);
    assert.equal(app2.tasks.get(taskA.id)?.status, "succeeded"); // 完成任务不可变
    assert.deepEqual(recovered.requeued.length, 1);

    const drain2 = app2.scheduler
      .drain(run.id, { timeoutMs: 30_000 })
      .catch(() => undefined);
    await waitFor(() => fake2.launches.length >= 1);
    fake2.complete(fake2.agentIdOfLaunch(1));
    await drain2;
    assert.equal(app2.runs.get(run.id)?.status, "completed");
    // A 没有重跑:第二个 executor 只见过 B
    assert.deepEqual(fake2.launches.map((l) => l.prompt), ["B"]);
    assert.equal(app2.tasks.get(taskA.id)?.attempt, 1);
    app2.close();
  });
});
