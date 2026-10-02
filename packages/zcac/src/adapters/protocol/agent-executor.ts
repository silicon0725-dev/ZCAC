/**
 * ZCAC Phase 13 — ProtocolAgentExecutor(adapter)。
 *
 * Worker = 独立 `zcode app-server --stdio` 子进程(崩溃隔离/多进程)。
 * 与 ZCodeAgentExecutor 实现同一 AgentExecutor 端口;上层零改动。
 *
 * 生命周期:
 *   launch → 获取进程(池复用或新 spawn) → session/create → session/send
 *            → 轮询事件直到 TurnComplete → 释放进程回池
 *   wait   → 同一轮询 promise
 *   stop   → session/stop + 进程树回收
 *   崩溃    → 子进程 exit 时未完成 handle 标记 failed(executor_error)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  decodeFrames,
  encodeFrame,
  isTurnCompleteNotification,
  extractTurnResponse,
  type ProtocolFrame,
  type ProtocolResponse,
  type ProtocolNotification,
} from "./frames.js";
import type {
  AgentExecutor,
  AgentHandle,
  AgentLaunchRequest,
  AgentResult,
} from "../../ports/agent-executor.js";
import type { UsageSummary } from "../../domain/task/task-input.js";

export interface ProtocolExecutorOptions {
  env?: NodeJS.ProcessEnv;
  /** zcode.cjs 入口路径;缺省从 ZCODE_CLI_BUNDLE 或 monorepo 相对路径推断。 */
  cliBundlePath?: string;
  /** idle 子进程保活上限(默认 2/role)。 */
  maxIdlePerRole?: number;
  /** 单任务轮询超时(默认 10 分钟)。 */
  taskTimeoutMs?: number;
}

interface WorkerProcess {
  child: ChildProcess;
  role: string;
  /** 已创建的 session(该进程可复用继续用同一 session) */
  sessionId?: string;
  busy: boolean;
  buffer: string;
  pending: Map<number | string, (frame: ProtocolFrame) => void>;
  nextRequestId: number;
  alive: boolean;
}

interface PendingTurn {
  resolve: (result: AgentResult) => void;
  handle: AgentHandle;
  request: AgentLaunchRequest;
  startedAtMs: number;
  timer: NodeJS.Timeout;
}

export class ProtocolAgentExecutor implements AgentExecutor {
  readonly #cliBundlePath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #maxIdlePerRole: number;
  readonly #taskTimeoutMs: number;
  readonly #workers = new Map<string, WorkerProcess>(); // key: child.pid
  readonly #idleByRole = new Map<string, WorkerProcess[]>();
  readonly #activeTurns = new Map<string, PendingTurn>(); // key: agentId(task-scoped handle id)
  #seq = 0;
  #crashed = 0;

  constructor(options: ProtocolExecutorOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#maxIdlePerRole = options.maxIdlePerRole ?? 2;
    this.#taskTimeoutMs = options.taskTimeoutMs ?? 10 * 60_000;
    this.#cliBundlePath =
      options.cliBundlePath ??
      this.#env.ZCODE_CLI_BUNDLE ??
      this.#resolveDefaultBundle();
  }

  #resolveDefaultBundle(): string {
    const candidates = [
      // monorepo 相对路径(构建产物)
      join(process.cwd(), "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
      // 相对 orchestrator bundle 位置向上找
      "zcode.cjs",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    // 兜底:交给 spawn 报错(错误信息里含路径)
    return candidates[0]!;
  }

  // -------------------------------------------------------------------------
  // AgentExecutor 端口
  // -------------------------------------------------------------------------

  async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const worker = await this.#acquireWorker(request.role);
    const agentId = `proto-${request.role}-${String(++this.#seq).padStart(3, "0")}`;
    const abort = new AbortController();

    // 1) session/create(该进程未创建过 session 时)
    if (!worker.sessionId) {
      const createResult = await this.#rpc(worker, "session/create", {
        workspace: { workspacePath: request.workingDirectory },
        mode: "yolo",
        ...(request.tools ? { toolAllowlist: [...request.tools] } : {}),
      });
      const createPayload = (createResult as ProtocolResponse).result as
        | { sessionId?: string }
        | string
        | undefined;
      worker.sessionId =
        typeof createPayload === "object" && createPayload !== null
          ? createPayload.sessionId
          : (createPayload as string | undefined);
    }

    const handle: AgentHandle = {
      agentId,
      role: request.role,
      sessionId: worker.sessionId!,
      model: request.model ?? "provider-default",
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    // 2) session/send + 轮询直到 TurnComplete
    const turnPromise = this.#runTurn(worker, handle, request);
    const timer = setTimeout(() => {
      const pending = this.#activeTurns.get(agentId);
      if (pending) {
        pending.resolve({
          status: "failed",
          agentId,
          role: request.role,
          sessionId: handle.sessionId,
          model: handle.model,
          response: "",
          durationMs: Date.now() - pending.startedAtMs,
          error: `task timeout after ${this.#taskTimeoutMs}ms`,
        });
        this.#activeTurns.delete(agentId);
      }
    }, this.#taskTimeoutMs);
    timer.unref?.();

    const startedAtMs = Date.now();
    this.#activeTurns.set(agentId, {
      resolve: (result) => {
        clearTimeout(timer);
        handle.resolveTurn?.(result);
      },
      handle,
      request,
      startedAtMs,
      timer,
    });
    // 把 turn promise 挂到 handle 上(wait 复用)
    (handle as AgentHandle & { resolveTurn?: (r: AgentResult) => void }).turnPromise =
      turnPromise.then((result) => ({ ...result, agentId, durationMs: Date.now() - startedAtMs }));
    // 存 turn promise 供 wait
    this.#turnPromises.set(agentId, turnPromise);

    // 触发 session/send(异步;事件经通知回流)
    void this.#rpc(worker, "session/send", {
      sessionId: worker.sessionId,
      prompt: request.prompt,
    }).catch((error: unknown) => {
      // 发送失败:立即失败该 turn
      const pending = this.#activeTurns.get(agentId);
      if (pending) {
        pending.resolve({
          status: "failed",
          agentId,
          role: request.role,
          sessionId: handle.sessionId,
          model: handle.model,
          response: "",
          durationMs: Date.now() - startedAtMs,
          error: `session/send failed: ${String(error)}`,
        });
        this.#activeTurns.delete(agentId);
      }
    });

    return handle;
  }

  readonly #turnPromises = new Map<string, Promise<AgentResult>>();

  async send(handle: AgentHandle, message: string): Promise<void> {
    const worker = this.#workerForSession(handle.sessionId);
    if (!worker) throw new Error(`no worker for session ${handle.sessionId}`);
    await this.#rpc(worker, "session/send", {
      sessionId: handle.sessionId,
      prompt: message,
    });
  }

  async wait(handle: AgentHandle): Promise<AgentResult> {
    const turn = this.#turnPromises.get(handle.agentId);
    if (!turn) throw new Error(`no pending turn for ${handle.agentId}`);
    const result = await turn;
    // 归还进程到池(任务结束)
    const worker = this.#workerForSession(handle.sessionId);
    if (worker) {
      worker.busy = false;
      this.#releaseToPool(worker);
    }
    return result;
  }

  async stop(handle: AgentHandle): Promise<void> {
    const worker = this.#workerForSession(handle.sessionId);
    if (worker?.sessionId) {
      await this.#rpc(worker, "session/stop", { sessionId: worker.sessionId }).catch(() => undefined);
    }
    const pending = this.#activeTurns.get(handle.agentId);
    if (pending) {
      pending.resolve({
        status: "cancelled",
        agentId: handle.agentId,
        role: handle.role,
        sessionId: handle.sessionId,
        model: handle.model,
        response: "",
        durationMs: Date.now() - pending.startedAtMs,
        error: "stopped by ZCAC",
      });
      this.#activeTurns.delete(handle.agentId);
    }
  }

  async dispose(handle?: AgentHandle): Promise<void> {
    if (handle) {
      const worker = this.#workerForSession(handle.sessionId);
      if (worker) this.#killWorker(worker);
      return;
    }
    for (const worker of [...this.#workers.values()]) {
      this.#killWorker(worker);
    }
    this.#workers.clear();
    this.#idleByRole.clear();
  }

  /** 当前保活子进程数(观察用)。 */
  get workerCount(): number {
    return this.#workers.size;
  }

  get crashCount(): number {
    return this.#crashed;
  }

  // -------------------------------------------------------------------------
  // 进程池
  // -------------------------------------------------------------------------

  async #acquireWorker(role: string): Promise<WorkerProcess> {
    const idle = this.#idleByRole.get(role);
    const reusable = idle?.find((w) => w.alive && !w.busy);
    if (reusable) {
      reusable.busy = true;
      return reusable;
    }
    return this.#spawnWorker(role);
  }

  #releaseToPool(worker: WorkerProcess): void {
    if (!worker.alive) return;
    const pool = this.#idleByRole.get(worker.role) ?? [];
    if (pool.length >= this.#maxIdlePerRole) {
      this.#killWorker(worker);
      return;
    }
    pool.push(worker);
    this.#idleByRole.set(worker.role, pool);
  }

  #spawnWorker(role: string): WorkerProcess {
    const child = spawn(process.execPath, [this.#cliBundlePath, "app-server", "--stdio"], {
      env: this.#env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const worker: WorkerProcess = {
      child,
      role,
      busy: true,
      buffer: "",
      pending: new Map(),
      nextRequestId: 1,
      alive: true,
    };
    this.#workers.set(String(child.pid), worker);

    child.stdout?.on("data", (chunk: Buffer) => {
      worker.buffer += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(worker.buffer);
      worker.buffer = rest;
      for (const frame of frames) {
        this.#dispatchFrame(worker, frame);
      }
    });

    child.on("exit", () => {
      worker.alive = false;
      this.#crashed += 1;
      // 未完成 turn 标记失败
      for (const [agentId, pending] of [...this.#activeTurns.entries()]) {
        if (pending.handle.sessionId === worker.sessionId) {
          pending.resolve({
            status: "failed",
            agentId,
            role: pending.handle.role,
            sessionId: pending.handle.sessionId,
            model: pending.handle.model,
            response: "",
            durationMs: Date.now() - pending.startedAtMs,
            error: "worker process exited unexpectedly",
          });
          this.#activeTurns.delete(agentId);
        }
      }
      // 从池中移除
      const pool = this.#idleByRole.get(worker.role);
      if (pool) {
        const index = pool.indexOf(worker);
        if (index !== -1) pool.splice(index, 1);
      }
    });

    return worker;
  }

  #workerForSession(sessionId: string): WorkerProcess | undefined {
    for (const worker of this.#workers.values()) {
      if (worker.sessionId === sessionId) return worker;
    }
    return undefined;
  }

  #killWorker(worker: WorkerProcess): void {
    worker.alive = false;
    if (!worker.child.killed) {
      worker.child.kill();
    }
    this.#workers.delete(String(worker.child.pid));
  }

  // -------------------------------------------------------------------------
  // 协议
  // -------------------------------------------------------------------------

  #dispatchFrame(worker: WorkerProcess, frame: ProtocolFrame): void {
    // 响应:匹配 pending rpc
    if ("id" in frame && frame.id !== undefined) {
      const resolver = worker.pending.get(frame.id);
      if (resolver) {
        worker.pending.delete(frame.id);
        resolver(frame);
      }
      return;
    }
    // 通知:TurnComplete → 解析结果 → resolve 活动 turn
    if (isTurnCompleteNotification(frame)) {
      const response = extractTurnResponse((frame as ProtocolNotification).params);
      // 取最早的活动 turn(单 session 同时只有一个 turn)
      const entries = [...this.#activeTurns.entries()].filter(
        ([, pending]) => pending.handle.sessionId === worker.sessionId,
      );
      if (entries.length > 0) {
        const [agentId, pending] = entries[0]!;
        pending.resolve({
          status: "completed",
          agentId,
          role: pending.handle.role,
          sessionId: pending.handle.sessionId,
          model: pending.handle.model,
          response,
          durationMs: Date.now() - pending.startedAtMs,
        });
        this.#activeTurns.delete(agentId);
        this.#turnPromises.delete(agentId);
      }
    }
  }

  #rpc(
    worker: WorkerProcess,
    method: string,
    params?: unknown,
  ): Promise<ProtocolFrame> {
    return new Promise((resolve, reject) => {
      const id = worker.nextRequestId++;
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, 60_000);
      timer.unref?.();
      worker.pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      worker.child.stdin?.write(encodeFrame({ id, method, params }));
    });
  }

  /** 一个 turn = session/send + 事件轮询(在通知流中等待 TurnComplete)。 */
  #runTurn(
    worker: WorkerProcess,
    handle: AgentHandle,
    request: AgentLaunchRequest,
  ): Promise<AgentResult> {
    // turn 的 resolve 在 #dispatchFrame(TurnComplete) 或超时/崩溃中;
    // 这里返回一个 promise 占位,实际 resolve 通道由 #activeTurns 管理。
    return new Promise<AgentResult>((resolve) => {
      // wait() 会从 #turnPromises 拿到这个 promise;
      // resolve 通过 #activeTurns 完成(见 dispatch/timeout/crash)。
      const original = this.#activeTurns.get(handle.agentId);
      if (original) {
        const innerResolve = original.resolve;
        original.resolve = (result: AgentResult) => {
          innerResolve(result);
          resolve(result);
        };
      } else {
        // launch 已设置;保险:超时兜底
        const timer = setTimeout(() => {
          resolve({
            status: "failed",
            agentId: handle.agentId,
            role: request.role,
            sessionId: handle.sessionId,
            model: handle.model,
            response: "",
            durationMs: this.#taskTimeoutMs,
            error: "turn promise fallback timeout",
          });
        }, this.#taskTimeoutMs + 5_000);
        timer.unref?.();
      }
    });
  }
}

// AgentHandle 扩展:turn promise 通道(类型侧最小侵入)
declare module "../../ports/agent-executor.js" {
  interface AgentHandle {
    resolveTurn?: (result: AgentResult) => void;
    turnPromise?: Promise<AgentResult> & { agentId?: string };
  }
}

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

// UsageSummary re-export(类型对齐)
export type { UsageSummary };
