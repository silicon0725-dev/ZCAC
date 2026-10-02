/**
 * ZCAC-0008 — Git WorktreeManager(adapter)。
 *
 * 纯 git 命令执行层,无 ZCAC 状态/事件;生命周期编排在 WorktreeService。
 * 全部操作经 execFile('git', ...),非交互;冲突 merge 必须 abort 保持主区干净。
 */

import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import type { CommitResult, MergeResult } from "../../domain/worktree/worktree.js";

/** @types/node 25 的 execFile 重载解析不可靠,这里固定到本用法的签名。 */
type ExecFileFixed = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeout?: number;
    maxBuffer?: number;
    windowsHide?: boolean;
    env: NodeJS.ProcessEnv;
  },
  callback: (error: Error | null, stdout: string) => void,
) => void;
const execFileFixed = execFile as unknown as ExecFileFixed;

/** promisify(execFile) 的重载不可靠,手写 Promise 包装。 */
function execGit(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileFixed(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_EDITOR: ":", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export interface GitWorktreeManagerOptions {
  /** 主仓库根(git rev-parse --show-toplevel)。 */
  repoRoot: string;
  /** worktree 检出根目录;默认 <repoRoot>/.zcac/worktrees。 */
  worktreeRoot?: string;
}

export interface CreateWorktreeGitInput {
  taskId: string;
  baseRef?: string;
}

export class GitWorktreeManager {
  readonly #repoRoot: string;
  readonly #worktreeRoot: string;

  constructor(options: GitWorktreeManagerOptions) {
    this.#repoRoot = resolve(options.repoRoot);
    // 默认放仓库外(同级目录):不污染主仓库的 git status,也无需 .gitignore。
    this.#worktreeRoot = resolve(
      options.worktreeRoot ??
        join(dirname(this.#repoRoot), `.zcac-worktrees-${basename(this.#repoRoot)}`),
    );
  }

  get repoRoot(): string {
    return this.#repoRoot;
  }

  get worktreeRoot(): string {
    return this.#worktreeRoot;
  }

  async #git(args: string[], cwd: string = this.#repoRoot): Promise<string> {
    return execGit(args, cwd);
  }

  /** 探测目录是否为 git 仓库并返回根路径。 */
  static async detectRepoRoot(directory: string): Promise<string | undefined> {
    try {
      const root = await execGit(["rev-parse", "--show-toplevel"], directory);
      return root.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.#git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  /** 创建 worktree + 专属分支 zcac/<taskId>,基于 baseRef(默认 HEAD)。 */
  async create(input: CreateWorktreeGitInput): Promise<{ path: string; branch: string; baseRef: string }> {
    const branch = `zcac/${input.taskId}`;
    const path = join(this.#worktreeRoot, input.taskId);
    const baseRef = input.baseRef ?? "HEAD";
    await this.#git(["worktree", "add", "-b", branch, path, baseRef]);
    return { path, branch, baseRef };
  }

  /** worktree 内提交全部变更;无变更返回 empty。 */
  async commit(path: string, message: string): Promise<CommitResult> {
    let status: string;
    try {
      status = await this.#git(["status", "--porcelain"], path);
    } catch {
      return { empty: true, message: `worktree unavailable: ${path}` };
    }
    if (status.trim().length === 0) {
      return { empty: true, message: "nothing to commit" };
    }
    await this.#git(["add", "-A"], path);
    await this.#git(["commit", "-m", message], path);
    const sha = (await this.#git(["rev-parse", "HEAD"], path)).trim();
    return { sha, empty: false, message };
  }

  /** worktree 相对基线的 diff 文本。 */
  async diff(path: string, baseRef: string): Promise<string> {
    return this.#git(["diff", `${baseRef}..HEAD`], path);
  }

  /**
   * 把 worktree 分支合并进主仓库当前分支。
   * 冲突时 git 返回非零 → 提取冲突文件 → `git merge --abort` 保持主区干净,
   * 分支保留待 Integrator/Supervisor 处理(绝不盲目覆盖)。
   */
  async mergeIntoTarget(
    input: { worktreeId: string; branch: string; target?: string },
  ): Promise<MergeResult> {
    const target = input.target ?? (await this.currentBranch());
    const base: Omit<MergeResult, "status" | "conflictFiles"> = {
      worktreeId: input.worktreeId,
      branch: input.branch,
      target,
    };
    // 与目标当前指向相同(已合并过)→ noop。
    const targetSha = (await this.#git(["rev-parse", "HEAD"])).trim();
    const branchSha = (await this.#git(["rev-parse", input.branch])).trim();
    if (targetSha === branchSha) {
      return { ...base, status: "noop", conflictFiles: [] };
    }
    try {
      await this.#git(["merge", "--no-edit", input.branch]);
      return { ...base, status: "merged", conflictFiles: [] };
    } catch {
      const conflictFiles = await this.#conflictFiles();
      // merge 可能因非冲突原因失败(如无 MERGE_HEAD 的 fast-forward 被拒);
      // abort 仅在确实处于合并中间态时执行,否则会以 128 二次抛错。
      try {
        await this.#git(["merge", "--abort"]);
      } catch {
        // 无 MERGE_HEAD(非冲突失败)或已清理 — 主区保持干净即可
      }
      return { ...base, status: "conflict", conflictFiles };
    }
  }

  async #conflictFiles(): Promise<string[]> {
    try {
      const status = await this.#git(["status", "--porcelain"]);
      return status
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => {
          const code = line.slice(0, 2);
          return code.includes("U") || code.startsWith("AA") || code.startsWith("DD");
        })
        .map((line) => line.slice(3).trim());
    } catch {
      return [];
    }
  }

  /** 删除 worktree 目录与分支(尽力而为,失败不抛)。 */
  async remove(path: string, branch: string): Promise<void> {
    try {
      await this.#git(["worktree", "remove", "--force", path]);
    } catch {
      // 目录可能已不存在/被占用;继续清理分支。
    }
    if (branch) {
      try {
        await this.#git(["branch", "-D", branch]);
      } catch {
        // 分支可能已合并删除;忽略。
      }
    }
  }
}
