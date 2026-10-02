/**
 * ZCAC Phase 7 — pipeline × worktree 组合单测(确定性,Fake 不烧 token)。
 *
 * WritingFakeExecutor 在 launch 的 workingDirectory 里真实写文件,
 * 验证组合链路:plan(主区) → implement(worktree,成功即合并)
 * → test(主区,必须看到已合并成果) → review。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildZcac } from "../src/application/build.js";

import { FakeExecutor, waitFor } from "./helpers.js";
import type {
  AgentHandle,
  AgentLaunchRequest,
  AgentResult,
} from "../src/ports/agent-executor.js";

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

/** 按 prompt 内容在 workingDirectory 里真实写文件的 Fake(受控"coder")。 */
class WritingFakeExecutor extends FakeExecutor {
  override async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const handle = await super.launch(request);
    if (request.role === "coder") {
      // coder:在自己的工作目录(worktree)里写 greet.js
      await writeFile(
        join(request.workingDirectory, "greet.js"),
        "function greet(name){return `Hello, ${name}!`}\nmodule.exports={greet};\n",
        "utf8",
      );
    } else if (request.role === "tester") {
      // tester:在主区断言 greet.js 已可见(组合缺陷的验证点)
      const visible = await readFile(
        join(request.workingDirectory, "greet.js"),
        "utf8",
      ).then(
        (content) => content.includes("greet"),
        () => false,
      );
      if (!visible) {
        // 记录失败事实,tester 任务将如实"失败"
        this.complete(handle.agentId, "greet.js NOT visible in workspace");
        return handle;
      }
    }
    const timer = setTimeout(() => {
      this.complete(handle.agentId, `ok(${request.role}): ${request.prompt.slice(0, 40)}`);
    }, 30);
    timer.unref?.();
    return handle;
  }
}

describe("pipeline × worktree composition (deterministic)", () => {
  it("implement merges before test runs; test sees merged result in main", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p7-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const repoRoot = join(dir, "repo");
    await mkdir(repoRoot);
    await git(["init", "-b", "main"], repoRoot);
    await git(["config", "user.email", "t@t"], repoRoot);
    await git(["config", "user.name", "t"], repoRoot);
    await writeFile(join(repoRoot, "README.md"), "x\n", "utf8");
    await git(["add", "-A"], repoRoot);
    await git(["commit", "-m", "init"], repoRoot);

    const fake = new WritingFakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: repoRoot,
      isolation: "worktree",
      maxConcurrentTasks: 2,
    });

    // 直接构造 pipeline 注入后的等价任务链(implement → test);
    // 不放 plan 任务——PipelineService 会监听 kind=plan 并注入,
    // 此处验证的是 scheduler 层组合链路,注入逻辑由 pipeline.test 覆盖。
    const run = app.taskService.createRun();
    const implement = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "create greet.js", role: "coder", workspacePath: repoRoot },
    });
    const test = app.taskService.createTask({
      runId: run.id,
      kind: "test",
      dependencies: [implement.id],
      input: { prompt: "verify greet.js", role: "tester", workspacePath: repoRoot },
    });

    await app.scheduler.drain(run.id);

    assert.equal(app.runs.get(run.id)?.status, "completed",
      `tasks=${app.tasks.listByRun(run.id).map((x) => `${x.kind}:${x.status}`).join(",")}`);
    // implement:在 worktree 执行 + 成功即合并
    const wt = app.worktreeRepo.listByRun(run.id).find((w) => w.taskId === implement.id);
    assert.ok(wt && wt.status === "merged" && wt.commitSha, `worktree=${JSON.stringify(wt?.status)}`);
    // coder 确实在 worktree 目录工作(而非主区)
    const coderLaunch = fake.launches.find((l) => l.role === "coder");
    assert.ok(coderLaunch && coderLaunch.workingDirectory !== repoRoot);
    // 主分支包含提交;test(主区)看到成果
    const log = await git(["log", "--oneline"], repoRoot);
    assert.ok(log.includes("zcac(implement)"), log);
    assert.ok((await readFile(join(repoRoot, "greet.js"), "utf8")).includes("greet"));
    // tester 的 response 证明它看到了文件(否则它会报告 NOT visible)
    const testTask = app.tasks.get(test.id)!;
    assert.ok(!(testTask.output?.response ?? "").includes("NOT visible"));
    app.close();
  });
});
