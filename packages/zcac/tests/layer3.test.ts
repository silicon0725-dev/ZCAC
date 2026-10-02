/**
 * ZCAC Phase 12c — Layer 3: Broadcast + @@TASK + Agent Discovery 单测。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  parseTaskDirectives,
  parseAgentMessages,
  buildAgentDiscoveryInstructions,
} from "../src/application/agent-communication.js";
import { createDefaultCapabilityRegistry } from "../src/domain/agent/agent-pool.js";
import { buildZcac } from "../src/application/build.js";
import { FakeExecutor, waitFor as waitForDefault } from "./helpers.js";

const waitFor = (condition: () => boolean, timeoutMs = 20_000) =>
  waitForDefault(condition, timeoutMs);

describe("@@TASK parsing", () => {
  it("extracts task directives with kind, role, and optional dependencies", () => {
    const response = [
      "I need to create additional work.",
      "",
      "@@TASK kind=implement role=coder",
      "Fix the failing dependency at src/lib/missing.ts",
      "@@END_TASK",
      "",
      "@@TASK kind=test role=tester depends=task_abc123",
      "Run integration tests after the fix",
      "@@END_TASK",
    ].join("\n");
    const tasks = parseTaskDirectives(response);
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks[0], { kind: "implement", role: "coder", dependsOn: [], content: "Fix the failing dependency at src/lib/missing.ts" });
    assert.deepEqual(tasks[1]!.kind, "test");
    assert.deepEqual(tasks[1]!.role, "tester");
    assert.deepEqual(tasks[1]!.dependsOn, ["task_abc123"]);
  });

  it("returns empty for responses without @@TASK", () => {
    assert.equal(parseTaskDirectives("no directives here").length, 0);
  });
});

describe("broadcast parsing", () => {
  it("accepts broadcast type in @@MSG", () => {
    const msgs = parseAgentMessages(
      "@@MSG to=* type=broadcast\nAttention all agents: API schema changed.\n@@END",
    );
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.to, "*");
    assert.equal(msgs[0]!.type, "broadcast");
  });
});

describe("agent discovery instructions", () => {
  it("lists all roles with capabilities and quotas", () => {
    const registry = createDefaultCapabilityRegistry();
    const instructions = buildAgentDiscoveryInstructions(registry);
    assert.ok(instructions.includes("coder"));
    assert.ok(instructions.includes("explorer"));
    assert.ok(instructions.includes("planner"));
    assert.ok(instructions.includes("tester"));
    assert.ok(instructions.includes("reviewer"));
    assert.ok(instructions.includes("max")); // quota info
  });
});

describe("@@TASK → graph mutation (integration)", () => {
  it("coder creates a test task via @@TASK directive", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-l3-"));
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
      input: { prompt: "implement feature X", role: "coder" },
    });

    const drain = app.scheduler.drain(run.id, { timeoutMs: 60_000 }).catch(() => undefined);

    // Coder 完成,带 @@TASK 指令
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(
      fake.agentIdOfLaunch(1),
      [
        "Feature X implemented.",
        "",
        "@@TASK kind=test role=tester",
        "Run unit tests for feature X",
        "@@END_TASK",
      ].join("\n"),
    );

    // @@TASK 自动创建 tester 任务
    await waitFor(() => fake.launches.length >= 2);
    assert.equal(fake.launches[1]!.role, "tester");
    assert.ok(fake.launches[1]!.prompt.includes("Run unit tests"));

    fake.complete(fake.agentIdOfLaunch(2), "All tests pass. VERDICT_PASS");
    await drain;

    const tasks = app.tasks.listByRun(run.id);
    assert.equal(app.runs.get(run.id)?.status, "completed");
    const testTask = tasks.find((t) => t.kind === "test");
    assert.ok(testTask?.input.metadata?.graphMutation, "task has graphMutation marker");
    assert.equal(testTask?.input.metadata?.createdBy, "coder");
    app.close();
  });

  it("unknown role in @@TASK is silently ignored", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "zcac-l3u-"));
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
      input: { prompt: "do something", role: "coder" },
    });

    const drain = app.scheduler.drain(run.id, { timeoutMs: 30_000 }).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(
      fake.agentIdOfLaunch(1),
      "@@TASK kind=implement role=nonexistent\nThis should be ignored\n@@END_TASK",
    );
    await drain;

    // 只有 1 个任务(原任务),没有新任务被创建
    const implementCount = app.tasks.listByRun(run.id).filter((t) => t.kind === "implement").length;
    assert.equal(implementCount, 1, "no extra tasks created for unknown role");
    app.close();
  });
});
