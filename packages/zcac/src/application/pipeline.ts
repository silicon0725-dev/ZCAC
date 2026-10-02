/**
 * ZCAC Phase 6 — Pipeline Mode(application)。
 *
 * 订阅 TASK_SUCCEEDED(kind=plan):解析 planner 的结构化计划,
 * 动态注入任务链(implement×N 并行 + test/review 汇合)。
 * 这是 v0.1 设计文档 §24/§36 完整流水线愿景的落地:
 *
 *   Planner → [事件驱动注入] → Coder×N → Tester → Reviewer(ReviewLoop 兜底)
 *
 * 计划格式由 buildPlanPrompt 统一约定(解析/构造分离,后续可换 submit 工具)。
 */

import type { Task } from "../domain/task/task.js";
import type { Clock } from "../ports/clock.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { ClusterEventBus } from "../domain/event/event-bus.js";
import type { TaskService } from "./task-service.js";
import { buildReviewPrompt } from "./review-loop.js";

export type PlanItemKind = "implement" | "test" | "review";

export interface PlanItem {
  seq: number;
  kind: PlanItemKind;
  description: string;
  dependsOn: number[];
}

export interface PipelineDeps {
  bus: ClusterEventBus;
  tasks: TaskRepository;
  runs: RunRepository;
  taskService: TaskService;
  clock: Clock;
  /** 计划中无 review 时是否追加终审(默认 true)。 */
  autoReview?: boolean;
  /** Supervisor:plan 失败先问决策(re-plan);缺省则直接 failRun。 */
  supervisor?: { onPlanFailure(planTask: Task, reason: string): { action: string } };
}

/** 注入任务的统一重试预算(Phase 3 教训:动态任务必须有重试预算)。 */
export const PIPELINE_RETRY_POLICY = {
  maxAttempts: 3,
  backoffMs: 20_000,
  retryOn: ["retryable_error", "interrupted"] as const,
};

export class PipelineService {
  readonly #autoReview: boolean;
  #detach?: () => void;

  constructor(private readonly deps: PipelineDeps) {
    this.#autoReview = deps.autoReview ?? true;
  }

  attach(): () => void {
    this.#detach ??= this.deps.bus.subscribe((event) => {
      if (event.type !== "TASK_SUCCEEDED" || !event.taskId) return;
      const task = this.deps.tasks.get(event.taskId);
      if (!task || task.kind !== "plan") return;
      this.#onPlanSucceeded(task);
    });
    return this.#detach;
  }

  #onPlanSucceeded(planTask: Task): void {
    const items = parsePlan(planTask.output?.response ?? "");
    if (items === undefined) {
      this.#handlePlanFailure(planTask, "plan_unparseable",
        `plan task ${planTask.id} produced no parseable PLAN_BEGIN/PLAN_END block`);
      return;
    }
    if (items.length === 0) {
      this.#handlePlanFailure(planTask, "plan_empty",
        `plan task ${planTask.id} resolved to zero tasks`);
      return;
    }
    const ordered = topologicalOrder(items);
    if (ordered === undefined) {
      this.#handlePlanFailure(planTask, "plan_cyclic",
        `plan task ${planTask.id} contains a dependency cycle`);
      return;
    }

    // 防御性编排:planner 输出不可控(实测有时漏写依赖)。test 无依赖时
    // 自动依赖全部 implement —— 测试必须晚于实现,语义底线由系统保证。
    const implementSeqs = items
      .filter((item) => item.kind === "implement")
      .map((item) => item.seq);
    for (const item of items) {
      if (item.kind === "test" && item.dependsOn.length === 0 && implementSeqs.length > 0) {
        item.dependsOn = [...implementSeqs];
      }
    }

    const target = planTargetOf(planTask) ?? planTask.input.prompt;
    const workspacePath = planTask.input.workspacePath;
    const model = planTask.input.model;
    const seqToTaskId = new Map<number, string>();
    const kinds = new Set<string>();

    // 拓扑序单遍创建:依赖的 seq 必已创建,dependencies 直接指向其 taskId。
    for (const item of ordered) {
      const task = this.deps.taskService.createTask({
        runId: planTask.runId,
        kind: item.kind,
        retryPolicy: PIPELINE_RETRY_POLICY,
        dependencies: item.dependsOn
          .map((dep) => seqToTaskId.get(dep))
          .filter((id): id is string => id !== undefined),
        input: {
          // 目录约束前缀:防模型路径漂移(实测会把文件写到主仓库而非 worktree)
          prompt: [
            "Work strictly inside the current working directory; use relative paths only.",
            item.description,
          ].join("\n"),
          role: roleOfKind(item.kind),
          model,
          workspacePath,
          metadata: { pipeline: true, planSeq: item.seq, targetPrompt: target },
        },
      });
      seqToTaskId.set(item.seq, task.id);
      kinds.add(item.kind);
    }

    // 计划无 review 且开启 autoReview → 追加终审(依赖全部计划任务)。
    if (this.#autoReview && !kinds.has("review")) {
      this.deps.taskService.createTask({
        runId: planTask.runId,
        kind: "review",
        retryPolicy: PIPELINE_RETRY_POLICY,
        dependencies: [...seqToTaskId.values()],
        input: {
          prompt: buildReviewPrompt(target),
          role: "reviewer",
          model,
          workspacePath,
          metadata: { pipeline: true, autoReview: true, targetPrompt: target },
        },
      });
    }
  }

  /** plan 失败:先问 Supervisor(re-plan 预算内注入新 plan);terminal 则 failRun。 */
  #handlePlanFailure(planTask: Task, reason: string, message: string): void {
    if (this.deps.supervisor) {
      const decision = this.deps.supervisor.onPlanFailure(planTask, reason);
      if (decision.action === "replan") return; // 新 plan 任务已注入
    }
    this.#failRun(planTask.runId, reason, message);
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
// 计划解析(约定格式;独立函数便于测试与将来替换为 submit 工具)
// ---------------------------------------------------------------------------

const PLAN_LINE =
  /^\s*(\d+)\.\s*\[(implement|test|review)\]\s*(.+?)(?:\s*\(depends:\s*([\d\s,]+)\))?\s*$/i;

export function parsePlan(response: string): PlanItem[] | undefined {
  const begin = response.indexOf("PLAN_BEGIN");
  const end = response.indexOf("PLAN_END");
  if (begin === -1 || end === -1 || end < begin) return undefined;
  const body = response.slice(begin + "PLAN_BEGIN".length, end);
  const items: PlanItem[] = [];
  const seen = new Set<number>();
  for (const line of body.split("\n")) {
    const match = PLAN_LINE.exec(line);
    if (!match) continue;
    const seq = Number(match[1]);
    if (!Number.isInteger(seq) || seq <= 0 || seen.has(seq)) continue;
    seen.add(seq);
    items.push({
      seq,
      kind: match[2]!.toLowerCase() as PlanItemKind,
      description: match[3]!.trim(),
      dependsOn: (match[4] ?? "")
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n !== seq),
    });
  }
  // 依赖引用了不存在的 seq → 视为不可解析(避免悬空依赖)
  const valid = items.every((item) => item.dependsOn.every((dep) => seen.has(dep)));
  return valid ? items : undefined;
}

/** 依赖先行排序;循环依赖返回 undefined。 */
export function topologicalOrder(items: PlanItem[]): PlanItem[] | undefined {
  const bySeq = new Map(items.map((item) => [item.seq, item]));
  const sorted: PlanItem[] = [];
  const state = new Map<number, "visiting" | "done">();
  const visit = (item: PlanItem): boolean => {
    const mark = state.get(item.seq);
    if (mark === "done") return true;
    if (mark === "visiting") return false; // cycle
    state.set(item.seq, "visiting");
    for (const dep of item.dependsOn) {
      const depItem = bySeq.get(dep);
      if (depItem && !visit(depItem)) return false;
    }
    state.set(item.seq, "done");
    sorted.push(item);
    return true;
  };
  for (const item of items) {
    if (!visit(item)) return undefined;
  }
  return sorted;
}

export function buildPlanPrompt(task: string): string {
  return [
    "You are the ZCAC Planner. Decompose the following task into the minimal set of worker tasks.",
    "",
    `Task:\n${task}`,
    "",
    "Rules:",
    "- Use kinds: implement (write/modify code, role coder) and test (run/author tests, role tester).",
    "- prefer 1-4 tasks; only add a review task if the user explicitly asked for one.",
    "- tasks without dependencies run in parallel; use (depends: N) to sequence.",
    "- each description must be fully self-contained (the worker sees only that line).",
    "",
    "Return the plan between PLAN_BEGIN and PLAN_END markers, one task per line, exactly:",
    "1. [implement] description",
    "2. [test] description (depends: 1)",
    "PLAN_BEGIN / PLAN_END lines contain nothing else.",
  ].join("\n");
}

function roleOfKind(kind: PlanItemKind): string {
  if (kind === "test") return "tester";
  if (kind === "review") return "reviewer";
  return "coder";
}

function planTargetOf(task: Task): string | undefined {
  const target = task.input.metadata?.targetPrompt;
  return typeof target === "string" ? target : undefined;
}
