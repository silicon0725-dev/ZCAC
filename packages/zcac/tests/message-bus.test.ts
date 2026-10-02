/**
 * ZCAC Phase 12 — Agent Communication Layer 单测。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_COMMUNICATION_POLICY,
  CommunicationDeniedError,
  isSendAllowed,
} from "../src/domain/message/agent-message.js";
import { MessageBus } from "../src/application/message-bus.js";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";

const waitFor = (condition: () => boolean, timeoutMs = 20_000) =>
  waitForDefault(condition, timeoutMs);

describe("communication policy", () => {
  it("default policy allows expected routes and denies others", () => {
    assert.ok(isSendAllowed(DEFAULT_COMMUNICATION_POLICY, "coder", "explorer"));
    assert.ok(isSendAllowed(DEFAULT_COMMUNICATION_POLICY, "planner", "coder"));
    assert.ok(!isSendAllowed(DEFAULT_COMMUNICATION_POLICY, "coder", "reviewer"));
    assert.ok(!isSendAllowed(DEFAULT_COMMUNICATION_POLICY, "unknown-role", "coder"));
    assert.ok(isSendAllowed(DEFAULT_COMMUNICATION_POLICY, "planner", "*"));
    assert.ok(!isSendAllowed(DEFAULT_COMMUNICATION_POLICY, "coder", "*"));
  });
});

describe("message bus", () => {
  it("routes, persists, threads, and rate-limits", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-msg-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      communicationPolicy: {
        coder: { canSendTo: ["explorer"], canBroadcast: false, maxMessagesPerTask: 3 },
        explorer: { canSendTo: ["coder"], canBroadcast: false, maxMessagesPerTask: 10 },
      },
    });
    const bus = app.messageBus!;
    assert.ok(bus, "messageBus wired");
    const run = app.taskService.createRun();

    // 1) 正常发送 + thread 自动创建
    const msg1 = bus.send({
      runId: run.id,
      fromAgent: "coder",
      toAgent: "explorer",
      type: "question",
      content: "What does src/foo.ts export?",
      taskId: "task_test_1",
    });
    assert.ok(msg1.threadId.startsWith("thread_"));

    // 2) reply → 同一 thread
    const reply = bus.reply(msg1.id, "explorer", "It exports bar() and baz().");
    assert.equal(reply.threadId, msg1.threadId);
    assert.equal(reply.replyTo, msg1.id);

    // 3) 越权发送被拒
    assert.throws(
      () => bus.send({ runId: run.id, fromAgent: "coder", toAgent: "reviewer", type: "finding", content: "x" }),
      CommunicationDeniedError,
    );

    // 4) 广播被拒(coder.canBroadcast=false)
    assert.throws(
      () => bus.send({ runId: run.id, fromAgent: "coder", toAgent: "*", type: "broadcast", content: "x" }),
      CommunicationDeniedError,
    );

    // 5) 限速:maxMessagesPerTask=3
    bus.send({ runId: run.id, fromAgent: "coder", toAgent: "explorer", type: "question", content: "2", taskId: "task_test_1" });
    bus.send({ runId: run.id, fromAgent: "coder", toAgent: "explorer", type: "question", content: "3", taskId: "task_test_1" });
    assert.throws(
      () => bus.send({ runId: run.id, fromAgent: "coder", toAgent: "explorer", type: "question", content: "4", taskId: "task_test_1" }),
      CommunicationDeniedError,
    );

    // 6) 查询:msg1 的 thread 含 msg1+reply = 2 条;msg2/msg3 各自新建 thread
    const thread = bus.getThread(msg1.threadId);
    assert.equal(thread.length, 2, "thread has msg1 + reply");
    const allForTask = bus.getMessages({ runId: run.id, taskId: "task_test_1" });
    assert.equal(allForTask.length, 4, "4 messages total for the task");

    app.close();
  });

  it("task handoff: auto-generated on completion, injected into downstream prompt", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-ho-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      pipeline: false,
      reviewMaxRounds: 0,
      supervisor: false,
    });
    const run = app.taskService.createRun();
    const taskA = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "implement the API", role: "coder" },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "test",
      dependencies: [taskA.id],
      input: { prompt: "test the API", role: "tester" },
    });

    const drain = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    // A 的 prompt 应无 handoff 前缀(无依赖)
    assert.ok(!fake.launches[0]!.prompt.includes("Upstream task context"));
    fake.complete(fake.agentIdOfLaunch(1), "API implemented at src/api.ts");

    await waitFor(() => fake.launches.length >= 2);
    // B 的 prompt 应含 handoff 上下文(依赖 A)
    const testerPrompt = fake.launches[1]!.prompt;
    assert.ok(testerPrompt.includes("Upstream task context"), "downstream prompt has handoff");
    assert.ok(testerPrompt.includes("implement the API") || testerPrompt.includes("API"), "handoff contains upstream summary");
    assert.ok(testerPrompt.includes("test the API"), "original task prompt preserved after handoff");

    // zcac_messages 表有 handoff 记录
    const handoffs = app.messageBus!.getMessages({ runId: run.id });
    assert.ok(handoffs.some((m) => m.type === "handoff"), "handoff persisted");

    fake.complete(fake.agentIdOfLaunch(2), "VERDICT_PASS");
    await drain;
    assert.equal(app.runs.get(run.id)?.status, "completed");
    app.close();
  });
});
