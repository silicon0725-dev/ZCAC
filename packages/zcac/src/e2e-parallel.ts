/**
 * ZCAC Phase 2 E2E(规范 §5,v0.1 Spec §50 场景):
 *
 *   Coder A(写 alpha.txt)──┐
 *                          ├──→ Tester(验证两个文件)──→ 完成
 *   Coder B(写 beta.txt)───┘
 *
 * 断言:双 Coder 真并行(时间区间重叠)、Tester 汇合于两者之后、
 * role quota 生效(coder=2 并行 / 单 tester)、文件内容正确、事件序列完整。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac } from "./application/build.js";
import type { ClusterEvent } from "./domain/event/cluster-event.js";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";
import type { Task } from "./domain/task/task.js";

const ALPHA = "alpha from zcac coder A";
const BETA = "beta from zcac coder B";

function parseModelOverride(): string | undefined {
  return (
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length)
  );
}

async function main(): Promise<void> {
  const sandbox = join(tmpdir(), `zcac-e2e2-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const dbPath = join(sandbox, "zcac.sqlite");
  const model = parseModelOverride() ?? "bigmodel-api/GLM-5.3-Flash@low";

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: dbPath,
    executor,
    defaultWorkingDirectory: sandbox,
    maxConcurrentTasks: 4,
    roleQuotas: { coder: 2, tester: 1 },
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
    console.log(`[e2e2] sandbox: ${sandbox}`);
    console.log(`[e2e2] model  : ${model}`);

    const run = app.taskService.createRun({ metadata: { phase: "2", model } });
    const coderA = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: [
          "Create a file named alpha.txt in the current working directory.",
          `It must contain exactly this single line: ${ALPHA}`,
          "Then read it back to verify.",
        ].join("\n"),
        role: "coder",
        model,
        workspacePath: sandbox,
      },
    });
    const coderB = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: [
          "Create a file named beta.txt in the current working directory.",
          `It must contain exactly this single line: ${BETA}`,
          "Then read it back to verify.",
        ].join("\n"),
        role: "coder",
        model,
        workspacePath: sandbox,
      },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "test",
      dependencies: [coderA.id, coderB.id],
      input: {
        prompt: [
          "Verify the test fixtures in the current working directory:",
          "1. alpha.txt exists and contains exactly the single line below,",
          `   ${ALPHA}`,
          "2. beta.txt exists and contains exactly the single line below,",
          `   ${BETA}`,
          "Use Read (and Grep if helpful) to check. Do not modify any files.",
          "End your reply with VERDICT_PASS if both checks pass, otherwise VERDICT_FAIL with the reason.",
        ].join("\n"),
        role: "tester",
        model,
        workspacePath: sandbox,
      },
    });

    const startedAt = Date.now();
    await app.scheduler.drain(run.id, { timeoutMs: 900_000 });
    const wallMs = Date.now() - startedAt;

    const runAfter = app.runs.get(run.id);
    const tasks = app.tasks.listByRun(run.id);
    const byRole = (role: string): Task[] => tasks.filter((t) => t.input.role === role);
    const coders = byRole("coder");
    const tester = byRole("tester")[0]!;

    console.log(`\n[e2e2] wall clock: ${(wallMs / 1000).toFixed(1)}s`);
    console.log("[e2e2] assertions:");
    check("run.status == completed", runAfter?.status === "completed", runAfter?.status);
    check("3 tasks all succeeded", tasks.every((t) => t.status === "succeeded"));
    check("tester verdict PASS", tester.output?.response?.includes("VERDICT_PASS") === true);

    // 双 Coder 并行:时间区间重叠
    const intervals = coders.map((t) => [t.startedAt ?? 0, t.completedAt ?? 0] as const);
    const overlap =
      intervals.length === 2 &&
      Math.max(intervals[0]![0], intervals[1]![0]) <
        Math.min(intervals[0]![1], intervals[1]![1]);
    check("two coders overlapped in time (真并行)", overlap, JSON.stringify(intervals));

    // Tester 汇合于两个 Coder 开始之后
    check(
      "tester started after both coders started",
      coders.every((c) => (tester.startedAt ?? 0) >= (c.startedAt ?? 0)),
    );

    // 文件内容
    const alpha = await readFile(join(sandbox, "alpha.txt"), "utf8").catch(() => undefined);
    const beta = await readFile(join(sandbox, "beta.txt"), "utf8").catch(() => undefined);
    check("alpha.txt content", alpha?.trim() === ALPHA, JSON.stringify(alpha));
    check("beta.txt content", beta?.trim() === BETA, JSON.stringify(beta));

    // 事件序:两个 TASK_STARTED(coder) 都在 tester TASK_STARTED 之前;sequence 严格递增
    const seqOf = (type: string, taskId?: string) =>
      events.find((e) => e.type === type && (!taskId || e.taskId === taskId))?.sequence;
    const testerStart = seqOf("TASK_STARTED", tester.id);
    const coderStarts = coders.map((c) => seqOf("TASK_STARTED", c.id));
    check(
      "event order: coder starts precede tester start",
      coderStarts.every((s) => s !== undefined && testerStart !== undefined && s < testerStart),
      `coderStarts=${coderStarts.join(",")} testerStart=${testerStart}`,
    );
    const sequences = events.map((e) => e.sequence);
    check(
      "sequence strictly increasing",
      sequences.every((s, i) => i === 0 || s === sequences[i - 1]! + 1),
    );
    // slot 记账:AGENT_ASSIGNED payload 带 slotId,两个 coder 用不同 slot
    const assigned = events.filter((e) => e.type === "AGENT_ASSIGNED");
    const slotIds = new Set(assigned.map((e) => (e.payload as { slotId?: string }).slotId));
    check("slot accounting (2 distinct coder slots)", slotIds.size >= 2, [...slotIds].join(","));

    // 总 token
    const totalTokens = tasks.reduce(
      (sum, t) => sum + (t.output?.usage?.totalTokens ?? 0),
      0,
    );
    console.log(`[e2e2] total tokens: ${totalTokens}`);

    console.log(pass ? "\n[e2e2] PASS ✅" : "\n[e2e2] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } finally {
    // dispose 可能因模型流/registry 关闭挂起:限时兜底,避免进程僵死。
    await Promise.race([
      executor.dispose(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((error: unknown) => {
  console.error("[e2e2] fatal:", error);
  process.exitCode = 1;
});
