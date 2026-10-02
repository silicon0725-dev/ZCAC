/**
 * ZCAC-0006 — Artifact 与 ZCAC-0007 — Review Loop 单元测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { artifactChecksum } from "../src/domain/artifact/artifact.js";
import {
  buildFixPrompt,
  buildReviewPrompt,
  parseReviewResult,
} from "../src/application/review-loop.js";
import { createTestContext, waitFor } from "./helpers.js";

const REVIEW_PROMPT = buildReviewPrompt("create alpha.txt with one line");

function verdictResponse(verdict: "PASS" | "FAIL", findings: string[] = []): string {
  return [
    ...(verdict === "FAIL" ? ["Findings:", ...findings] : ["All checks passed."]),
    "",
    `REVIEW_VERDICT: ${verdict}`,
  ].join("\n");
}

describe("review result parsing", () => {
  it("parses verdict and findings with severity/file/line", () => {
    const result = parseReviewResult(
      verdictResponse("FAIL", [
        "- [high] alpha.txt:1 missing required second line",
        "- [low] README not updated",
      ]),
    );
    assert.equal(result?.verdict, "FAIL");
    assert.equal(result?.findings.length, 2);
    assert.deepEqual(result?.findings[0], {
      severity: "high",
      file: "alpha.txt",
      line: 1,
      message: "missing required second line",
    });
    assert.deepEqual(result?.findings[1], {
      severity: "low",
      message: "README not updated",
    });
  });

  it("returns undefined without a verdict line", () => {
    assert.equal(parseReviewResult("looks fine to me"), undefined);
  });

  it("prompts embed the verdict contract", () => {
    assert.ok(buildReviewPrompt("target").includes("REVIEW_VERDICT: PASS"));
    assert.ok(buildFixPrompt("target", []).includes("Fix every finding"));
  });
});

describe("artifact store", () => {
  it("createArtifact persists with checksum and emits ARTIFACT_CREATED", async (t) => {
    const ctx = await createTestContext();
    t.after(() => ctx.cleanup());
    const { app } = ctx;

    const run = app.taskService.createRun();
    const task = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "A" } });
    const artifact = app.taskService.createArtifact({
      runId: run.id,
      taskId: task.id,
      type: "report",
      content: { response: "done" },
    });

    assert.equal(artifact.checksum, artifactChecksum({ response: "done" }));
    const stored = app.artifacts.get(artifact.id);
    assert.equal(stored?.type, "report");
    assert.equal(stored?.checksum, artifact.checksum);
    assert.equal(app.artifacts.listByRun(run.id).length, 1);

    const events = app.journal.listByRun(run.id).map((e) => e.type);
    assert.ok(events.includes("ARTIFACT_CREATED"));
  });

  it("scheduler emits an artifact per completed task", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    app.taskService.createTask({ runId: run.id, kind: "test", input: { prompt: "A", role: "tester" } });
    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1), "VERDICT_PASS");
    await draining;

    const artifacts = app.artifacts.listByRun(run.id);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.type, "test_result");
    assert.equal((artifacts[0]!.content as { kind: string }).kind, "test");
  });
});

describe("review loop (dynamic DAG)", () => {
  it("PASS review injects nothing; run completes", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const coder = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "write file" } });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [coder.id],
      input: { prompt: REVIEW_PROMPT, role: "reviewer", metadata: { targetPrompt: "write file" } },
    });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1)); // coder
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(fake.agentIdOfLaunch(2), verdictResponse("PASS")); // reviewer
    await draining;

    assert.equal(app.runs.get(run.id)?.status, "completed");
    assert.equal(app.tasks.listByRun(run.id).length, 2); // 无注入
  });

  it("FAIL review injects fix + re-review; round 2 PASS completes the run", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const coder = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "write file" } });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [coder.id],
      input: { prompt: REVIEW_PROMPT, role: "reviewer", metadata: { targetPrompt: "write file" } },
    });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1)); // coder
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(
      fake.agentIdOfLaunch(2),
      verdictResponse("FAIL", ["- [high] alpha.txt:1 missing second line"]),
    ); // review r1

    await waitFor(() => fake.launches.length >= 3);
    const fixPrompt = fake.launches[2]?.prompt ?? "";
    assert.ok(fixPrompt.includes("Fix every finding"));
    assert.ok(fixPrompt.includes("missing second line"));
    fake.complete(fake.agentIdOfLaunch(3)); // fix

    await waitFor(() => fake.launches.length >= 4);
    fake.complete(fake.agentIdOfLaunch(4), verdictResponse("PASS")); // review r2
    await draining;

    const tasks = app.tasks.listByRun(run.id);
    assert.equal(tasks.length, 4); // coder + review + fix + re-review
    assert.ok(tasks.some((task) => task.kind === "fix"));
    assert.equal(app.runs.get(run.id)?.status, "completed");
    // re-review 依赖 fix(动态加边)
    const reReview = tasks.filter((task) => task.kind === "review")[1]!;
    const fix = tasks.find((task) => task.kind === "fix")!;
    assert.deepEqual(reReview.dependencies, [fix.id]);
  });

  it("max rounds exhausted fails the run with review_max_rounds", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1, reviewMaxRounds: 2 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const coder = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "write file" } });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [coder.id],
      input: { prompt: REVIEW_PROMPT, role: "reviewer", metadata: { targetPrompt: "write file" } },
    });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1)); // coder
    for (let round = 2; round <= 4; round += 1) {
      await waitFor(() => fake.launches.length >= round);
      fake.complete(
        fake.agentIdOfLaunch(round),
        verdictResponse("FAIL", ["- [medium] still broken"]),
      );
    }
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;

    const failEvent = app.journal
      .listByRun(run.id)
      .find((event) => event.type === "RUN_FAILED");
    assert.equal((failEvent?.payload as { reason?: string }).reason, "review_max_rounds");
    // r2 注入了 fix+re-review;r2 FAIL 后不再注入
    const tasks = app.tasks.listByRun(run.id);
    assert.equal(tasks.filter((task) => task.kind === "review").length, 2);
    assert.equal(tasks.filter((task) => task.kind === "fix").length, 1);
  });

  it("unparseable review verdict fails the run", async (t) => {
    const ctx = await createTestContext({ maxConcurrentTasks: 1 });
    t.after(() => ctx.cleanup());
    const { app, fake } = ctx;

    const run = app.taskService.createRun();
    const coder = app.taskService.createTask({ runId: run.id, kind: "implement", input: { prompt: "write file" } });
    app.taskService.createTask({
      runId: run.id,
      kind: "review",
      dependencies: [coder.id],
      input: { prompt: REVIEW_PROMPT, role: "reviewer" },
    });

    const draining = app.scheduler.drain(run.id).catch(() => undefined);
    await waitFor(() => fake.launches.length >= 1);
    fake.complete(fake.agentIdOfLaunch(1));
    await waitFor(() => fake.launches.length >= 2);
    fake.complete(fake.agentIdOfLaunch(2), "I looked at it and it seems fine.");
    await waitFor(() => app.runs.get(run.id)?.status === "failed");
    await draining;
    const failEvent = app.journal.listByRun(run.id).find((e) => e.type === "RUN_FAILED");
    assert.equal((failEvent?.payload as { reason?: string }).reason, "review_unparseable");
  });
});
