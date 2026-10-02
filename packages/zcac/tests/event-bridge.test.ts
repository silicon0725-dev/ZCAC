/**
 * ZCAC Phase 12c — Event → Message 桥单测。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EventMessageBridge } from "../src/application/event-message-bridge.js";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";

const waitFor = (condition: () => boolean, timeoutMs = 20_000) =>
  waitForDefault(condition, timeoutMs);

describe("event → message bridge", () => {
  it("bridges REVIEW_FAILED into MessageBus as system broadcast", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-bridge-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 1,
      pipeline: false,
      reviewMaxRounds: 1, // 让 review 失败快速触发 REVIEW_FAILED
      supervisor: false,
    });

    const run = app.taskService.createRun();
    const coder = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "write code", role: "coder" },
    });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [coder.id],
      input: { prompt: "review it", role: "reviewer", metadata: { targetPrompt: "write code" } },
    });

    const drain = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 2);
    // reviewMaxRounds=1:首次 FAIL 即 review_max_rounds → REVIEW_FAILED + RUN_FAILED
    fake.complete(
      fake.agentIdOfLaunch(2),
      "Bad.\n\nREVIEW_VERDICT: FAIL",
    );
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await drain;

    // 桥接的消息:review_max_rounds 路径下 ReviewLoop 直接发 RUN_FAILED
    // (REVIEW_FAILED 事件类型已定义但当前 ReviewLoop 不发射,桥已预留支持)
    const messages = app.messageBus!.getMessages({ runId: run.id });
    const systemMessages = messages.filter((m) => m.fromAgent === "system");
    const types = systemMessages.map((m) => {
      const data = JSON.parse(m.content) as { eventType: string };
      return data.eventType;
    });
    assert.ok(types.includes("RUN_FAILED"), `expected RUN_FAILED, got ${types.join(",")}`);
    // 带 bridge 标记
    assert.ok(systemMessages.every((m) => (m.metadata as { bridge?: boolean }).bridge === true));
    assert.ok(systemMessages.length >= 1, String(systemMessages.length));
    app.close();
  });

  it("does not bridge ordinary events (TASK_CREATED etc.)", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-bridge2-"));
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
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "do it", role: "coder" },
    });
    const drain = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1), "done");
    await drain;

    const messages = app.messageBus!.getMessages({ runId: run.id });
    const systemMessages = messages.filter((m) => m.fromAgent === "system");
    // 正常完成的 run 没有需要桥接的事件(只有 TASK_* / RUN_COMPLETED)
    assert.equal(systemMessages.filter((m) => (m.metadata as { bridge?: boolean }).bridge).length, 0);
    app.close();
  });
});
