/**
 * ZCAC Phase 13 — ProtocolAgentExecutor(adapter,v0.3 重建模)。
 *
 * Worker → Session → Turn 三层生命周期(审查修正版):
 *
 *   WorkerProcess  = 子进程(可承载多个 session)
 *   WorkerSession  = workspace + policy 绑定(池 key 含 workspace,不串)
 *   Turn           = 一次 session/send → TurnComplete(显式 settle 幂等)
 *
 * 生命周期保证:
 *   - launch 先建 Turn 通道(resolve 引用)再注册活动表(无时序窗口)
 *   - TurnComplete 按 session 精确匹配;late event 显式丢弃
 *   - timeout/crash/stop 的 session 立即污染销毁(不回池)
 *   - 干净完成的 session 归还池(workspace 隔离:不同 worktree 不串)
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  decodeFrames,
  encodeFrame,
  extractTurnResponse,
  rpcResult,
  type ProtocolFrame,
  type ProtocolNotification,
  type ProtocolResponse,
} from "./frames.js";
import type {
  AgentExecutor,
  AgentHandle,
  AgentLaunchRequest,
  AgentResult,
} from "../../ports/agent-executor.js";

// ---------------------------------------------------------------------------
// 三层生命周期模型
// ---------------------------------------------------------------------------

interface WorkerProcess {
  child: ChildProcess;
  buffer: string;
  pendingRpc: Map<number, (frame: ProtocolResponse) => void>;
  nextRequestId: number;
  alive: boolean;
  /** 该进程承载的 sessions(key: workspaceKey;一个进程可服务多个 workspace)。 */
  sessions: Map<string, WorkerSession>;
}

interface WorkerSession {
  sessionId: string;
  workspaceKey: string;
  role: string;
  activeTurn?: Turn;
  /** 超时/崩溃/stop 后置位:worker 必须弃用。 */
  poisoned: boolean;
}

interface Turn {
  agentId: string;
  resolve: (result: AgentResult) => void;
  settled: boolean;
  timer: NodeJS.Timeout;
}

interface AgentHandleInternal extends AgentHandle {
  turnPromise: Promise<AgentResult>;
}

export interface ProtocolExecutorOptions {
  env?: NodeJS.ProcessEnv;
  cliBundlePath?: string;
  /** 归还池上限(每 workspace key);默认 2。 */
  maxIdlePerWorkspace?: number;
  /** 单 turn 超时(默认 10 分钟)。 */
  taskTimeoutMs?: number;
  /** 注入 spawn(测试 fake 子进程)。 */
  spawnOverride?: typeof spawn;
}

export class ProtocolAgentExecutor implements AgentExecutor {
  readonly #cliBundlePath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #maxIdle: number;
  readonly #taskTimeoutMs: number;
  readonly #spawnFn: typeof spawn;

  readonly #processes = new Set<WorkerProcess>();
  readonly #idleSessions = new Map<string, { worker: WorkerProcess; session: WorkerSession }[]>();
  readonly #turns = new Map<string, Turn>();
  #seq = 0;
  #crashCount = 0;

  constructor(options: ProtocolExecutorOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#maxIdle = options.maxIdlePerWorkspace ?? 2;
    this.#taskTimeoutMs = options.taskTimeoutMs ?? 10 * 60_000;
    this.#spawnFn = options.spawnOverride ?? spawn;
    this.#cliBundlePath =
      options.cliBundlePath ??
      this.#env.ZCODE_CLI_BUNDLE ??
      "apps/zcode-cli/packages/cli/dist/zcode.cjs";
  }

  get processCount(): number {
    return this.#processes.size;
  }

  get crashCount(): number {
    return this.#crashCount;
  }

  // -------------------------------------------------------------------------
  // AgentExecutor 端口
  // -------------------------------------------------------------------------

  async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const workspaceKey = `${request.role}::${request.workingDirectory}`;
    const { worker, session } = await this.#acquireSession(workspaceKey, request);

    // ---- P0-1 修复:先建 Turn 通道(resolve 引用),再注册活动表 ----
    const agentId = `proto-${request.role}-${String(++this.#seq).padStart(3, "0")}`;
    let resolveTurn!: (result: AgentResult) => void;
    const turnPromise = new Promise<AgentResult>((resolve) => {
      resolveTurn = resolve;
    });

    const startedAtMs = Date.now();
    const timer = setTimeout(() => {
      // 超时:结算为 failed 并污染 session(旧 TurnComplete 不得串扰后续任务)
      this.#settleTurn(turn, {
        status: "failed",
        agentId,
        role: request.role,
        sessionId: session.sessionId,
        model: request.model ?? "provider-default",
        response: "",
        durationMs: Date.now() - startedAtMs,
        error: `task timeout after ${this.#taskTimeoutMs}ms`,
      });
      this.#poisonSession(worker, session);
    }, this.#taskTimeoutMs);
    timer.unref?.();

    const turn: Turn = { agentId, resolve: resolveTurn, settled: false, timer };
    session.activeTurn = turn;
    this.#turns.set(agentId, turn);

    const handle: AgentHandleInternal = {
      agentId,
      role: request.role,
      sessionId: session.sessionId,
      model: request.model ?? "provider-default",
      turnPromise,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    // ---- session/send(异步;TurnComplete 通知匹配 session 的活动 turn) ----
    void this.#rpc(worker, "session/send", {
      sessionId: session.sessionId,
      prompt: request.prompt,
    }).catch((error: unknown) => {
      this.#settleTurn(turn, {
        status: "failed",
        agentId,
        role: request.role,
        sessionId: session.sessionId,
        model: handle.model,
        response: "",
        durationMs: Date.now() - startedAtMs,
        error: `session/send failed: ${String(error)}`,
      });
    });

    return handle;
  }

  async wait(handle: AgentHandle): Promise<AgentResult> {
    return (handle as AgentHandleInternal).turnPromise;
  }

  async send(handle: AgentHandle, message: string): Promise<void> {
    const found = this.#findBySessionId(handle.sessionId);
    if (!found?.worker || !found.session) throw new Error(`no session ${handle.sessionId}`);
    await this.#rpc(found.worker, "session/send", {
      sessionId: found.session.sessionId,
      prompt: message,
    });
  }

  async stop(handle: AgentHandle): Promise<void> {
    const turn = this.#turns.get(handle.agentId);
    if (turn && !turn.settled) {
      this.#settleTurn(turn, {
        status: "cancelled",
        agentId: handle.agentId,
        role: handle.role,
        sessionId: handle.sessionId,
        model: handle.model,
        response: "",
        durationMs: 0,
        error: "stopped by ZCAC",
      });
    }
    // stop 后 TurnComplete 是幽灵 → session 污染弃用
    const found = this.#findBySessionId(handle.sessionId);
    if (found?.worker && found.session) this.#poisonSession(found.worker, found.session);
  }

  async dispose(handle?: AgentHandle): Promise<void> {
    if (handle) {
      const found = this.#findBySessionId(handle.sessionId);
      if (found?.worker) this.#killWorker(found.worker);
      return;
    }
    for (const worker of [...this.#processes]) this.#killWorker(worker);
    this.#idleSessions.clear();
    this.#turns.clear();
  }

  // -------------------------------------------------------------------------
  // Worker/Session 池(workspace 隔离)
  // -------------------------------------------------------------------------

  async #acquireSession(
    workspaceKey: string,
    request: AgentLaunchRequest,
  ): Promise<{ worker: WorkerProcess; session: WorkerSession }> {
    const pool = this.#idleSessions.get(workspaceKey);
    const reusable = pool?.pop();
    if (reusable && reusable.worker.alive && !reusable.session.poisoned) {
      return { worker: reusable.worker, session: reusable.session };
    }
    if (reusable) this.#killWorker(reusable.worker); // 死进程清理
    const worker = this.#spawnWorker();
    const session = await this.#createSession(worker, workspaceKey, request);
    return { worker, session };
  }

  async #createSession(
    worker: WorkerProcess,
    workspaceKey: string,
    request: AgentLaunchRequest,
  ): Promise<WorkerSession> {
    const response = await this.#rpc(worker, "session/create", {
      workspace: { workspacePath: request.workingDirectory },
      mode: "yolo",
      ...(request.tools ? { toolAllowlist: [...request.tools] } : {}),
    });
    const payload = rpcResult(response) as { sessionId?: string } | string | undefined;
    const sessionId =
      typeof payload === "object" && payload !== null
        ? payload.sessionId
        : (payload as string | undefined);
    if (!sessionId) {
      this.#killWorker(worker);
      throw new Error(`session/create returned no sessionId: ${JSON.stringify(payload)}`);
    }
    const session: WorkerSession = {
      sessionId,
      workspaceKey,
      role: request.role,
      poisoned: false,
    };
    worker.sessions.set(workspaceKey, session);
    return session;
  }

  #releaseSession(worker: WorkerProcess, session: WorkerSession): void {
    if (!worker.alive || session.poisoned) {
      this.#killWorker(worker);
      return;
    }
    const pool = this.#idleSessions.get(session.workspaceKey) ?? [];
    if (pool.length >= this.#maxIdle) {
      this.#killWorker(worker);
      return;
    }
    pool.push({ worker, session });
    this.#idleSessions.set(session.workspaceKey, pool);
  }

  #poisonSession(worker: WorkerProcess, session: WorkerSession): void {
    session.poisoned = true;
    this.#killWorker(worker);
  }

  #spawnWorker(): WorkerProcess {
    const child = this.#spawnFn(
      process.execPath,
      [this.#cliBundlePath, "app-server", "--stdio"],
      { env: this.#env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const worker: WorkerProcess = {
      child,
      buffer: "",
      pendingRpc: new Map(),
      nextRequestId: 1,
      alive: true,
      sessions: new Map(),
    };
    this.#processes.add(worker);

    child.stdout?.on("data", (chunk: Buffer) => {
      worker.buffer += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(worker.buffer);
      worker.buffer = rest;
      for (const frame of frames) this.#dispatchFrame(worker, frame);
    });

    child.on("exit", () => {
      worker.alive = false;
      this.#crashCount += 1;
      // 该进程全部 session 的活动 turn 结算为 failed(P0-3: 崩溃标记)
      for (const session of worker.sessions.values()) {
        if (session.activeTurn && !session.activeTurn.settled) {
          this.#settleTurn(session.activeTurn, {
            status: "failed",
            agentId: session.activeTurn.agentId,
            role: session.role,
            sessionId: session.sessionId,
            model: "provider-default",
            response: "",
            durationMs: 0,
            error: "worker process exited unexpectedly",
          });
        }
      }
      this.#evictWorkerFromPools(worker);
    });

    return worker;
  }

  #findBySessionId(sessionId: string): {
    worker?: WorkerProcess;
    session?: WorkerSession;
  } {
    for (const worker of this.#processes) {
      for (const session of worker.sessions.values()) {
        if (session.sessionId === sessionId) return { worker, session };
      }
    }
    return {};
  }

  #killWorker(worker: WorkerProcess): void {
    worker.alive = false;
    if (!worker.child.killed) worker.child.kill();
    this.#processes.delete(worker);
    this.#evictWorkerFromPools(worker);
  }

  #evictWorkerFromPools(worker: WorkerProcess): void {
    for (const [key, pool] of [...this.#idleSessions.entries()]) {
      this.#idleSessions.set(
        key,
        pool.filter((entry) => entry.worker !== worker),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 协议分发
  // -------------------------------------------------------------------------

  #dispatchFrame(worker: WorkerProcess, frame: ProtocolFrame): void {
    if ("id" in frame && frame.id !== undefined) {
      const resolver = worker.pendingRpc.get(Number(frame.id));
      if (resolver) {
        worker.pendingRpc.delete(Number(frame.id));
        resolver(frame as ProtocolResponse);
      }
      return;
    }
    // 通知:TurnComplete → 该 worker 任一 session 的活动 turn 结算
    const method = (frame as ProtocolNotification).method;
    if (typeof method === "string" && method.toLowerCase().includes("turncomplete")) {
      const response = extractTurnResponse((frame as ProtocolNotification).params);
      for (const session of worker.sessions.values()) {
        const turn = session.activeTurn;
        if (turn && !turn.settled) {
          this.#settleTurn(turn, {
            status: "completed",
            agentId: turn.agentId,
            role: session.role,
            sessionId: session.sessionId,
            model: "provider-default",
            response,
            durationMs: 0,
          });
          this.#releaseSession(worker, session);
          return;
        }
      }
      // late event(无活动 turn)→ 显式丢弃(P0-3)
    }
  }

  #rpc(
    worker: WorkerProcess,
    method: string,
    params?: unknown,
  ): Promise<ProtocolResponse> {
    return new Promise((resolve, reject) => {
      const id = worker.nextRequestId++;
      const timer = setTimeout(() => {
        worker.pendingRpc.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, 60_000);
      timer.unref?.();
      worker.pendingRpc.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      worker.child.stdin?.write(encodeFrame({ id, method, params }));
    });
  }

  /** 单一结算入口:幂等;清理活动表/timer。 */
  #settleTurn(turn: Turn, result: AgentResult): void {
    if (turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    this.#turns.delete(turn.agentId);
    for (const worker of this.#processes) {
      for (const session of worker.sessions.values()) {
        if (session.activeTurn === turn) session.activeTurn = undefined;
      }
    }
    turn.resolve(result);
  }
}
