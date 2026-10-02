/**
 * 测试装配::memory: 或临时文件 SQLite + FakeExecutor。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac, type ZcacApp } from "../src/application/build.js";
import type { AgentExecutor, AgentHandle, AgentLaunchRequest, AgentResult } from "../src/ports/agent-executor.js";
import type { Clock } from "../src/ports/clock.js";

export interface TestContext {
  app: ZcacApp;
  fake: FakeExecutor;
  cleanup(): Promise<void>;
}

export async function createTestContext(options?: {
  databasePath?: string;
  maxConcurrentTasks?: number;
  leaseMs?: number;
  roleQuotas?: Record<string, number>;
  poolGlobalMax?: number;
  clock?: Clock;
  reviewMaxRounds?: number;
}): Promise<TestContext> {
  let databasePath = options?.databasePath;
  let tempDir: string | undefined;
  if (databasePath === undefined) {
    tempDir = await mkdtemp(join(tmpdir(), "zcac-test-"));
    databasePath = join(tempDir, "zcac.sqlite");
  }
  const fake = new FakeExecutor();
  const app = await buildZcac({
    databasePath,
    executor: fake,
    defaultWorkingDirectory: tempDir ?? process.cwd(),
    ...(options?.maxConcurrentTasks ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
    ...(options?.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...(options?.roleQuotas ? { roleQuotas: options.roleQuotas } : {}),
    ...(options?.poolGlobalMax ? { poolGlobalMax: options.poolGlobalMax } : {}),
    ...(options?.clock ? { clock: options.clock } : {}),
    ...(options?.reviewMaxRounds !== undefined
      ? { reviewMaxRounds: options.reviewMaxRounds }
      : {}),
  });
  return {
    app,
    fake,
    cleanup: async () => {
      app.close();
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export class FakeExecutor implements AgentExecutor {
  readonly launches: AgentLaunchRequest[] = [];
  readonly #deferreds = new Map<
    string,
    { resolve: (result: AgentResult) => void; promise: Promise<AgentResult> }
  >();
  #counter = 0;

  async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const agentId = `fake-${String(++this.#counter).padStart(2, "0")}`;
    this.launches.push(request);
    let resolve!: (result: AgentResult) => void;
    const promise = new Promise<AgentResult>((res) => {
      resolve = res;
    });
    this.#deferreds.set(agentId, { resolve, promise });
    return {
      agentId,
      role: request.role,
      sessionId: `sess-${agentId}`,
      model: request.model ?? "fake/model",
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  async send(): Promise<void> {}

  async wait(handle: AgentHandle): Promise<AgentResult> {
    const deferred = this.#deferreds.get(handle.agentId);
    if (!deferred) throw new Error(`FakeExecutor: unknown handle ${handle.agentId}`);
    return deferred.promise;
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const deferred of this.#deferreds.values()) {
      deferred.resolve(fakeResult("fake", "cancelled", "disposed"));
    }
    this.#deferreds.clear();
  }

  complete(agentId: string, response = "done"): void {
    this.#deferreds.get(agentId)?.resolve(fakeResult(agentId, "completed", undefined, response));
  }

  fail(agentId: string, error = "boom"): void {
    this.#deferreds.get(agentId)?.resolve(fakeResult(agentId, "failed", error));
  }

  /** 第 n 次 launch(1-based)的 agentId。 */
  agentIdOfLaunch(n: number): string {
    return `fake-${String(n).padStart(2, "0")}`;
  }
}

function fakeResult(
  agentId: string,
  status: AgentResult["status"],
  error?: string,
  response = "",
): AgentResult {
  return {
    status,
    agentId,
    role: "coder",
    sessionId: `sess-${agentId}`,
    model: "fake/model",
    response,
    durationMs: 1,
    ...(error ? { error } : {}),
    usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
  };
}

/** 轮询等待条件成立(测试驱动异步调度用)。 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
