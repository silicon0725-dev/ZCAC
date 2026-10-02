/**
 * ZCAC Phase 10 — 真实仓库压力测试(P0-2)。
 *
 * 场地:临时 git 仓库中的 mini todo 模块(真实代码 + node:test 测试),
 * 预置一个真实 bug(listTodos 过滤逻辑反了)和一个因此失败的测试。
 *
 * 6 个任务(worktree 模式,真实合并):
 *   1. explorer 只读分析(无文件变更)
 *   2. coder 单文件改(README)
 *   3. pipeline:新增 clearAll() + 测试(planner 分解)
 *   4. coder 猎 bug:修复预置的过滤 bug(测试由红转绿的验证靠任务 5)
 *   5. tester:跑 node --test 验证全绿
 *   6. pipeline:新增 deleteById() + 测试
 *
 * 输出:逐任务结果 + 汇总(成功率/失败模式/token/墙钟)。
 */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildZcac } from "./application/build.js";
import { buildPlanPrompt } from "./application/pipeline.js";
import type { Run } from "./domain/run/run.js";
import type { Task } from "./domain/task/task.js";
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

const TODO_JS = `// Minimal in-memory todo module.
let nextId = 1;
const todos = [];

function addTodo(title) {
  const todo = { id: nextId++, title, done: false };
  todos.push(todo);
  return todo;
}

function listTodos(options = {}) {
  const includeDone = options.includeDone !== undefined ? options.includeDone : true;
  if (includeDone) {
    return [...todos];
  }
  // BUG(expected by tests): inverted filter — returns done instead of open todos.
  return todos.filter((t) => t.done);
}

function toggleTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) throw new Error("todo not found: " + id);
  todo.done = !todo.done;
  return todo;
}

module.exports = { addTodo, listTodos, toggleTodo };
`;

const TODO_TEST = `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { addTodo, listTodos, toggleTodo } = require("./todo.js");

test("add and list", () => {
  const t = addTodo("first");
  assert.equal(t.title, "first");
  assert.equal(listTodos().length, 1);
});

test("toggle", () => {
  const t = addTodo("second");
  toggleTodo(t.id);
  assert.equal(listTodos().find((x) => x.id === t.id).done, true);
});

test("listTodos without done items (currently failing)", () => {
  const open = addTodo("open item");
  addTodo("done item");
  toggleTodo(listTodos().find((x) => x.title === "done item").id);
  const filtered = listTodos({ includeDone: false });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, open.id);
});
`;

const README = `# todo-mini

A tiny in-memory todo module used as a ZCAC stress-test target.
`;

async function main(): Promise<void> {
  const model =
    process.env.ZCAC_MODEL ?? "bigmodel-api/GLM-5.3-Flash@low";
  const sandbox = await mkdtemp(join(tmpdir(), "zcac-stress-"));
  const repoRoot = join(sandbox, "repo");
  await mkdir(repoRoot);
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "stress@zcac.local"], repoRoot);
  await git(["config", "user.name", "zcac-stress"], repoRoot);
  await writeFile(join(repoRoot, "todo.js"), TODO_JS, "utf8");
  await writeFile(join(repoRoot, "todo.test.js"), TODO_TEST, "utf8");
  await writeFile(join(repoRoot, "README.md"), README, "utf8");
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", "init todo-mini"], repoRoot);

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: join(sandbox, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: repoRoot,
    isolation: "worktree",
    maxConcurrentTasks: 2,
  });

  interface StressCase {
    name: string;
    mode: "single" | "pipeline";
    kind: string;
    role: string;
    prompt: string;
    /** 结束后的附加验证(undefined=通过)。 */
    verify?: () => Promise<string | undefined>;
  }

  const cases: StressCase[] = [
    {
      name: "1-explorer-analyze",
      mode: "single",
      kind: "explore",
      role: "explorer",
      prompt:
        "Analyze todo.js in the current working directory. List each exported function with its signature and one-line behavior summary, plus any suspicious logic you notice. Read-only: do not modify any files. End with a line 'ANALYSIS_DONE'.",
    },
    {
      name: "2-readme-doc",
      mode: "single",
      kind: "implement",
      role: "coder",
      prompt:
        "Work strictly inside the current working directory; use relative paths only. Add a '## Usage' section to README.md showing how to require todo.js and call addTodo/listTodos, with a short node example. Keep it under 15 lines.",
      verify: async () => {
        const readme = await readFile(join(repoRoot, "README.md"), "utf8");
        return readme.includes("## Usage") ? undefined : "README missing Usage section";
      },
    },
    {
      name: "3-pipeline-clearall",
      mode: "pipeline",
      kind: "plan",
      role: "planner",
      prompt: buildPlanPrompt(
        "Add a clearAll() function to todo.js that removes all todos and returns nothing, plus a node:test test in todo.test.js that adds two todos, calls clearAll(), and asserts listTodos() is empty. Work in the current working directory with relative paths only.",
      ),
      verify: async () => {
        const source = await readFile(join(repoRoot, "todo.js"), "utf8");
        return source.includes("clearAll") ? undefined : "todo.js missing clearAll";
      },
    },
    {
      name: "4-bughunt-filter",
      mode: "single",
      kind: "implement",
      role: "coder",
      prompt:
        "Work strictly inside the current working directory; use relative paths only. The test 'listTodos without done items' in todo.test.js is failing: listTodos({ includeDone: false }) returns the wrong set. Read todo.js, find the bug, and fix it with the minimal change. Run the failing test with: node --test todo.test.js — iterate until that test passes (the others must keep passing).",
      verify: async () => {
        const source = await readFile(join(repoRoot, "todo.js"), "utf8");
        const fixed = source.includes("t.done") && source.includes("!t.done");
        return fixed ? undefined : "filter not fixed (!t.done missing)";
      },
    },
    {
      name: "5-tester-verify",
      mode: "single",
      kind: "test",
      role: "tester",
      prompt:
        "In the current working directory run: node --test todo.test.js — report the pass/fail summary with evidence. End your reply with VERDICT_PASS if all tests pass, otherwise VERDICT_FAIL.",
    },
    {
      name: "6-pipeline-delete",
      mode: "pipeline",
      kind: "plan",
      role: "planner",
      prompt: buildPlanPrompt(
        "Add deleteById(id) to todo.js that removes the todo with that id and returns true, or returns false if not found (no throw), plus a node:test test covering both cases. Work in the current working directory with relative paths only; run the full test suite afterwards to make sure everything still passes.",
      ),
      verify: async () => {
        const source = await readFile(join(repoRoot, "todo.js"), "utf8");
        return source.includes("deleteById") ? undefined : "todo.js missing deleteById";
      },
    },
  ];

  const results: Array<{
    name: string;
    runStatus: string;
    tasks: string;
    wallSec: number;
    tokens: number;
    verify?: string;
    failReason?: string;
  }> = [];

  try {
    console.log(`[stress] repo: ${repoRoot}`);
    console.log(`[stress] model: ${model}\n`);

    for (const testCase of cases) {
      console.log(`[stress] === ${testCase.name} (${testCase.mode}/${testCase.role}) ===`);
      const run = app.taskService.createRun({ metadata: { stress: testCase.name } });
      app.taskService.createTask({
        runId: run.id,
        kind: testCase.kind,
        input: {
          prompt: testCase.prompt,
          role: testCase.role,
          model,
          workspacePath: repoRoot,
          ...(testCase.mode === "pipeline"
            ? { metadata: { targetPrompt: testCase.prompt.replace(/^[\s\S]*?Task:\n/, "") } }
            : {}),
        },
        retryPolicy: { maxAttempts: 3, backoffMs: 20_000, retryOn: ["retryable_error"] },
      });

      const startedAt = Date.now();
      let failReason: string | undefined;
      try {
        await app.scheduler.drain(run.id, { timeoutMs: 900_000 });
      } catch (error) {
        failReason = error instanceof Error ? error.message : String(error);
      }
      const wallSec = Math.round((Date.now() - startedAt) / 100) / 10;

      const runAfter = app.runs.get(run.id)!;
      const tasks = app.tasks.listByRun(run.id);
      const tokens = tasks.reduce((sum, t) => sum + (t.output?.usage?.totalTokens ?? 0), 0);
      const taskSummary = tasks.map((t) => `${t.kind}:${t.status}`).join(" ");
      let verify: string | undefined;
      if (runAfter.status === "completed" && testCase.verify) {
        verify = await testCase.verify();
      }
      if (runAfter.status !== "completed" && !failReason) {
        const failedTask = tasks.find((t) => t.status === "failed");
        const runFailed = app.journal
          .listByRun(run.id)
          .find((e) => e.type === "RUN_FAILED");
        failReason =
          failedTask?.error?.code ??
          ((runFailed?.payload as { reason?: string })?.reason ?? "run failed");
      }
      results.push({
        name: testCase.name,
        runStatus: runAfter.status,
        tasks: taskSummary,
        wallSec,
        tokens,
        ...(verify ? { verify } : {}),
        ...(failReason ? { failReason } : {}),
      });
      console.log(
        `[stress] ${testCase.name}: ${runAfter.status} | ${taskSummary} | ${wallSec}s | ${tokens} tok` +
          (verify ? ` | VERIFY_FAIL: ${verify}` : "") +
          (failReason ? ` | reason: ${failReason}` : ""),
      );
    }

    // 汇总
    const ok = results.filter(
      (r) => r.runStatus === "completed" && !r.verify && !r.failReason,
    ).length;
    console.log("\n[stress] ===== SUMMARY =====");
    for (const r of results) {
      const flag = r.runStatus === "completed" && !r.verify && !r.failReason ? "OK " : "BAD";
      console.log(
        `[${flag}] ${r.name.padEnd(22)} ${r.runStatus.padEnd(9)} ${String(r.wallSec).padStart(6)}s ${String(r.tokens).padStart(7)} tok ${r.tasks}` +
          (r.verify ? ` verify=${r.verify}` : "") +
          (r.failReason ? ` reason=${r.failReason}` : ""),
      );
    }
    console.log(`\n[stress] success: ${ok}/${results.length}`);
    console.log("[stress] final test suite state:");
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const runTests = promisify(execFile);
      const result = await runTests("node", ["--test", "todo.test.js"], { cwd: repoRoot });
      const summary = (result.stdout as string)
        .toString()
        .split("\n")
        .filter((line) => /^# (pass|fail|tests)/.test(line))
        .join(" | ");
      console.log(`[stress] node --test: ${summary}`);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      console.log(
        "[stress] final test check failed:",
        typeof stderr === "string" ? stderr.split("\n").slice(0, 5).join(" ") : error,
      );
    }
    console.log(`[stress] repo kept at: ${repoRoot}`);
  } finally {
    // 保留仓库供检查,只关 app
    app.close();
    await Promise.race([
      executor.dispose(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
    process.exit(0);
  }
}

void main().catch((error: unknown) => {
  console.error("[stress] fatal:", error);
  process.exit(1);
});
