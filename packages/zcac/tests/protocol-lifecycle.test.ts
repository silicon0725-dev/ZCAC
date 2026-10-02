/**
 * ZCAC Phase 13 — ProtocolAgentExecutor 生命周期测试(fake child process)。
 *
 * 覆盖审查矩阵:
 *   单 Worker 单 Task / 池复用 / 不同 workspace 不串 session /
 *   worker crash → task failed / timeout → session 污染 /
 *   stop → 无幽灵 TurnComplete / late event 丢弃
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
// FakeChild:模拟 app-server 子进程的可编程 stdout/stdin
// ---------------------------------------------------------------------------

interface FakeChildController {
  child: EventEmitter & { stdin: { write: (s: string) => void; killed: boolean }; killed: boolean };
  /** 模拟子进程向 stdout 写一帧 NDJSON。 */
  emitLine: (json: string) => void;
  /** 模拟子进程 exit。 */
  emitExit: () => void;
  /** 收到的 stdin 写入(解析后的请求列表)。 */
  readonly received: Array<{ id: number; method: string; params?: unknown }>;
}

function createFakeChild(): FakeChildController {
  const received: Array<{ id: number; method: string; params?: unknown }> = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: (s: string) => void; killed: boolean };
    stdout: EventEmitter;
    killed: boolean;
  };
  let exitEmitted = false;
  child.stdout = new EventEmitter();
  child.stdin = {
    write: (line: string) => {
      try {
        received.push(JSON.parse(line));
      } catch { /* ignore */ }
    },
    get killed() {
      return child.killed;
    },
  };
  child.killed = false;
  const api = {
    child,
    received,
    emitLine(json: string) {
      // 写入 stdout(executor 监听 child.stdout 的 data 事件)
      child.stdout.emit("data", Buffer.from(`${json}\n`, "utf8"));
    },
    emitExit() {
      if (exitEmitted) return;
      exitEmitted = true;
      child.emit("exit", 0);
    },
  };
  // kill() 触发 exit(fake 不真退出进程)
  (child as unknown as { kill: () => void }).kill = () => {
    child.killed = true;
    api.emitExit();
    return true;
  };
  return api;
}

function req(overrides?: Partial<AgentLaunchRequest>): AgentLaunchRequest {
  return {
    role: "coder",
    prompt: "do the thing",
    workingDirectory: "/ws/project",
    ...overrides,
  };
}

/** 标准 scripted fake:session/create → 返回 sessionId;TurnComplete 由测试控制。 */
function scriptedSpawn(
  controllers: FakeChildController[],
): typeof import("node:child_process").spawn {
  return ((() => {
    const control = createFakeChild();
    controllers.push(control);
    // 自动应答 session/create(直接写 stdout)
    // sessionId 全局唯一(与真实 zcode 一致;per-process 计数会撞名造成假阳性)
    let createSeq = 0;
    const originalWrite = control.child.stdin.write.bind(control.child.stdin);
    control.child.stdin.write = (line: string) => {
      originalWrite(line);
      try {
        const parsed = JSON.parse(line) as { id: number; method: string };
        if (parsed.method === "session/create") {
          createSeq += 1;
          const id = parsed.id;
          const response = JSON.stringify({ id, result: { sessionId: `sess-${controllers.indexOf(control) + 1}-${createSeq}` } });
          setImmediate(() => {
            control.emitLine(response);
          });
        }
      } catch { /* ignore */ }
    };
    return control.child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown) as typeof import("node:child_process").spawn;
}

async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ProtocolAgentExecutor lifecycle (fake child)", () => {
  it("single worker single task: create → send → TurnComplete → completed", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p13-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeChildController[] = [];
    const executor = new ProtocolAgentExecutor({
      spawnOverride: scriptedSpawn(controllers),
      taskTimeoutMs: 5_000,
    });

    const handle = await executor.launch(req());
    await drainMicrotasks();

    // session/create + session/send 已发出
    const methods = controllers[0]!.received.map((r) => r.method);
    assert.ok(methods.includes("session/create"), methods.join(","));
    assert.ok(methods.includes("session/send"));

    // 模拟 TurnComplete
    controllers[0]!.emitLine(
      JSON.stringify({ method: "session/TurnComplete", params: { parts: [{ type: "text", text: "work done" }] } }),
    );
    const result = await executor.wait(handle);
    assert.equal(result.status, "completed");
    assert.equal(result.response, "work done");
    assert.ok(result.sessionId.startsWith("sess-1-"), result.sessionId);
    await executor.dispose();
  });

  it("pool reuse: second task on same workspace reuses process+session", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p13b-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeChildController[] = [];
    const executor = new ProtocolAgentExecutor({
      spawnOverride: scriptedSpawn(controllers),
      taskTimeoutMs: 5_000,
    });

    // Task 1 完成
    const h1 = await executor.launch(req());
    await drainMicrotasks();
    controllers[0]!.emitLine(
      JSON.stringify({ method: "session/TurnComplete", params: { parts: [{ type: "text", text: "one" }] } }),
    );
    const r1 = await executor.wait(h1);
    assert.equal(r1.status, "completed");
    assert.equal(executor.processCount, 1, "process kept alive for reuse");

    // Task 2 同 workspace:复用(不新 spawn)
    const h2 = await executor.launch(req({ prompt: "second task" }));
    await drainMicrotasks();
    assert.equal(controllers.length, 1, "no new process spawned");
    assert.equal(h2.sessionId, h1.sessionId, "same session reused");

    controllers[0]!.emitLine(
      JSON.stringify({ method: "session/TurnComplete", params: { parts: [{ type: "text", text: "two" }] } }),
    );
    const r2 = await executor.wait(h2);
    assert.equal(r2.response, "two");
    await executor.dispose();
  });

  it("different workspaces NEVER share session (isolation)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p13c-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeChildController[] = [];
    const executor = new ProtocolAgentExecutor({
      spawnOverride: scriptedSpawn(controllers),
      taskTimeoutMs: 5_000,
    });

    const h1 = await executor.launch(req({ workingDirectory: "/ws/worktree-A" }));
    await drainMicrotasks();
    controllers[0]!.emitLine(
      JSON.stringify({ method: "session/TurnComplete", params: { parts: [{ type: "text", text: "a" }] } }),
    );
    await executor.wait(h1);

    const h2 = await executor.launch(req({ workingDirectory: "/ws/worktree-B" }));
    await drainMicrotasks();
    assert.notEqual(h2.sessionId, h1.sessionId, "sessions isolated per workspace");
    assert.equal(controllers.length, 2, "new process for new workspace");
    await executor.dispose();
  });

  it("worker crash: pending task → failed(executor_error)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p13d-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeChildController[] = [];
    const executor = new ProtocolAgentExecutor({
      spawnOverride: scriptedSpawn(controllers),
      taskTimeoutMs: 5_000,
    });

    const handle = await executor.launch(req());
    await drainMicrotasks();
    // 模拟子进程崩溃
    controllers[0]!.emitExit();

    const result = await executor.wait(handle);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /exited unexpectedly/);
    await executor.dispose();
  });

  it("timeout: task failed + session poisoned (late TurnComplete ignored)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p13e-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeChildController[] = [];
    const executor = new ProtocolAgentExecutor({
      spawnOverride: scriptedSpawn(controllers),
      taskTimeoutMs: 50, // 极短超时
    });

    const handle = await executor.launch(req());
    const result = await executor.wait(handle);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /timeout/);

    // late TurnComplete 到达:不得产生任何新结果/新任务污染
    const spawnCountBefore = controllers.length;
    controllers[0]!.emitLine(
      JSON.stringify({ method: "session/TurnComplete", params: { parts: [{ type: "text", text: "late ghost" }] } }),
    );
    await drainMicrotasks();
    assert.equal(controllers.length, spawnCountBefore, "poisoned worker killed, no new spawns");
    // executor 仍可用:新任务走全新 session
    const h2 = await executor.launch(req({ prompt: "fresh task" }));
    await drainMicrotasks();
    assert.notEqual(h2.sessionId, handle.sessionId, "fresh session after poisoning");
    await executor.dispose();
  });

  it("stop: task cancelled + late TurnComplete ignored (no ghost)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-p13f-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const controllers: FakeChildController[] = [];
    const executor = new ProtocolAgentExecutor({
      spawnOverride: scriptedSpawn(controllers),
      taskTimeoutMs: 5_000,
    });

    const handle = await executor.launch(req());
    await drainMicrotasks();
    await executor.stop(handle);
    const result = await executor.wait(handle);
    assert.equal(result.status, "cancelled");

    // ghost TurnComplete 到达:无活动 turn,丢弃
    controllers[0]!.emitLine(
      JSON.stringify({ method: "session/TurnComplete", params: { parts: [{ type: "text", text: "ghost" }] } }),
    );
    await drainMicrotasks(); // 无异常即通过
    await executor.dispose();
  });
});
