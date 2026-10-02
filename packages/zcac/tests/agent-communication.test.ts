/**
 * ZCAC Phase 12b — Layer 2: Agent Direct Message 单测。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  parseAgentMessages,
  buildCommunicationInstructions,
} from "../src/application/agent-communication.js";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";

const waitFor = (condition: () => boolean, timeoutMs = 20_000) =>
  waitForDefault(condition, timeoutMs);

describe("@@MSG parsing", () => {
  it("extracts multiple messages with types and targets", () => {
    const response = [
      "I've implemented the API.",
      "",
      "@@MSG to=tester type=finding",
      "API endpoint is at src/api.ts:42",
      "@@END",
      "",
      "@@MSG to=explorer type=question",
      "Does src/foo.ts already export bar()?",
      "@@END",
    ].join("\n");
    const messages = parseAgentMessages(response);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      to: "tester",
      type: "finding",
      content: "API endpoint is at src/api.ts:42",
    });
    assert.deepEqual(messages[1], {
      to: "explorer",
      type: "question",
      content: "Does src/foo.ts already export bar()?",
    });
  });

  it("returns empty for responses without markers", () => {
    assert.equal(parseAgentMessages("plain response").length, 0);
    assert.equal(parseAgentMessages("@@MSG without proper format").length, 0);
  });

  it("communication instructions are non-empty for allowed roles", () => {
    const instructions = buildCommunicationInstructions(["explorer", "tester"]);
    assert.ok(instructions.includes("explorer"));
    assert.ok(instructions.includes("@@MSG"));
    assert.equal(buildCommunicationInstructions([]), "");
  });
});

describe("task chaining (question → answer → continuation)", () => {
  it("coder question triggers explorer sub-task + coder continuation with answer", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-l2-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 1,
      pipeline: false,
      reviewMaxRounds: 0,
      supervisor: false,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "implement the API", role: "coder" },
    });

    const drain = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);

    // 1) Coder 完成,带 @@MSG question
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(
      fake.agentIdOfLaunch(1),
      [
        "I started implementing but need to check something.",
        "",
        "@@MSG to=explorer type=question",
        "Does src/foo.ts already export bar()?",
        "@@END",
      ].join("\n"),
    );

    // 2) 自动创建 Explorer 子任务(answer)
    await waitFor(() => fake.launches.length >= 2);
    const explorerPrompt = fake.launches[1]!.prompt;
    assert.ok(explorerPrompt.includes("Does src/foo.ts"), "explorer task has the question");
    assert.ok(explorerPrompt.includes("ANSWER:"), "explorer told to format answer");

    // Explorer 回答
    fake.complete(
      fake.agentIdOfLaunch(2),
      "I checked src/foo.ts.\nANSWER: Yes, bar() is already exported at line 15.",
    );

    // 3) 自动创建 Coder 续接任务(带上游上下文 = explorer 的答案)
    await waitFor(() => fake.launches.length >= 3);
    const continuationPrompt = fake.launches[2]!.prompt;
    assert.ok(continuationPrompt.includes("bar()"), "continuation has the answer");
    assert.ok(continuationPrompt.includes("implement the API") || continuationPrompt.includes("original"), "continuation references original task");
    assert.equal(fake.launches[2]!.role, "coder", "continuation task uses coder role");

    fake.complete(fake.agentIdOfLaunch(3), "Done, implemented using bar().");
    await drain;

    // 4) 验证:run completed;4 个任务(coder + explorer + continuation + autoReview 或直接完成)
    const tasks = app.tasks.listByRun(run.id);
    assert.equal(app.runs.get(run.id)?.status, "completed",
      tasks.map((x) => `${x.kind}:${x.status}`).join(","));

    // 5) MessageBus:question + answer(finding)在同一 thread
    const messages = app.messageBus!.getMessages({ runId: run.id });
    const question = messages.find((m) => m.type === "question");
    const answer = messages.find((m) => m.type === "finding" && m.replyTo === question?.id);
    assert.ok(question, "question message persisted");
    assert.ok(answer, "answer message persisted with replyTo");
    assert.equal(answer!.threadId, question!.threadId, "same thread");
    assert.ok(answer!.content.includes("bar()"), "answer content correct");

    app.close();
  });

  it("finding message is recorded but does not create sub-tasks", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-l2f-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 1,
      pipeline: false,
      reviewMaxRounds: 0,
      supervisor: false,
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "implement", role: "coder" },
    });

    const drain = app.scheduler.drain(run.id, { timeoutMs: 30_000 }).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(
      fake.agentIdOfLaunch(1),
      [
        "Done.",
        "",
        "@@MSG to=tester type=finding",
        "API at src/api.ts:42",
        "@@END",
      ].join("\n"),
    );
    await drain;

    // 只有 1 个任务(finding 不触发子任务)
    assert.equal(app.tasks.listByRun(run.id).filter((t) => t.kind !== "review").length, 1);
    // finding 已记录
    const findings = app.messageBus!.getMessages({ runId: run.id }).filter((m) => m.type === "finding");
    assert.equal(findings.length, 1);
    app.close();
  });

  it("continuation depth limit prevents infinite chains", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-l2d-"));
    t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined));

    const fake = new FakeExecutor();
    const app = await buildZcac({
      databasePath: join(dir, "zcac.sqlite"),
      executor: fake,
      defaultWorkingDirectory: dir,
      maxConcurrentTasks: 1,
      pipeline: false,
      reviewMaxRounds: 0,
      supervisor: false,
      maxContinuationDepth: 1, // 只允许 1 层续接
    });

    const run = app.taskService.createRun();
    app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: { prompt: "implement", role: "coder" },
    });

    const drain = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);

    // Coder 问问题(depth 0)
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(
      fake.agentIdOfLaunch(1),
      "@@MSG to=explorer type=question\nWhat is X?\n@@END",
    );
    // Explorer 回答 → 创建续接(depth 1)
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(fake.agentIdOfLaunch(2), "ANSWER: X is Y.");
    // 续接任务又问问题(depth 1 = maxDepth) → 不再创建子任务
    await waitFor(() => fake.launches.length >= 3);
    fake.complete(
      fake.agentIdOfLaunch(3),
      "@@MSG to=explorer type=question\nAnother question?\n@@END",
    );
    await drain;

    // 不应该出现第 4 个任务(深度限制)
    const implementTasks = app.tasks.listByRun(run.id).filter((t) => t.kind === "implement" || t.kind === "explore");
    assert.equal(implementTasks.length, 3, `expected 3 (coder + explorer + continuation), got ${implementTasks.length}`);
    app.close();
  });
});
