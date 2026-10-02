/**
 * ZCAC Application — TaskService。
 *
 * Task/Run 生命周期与事件的唯一写入点。
 * 一致性规则(规范 §18 journal-first):
 *   tx { 状态迁移 + 事件 append } → COMMIT → bus.publish(live emit)
 * 例外:claim 是单条原子 UPDATE(规范 §26),TASK_STARTED 事件紧随其后补写。
 */

import type { ClusterEventBus } from "../domain/event/event-bus.js";
import type { ClusterEvent } from "../domain/event/cluster-event.js";
import type { ClusterEventType } from "../domain/event/event-types.js";
import type { TaskGraph } from "../domain/graph/task-graph.js";
import type { AgentCapabilityRegistry } from "../domain/agent/agent-pool.js";
import { createArtifact, type Artifact } from "../domain/artifact/artifact.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import { createRun, type CreateRunInput, type Run } from "../domain/run/run.js";
import { shouldRetry } from "../domain/task/retry-policy.js";
import { assertTransition } from "../domain/task/task-status.js";
import type { Task, TaskError, TaskId } from "../domain/task/task.js";
import { createTask, type CreateTaskInput } from "../domain/task/task.js";
import type { TaskOutput } from "../domain/task/task-input.js";
import type { Clock, TransactionRunner } from "../ports/clock.js";
import type { EventJournal } from "../ports/event-journal.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { TaskRepository } from "../ports/task-repository.js";

export interface TaskServiceDeps {
  runs: RunRepository;
  tasks: TaskRepository;
  journal: EventJournal;
  tx: TransactionRunner;
  clock: Clock;
  bus: ClusterEventBus;
  graph: TaskGraph;
  /** 角色注册表:input.role 指定时在 createTask 即校验(Phase 2)。 */
  registry?: AgentCapabilityRegistry;
  /** claim 写入的租约时长;默认 120s(ZCAC-0004)。 */
  leaseMs?: number;
  /** Artifact 仓储(ZCAC-0006);注入后 createArtifact 可用。 */
  artifacts?: ArtifactRepository;
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  private get leaseMs(): number {
    return this.deps.leaseMs ?? 120_000;
  }

  createRun(input: CreateRunInput = {}): Run {
    const run = createRun(input, this.deps.clock.now());
    this.emitPersisted(
      () => this.deps.runs.insert(run),
      run.id,
      "RUN_CREATED",
      { status: run.status },
    );
    return run;
  }

  /** 创建 Task 并入图(规范 §14:运行时加节点);role 必须已在 registry 注册。 */
  createTask(input: CreateTaskInput): Task {
    const role = input.input.role ?? "coder";
    this.deps.registry?.requireRole(role);
    const task = createTask(input, this.deps.clock.now());
    this.emitPersisted(
      () => {
        this.deps.tasks.insert(task);
        this.deps.graph.addTask(task);
      },
      task.runId,
      "TASK_CREATED",
      {
        kind: task.kind,
        role: task.input.role ?? "coder",
        priority: task.priority,
        dependencies: task.dependencies,
      },
      task.id,
    );
    return task;
  }

  /** 原子认领(含 lease):成功返回 running 态 Task(attempt+1, leaseUntil 已写)。 */
  claimTask(taskId: TaskId): Task | undefined {
    const now = this.deps.clock.now();
    const claimed = this.deps.tasks.claim(taskId, now, now + this.leaseMs);
    if (!claimed) return undefined;
    this.deps.graph.updateTask(claimed);
    this.emit(
      claimed.runId,
      "TASK_STARTED",
      { attempt: claimed.attempt, leaseUntil: claimed.leaseUntil },
      claimed.id,
    );
    return claimed;
  }

  /** 执行期间续约(ZCAC-0004):仅 running 态生效。 */
  heartbeatTask(taskId: TaskId): boolean {
    const now = this.deps.clock.now();
    return this.deps.tasks.heartbeat(taskId, now, now + this.leaseMs);
  }

  assignAgent(taskId: TaskId, agentId: string, model: string, slotId?: string): void {
    const task = this.requireTask(taskId);
    this.transition(
      task,
      { assignedAgentId: agentId },
      "AGENT_ASSIGNED",
      { agentId, model, ...(slotId ? { slotId } : {}) },
      agentId,
    );
  }

  releaseAgent(taskId: TaskId): void {
    const task = this.requireTask(taskId);
    if (!task.assignedAgentId) return;
    this.transition(task, {}, "AGENT_RELEASED", { agentId: task.assignedAgentId }, task.assignedAgentId);
  }

  completeTask(taskId: TaskId, output: TaskOutput): Task {
    const task = this.requireTask(taskId);
    assertTransition(task.id, task.status, "succeeded");
    const completedAt = this.deps.clock.now();
    return this.transition(
      task,
      {
        status: "succeeded",
        completedAt,
        output,
        error: undefined,
      },
      "TASK_SUCCEEDED",
      {
        attempt: task.attempt,
        durationMs: task.startedAt ? completedAt - task.startedAt : undefined,
      },
    );
  }

  /**
   * 失败收口(规范 §29):retryable 且 attempt < maxAttempts → retry_wait;
   * 否则 failed(终态)。
   */
  failTask(taskId: TaskId, error: TaskError): Task {
    const task = this.requireTask(taskId);
    const retry = shouldRetry(task.attempt, task.retryPolicy, {
      retryable: error.retryable,
      condition: error.code === "interrupted" ? "interrupted" : undefined,
    });
    const now = this.deps.clock.now();
    if (retry) {
      assertTransition(task.id, task.status, "retry_wait");
      return this.transition(
        task,
        {
          status: "retry_wait",
          error,
          retryNotBefore: now + task.retryPolicy.backoffMs,
        },
        "TASK_RETRY",
        { attempt: task.attempt, retryInMs: task.retryPolicy.backoffMs, error: error.code },
      );
    }
    assertTransition(task.id, task.status, "failed");
    return this.transition(
      task,
      { status: "failed", completedAt: now, error },
      "TASK_FAILED",
      { attempt: task.attempt, error: error.code, message: error.message },
    );
  }

  /** readiness 迁移(GraphService 调用):pending/blocked → ready/blocked。 */
  applyReadinessChange(taskId: TaskId, to: "ready" | "blocked"): void {
    const task = this.requireTask(taskId);
    assertTransition(task.id, task.status, to);
    this.transition(task, { status: to }, to === "ready" ? "TASK_READY" : "TASK_BLOCKED", {
      from: task.status,
    });
  }

  /** retry_wait 到期 → ready(Scheduler 调用)。 */
  promoteRetry(taskId: TaskId): void {
    const task = this.requireTask(taskId);
    assertTransition(task.id, task.status, "ready");
    this.transition(task, { status: "ready", retryNotBefore: undefined }, "TASK_READY", {
      retry: true,
      attempt: task.attempt,
    });
  }

  /** 崩溃遗留的 running → interrupted(瞬时) → ready|failed(规范 §33)。 */
  recoverInterruptedTask(taskId: TaskId): "requeued" | "failed" | "skipped" {
    const task = this.requireTask(taskId);
    if (task.status !== "running") return "skipped";
    const interrupted = this.transition(task, { status: "interrupted" }, null, {});
    const retry = shouldRetry(interrupted.attempt, interrupted.retryPolicy, {
      retryable: true,
      condition: "interrupted",
    });
    if (retry) {
      assertTransition(interrupted.id, interrupted.status, "ready");
      this.transition(interrupted, { status: "ready" }, "TASK_READY", {
        recovered: true,
        attempt: interrupted.attempt,
      });
      return "requeued";
    }
    assertTransition(interrupted.id, interrupted.status, "failed");
    this.transition(
      interrupted,
      {
        status: "failed",
        completedAt: this.deps.clock.now(),
        error: { code: "interrupted", message: "Task interrupted by process restart", retryable: false },
      },
      "TASK_FAILED",
      { attempt: interrupted.attempt, error: "interrupted", recovered: true },
    );
    return "failed";
  }

  /**
   * 产出 Artifact(ZCAC-0006):journal-first 与状态迁移同规则;
   * Agent 间以 Artifact 为正式通信媒介,而非互贴长文本。
   */
  createArtifact(input: {
    runId: string;
    taskId: string;
    agentId?: string;
    type: import("../domain/artifact/artifact.js").ArtifactType;
    content: unknown;
  }): Artifact {
    if (!this.deps.artifacts) {
      throw new Error("ArtifactRepository not configured in TaskService");
    }
    const artifact = createArtifact(input, this.deps.clock.now());
    const event = this.deps.tx.run(() => {
      this.deps.artifacts!.insert(artifact);
      return this.deps.journal.append({
        runId: artifact.runId,
        type: "ARTIFACT_CREATED",
        timestamp: artifact.createdAt,
        taskId: artifact.taskId,
        agentId: artifact.agentId,
        payload: { artifactId: artifact.id, type: artifact.type, checksum: artifact.checksum },
      });
    });
    this.deps.bus.publish(event);
    return artifact;
  }

  /** Run 级事件入口(GraphService 聚合状态用):journal-first + live emit。 */
  emitRunEvent(runId: string, type: ClusterEventType, payload: unknown): void {
    this.emit(runId, type, payload);
  }

  /** Worktree/合并事件:仅 append(必须在调用方事务内),返回事件供 commit 后 publish。 */
  appendEvent(
    runId: string,
    type: ClusterEventType,
    taskId: string,
    payload: unknown,
  ): ClusterEvent {
    if (!this.deps.tx.inTransaction) {
      throw new Error("appendEvent must be called inside a transaction (journal-first)");
    }
    return this.deps.journal.append({
      runId,
      type,
      timestamp: this.deps.clock.now(),
      taskId,
      payload,
    });
  }

  /** Run 状态迁移 + 事件同事务(journal-first 对 run 同样成立)。 */
  updateRunWithEvent(
    runId: string,
    patch: Partial<Run>,
    type: ClusterEventType | null,
    payload: unknown,
  ): Run {
    const current = this.deps.runs.get(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const updated: Run = { ...current, ...patch, updatedAt: this.deps.clock.now() };
    const event = this.deps.tx.run(() => {
      this.deps.runs.update(updated);
      return type === null
        ? undefined
        : this.deps.journal.append({
            runId,
            type,
            timestamp: updated.updatedAt,
            payload,
          });
    });
    if (event) this.deps.bus.publish(event);
    return updated;
  }

  private transition(
    task: Task,
    patch: Partial<Task>,
    eventType: ClusterEventType | null,
    payload: unknown,
    agentId?: string,
  ): Task {
    const updatedAt = this.deps.clock.now();
    const updated: Task = { ...task, ...patch, updatedAt };
    if (patch.status !== undefined) {
      assertTransition(task.id, task.status, patch.status);
    }
    const event = this.deps.tx.run(() => {
      this.deps.tasks.update(updated);
      this.deps.graph.updateTask(updated);
      return eventType === null
        ? undefined
        : this.deps.journal.append({
            runId: updated.runId,
            type: eventType,
            timestamp: updatedAt,
            taskId: updated.id,
            agentId,
            payload,
          });
    });
    if (event) this.deps.bus.publish(event);
    return updated;
  }

  /** 与 transition 相同的 journal-first 顺序,但允许附带 run/graph 写入。 */
  private emitPersisted(
    persist: () => void,
    runId: string,
    type: ClusterEventType,
    payload: unknown,
    taskId?: string,
    agentId?: string,
  ): ClusterEvent {
    const event = this.deps.tx.run(() => {
      persist();
      return this.deps.journal.append({
        runId,
        type,
        timestamp: this.deps.clock.now(),
        taskId,
        agentId,
        payload,
      });
    });
    this.deps.bus.publish(event);
    return event;
  }

  private emit(
    runId: string,
    type: ClusterEventType,
    payload: unknown,
    taskId?: string,
    agentId?: string,
  ): void {
    const event = this.deps.tx.run(() =>
      this.deps.journal.append({
        runId,
        type,
        timestamp: this.deps.clock.now(),
        taskId,
        agentId,
        payload,
      }),
    );
    this.deps.bus.publish(event);
  }

  private requireTask(taskId: TaskId): Task {
    const task = this.deps.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
}
