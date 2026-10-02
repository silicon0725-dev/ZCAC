/**
 * ZCAC-0007 — Review Loop(application)。
 *
 * 订阅 TASK_SUCCEEDED(review kind)→ 解析结构化结论:
 *   PASS                    → 不动作(run 聚合自然完成)
 *   FAIL 且 round < max     → 动态创建 Fix Task(coder)+ Re-review Task(依赖 fix)
 *                             ——运行时可变 DAG 的核心场景(v0.1 Spec §51)
 *   FAIL 且 round ≥ max     → run 判 failed(review_max_rounds)
 *   无法解析 verdict        → run 判 failed(review_unparseable)
 *
 * 结论格式由 buildReviewPrompt 统一约定:response 最后一行
 *   REVIEW_VERDICT: PASS | FAIL
 * 以及可选的 FINDINGS 列表。
 */

import type { Finding } from "../domain/task/task-input.js";
import type { Task } from "../domain/task/task.js";
import type { Clock } from "../ports/clock.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { ClusterEventBus } from "../domain/event/event-bus.js";
import type { TaskService } from "./task-service.js";

export interface ReviewResult {
  verdict: "PASS" | "FAIL";
  findings: Finding[];
}

export interface ReviewLoopDeps {
  bus: ClusterEventBus;
  tasks: TaskRepository;
  runs: RunRepository;
  taskService: TaskService;
  clock: Clock;
  /** 最大审查轮数(含首轮);默认 3。 */
  maxRounds?: number;
}

export class ReviewLoopService {
  readonly #maxRounds: number;
  #detach?: () => void;

  constructor(private readonly deps: ReviewLoopDeps) {
    this.#maxRounds = deps.maxRounds ?? 3;
  }

  /** 订阅 bus;返回退订函数。 */
  attach(): () => void {
    this.#detach ??= this.deps.bus.subscribe((event) => {
      if (event.type !== "TASK_SUCCEEDED" || !event.taskId) return;
      void this.#onTaskSucceeded(event.taskId);
    });
    return this.#detach;
  }

  async #onTaskSucceeded(taskId: string): Promise<void> {
    const task = this.deps.tasks.get(taskId);
    if (!task || task.kind !== "review") return;
    const review = parseReviewResult(task.output?.response ?? "");

    if (review === undefined) {
      this.#failRun(task.runId, "review_unparseable",
        `review task ${task.id} completed without a parseable REVIEW_VERDICT`);
      return;
    }
    if (review.verdict === "PASS") return;

    const round = reviewRoundOf(task);
    if (round >= this.#maxRounds) {
      this.#failRun(task.runId, "review_max_rounds",
        `review failed after ${round} rounds (maxRounds=${this.#maxRounds})`);
      return;
    }

    // 动态注入:Fix(coder) + Re-review(依赖 fix),round+1。
    // 注入任务必须自带重试预算:真实环境 reviewer 常被 429 限流打断,
    // 无重试预算会直接终态失败(maxAttempts=1 的默认值对此过于脆弱)。
    const target = targetPromptOf(task) ?? "the original task";
    const retryPolicy = { maxAttempts: 2, backoffMs: 15_000, retryOn: ["retryable_error"] as const };
    const fix = this.deps.taskService.createTask({
      runId: task.runId,
      kind: "fix",
      retryPolicy,
      input: {
        prompt: buildFixPrompt(target, review.findings),
        role: "coder",
        workspacePath: task.input.workspacePath,
        metadata: { reviewRound: round, fixesReviewOf: task.id },
      },
    });
    this.deps.taskService.createTask({
      runId: task.runId,
      kind: "review",
      dependencies: [fix.id],
      retryPolicy,
      input: {
        prompt: task.input.prompt, // 同样的审查要求
        role: "reviewer",
        workspacePath: task.input.workspacePath,
        metadata: {
          reviewRound: round + 1,
          targetPrompt: target,
        },
      },
    });
  }

  #failRun(runId: string, reason: string, message: string): void {
    const run = this.deps.runs.get(runId);
    if (!run || run.status === "completed" || run.status === "failed") return;
    this.deps.taskService.updateRunWithEvent(
      runId,
      { status: "failed" },
      "RUN_FAILED",
      { reason, message },
    );
  }
}

// ---------------------------------------------------------------------------
// 结构化提取(Phase 3 采用 response 约定格式;后续可替换为 submit 工具 + schema)
// ---------------------------------------------------------------------------

export function parseReviewResult(response: string): ReviewResult | undefined {
  const match = response.match(/^\s*REVIEW_VERDICT:\s*(PASS|FAIL)\s*$/im);
  if (!match) return undefined;
  const verdict = match[1] as "PASS" | "FAIL";
  const findings: Finding[] = [];
  // 每行独立匹配(不带 g 标志),避免 lastIndex 跨行串扰。
  // file 捕获组须含 "." 或 "/"(路径特征)且止于冒号/空白:裸词归入 message,
  // "alpha.txt:42" 拆成 file=alpha.txt + line=42。
  const findingLine =
    /^\s*[-*]\s*\[(low|medium|high)\]\s*(?:(\S*[./][^\s:]*)(?::(\d+))?\s*[-—:]?\s*)?(.+)$/i;
  for (const line of response.split("\n")) {
    const m = findingLine.exec(line.trim());
    if (!m) continue;
    findings.push({
      severity: m[1]!.toLowerCase() as Finding["severity"],
      ...(m[2] ? { file: m[2] } : {}),
      ...(m[3] ? { line: Number(m[3]) } : {}),
      message: m[4]!.trim(),
    });
  }
  return { verdict, findings };
}

export function reviewRoundOf(task: Task): number {
  const round = (task.input.metadata?.reviewRound as number | undefined) ?? 1;
  return typeof round === "number" ? round : 1;
}

function targetPromptOf(task: Task): string | undefined {
  const target = task.input.metadata?.targetPrompt;
  return typeof target === "string" ? target : undefined;
}

// ---------------------------------------------------------------------------
// Prompt 构造器(调用方与 ReviewLoop 共用同一约定)
// ---------------------------------------------------------------------------

export function buildReviewPrompt(target: string, extraRequirements?: string): string {
  return [
    "You are the ZCAC Reviewer for the current working directory.",
    `Review the workspace against this task intent:\n${target}`,
    ...(extraRequirements ? ["", `Additional review requirements:\n${extraRequirements}`] : []),
    "",
    "You are read-only. Check the actual files.",
    "List any problems as markdown bullets in exactly this format:",
    "- [high] path/to/file.ts:42 short description",
    "(severity is low | medium | high; file:line is optional when not applicable)",
    "",
    "End your reply with exactly one final line:",
    "REVIEW_VERDICT: PASS",
    "or",
    "REVIEW_VERDICT: FAIL",
  ].join("\n");
}

export function buildFixPrompt(target: string, findings: Finding[]): string {
  const lines = findings.map(
    (f) => `- [${f.severity}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""} ${f.message}`,
  );
  return [
    "The ZCAC Reviewer rejected the current workspace. Fix every finding below.",
    `Original task intent:\n${target}`,
    "",
    "Findings:",
    ...(lines.length > 0 ? lines : ["- [medium] review failed without detailed findings; re-check the workspace against the task intent"]),
    "",
    "Make the minimal changes that resolve all findings while keeping the task intent.",
  ].join("\n");
}
