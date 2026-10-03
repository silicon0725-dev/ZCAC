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
  pendingRpc: Map<string, (frame: ProtocolResponse) => void>;
  nextRequestId: number;
  alive: boolean;
  /** 该进程承载的 sessions(key: workspaceKey;一个进程可服务多个 workspace)。 */
  sessions: Map<string, WorkerSession>;
  /** 最近 stderr(崩溃诊断)。 */
  lastStderr: string;
  /** 活动 session 的事件轮询句柄(turn 结束时停止)。 */
  polls: Array<{ stop: () => void }>;
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
    if (!options.cliBundlePath && !this.#env.ZCODE_CLI_BUNDLE) {
      throw new Error(
        "ProtocolAgentExecutor requires an explicit cli bundle path: " +
          "pass { cliBundlePath } or set ZCODE_CLI_BUNDLE (no implicit resolution).",
      );
    }
    this.#cliBundlePath = options.cliBundlePath ?? this.#env.ZCODE_CLI_BUNDLE!;
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

    // ---- session/send(字段是 content,实测 ZodError 校验)----
    // stdio 协议无回合通知流(实测):Turn 完成靠 session/events 轮询。
    let lastEventSeq = 0;
    const poll = setInterval(() => {
      void this.#pollEvents(worker, session, turn, lastEventSeq).then((next) => {
        if (next > lastEventSeq) lastEventSeq = next;
      });
    }, 1_500);
    poll.unref?.();
    worker.polls.push({ stop: () => clearInterval(poll) });

    void this.#rpc(worker, "session/send", {
      sessionId: session.sessionId,
      content: request.prompt,
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
      content: message,
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
      workspace: {
        workspacePath: request.workingDirectory,
        // 真实 schema 必填(实测 ZodError: workspace.workspaceKey expected string)
        workspaceKey: request.workingDirectory,
      },
      mode: "yolo",
      ...(request.tools ? { toolAllowlist: [...request.tools] } : {}),
    });
    const payload = rpcResult(response) as
      | { sessionId?: string; session?: { sessionId?: string } }
      | string
      | undefined;
    // 真实响应形态(实测): sessionId 嵌在 result.session.sessionId;
    // 兼容平铺 result.sessionId 与纯字符串三种形态。
    const sessionId =
      typeof payload === "object" && payload !== null
        ? payload.sessionId ?? payload.session?.sessionId
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
      lastStderr: "",
      polls: [],
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      worker.lastStderr = (worker.lastStderr + chunk.toString("utf8")).slice(-2000);
    });
    this.#processes.add(worker);

    child.stdout?.on("data", (chunk: Buffer) => {
      worker.buffer += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(worker.buffer);
      worker.buffer = rest;
      for (const frame of frames) this.#dispatchFrame(worker, frame);
    });

    child.on("exit", (code, signal) => {
      console.error("[proto] worker exit code=" + code + " signal=" + signal + " stderr=" + worker.lastStderr.slice(-300));
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
            error: `worker process exited unexpectedly: ${worker.lastStderr.slice(-300) || "no stderr"}`,
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
    for (const poll of worker.polls) poll.stop();
    worker.polls = [];
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
    // agent→host 的 rpc 请求(如 session/requestRuntimePreferences):自动应答。
    // 注意:server 请求的 id 是字符串("server-1");必须先检查是否我们自己的 rpc
    // (实测踩过:Number("server-1")=NaN 导致应答不匹配,session/create 超时 -32022)。
    if ("method" in frame && "id" in frame && frame.id !== undefined) {
      const requestId = String(frame.id);
      if (!worker.pendingRpc.has(requestId)) {
        const request = frame as ProtocolNotification & { id: string | number };
        const response = this.#answerHostRpc(request);
        if (response !== undefined) {
          worker.child.stdin?.write(encodeFrame({ id: String(frame.id), result: response }));
          return;
        }
        worker.child.stdin?.write(
          encodeFrame({ id: String(frame.id), error: { code: -32601, message: "method not handled by ZCAC host" } }),
        );
        return;
      }
    }
    if ("id" in frame && frame.id !== undefined) {
      const resolver = worker.pendingRpc.get(String(frame.id));
      if (resolver) {
        worker.pendingRpc.delete(String(frame.id));
        resolver(frame as ProtocolResponse);
        return;
      }
    }
    // 通知:turn.completed(真实协议事件,v1 session event envelope)
    //   {method:"session/event", params:{event:"turn.completed", payload:{response, usage,...}}}
    // 或直接 {method:"turn.completed", params:{...}} —— 两种信封都接受。
    const method = String((frame as ProtocolNotification).method ?? "");
    const params = (frame as ProtocolNotification).params as
      | { event?: string; payload?: Record<string, unknown> }
      | undefined;
    const eventName = params?.event ?? method;
    const payload = (params?.payload ?? params ?? {}) as Record<string, unknown>;
    if (
      eventName === "turn.completed" ||
      eventName.toLowerCase() === "turncompleted" ||
      eventName.toLowerCase().includes("turncomplete")
    ) {
      const response =
        typeof payload.response === "string"
          ? payload.response
          : extractTurnResponse(params);
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
      // late event(无活动 turn)→ 显式丢弃
    }
    if (eventName === "turn.failed") {
      const message = String(payload.error ?? payload.message ?? "turn failed");
      for (const session of worker.sessions.values()) {
        const turn = session.activeTurn;
        if (turn && !turn.settled) {
          this.#settleTurn(turn, {
            status: "failed",
            agentId: turn.agentId,
            role: session.role,
            sessionId: session.sessionId,
            model: "provider-default",
            response: "",
            durationMs: 0,
            error: message,
          });
          this.#poisonSession(worker, session);
          return;
        }
      }
    }
  }

  #rpc(
    worker: WorkerProcess,
    method: string,
    params?: unknown,
  ): Promise<ProtocolResponse> {
    return new Promise((resolve, reject) => {
      const id = String(worker.nextRequestId++);
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

  /**
   * agent→host 请求的自动应答。
   * 返回 undefined 表示不处理(发 method-not-found,agent 走兼容 fallback)。
   */
  #answerHostRpc(request: { method: string; params?: unknown }): unknown | undefined {
    if (request.method === "session/requestRuntimePreferences") {
      // 无宿主偏好的安全默认(与 agent 侧 -32601 fallback 语义一致)
      return {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      };
    }
    if (request.method === "interaction/requestOfficialMcpAuthHeaders") {
      // 无官方 MCP 凭据:空 headers(agent 跳过官方 MCP 认证,不影响任务)
      // 实测踩过:回 -32601 会让 agent 进程直接退出(该方法无 fallback)。
      return { headers: {} };
    }
    return undefined;
  }

  /**
   * 轮询 session/events(1.5s):解析 turn.completed / turn.failed 结算活动 turn。
   * 事件形态(实测):{kind:"turn.completed", payload:{response,...}}。
   * 返回本批次最大 sequence(供游标推进)。
   */
  async #pollEvents(
    worker: WorkerProcess,
    session: WorkerSession,
    turn: Turn,
    afterSeq: number,
  ): Promise<number> {
    if (turn.settled || !worker.alive) return afterSeq;
    try {
      const response = await this.#rpc(worker, "session/events", {
        sessionId: session.sessionId,
        afterSeq,
        limit: 100,
      });
      const events =
        ((rpcResult(response) as { events?: Array<Record<string, unknown>> }).events ?? []);
      let maxSeq = afterSeq;
      for (const event of events) {
        if (typeof event.sequence === "number" && event.sequence > maxSeq) {
          maxSeq = event.sequence;
        }
        const kind = String(event.kind ?? event.type ?? "");
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (session.activeTurn !== turn || turn.settled) return maxSeq;
        if (kind === "turn.completed") {
          this.#settleTurn(turn, {
            status: "completed",
            agentId: turn.agentId,
            role: session.role,
            sessionId: session.sessionId,
            model: "provider-default",
            response: typeof payload.response === "string" ? payload.response : "",
            durationMs: 0,
          });
          this.#releaseSession(worker, session);
          return maxSeq;
        }
        if (kind === "turn.failed") {
          this.#settleTurn(turn, {
            status: "failed",
            agentId: turn.agentId,
            role: session.role,
            sessionId: session.sessionId,
            model: "provider-default",
            response: "",
            durationMs: 0,
            error: String(payload.error ?? payload.message ?? "turn failed"),
          });
          this.#poisonSession(worker, session);
          return maxSeq;
        }
      }
      return maxSeq;
    } catch {
      return afterSeq; // 轮询失败:下一轮再试;崩溃由 exit 处理
    }
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
