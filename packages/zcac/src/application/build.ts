/**
 * ZCAC 组合根:装配 domain + application + sqlite 适配器。
 * ZCode executor 由调用方注入(保持 core 不依赖 @zcode/*,规范 §2)。
 */

import { ClusterEventBus } from "../domain/event/event-bus.js";
import { TaskGraph } from "../domain/graph/task-graph.js";
import {
  createDefaultCapabilityRegistry,
  type AgentCapabilityRegistry,
} from "../domain/agent/agent-pool.js";
import { AgentPool } from "./agent-pool.js";
import { GraphService } from "./graph-service.js";
import { PipelineService } from "./pipeline.js";
import { SupervisorService } from "./supervisor.js";
import { ExponentialBackoffGovernor } from "./rate-governor.js";
import { RecoveryService } from "./recovery.js";
import { ReviewLoopService } from "./review-loop.js";
import { Scheduler, type WorkspaceIsolation } from "./scheduler.js";
import { TaskService } from "./task-service.js";
import { WorktreeService } from "./worktree-service.js";
import { SqliteDatabase } from "../adapters/sqlite/database.js";
import { SqliteArtifactRepository } from "../adapters/sqlite/artifact-repository.js";
import { SqliteEventJournal } from "../adapters/sqlite/event-journal.js";
import { SqliteRunRepository } from "../adapters/sqlite/run-repository.js";
import { SqliteTaskRepository } from "../adapters/sqlite/task-repository.js";
import { SqliteWorktreeRepository } from "../adapters/sqlite/worktree-repository.js";
import { GitWorktreeManager } from "../adapters/git/worktree-manager.js";
import { SystemClock, type Clock } from "../ports/clock.js";
import type { AgentExecutor } from "../ports/agent-executor.js";

export interface ZcacOptions {
  /** SQLite 文件路径;":memory:" 用于测试。 */
  databasePath: string;
  executor: AgentExecutor;
  defaultWorkingDirectory: string;
  maxConcurrentTasks?: number;
  /** 覆盖角色配额(role → max concurrent slots)。 */
  roleQuotas?: Record<string, number>;
  /** 全局并发上限。 */
  poolGlobalMax?: number;
  /** claim 租约时长(默认 120s)与 heartbeat 间隔(默认其 1/3)。 */
  leaseMs?: number;
  /** 注入时钟(测试);默认 SystemClock。 */
  clock?: Clock;
  /** 覆盖默认角色注册表。 */
  registry?: AgentCapabilityRegistry;
  /** Review Loop 最大轮数;0 表示关闭 Review Loop。默认 3。 */
  reviewMaxRounds?: number;
  /** Pipeline Mode:plan 任务成功后自动注入任务链;默认开启。0 关闭。 */
  pipeline?: boolean;
  /** Supervisor 决策循环;默认开启(0 关闭)。 */
  supervisor?: boolean;
  /** 每 run 总决策预算(默认 2)。 */
  supervisorMaxDecisions?: number;
  /** 调度层限流退避;默认装配(0 关闭:baseCooldownMs=0)。 */
  governorBaseCooldownMs?: number;
  /** 按角色分配模型(role → providerId/modelId[@level]);multi-model 协作。 */
  roleModels?: Readonly<Record<string, string>>;
  governorMaxCooldownMs?: number;
  /** 计划无 review 时是否追加终审;默认 true。 */
  pipelineAutoReview?: boolean;
  /** 工作区隔离模式;默认 "shared"。worktree 模式需要 defaultWorkingDirectory 位于 git 仓库。 */
  isolation?: WorkspaceIsolation;
  /** worktree 模式下需要隔离的角色;默认 ["coder"]。 */
  isolationRoles?: readonly string[];
  /** 显式注入 WorktreeManager(测试);缺省时 worktree 模式自动探测仓库根。 */
  worktreeManager?: GitWorktreeManager;
}

export interface ZcacApp {
  database: SqliteDatabase;
  bus: ClusterEventBus;
  graph: TaskGraph;
  registry: AgentCapabilityRegistry;
  pool: AgentPool;
  taskService: TaskService;
  graphService: GraphService;
  scheduler: Scheduler;
  recovery: RecoveryService;
  governor?: ExponentialBackoffGovernor;
  reviewLoop?: ReviewLoopService;
  pipeline?: PipelineService;
  supervisor?: SupervisorService;
  worktrees?: WorktreeService;
  artifacts: SqliteArtifactRepository;
  worktreeRepo: SqliteWorktreeRepository;
  runs: SqliteRunRepository;
  tasks: SqliteTaskRepository;
  journal: SqliteEventJournal;
  close(): void;
}

export async function buildZcac(options: ZcacOptions): Promise<ZcacApp> {
  const database = new SqliteDatabase(options.databasePath);
  const clock = options.clock ?? new SystemClock();
  const bus = new ClusterEventBus();
  const graph = new TaskGraph();
  const registry = options.registry ?? createDefaultCapabilityRegistry();
  const runs = new SqliteRunRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const journal = new SqliteEventJournal(database);
  const artifacts = new SqliteArtifactRepository(database);
  const leaseMs = options.leaseMs ?? 120_000;

  const taskService = new TaskService({
    runs,
    tasks,
    journal,
    tx: database,
    clock,
    bus,
    graph,
    registry,
    leaseMs,
    artifacts,
  });
  const graphService = new GraphService({ graph, tasks, runs, tx: database, clock, taskService });
  const pool = new AgentPool({
    registry,
    ...(options.roleQuotas ? { quotas: options.roleQuotas } : {}),
    ...(options.poolGlobalMax ? { globalMax: options.poolGlobalMax } : {}),
  });
  const recovery = new RecoveryService({ tasks, taskService, clock });
  const reviewMaxRounds = options.reviewMaxRounds === undefined ? 3 : options.reviewMaxRounds;
  const reviewLoop =
    reviewMaxRounds > 0
      ? new ReviewLoopService({ bus, tasks, runs, taskService, clock, maxRounds: reviewMaxRounds })
      : undefined;
  reviewLoop?.attach();

  const supervisorOn = options.supervisor !== false;
  const supervisor = supervisorOn
    ? new SupervisorService({
        bus,
        tasks,
        runs,
        taskService,
        tx: database,
        clock,
        // 显式 !== undefined:0 是合法值(关闭决策),?: 的 falsy 陷阱会吞掉它
        ...(options.supervisorMaxDecisions !== undefined
          ? { maxDecisions: options.supervisorMaxDecisions }
          : {}),
      })
    : undefined;
  supervisor?.attach();

  const pipelineOn = options.pipeline !== false;
  const pipeline = pipelineOn
    ? new PipelineService({
        bus,
        tasks,
        runs,
        taskService,
        clock,
        ...(options.pipelineAutoReview === false ? { autoReview: false } : {}),
        ...(supervisor ? { supervisor } : {}),
      })
    : undefined;
  pipeline?.attach();

  const worktreeRepo = new SqliteWorktreeRepository(database);
  let worktrees: WorktreeService | undefined;
  if (options.isolation === "worktree") {
    const repoRoot =
      options.worktreeManager?.repoRoot ??
      (await GitWorktreeManager.detectRepoRoot(options.defaultWorkingDirectory));
    if (!repoRoot) {
      throw new Error(
        `isolation=worktree requires defaultWorkingDirectory inside a git repository (got: ${options.defaultWorkingDirectory})`,
      );
    }
    const manager =
      options.worktreeManager ?? new GitWorktreeManager({ repoRoot });
    worktrees = new WorktreeService({
      manager,
      worktrees: worktreeRepo,
      taskService,
      tx: database,
      clock,
      bus,
    });
  }

  const governor =
    options.governorBaseCooldownMs === 0
      ? undefined
      : new ExponentialBackoffGovernor({
          clock,
          ...(options.governorBaseCooldownMs !== undefined
            ? { baseCooldownMs: options.governorBaseCooldownMs }
            : {}),
          ...(options.governorMaxCooldownMs !== undefined
            ? { maxCooldownMs: options.governorMaxCooldownMs }
            : {}),
        });

  const scheduler = new Scheduler({
    taskService,
    graphService,
    tasks,
    executor: options.executor,
    pool,
    clock,
    defaultWorkingDirectory: options.defaultWorkingDirectory,
    ...(options.maxConcurrentTasks ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
    heartbeatIntervalMs: Math.max(1_000, Math.floor(leaseMs / 3)),
    ...(options.isolation ? { isolation: options.isolation } : {}),
    ...(options.isolationRoles ? { isolationRoles: options.isolationRoles } : {}),
    ...(worktrees ? { worktrees } : {}),
    ...(governor ? { governor } : {}),
    ...(options.roleModels ? { roleModels: options.roleModels } : {}),
  });

  return {
    database,
    bus,
    graph,
    registry,
    pool,
    taskService,
    graphService,
    scheduler,
    recovery,
    ...(governor ? { governor } : {}),
    ...(reviewLoop ? { reviewLoop } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(supervisor ? { supervisor } : {}),
    ...(worktrees ? { worktrees } : {}),
    artifacts,
    worktreeRepo,
    runs,
    tasks,
    journal,
    close: () => database.close(),
  };
}
