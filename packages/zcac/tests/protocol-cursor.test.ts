/**
 * ZCAC Phase 13b — Event Cursor / Poll 生命周期 / Send 失败回归测试。
 *
 * 覆盖审查矩阵(真实 session/events 轮询路径,非旧式通知):
 *   1. cursor reuse — Task B 复用 session 后不重放 Task A 的 turn.completed
 *   2. poll cleanup — 多任务复用后无 interval 累积
 *   3. send failure — rpc 错误帧 → task failed + session 污染
 *   4. multi-turn — 同一 session 多轮 send 生命周期
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProtocolAgentExecutor } from "../src/adapters/protocol/agent-executor.js";
import type { AgentHandle, AgentLaunchRequest } from "../src/ports/agent-executor.js";

// ---------------------------------------------------------------------------
// EventStoreFake:模拟真实 app-server 的 session/events 轮询路径
// ---------------------------------------------------------------------------

interface StoreEvent {
  sequence: number;
  kind: string;
  payload?: Record<string, unknown>;
}

interface FakeController {
  child: EventEmitter & {
    stdin: { write: (s: string) => void; killed: boolean };
    stdout: EventEmitter;
    killed: boolean;
  };
  emitLine: (json: string) => void;
  emitExit: () => void;
  readonly received: Array<{ id: string; method: string; params?: unknown }>;
  /** 客户端发来的全部 afterSeq 值(session/events 轮询游标审计)。 */
  readonly afterSeqLog: number[];
  kill: () => void;
}

/**
 * 事件存储型 fake:
 *   - session/create → 自动应答唯一 sessionId
 *   - session/events → 从 store 过滤 sequence > afterSeq 返回(审计 afterSeq)
 *   - session/send   → 可编程(默认 accepted)
 * 完成完全由 store 驱动:测试向 store 追加 turn.completed 事件即触发结算。
 */
function createEventStoreFake(
  controllers: FakeController[],
  store: { events: StoreEvent[] },
  sendBehavior: "accept" | "error" = "accept",
): typeof import("node:child_process").spawn {
  let sessionCounter = 0;
  const fn = () => {
    const received: Array<{ id: string; method: string; params?: unknown }> = [];
    const afterSeqLog: number[] = [];
    const child = new EventEmitter() as FakeController["child"] & { kill: () => void };
    child.stdout = new EventEmitter();
    child.killed = false;
    let sessionSeq = 0;
    const sessionIndex = controllers.length + 1;
    const respond = (frame: Record<string, unknown>): void => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
      });
    };
    child.stdin = {
      write: (line: string) => {
        let parsed: { id: string; method: string; params?: Record<string, unknown> };
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        received.push(parsed);
        if (parsed.method === "session/create") {
          sessionSeq += 1;
          respond({ id: parsed.id, result: { session: { sessionId: `sess-${sessionIndex}-${sessionSeq}` } } });
          return;
        }
        if (parsed.method === "session/events") {
          const afterSeq = typeof parsed.params?.afterSeq === "number" ? parsed.params.afterSeq : 0;
          afterSeqLog.push(afterSeq);
          const events = store.events.filter((e) => e.sequence > afterSeq).slice(0, 100);
          respond({ id: parsed.id, result: { events } });
          return;
        }
        if (parsed.method === "session/send") {
          if (sendBehavior === "error") {
            respond({ id: parsed.id, error: { code: -32010, message: "chaos: send rejected" } });
          } else {
            respond({ id: parsed.id, result: { accepted: true, sessionId: parsed.params?.sessionId } });
          }
          return;
        }
        // 其它 agent→host 请求
        if (parsed.method === "session/requestRuntimePreferences") {
          respond({
            id: parsed.id,
            result: {
              nativeSearchEnhancementsEnabled: true,
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: true,
            },
          });
          return;
        }
        respond({ id: parsed.id, error: { code: -32601, message: "unhandled" } });
      },
      killed: false,
    };
    child.kill = () => {
      child.killed = true;
      child.emit("exit", 0);
      return true;
    };
    const control: FakeController = {
      child,
      emitLine: (json: string) => {
        child.stdout.emit("data", Buffer.from(`${json}\n`, "utf8"));
      },
      emitExit: () => child.emit("exit", 0),
      received,
      afterSeqLog,
      kill: () => child.kill(),
    };
    controllers.push(control);
    return child;
  };
  return fn as unknown as typeof import("node:child_process").spawn;
}

function req(overrides?: Partial<AgentLaunchRequest>): AgentLaunchRequest {
  return {
    role: "coder",
    prompt: "task",
    workingDirectory: "/ws/project",
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** 等待条件成立(轮询间隔 50ms 时 5s 足够)。 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("event cursor / poll lifecycle (real polling path)", () => {
  it("cursor reuse: Task B on pooled session never replays Task A's turn.completed", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-cur-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeController[] = [];
    const store: { events: StoreEvent[] } = { events: [] };
    const executor = new ProtocolAgentExecutor({
      spawnOverride: createEventStoreFake(controllers, store),
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 40,
    });

    // Task A:完成后 store 里追加它的 turn.completed(seq 2)
    const h1 = await executor.launch(req({ prompt: "A" }));
    store.events.push({ sequence: 1, kind: "turn.started" });
    store.events.push({ sequence: 2, kind: "turn.completed", payload: { response: "A-done" } });
    const r1 = await executor.wait(h1);
    assert.equal(r1.status, "completed");
    assert.equal(r1.response, "A-done");

    // Task B:同 workspace → 复用 session;store 追加 Task B 自己的完成事件(seq 3)
    store.events.push({ sequence: 3, kind: "turn.completed", payload: { response: "B-done" } });
    const h2 = await executor.launch(req({ prompt: "B" }));
    const r2 = await executor.wait(h2);
    assert.equal(r2.status, "completed");
    // 关键断言:如果游标失效(重放 seq 2),r2.response 会是 "A-done"
    assert.equal(r2.response, "B-done", `cursor broken: got "${r2.response}"`);

    // 游标审计:afterSeqLog = [Task A 首轮 0, Task B 首轮 2]——
    // Task B 从 Task A 消费到的位置(2)继续,不重放旧事件。
    const controller = controllers[0]!;
    assert.ok(controller.afterSeqLog.length >= 2, controller.afterSeqLog.join(","));
    assert.equal(controller.afterSeqLog[0], 0, "Task A starts from 0");
    assert.ok(
      controller.afterSeqLog[controller.afterSeqLog.length - 1]! >= 2,
      `Task B must poll with cursor ≥ 2, got: ${controller.afterSeqLog.join(",")}`,
    );
    await executor.dispose();
  });

  it("poll cleanup: repeated task reuse does not accumulate intervals", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-poll-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeController[] = [];
    const store: { events: StoreEvent[] } = { events: [] };
    const executor = new ProtocolAgentExecutor({
      spawnOverride: createEventStoreFake(controllers, store),
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    let seq = 0;
    for (let i = 1; i <= 8; i += 1) {
      const handle = await executor.launch(req({ prompt: `task ${i}` }));
      seq += 1;
      store.events.push({ sequence: ++seq, kind: "turn.started" });
      store.events.push({ sequence: seq + 1, kind: "turn.completed", payload: { response: `done-${i}` } });
      const result = await executor.wait(handle);
      assert.equal(result.status, "completed");
      // settle 后 poll 应立即清理
      assert.equal(executor.activePollCount, 0, `after task ${i}`);
    }
    assert.equal(executor.activePollCount, 0, "no interval leak after 8 tasks");
    await executor.dispose();
  });

  it("session/send rpc error → task failed + session poisoned (worker killed)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-send-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeController[] = [];
    const store: { events: StoreEvent[] } = { events: [] };
    const executor = new ProtocolAgentExecutor({
      spawnOverride: createEventStoreFake(controllers, store, "error"),
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 40,
    });

    const handle = await executor.launch(req({ prompt: "will fail" }));
    const result = await executor.wait(handle);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /send rejected/);

    // session 污染:worker 被杀,不留在池里
    await flushAsync();
    assert.equal(executor.processCount, 0, "poisoned worker killed");
    await executor.dispose();
  });

  it("multi-turn: send() writes content frames on the same session", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-mt-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeController[] = [];
    const store: { events: StoreEvent[] } = { events: [] };
    const executor = new ProtocolAgentExecutor({
      spawnOverride: createEventStoreFake(controllers, store),
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 40,
    });

    const handle = await executor.launch(req({ prompt: "first" }));
    store.events.push({ sequence: 1, kind: "turn.started" });
    store.events.push({ sequence: 2, kind: "turn.completed", payload: { response: "one" } });
    await executor.wait(handle);

    // 同一 session 追加一轮 send(steer 场景)
    await executor.send(handle, "follow-up instruction");
    const sends = controllers[0]!.received
      .filter((r) => r.method === "session/send")
      .map((r) => ({ params: r.params as { content?: string; sessionId?: string } }));
    assert.equal(sends.length, 2);
    assert.equal(sends[1]?.params?.content, "follow-up instruction");
    assert.equal(sends[1]?.params?.sessionId, handle.sessionId, "same session");

    // 第二轮 turn 也走完
    const h2 = await executor.launch(req({ prompt: "second" }));
    store.events.push({ sequence: 3, kind: "turn.started" });
    store.events.push({ sequence: 4, kind: "turn.completed", payload: { response: "two" } });
    const r2 = await executor.wait(h2);
    assert.equal(r2.status, "completed");
    assert.equal(r2.response, "two");
    await executor.dispose();
  });
});

