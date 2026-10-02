/**
 * ZCAC Phase 8 — Supervisor 决策循环(application)。
 *
 * 把可自动恢复的失败升级为有限预算的自动决策(v0.1 §15/§26):
 *
 *   merge_conflict → rebase 重做(注入 coder 任务,worktree 重建基于当前 HEAD,
 *                    天然 rebase;Phase 7 已验证基线前移会自然消解冲突)
 *   plan 解析失败  → re-plan(注入新 plan 任务,prompt 追加格式强调)
 *   预算耗尽/其他  → 不动作(终态保留,escalate 以事件记录)
 *
 * 预算:per-run 总决策数(maxDecisions)+ 每类失败单独限额,防决策风暴。
 */

import type { Task } from "../domain/task/task.js";
import type { Clock, TransactionRunner } from "../ports/clock.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { ClusterEventBus } from "../domain/event/event-bus.js";
import type { TaskService } from "./task-service.js";
import { buildPlanPrompt } from "./pipeline.js";
import { PIPELINE_RETRY_POLICY } from "./pipeline.js";

export type SupervisorAction =
  | { action: "rebase_redo"; newTaskId: string }
  | { action: "replan"; newTaskId: string }
  | { action: "terminal" };

export interface SupervisorDeps {
  bus: ClusterEventBus;
  tasks: TaskRepository;
  runs: RunRepository;
  taskService: TaskService;
  tx: TransactionRunner;
  clock: Clock;
  /** 每 run 总决策预算(默认 2)。 */
  maxDecisions?: number;
  /** merge_conflict 重做限额(默认 1/run)。 */
  maxConflictRedo?: number;
  /** re-plan 限额(默认 1/run)。 */
  maxReplans?: number;
}

export class SupervisorService {
  readonly #maxDecisions: number;
  readonly #maxConflictRedo: number;
  readonly #maxReplans: number;
  readonly #decisionsByRun = new Map<string, { total: number; conflictRedo: number; replans: number }>();
  #detach?: () => void;

  constructor(private readonly deps: SupervisorDeps) {
    this.#maxDecisions = deps.maxDecisions ?? 2;
    this.#maxConflictRedo = deps.maxConflictRedo ?? 1;
    this.#maxReplans = deps.maxReplans ?? 1;
  }

  attach(): () => void {
    this.#detach ??= this.deps.bus.subscribe((event) => {
      if (event.type !== "TASK_FAILED" || !event.taskId) return;
      const task = this.deps.tasks.get(event.taskId);
      if (!task) return;
      if (task.error?.code === "merge_conflict") {
        this.onMergeConflict(task);
      }
    });
    return this.#detach;
  }

  /** merge_conflict → rebase 重做(注入 coder 任务,立即就绪)。 */
  onMergeConflict(task: Task): SupervisorAction {
    const budget = this.#budget(task.runId);
    if (budget.total >= this.#maxDecisions || budget.conflictRedo >= this.#maxConflictRedo) {
      return this.#terminal(task.runId, "merge_conflict", budget,
        `budget exhausted (total=${budget.total}/${this.#maxDecisions}, redo=${budget.conflictRedo}/${this.#maxConflictRedo})`);
    }
    const target = targetPromptOf(task);
    const conflictFiles = conflictFilesOf(task);
    const redo = this.deps.taskService.createTask({
      runId: task.runId,
      kind: "implement",
      retryPolicy: { ...PIPELINE_RETRY_POLICY, retryOn: ["retryable_error"] },
      input: {
        prompt: [
          "Work strictly inside the current working directory; use relative paths only.",
          target,
          "",
          "Your earlier change conflicted with other merged work on:",
          ...(conflictFiles.length > 0
            ? conflictFiles.map((file) => `- ${file}`)
            : ["- <unknown files>"]),
          "The main branch has moved on. Re-implement your change on the CURRENT state",
          "of these files (read them first), resolving in favor of your task intent.",
        ].join("\n"),
        role: "coder",
        workspacePath: task.input.workspacePath,
        model: task.input.model,
        metadata: {
          supervisor: "rebase_redo",
          redoOf: task.id,
          targetPrompt: target,
        },
      },
    });
    return this.#decide(task.runId, "merge_conflict", "rebase_redo", redo.id, budget);
  }

  /**
   * plan 失败 → re-plan(注入新 plan 任务)。
   * 返回 replan 动作或 terminal(调用方据此决定是否 failRun)。
   */
  onPlanFailure(planTask: Task, reason: string): SupervisorAction {
    const budget = this.#budget(planTask.runId);
    if (budget.total >= this.#maxDecisions || budget.replans >= this.#maxReplans) {
      this.#terminal(planTask.runId, reason, budget, "replan budget exhausted");
      return { action: "terminal" };
    }
    const target = targetPromptOf(planTask) ?? planTask.input.prompt;
    const replan = this.deps.taskService.createTask({
      runId: planTask.runId,
      kind: "plan",
      retryPolicy: { ...PIPELINE_RETRY_POLICY, retryOn: ["retryable_error"] },
      input: {
        prompt: [
          buildPlanPrompt(target),
          "",
          "IMPORTANT: your previous plan attempt was rejected",
          `(${reason}). Follow the output format EXACTLY — the response must contain`,
          "PLAN_BEGIN and PLAN_END markers with one task per line in the given format.",
        ].join("\n"),
        role: "planner",
        workspacePath: planTask.input.workspacePath,
        model: planTask.input.model,
        metadata: {
          supervisor: "replan",
          replanOf: planTask.id,
          targetPrompt: target,
        },
      },
    });
    return this.#decide(planTask.runId, reason, "replan", replan.id, budget);
  }

  #budget(runId: string): { total: number; conflictRedo: number; replans: number } {
    let budget = this.#decisionsByRun.get(runId);
    if (!budget) {
      budget = { total: 0, conflictRedo: 0, replans: 0 };
      this.#decisionsByRun.set(runId, budget);
    }
    return budget;
  }

  #decide(
    runId: string,
    trigger: string,
    action: "rebase_redo" | "replan",
    newTaskId: string,
    budget: { total: number; conflictRedo: number; replans: number },
  ): SupervisorAction {
    budget.total += 1;
    if (action === "rebase_redo") budget.conflictRedo += 1;
    else budget.replans += 1;
    const event = this.deps.tx.run(() =>
      this.deps.taskService.appendEvent(runId, "SUPERVISOR_DECISION", newTaskId, {
        trigger,
        action,
        newTaskId,
        budget: { ...budget },
      }),
    );
    this.deps.bus.publish(event);
    return { action, newTaskId };
  }

  #terminal(
    runId: string,
    trigger: string,
    budget: { total: number; conflictRedo: number; replans: number },
    reason: string,
  ): SupervisorAction {
    const event = this.deps.tx.run(() =>
      this.deps.taskService.appendEvent(runId, "SUPERVISOR_DECISION", "", {
        trigger,
        action: "terminal",
        reason,
        budget: { ...budget },
      }),
    );
    this.deps.bus.publish(event);
    return { action: "terminal" };
  }
}

function targetPromptOf(task: Task): string {
  const target = task.input.metadata?.targetPrompt;
  return typeof target === "string" ? target : task.input.prompt;
}

function conflictFilesOf(task: Task): string[] {
  const message = task.error?.message ?? "";
  const marker = "merge conflicted on: ";
  if (!message.includes(marker)) return [];
  return message
    .slice(message.indexOf(marker) + marker.length)
    .split(";")[0]!
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}
