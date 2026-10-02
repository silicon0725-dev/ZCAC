/**
 * ZCAC Application — Scheduler (Phase 1: dependency-aware FIFO,规范 §24-§28)。
 *
 * 调度顺序:READY → priority DESC → createdAt ASC → id ASC(TaskGraph.getReadyTasks)。
 * claim 为持久化原子操作(规范 §26),同一 Task 不可能被 claim 两次。
 * Scheduler 只依赖 AgentExecutor 端口,不知道 createZCodeApp/AgentRuntime。
 */

import type { RunId, Task, TaskId } from "../domain/task/task.js";
import type { TaskOutput, UsageSummary } from "../domain/task/task-input.js";
import type { AgentExecutor, AgentHandle, AgentResult } from "../ports/agent-executor.js";
import type { Clock } from "../ports/clock.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { AgentPool } from "./agent-pool.js";
import type { RateLimitGovernor } from "../ports/rate-governor.js";
import type { GraphService } from "./graph-service.js";
import type { TaskService } from "./task-service.js";
import type { WorktreeService } from "./worktree-service.js";

export type WorkspaceIsolation = "shared" | "worktree";

export interface SchedulerDeps {
  taskService: TaskService;
  graphService: GraphService;
  tasks: TaskRepository;
  executor: AgentExecutor;
  pool: AgentPool;
  clock: Clock;
  /** claim 后仍未完成的任务的默认工作目录(任务 input.workspacePath 优先)。 */
  defaultWorkingDirectory: string;
  maxConcurrentTasks?: number;
  /** 执行期间 heartbeat 间隔;默认 40s(lease 120s 的 1/3)。 */
  heartbeatIntervalMs?: number;
  /** 工作区隔离模式;默认 shared(v0.1 §30:显式选择,不默认 worktree)。 */
  isolation?: WorkspaceIsolation;
  /** worktree 模式下需要隔离的角色;默认 ["coder"]。 */
  isolationRoles?: readonly string[];
  /** isolation=worktree 时必须注入。 */
  worktrees?: WorktreeService;
  /** 调度层限流退避;缺省不限制(测试向后兼容),build 默认装配。 */
  governor?: RateLimitGovernor;
}

export interface DrainOptions {
  timeoutMs?: number;
  /** 每个 run 状态变化后的观察回调(进度打印)。 */
  onTick?: (snapshot: SchedulerSnapshot) => void;
}

export interface SchedulerSnapshot {
  runId: RunId;
  ready: number;
  inFlight: number;
  blocked: number;
  terminal: number;
}

export class Scheduler {
  readonly #inFlight = new Map<TaskId, Promise<void>>();
  readonly maxConcurrentTasks: number;
  readonly heartbeatIntervalMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.maxConcurrentTasks = deps.maxConcurrentTasks ?? 2;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 40_000;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  /**
   * 驱动 run 直到完成/失败/超时。确定性执行(测试与 E2E 复用):
   * 循环 { readiness 重算 → retry 提升 → claim+launch(不阻塞) → 等一个完成 }。
   * 仅剩 retry_wait 在等待时,睡到最近到期点,避免忙等。
   * deadline 只在「停滞且无可推进」时判定——任务仍在执行(in-flight)不算超时。
   */
  async drain(runId: RunId, options: DrainOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const deadline = this.deps.clock.now() + timeoutMs;
    this.deps.graphService.markRunStarted(runId);

    for (;;) {
      this.promoteDueRetries(runId);
      this.deps.graphService.refreshReadiness(runId);
      this.claimAndLaunch(runId);
      options.onTick?.(this.snapshot(runId));

      if (this.#inFlight.size > 0) {
        // 等任一任务完成,或睡到 deadline 再评估(防止错过超时检查)。
        const remaining = deadline - this.deps.clock.now();
        await Promise.race([...this.#inFlight.values(), sleep(Math.max(0, remaining))]);
        continue;
      }

      const status = this.deps.graphService.refreshRunStatus(runId);
      if (status === "completed" || status === "failed") break;

      const ready = this.readyTaskIdsOf(runId).length;
      if (ready > 0) {
        // ready 但限流冷却中:睡到冷却结束(否则忙转);容量释放场景仍立即重试
        if (this.deps.governor) {
          const cooldownEnd = this.deps.governor.cooldownUntil();
          if (cooldownEnd > this.deps.clock.now()) {
            const waitMs = Math.max(1, Math.min(cooldownEnd - this.deps.clock.now(), 1_000));
            await sleep(waitMs);
          }
        }
        continue;
      }

      // 无 ready、无 in-flight:按最近唤醒点等待(retry 到期 / 限流冷却 / 无可推进)。
      const wakeups: number[] = [];
      const nextRetry = this.#nextRetryAt(runId);
      if (nextRetry !== undefined) wakeups.push(nextRetry);
      if (this.deps.governor) {
        const cooldownEnd = this.deps.governor.cooldownUntil();
        if (cooldownEnd > this.deps.clock.now()) wakeups.push(cooldownEnd);
      }
      if (wakeups.length === 0) {
        if (this.deps.clock.now() > deadline) {
          throw new Error(
            `Scheduler.drain timed out after ${timeoutMs}ms for run ${runId} (stalled with no progress possible)`,
          );
        }
        break; // 无可推进(防御性退出,状态已持久化,可 resume)
      }
      const wakeAt = Math.min(...wakeups);
      const waitMs = Math.max(1, Math.min(wakeAt - this.deps.clock.now(), 1_000));
      await sleep(waitMs);
    }
    this.deps.graphService.refreshRunStatus(runId);
  }

  /** 停止在途任务(Phase 1 供外部取消/超时使用)。 */
  async stopInFlight(): Promise<void> {
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    await Promise.allSettled(handles.map((handle) => this.deps.executor.stop(handle)));
  }

  #handles = new Map<TaskId, AgentHandle>();

  /**
   * v2 准入(规范 §4):pool.acquire(role) 先于 claim——
   * role quota / 全局上限满则跳过该任务(不阻塞其他角色);
   * claim 失败立即归还 slot。
   */
  private claimAndLaunch(runId: RunId): void {
    const readyTaskIds = this.readyTaskIdsOf(runId);
    for (const taskId of readyTaskIds) {
      if (this.#inFlight.size >= this.maxConcurrentTasks) break;
      if (
        this.deps.governor &&
        !this.deps.governor.canLaunch(this.deps.clock.now())
      ) {
        break; // 限流冷却:暂停新 claim,在飞任务自然完成
      }
      const task = this.deps.tasks.get(taskId);
      if (!task || task.status !== "ready") continue;
      const role = task.input.role ?? "coder";
      if (!this.deps.pool.hasCapacity(role)) continue;
      const slot = this.deps.pool.acquire(role, this.deps.clock.now(), taskId);
      if (!slot) continue;
      const claimed = this.deps.taskService.claimTask(taskId);
      if (!claimed) {
        this.deps.pool.release(slot.id, this.deps.clock.now()); // 被并发抢走
        continue;
      }
      const promise = this.#execute(claimed, slot)
        .finally(() => {
          this.#inFlight.delete(taskId);
        });
      this.#inFlight.set(taskId, promise);
    }
  }

  async #execute(task: Task, slot: { id: string }): Promise<void> {
    let handle: AgentHandle | undefined;
    // worktree 隔离(ZCAC-0008):写入型任务在专属 worktree 中工作,
    // 成功 commit、失败清理;评审/只读任务仍在主工作区。
    const role = task.input.role ?? "coder";
    const isolationRoles = this.deps.isolationRoles ?? ["coder"];
    const isolated =
      this.deps.isolation === "worktree" &&
      this.deps.worktrees !== undefined &&
      isolationRoles.includes(role);
    let worktreePath: string | undefined;
    if (isolated && this.deps.worktrees) {
      const worktree = await this.deps.worktrees.createForTask(task);
      worktreePath = worktree.path;
    }
    // lease 续约(ZCAC-0004):执行期间按 heartbeatIntervalMs 续约。
    // unref:被遗弃的执行(进程级崩溃模拟)不靠它拖住事件循环。
    const heartbeat = setInterval(() => {
      this.deps.taskService.heartbeatTask(task.id);
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      handle = await this.deps.executor.launch({
        role,
        prompt: task.input.prompt,
        description: `${task.kind} ${task.id}`,
        workingDirectory: worktreePath ?? task.input.workspacePath ?? this.deps.defaultWorkingDirectory,
        ...(task.input.model ? { model: task.input.model } : {}),
        metadata: { runId: task.runId, taskId: task.id },
      });
      this.#handles.set(task.id, handle);
      this.deps.taskService.assignAgent(
        task.id,
        handle.agentId,
        handle.model,
        slot.id,
      );
      const result = await this.deps.executor.wait(handle);
      if (result.status === "completed") {
        // worktree 模式(Phase 7):implement 成功即 commit+merge——
        // 下游 test/review 在主区可见成果;冲突任务级失败(分支保留待处理)。
        if (isolated && this.deps.worktrees) {
          const outcome = await this.deps.worktrees.commitAndMergeTask(
            task.id,
            `zcac(${task.kind}): ${result.response.slice(0, 60).replace(/\n/g, " ")}`,
          );
          if (outcome.merge === "conflict") {
            this.deps.taskService.failTask(task.id, {
              code: "merge_conflict",
              message: `merge conflicted on: ${outcome.conflictFiles.join(", ") || "unknown files"}; branch preserved for manual resolution`,
              retryable: false,
            });
            return;
          }
        }
        const output = outputFromResult(result);
        this.deps.taskService.completeTask(task.id, output);
        this.#emitArtifact(task, handle, output);
        this.deps.governor?.noteTaskSuccess();
      } else {
        const failure = errorFromResult(result);
        this.deps.governor?.noteTaskFailure(failure);
        this.deps.taskService.failTask(task.id, failure);
        if (isolated && this.deps.worktrees) {
          await this.deps.worktrees.abandonTask(task.id).catch(() => undefined);
        }
      }
    } catch (error) {
      // launch/wait 抛出的环境错误:不重试(配置/环境问题重试无意义,规范 §29 简化)。
      this.deps.taskService.failTask(task.id, {
        code: "executor_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        details: error,
      });
      if (isolated && this.deps.worktrees) {
        await this.deps.worktrees.abandonTask(task.id).catch(() => undefined);
      }
    } finally {
      clearInterval(heartbeat);
      if (handle) {
        this.#handles.delete(task.id);
        this.deps.taskService.releaseAgent(task.id);
      }
      this.deps.pool.release(slot.id, this.deps.clock.now());
    }
  }

  private promoteDueRetries(runId: RunId): void {
    const now = this.deps.clock.now();
    for (const task of this.deps.tasks.listByRunAndStatus(runId, "retry_wait")) {
      if ((task.retryNotBefore ?? 0) <= now) {
        this.deps.taskService.promoteRetry(task.id);
      }
    }
  }

  private readyTaskIdsOf(runId: RunId): TaskId[] {
    // 复用 TaskGraph 的排序(priority DESC → createdAt ASC → id ASC)。
    const all = this.deps.tasks.listByRun(runId);
    return all
      .filter((task) => task.status === "ready")
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt - b.createdAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((task) => task.id);
  }

  /** 任务完成即落 Artifact(ZCAC-0006):Agent 产出的正式载体。 */
  #emitArtifact(task: Task, handle: AgentHandle, output: TaskOutput): void {
    try {
      this.deps.taskService.createArtifact({
        runId: task.runId,
        taskId: task.id,
        agentId: handle.agentId,
        type: artifactTypeOf(task.kind),
        content: {
          kind: task.kind,
          role: task.input.role ?? "coder",
          response: output.response,
          ...(output.usage ? { usage: output.usage } : {}),
          ...(output.findings ? { findings: output.findings } : {}),
          metadata: output.metadata,
        },
      });
    } catch {
      // artifact 未配置或写入失败不回滚任务结果;journal 中任务事实已成立。
    }
  }

  private snapshot(runId: RunId): SchedulerSnapshot {
    const tasks = this.deps.tasks.listByRun(runId);
    return {
      runId,
      ready: tasks.filter((t) => t.status === "ready").length,
      inFlight: this.#inFlight.size,
      blocked: tasks.filter((t) => t.status === "blocked" || t.status === "retry_wait").length,
      terminal: tasks.filter(
        (t) =>
          t.status === "succeeded" || t.status === "failed" || t.status === "cancelled",
      ).length,
    };
  }

  /** 最近一个将到期的 retry_wait 时间戳;无等待任务时返回 undefined。 */
  #nextRetryAt(runId: RunId): number | undefined {
    const waiting = this.deps.tasks.listByRunAndStatus(runId, "retry_wait");
    if (waiting.length === 0) return undefined;
    return Math.min(...waiting.map((task) => task.retryNotBefore ?? 0));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 遗弃的 drain(如崩溃模拟)不应靠这个定时器拖住进程退出。
    timer.unref?.();
  });
}

function artifactTypeOf(
  kind: string,
): "review" | "test_result" | "plan" | "patch" | "report" {
  if (kind === "review") return "review";
  if (kind === "fix") return "patch";
  if (kind === "test") return "test_result";
  if (kind === "plan") return "plan";
  return "report";
}

function outputFromResult(result: AgentResult): TaskOutput {
  return {
    status: "success",
    summary: result.response.slice(0, 200),
    response: result.response,
    artifacts: [],
    ...(result.usage ? { usage: usageFromResult(result.usage) } : {}),
    metadata: {
      agentId: result.agentId,
      sessionId: result.sessionId,
      model: result.model,
      durationMs: result.durationMs,
      ...(result.metadata ?? {}),
    },
  };
}

function usageFromResult(usage: UsageSummary): UsageSummary {
  return usage;
}

function errorFromResult(result: AgentResult): {
  code: string;
  message: string;
  retryable: boolean;
} {
  // Phase 1 简化分类(规范 §29):执行失败一律可重试,由 RetryPolicy.maxAttempts 封顶;
  // cancelled 不可重试。
  return {
    code: result.status === "cancelled" ? "agent_cancelled" : "agent_failed",
    message: result.error ?? `${result.status} without error detail`,
    retryable: result.status !== "cancelled",
  };
}
