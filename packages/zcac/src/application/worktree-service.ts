/**
 * ZCAC-0008 — WorktreeService(application):生命周期编排 + 事件。
 *
 *   createForTask    → WORKTREE_CREATED   (claim 后、launch 前)
 *   commitTask       → committed          (任务成功后;无变更则保持 created)
 *   abandonTask      → abandoned + WORKTREE_REMOVED (任务失败/取消后清理)
 *   mergeRun         → MERGE_STARTED/MERGE_COMPLETED|MERGE_CONFLICT
 *                      (run 全部任务成功后,按创建顺序逐个合并进主分支)
 */

import type { GitWorktreeManager } from "../adapters/git/worktree-manager.js";
import type { Task } from "../domain/task/task.js";
import type {
  CommitResult,
  MergeResult,
  Worktree,
} from "../domain/worktree/worktree.js";
import type { Clock, TransactionRunner } from "../ports/clock.js";
import type { WorktreeRepository } from "../ports/worktree-repository.js";
import type { ClusterEventBus } from "../domain/event/event-bus.js";
import type { TaskService } from "./task-service.js";

export interface WorktreeServiceDeps {
  manager: GitWorktreeManager;
  worktrees: WorktreeRepository;
  taskService: TaskService;
  tx: TransactionRunner;
  clock: Clock;
  bus: ClusterEventBus;
}

export class WorktreeService {
  /** 对同一主仓库的 git 写操作(worktree add/commit/merge)必须互斥:index.lock 竞争。 */
  #gitChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorktreeServiceDeps) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#gitChain.then(operation, operation);
    this.#gitChain = result.catch(() => undefined);
    return result;
  }

  async createForTask(task: Task): Promise<Worktree> {
    const created = await this.enqueue(() => this.deps.manager.create({ taskId: task.id }));
    const now = this.deps.clock.now();
    const worktree: Worktree = {
      id: `worktree_${crypto.randomUUID()}`,
      runId: task.runId,
      taskId: task.id,
      path: created.path,
      branch: created.branch,
      baseRef: created.baseRef,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    const event = this.deps.tx.run(() => {
      this.deps.worktrees.insert(worktree);
      return this.deps.taskService.appendEvent(
        task.runId,
        "WORKTREE_CREATED",
        task.id,
        { worktreeId: worktree.id, path: worktree.path, branch: worktree.branch },
      );
    });
    this.deps.bus.publish(event);
    return worktree;
  }

  /** 任务成功后提交 worktree 变更;无变更时保持 created 状态(合并时 noop)。 */
  async commitTask(taskId: string, message: string): Promise<Worktree | undefined> {
    const worktree = this.deps.worktrees.findByTask(taskId);
    if (!worktree || worktree.status !== "created") return undefined;
    const commit = await this.deps.manager.commit(worktree.path, message);
    const updated: Worktree = {
      ...worktree,
      status: commit.empty ? "created" : "committed",
      ...(commit.sha ? { commitSha: commit.sha } : {}),
      updatedAt: this.deps.clock.now(),
    };
    this.deps.tx.run(() => this.deps.worktrees.update(updated));
    return updated;
  }

  /** 任务失败/取消后清理 worktree(分支与目录一并移除)。 */
  async abandonTask(taskId: string): Promise<void> {
    const worktree = this.deps.worktrees.findByTask(taskId);
    if (!worktree) return;
    await this.enqueue(() => this.deps.manager.remove(worktree.path, worktree.branch));
    const updated: Worktree = {
      ...worktree,
      status: "abandoned",
      updatedAt: this.deps.clock.now(),
    };
    const event = this.deps.tx.run(() => {
      this.deps.worktrees.update(updated);
      return this.deps.taskService.appendEvent(
        worktree.runId,
        "WORKTREE_REMOVED",
        worktree.taskId,
        { worktreeId: worktree.id, reason: "task_failed" },
      );
    });
    this.deps.bus.publish(event);
  }

  /**
   * 任务成功即合并(Phase 7):commit → merge 进主分支。
   * 冲突不抛出——返回 conflict 信息由调用方(Scheduler)决定任务级失败。
   */
  async commitAndMergeTask(
    taskId: string,
    message: string,
    target?: string,
  ): Promise<
    | { committed: false; merge: undefined }
    | { committed: true; merge: "merged" | "noop" }
    | { committed: true; merge: "conflict"; conflictFiles: string[] }
  > {
    const worktree = this.deps.worktrees.findByTask(taskId);
    if (!worktree) return { committed: false, merge: undefined };
    return this.enqueue(async () => {
      const commit = await this.deps.manager.commit(worktree.path, message);
      if (commit.empty) {
        // 无变更:无需合并(worktree 分支与基线一致)
        this.deps.tx.run(() =>
          this.deps.worktrees.update({
            ...worktree,
            ...(commit.sha ? { commitSha: commit.sha } : {}),
            updatedAt: this.deps.clock.now(),
          }),
        );
        return { committed: true, merge: "noop" as const };
      }
      const updated: Worktree = {
        ...worktree,
        status: "committed",
        ...(commit.sha ? { commitSha: commit.sha } : {}),
        updatedAt: this.deps.clock.now(),
      };
      this.deps.tx.run(() => this.deps.worktrees.update(updated));
      const result = await this.#mergeOne(updated, target);
      if (result.status === "conflict") {
        return { committed: true, merge: "conflict" as const, conflictFiles: result.conflictFiles };
      }
      return { committed: true, merge: result.status };
    });
  }

  /**
   * Run 级合并兜底:处理遗留的 committed(如崩溃后恢复)与未合并 worktree。
   * 任务级 commitAndMergeTask 已合并的分支在此处返回 noop。
   */
  async mergeRun(runId: string, target?: string): Promise<MergeResult[]> {
    const results: MergeResult[] = [];
    for (const worktree of this.deps.worktrees.listByRun(runId)) {
      if (worktree.status === "abandoned" || worktree.status === "conflict") continue;
      if (worktree.status === "merged") continue; // 已任务级合并
      results.push(await this.#mergeOne(worktree, target));
    }
    return results;
  }

  /** 单个 worktree 合并 + 状态迁移 + MERGE_* 事件(journal-first)。 */
  async #mergeOne(worktree: Worktree, target?: string): Promise<MergeResult> {
    const runId = worktree.runId;
    this.deps.bus.publish(
      this.deps.tx.run(() =>
        this.deps.taskService.appendEvent(runId, "MERGE_STARTED", worktree.taskId, {
          worktreeId: worktree.id,
          branch: worktree.branch,
        }),
      ),
    );
    const result = await this.deps.manager.mergeIntoTarget({
      worktreeId: worktree.id,
      branch: worktree.branch,
      ...(target ? { target } : {}),
    });
    const status: Worktree["status"] =
      result.status === "conflict" ? "conflict" : "merged";
    this.deps.bus.publish(
      this.deps.tx.run(() => {
        this.deps.worktrees.update({
          ...worktree,
          status,
          updatedAt: this.deps.clock.now(),
        });
        return this.deps.taskService.appendEvent(
          runId,
          result.status === "conflict" ? "MERGE_CONFLICT" : "MERGE_COMPLETED",
          worktree.taskId,
          {
            worktreeId: worktree.id,
            branch: result.branch,
            target: result.target,
            ...(result.conflictFiles.length > 0
              ? { conflictFiles: result.conflictFiles }
              : {}),
          },
        );
      }),
    );
    return result;
  }
}
