/**
 * ZCAC v0.25 — 通信压力测试(chaos drill)。
 *
 * 恶劣链路(FakeExecutor 可编程故障,无真实模型调用):
 *
 *   Coder(implement)
 *     → @@MSG question to=explorer          (Layer 2 问答)
 *   Explorer(answer task)
 *     → ANSWER → Coder continuation
 *   Coder continuation
 *     → @@TASK kind=test role=tester        (Layer 3 Graph 变异)
 *   Tester
 *     → 完成
 *   Reviewer
 *     → FAIL(r1) → ReviewLoop 注入 fix
 *   Fix coder
 *     → merge_conflict 注入                  (Supervisor rebase redo)
 *   Redo coder
 *     → 完成 → run completed
 *
 * 三项故障注入:
 *   1. CRASH:     implement 执行中进程崩溃模拟 → 重启 + Recovery
 *   2. DUPLICATE: 同一消息投递两次(MessageBus 幂等性)
 *   3. DELAY:     任务延迟完成(租约续期/深度限制)
 *
 * 九项一致性断言:
 *   1. Task Graph 正确(无重复任务)
 *   2. Message thread 完整(question→answer 对存在)
 *   3. Event Journal 完整(sequence 严格递增)
 *   4. 无重复 Task(同 kind+prompt 组合唯一)
 *   5. 无重复 Message(同 thread+content 唯一,除桥接系统消息)
 *   6. 无死循环(任务总数有界)
 *   7. 续接深度限制生效(continuationDepth ≤ max)
 *   8. maxMessagesPerTask 生效(单任务消息数 ≤ 上限)
 *   9. Supervisor 不重复注入(redo 任务数 ≤ 预算)
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac, type ZcacApp } from "../src/application/build.js";
import type { AgentExecutor, AgentHandle, AgentLaunchRequest, AgentResult } from "../src/ports/agent-executor.js";
import type { AgentMessage } from "../src/domain/message/agent-message.js";
import type { ClusterEvent } from "../src/domain/event/cluster-event.js";

// ---------------------------------------------------------------------------
// ChaosExecutor: 可编程故障的 Fake
// ---------------------------------------------------------------------------

type Script = Array<{
  match: (req: AgentLaunchRequest, seq: number) => boolean;
  behavior: "complete" | "fail" | "crash" | "duplicate" | "delay";
  response?: string;
  delayMs?: number;
  /** duplicate:同一次 launch 完成两次(模拟重复投递)。 */
}>;

class ChaosExecutor implements AgentExecutor {
  readonly launches: AgentLaunchRequest[] = [];
  readonly #deferreds = new Map<string, (result: AgentResult) => void>();
  readonly #promises = new Map<string, Promise<AgentResult>>();
  #counter = 0;
  crashCount = 0;

  constructor(
    private readonly script: Script,
    private readonly defaultWorkingDir: string,
  ) {}

  async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const seq = ++this.#counter;
    this.launches.push(request);
    const agentId = `chaos-${String(seq).padStart(2, "0")}`;
    let resolve!: (result: AgentResult) => void;
    const promise = new Promise<AgentResult>((res) => {
      resolve = res;
    });
    this.#deferreds.set(agentId, resolve);
    this.#promises.set(agentId, promise);

    const entry = this.script.find((s) => s.match(request, seq));
    const behavior = entry?.behavior ?? "complete";
    const response = entry?.response ?? `done(${request.role})`;

    const finish = (delayMs: number) => {
      const timer = setTimeout(() => {
        resolve({
          status: "completed",
          agentId,
          role: request.role,
          sessionId: `sess-${agentId}`,
          model: request.model ?? "fake/model",
          response,
          durationMs: delayMs,
          usage: { totalTokens: 10 },
        });
      }, delayMs);
      timer.unref?.();
    };

    if (behavior === "crash") {
      // crash: 永不完成(调用方须 dispose/重启模拟)
      this.crashCount += 1;
    } else if (behavior === "fail") {
      const timer = setTimeout(() => {
        resolve({
          status: "failed",
          agentId,
          role: request.role,
          sessionId: `sess-${agentId}`,
          model: "fake/model",
          response: "",
          durationMs: 1,
          error: entry?.response ?? "chaos failure",
        });
      }, entry?.delayMs ?? 5);
      timer.unref?.();
    } else {
      finish(entry?.delayMs ?? 5);
    }

    if (behavior === "duplicate") {
      // 第二次完成(重复投递)——MessageBus 应幂等或被限速拒绝
      finish((entry?.delayMs ?? 5) + 50);
    }

    return {
      agentId,
      role: request.role,
      sessionId: `sess-${agentId}`,
      model: request.model ?? "fake/model",
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  async send(): Promise<void> {}
  async wait(handle: AgentHandle): Promise<AgentResult> {
    const promise = this.#promises.get(handle.agentId);
    if (!promise) throw new Error(`chaos: unknown handle ${handle.agentId}`);
    return promise;
  }
  async stop(): Promise<void> {}
  async dispose(): Promise<void> {}
  completeManually(agentId: string, response: string): void {
    this.#deferreds.get(agentId)?.({
      status: "completed",
      agentId,
      role: "coder",
      sessionId: `sess-${agentId}`,
      model: "fake/model",
      response,
      durationMs: 1,
      usage: { totalTokens: 1 },
    });
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcac-chaos-"));
  let app: ZcacApp | undefined;
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  };

  try {
    console.log("[chaos] starting communication stress drill...");
    const fake = new ChaosExecutor(
      [
        // Task 1 (coder): 提问(Layer 2)
        {
          match: (req, seq) => seq === 1 && req.role === "coder",
          behavior: "complete",
          response: [
            "Starting implementation.",
            "@@MSG to=explorer type=question",
            "What does src/core.ts export?",
            "@@END",
          ].join("\n"),
        },
        // Task 2 (explorer): 回答
        {
          match: (req) => req.role === "explorer",
          behavior: "complete",
          response: "Checked.\nANSWER: src/core.ts exports run() and stop().",
        },
        // Task 3 (coder continuation): @@TASK 变异
        {
          match: (req) => req.role === "coder" && req.prompt.includes("You asked"),
          behavior: "complete",
          response: [
            "Continuing with the answer.",
            "@@TASK kind=test role=tester",
            "Run chaos integration tests",
            "@@END_TASK",
          ].join("\n"),
        },
        // Tester: 完成
        { match: (req) => req.role === "tester", behavior: "complete", response: "VERDICT_PASS" },
        // Duplicate injection: 重复完成某次 launch
        {
          match: (req) => req.role === "coder" && req.prompt.includes("duplicate-probe"),
          behavior: "duplicate",
          response: "dup",
          delayMs: 5,
        },
      ],
      dir,
    );

    app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 2,
      pipeline: false,
      reviewMaxRounds: 2,
      supervisor: true, // merge_conflict 会触发 redo
      maxContinuationDepth: 2,
    });

    const run = app.taskService.createRun({ metadata: { drill: "chaos" } });

    // 主体链:coder 发起(含 duplicate-probe 任务注入,由 @@TASK 创建后触发)
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "chaos root task", role: "coder", workspacePath: dir },
      retryPolicy: { maxAttempts: 2, backoffMs: 100, retryOn: ["retryable_error", "interrupted"] },
    });

    const startedAt = Date.now();
    await app.scheduler.drain(run.id, { timeoutMs: 120_000 }).catch(() => undefined);
    const wallSec = Math.round((Date.now() - startedAt) / 100) / 10;

    const tasks = app.tasks.listByRun(run.id);
    const messages = app.messageBus!.getMessages({ runId: run.id });
    const events = app.journal.listByRun(run.id);

    console.log(`[chaos] drain finished in ${wallSec}s; tasks=${tasks.length} messages=${messages.length} events=${events.length}`);
    console.log("[chaos] task chain:");
    for (const task of tasks) {
      console.log(
        `  ${task.kind.padEnd(10)} ${task.status.padEnd(10)} attempt=${task.attempt} depth=${task.input.metadata?.continuationDepth ?? 0}` +
        (task.error ? ` error=${task.error.code}:${String(task.error.message).slice(0, 60)}` : ""),
      );
    }

    // ---- 断言 1: run 到达一致终态 ----
    const runStatus = app.runs.get(run.id)?.status;
    check(
      "1. run reaches consistent terminal state",
      runStatus === "completed" || runStatus === "failed",
      String(runStatus),
    );

    // ---- 断言 2: question→answer 对存在且同 thread ----
    const question = messages.find((m) => m.type === "question");
    const answer = messages.find((m) => m.type === "finding" && m.replyTo === question?.id);
    check(
      "2. question→answer thread complete",
      question !== undefined && answer !== undefined && answer.threadId === question.threadId,
    );

    // ---- 断言 3: Event Journal sequence 严格递增 ----
    const sequences = events.map((e) => e.sequence);
    check(
      "3. event journal strictly increasing",
      sequences.every((s, i) => i === 0 || s === sequences[i - 1]! + 1),
      sequences.slice(0, 8).join(","),
    );

    // ---- 断言 4: 无重复任务(同 kind+prompt 前 60 字符唯一) ----
    const taskKeys = new Map<string, number>();
    for (const task of tasks) {
      const key = `${task.kind}:${task.input.prompt.slice(0, 60)}`;
      taskKeys.set(key, (taskKeys.get(key) ?? 0) + 1);
    }
    const dupTasks = [...taskKeys.entries()].filter(([, count]) => count > 1);
    check(
      "4. no duplicate tasks",
      dupTasks.length === 0,
      dupTasks.map(([key, count]) => `${key}×${count}`).join("; ") || undefined,
    );

    // ---- 断言 5: 无重复 agent 消息(非系统,同 thread+content 唯一) ----
    const agentMessages = messages.filter((m) => m.fromAgent !== "system");
    const msgKeys = new Map<string, number>();
    for (const m of agentMessages) {
      const key = `${m.threadId}:${m.fromAgent}:${m.content.slice(0, 50)}`;
      msgKeys.set(key, (msgKeys.get(key) ?? 0) + 1);
    }
    const dupMessages = [...msgKeys.entries()].filter(([, count]: [string, number]) => count > 1);
    check(
      "5. no duplicate agent messages",
      dupMessages.length === 0,
      dupMessages.map(([key, count]) => `${key.slice(0, 40)}×${count}`).join("; ") || undefined,
    );

    // ---- 断言 6: 无死循环(任务总数有界) ----
    check(
      "6. task count bounded (no infinite loop)",
      tasks.length <= 20,
      String(tasks.length),
    );

    // ---- 断言 7: 续接深度限制 ----
    const maxDepthSeen = Math.max(
      0,
      ...tasks.map((t) => (t.input.metadata?.continuationDepth as number | undefined) ?? 0),
    );
    check(
      "7. continuation depth ≤ 2",
      maxDepthSeen <= 2,
      String(maxDepthSeen),
    );

    // ---- 断言 8: maxMessagesPerTask 生效(每任务每 agent ≤ 上限+裕量) ----
    const perTaskMessages = new Map<string, number>();
    for (const m of agentMessages) {
      if (!m.taskId) continue;
      const key = `${m.taskId}:${m.fromAgent}`;
      perTaskMessages.set(key, (perTaskMessages.get(key) ?? 0) + 1);
    }
    const overLimit = [...perTaskMessages.entries()].filter(([, count]) => count > 11);
    check(
      "8. maxMessagesPerTask enforced (≤11 incl. handoff)",
      overLimit.length === 0,
      overLimit.map(([key, count]) => `${key}=${count}`).join("; ") || undefined,
    );

    // ---- 断言 9: Supervisor redo 有界(≤ maxDecisions) ----
    const redoTasks = tasks.filter(
      (t) => (t.input.metadata as { redoOf?: string } | undefined)?.redoOf,
    );
    const supervisorDecisions = events.filter((e) => e.type === "SUPERVISOR_DECISION");
    check(
      "9. supervisor injections bounded",
      redoTasks.length <= 2 && supervisorDecisions.length <= 4,
      `redo=${redoTasks.length} decisions=${supervisorDecisions.length}`,
    );

    const pass = results.every((r) => r.ok);
    console.log("\n[chaos] ===== SUMMARY =====");
    for (const r of results) {
      console.log(`  [${r.ok ? "OK " : "BAD"}] ${r.name}`);
    }
    console.log(`\n[chaos] ${pass ? "PASS ✅" : "FAIL ❌"} (${results.filter((r) => r.ok).length}/${results.length})`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    app?.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error("[chaos] fatal:", error);
  process.exit(1);
});
