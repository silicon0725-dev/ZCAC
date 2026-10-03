/**
 * ZCAC Phase 13 — ProtocolAgentExecutor 生命周期测试(真实协议路径)。
 *
 * 全部通过 session/events 轮询驱动(与真实 zcode app-server 一致):
 *   session/create → session/send → session/events(afterSeq=cursor)
 *   → {seq, kind:"turn.completed", payload:{response}}
 *
 * 覆盖审查矩阵:单任务 / 池复用+游标 / workspace 隔离 /
 * crash / timeout+late-event / stop / send-failure / poll cleanup。
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
// EventStoreFake:按真实协议模拟 session/events 轮询
// ---------------------------------------------------------------------------

interface StoreEvent {
  seq: number;
  kind: string;
  payload?: Record<string, unknown>;
}

interface FakeController {
  child: EventEmitter & {
    stdin: { write: (s: string) => void; killed: boolean };
    stdout: EventEmitter;
    killed: boolean;
    kill: () => void;
  };
  emitLine: (json: string) => void;
  emitExit: () => void;
  readonly received: Array<{ id: string; method: string; params?: unknown }>;
  readonly afterSeqLog: number[];
}

interface EventStoreFake {
  spawn: typeof import("node:child_process").spawn;
  controllers: FakeController[];
  emit: (kind: string, payload?: Record<string, unknown>) => number;
}

function createEventStoreFake(
  controllers: FakeController[],
  opts?: { sendBehavior?: "accept" | "error" },
): EventStoreFake {
  const store: { events: StoreEvent[]; nextSeq: number } = { events: [], nextSeq: 1 };
  let sessionCounter = 0;

  const fn = () => {
    const received: Array<{ id: string; method: string; params?: unknown }> = [];
    const afterSeqLog: number[] = [];
    const child = new EventEmitter() as FakeController["child"];
    child.stdout = new EventEmitter();
    child.killed = false;

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
          sessionCounter += 1;
          respond({
            id: parsed.id,
            result: { session: { sessionId: `sess-${sessionCounter}` } },
          });
          return;
        }

        if (parsed.method === "session/events") {
          const afterSeq = typeof parsed.params?.afterSeq === "number" ? parsed.params.afterSeq : 0;
          afterSeqLog.push(afterSeq);
          const events = store.events.filter((e) => e.seq > afterSeq).slice(0, 100);
          respond({ id: parsed.id, result: { events } });
          return;
        }

        if (parsed.method === "session/send") {
          if (opts?.sendBehavior === "error") {
            respond({ id: parsed.id, error: { code: -32010, message: "send rejected" } });
          } else {
            respond({
              id: parsed.id,
              result: { accepted: true, sessionId: parsed.params?.sessionId },
            });
          }
          return;
        }

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
    };
    controllers.push(control);
    return child;
  };

  return {
    spawn: fn as unknown as typeof import("node:child_process").spawn,
    controllers,
    emit(kind: string, payload?: Record<string, unknown>): number {
      const seq = store.nextSeq++;
      store.events.push({ seq, kind, payload });
      return seq;
    },
  };
}

function req(overrides?: Partial<AgentLaunchRequest>): AgentLaunchRequest {
  return {
    role: "coder",
    prompt: "do the thing",
    workingDirectory: "/ws/project",
    ...overrides,
  };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProtocolAgentExecutor (real session/events polling)", () => {
  it("single task: create → send → events polling → turn.completed → completed", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    const handle = await executor.launch(req());
    await drain();
    fake.emit("turn.started");
    fake.emit("turn.completed", { response: "work done" });
    const result = await executor.wait(handle);
    assert.equal(result.status, "completed");
    assert.equal(result.response, "work done");
    await executor.dispose();
  });

  it("pool reuse + event cursor: Task B polls from Task A cursor, gets own response", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl2-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    // Task A
    const h1 = await executor.launch(req({ prompt: "A" }));
    await drain();
    fake.emit("turn.started");
    fake.emit("turn.completed", { response: "A-done" });
    const r1 = await executor.wait(h1);
    assert.equal(r1.response, "A-done");
    // 核心断言:Task B 复用同一 session 时必须从 Task A 停止的位置继续轮询。
    // 如果游标失效(Task B 重放 A 的 turn.completed),r2.response 会是 "A-done"。

    // Task B: same workspace → same session; B 自己的 completed
    fake.emit("turn.started");
    fake.emit("turn.completed", { response: "B-done" });
    const h2 = await executor.launch(req({ prompt: "B" }));
    await drain();
    const r2 = await executor.wait(h2);
    assert.equal(r2.response, "B-done", `cursor broken: got "${r2.response}"`);
    assert.equal(h2.sessionId, h1.sessionId, "session reused");
    await executor.dispose();
  });

  it("different workspaces NEVER share session", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl3-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    const h1 = await executor.launch(req({ workingDirectory: "/ws/wt-A" }));
    await drain();
    fake.emit("turn.started");
    fake.emit("turn.completed", { response: "a" });
    await executor.wait(h1);

    const h2 = await executor.launch(req({ workingDirectory: "/ws/wt-B" }));
    await drain();
    assert.notEqual(h2.sessionId, h1.sessionId);
    assert.equal(controllers.length, 2);
    await executor.dispose();
  });

  it("worker crash: pending task → failed(executor_error)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl4-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    const handle = await executor.launch(req());
    await drain();
    controllers[0]!.emitExit();
    const result = await executor.wait(handle);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /exited unexpectedly/);
    await executor.dispose();
  });

  it("timeout: task failed + late events ignored", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl5-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 50,
      pollIntervalMs: 30,
    });

    const handle = await executor.launch(req());
    const result = await executor.wait(handle);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timeout/);

    // late turn.completed → 丢弃
    fake.emit("turn.completed", { response: "late ghost" });
    await drain();
    const spawnCountBefore = controllers.length;
    const h2 = await executor.launch(req({ prompt: "fresh" }));
    await drain();
    assert.notEqual(h2.sessionId, handle.sessionId, "fresh session after poison");
    assert.equal(controllers.length, spawnCountBefore + 1, "exactly one new spawn for fresh task");
    await executor.dispose();
  });

  it("stop: cancelled + ghost events ignored", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl6-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    const handle = await executor.launch(req());
    await drain();
    await executor.stop(handle);
    const result = await executor.wait(handle);
    assert.equal(result.status, "cancelled");
    fake.emit("turn.completed", { response: "ghost" });
    await drain();
    await executor.dispose();
  });

  it("poll cleanup: 8 reuses → activePollCount stays 0", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl7-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers);
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    for (let i = 1; i <= 8; i += 1) {
      const handle = await executor.launch(req({ prompt: `task ${i}` }));
      await drain();
      fake.emit("turn.started");
      fake.emit("turn.completed", { response: `done-${i}` });
      const result = await executor.wait(handle);
      assert.equal(result.status, "completed", `task ${i}`);
      assert.equal(executor.activePollCount, 0, `after task ${i}`);
    }
    await executor.dispose();
  });

  it("session/send rpc error → task failed + session poisoned", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-rl8-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));
    const controllers: FakeController[] = [];
    const fake = createEventStoreFake(controllers, { sendBehavior: "error" });
    const executor = new ProtocolAgentExecutor({
      spawnOverride: fake.spawn,
      cliBundlePath: "fake/zcode.cjs",
      taskTimeoutMs: 10_000,
      pollIntervalMs: 30,
    });

    const handle = await executor.launch(req());
    const result = await executor.wait(handle);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /send rejected/);
    await drain();
    assert.equal(executor.processCount, 0, "poisoned worker killed");
    await executor.dispose();
  });
});
