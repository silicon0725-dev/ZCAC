/**
 * ZCAC Phase 1 E2E(规范 §30):
 *
 *   Run → Task(hello.txt) → READY → atomic claim → AgentExecutor
 *   → GLM(真实调用) → Write hello.txt → TASK_SUCCEEDED → RUN_COMPLETED
 *
 * 断言:run/task 状态、文件内容、事件序列(RUN_CREATED..TASK_SUCCEEDED..RUN_COMPLETED)、
 * 以及重开 SQLite 后状态不变(§32)。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcac } from "./application/build.js";
import type { ClusterEvent } from "./domain/event/cluster-event.js";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";

const LINE = "hello from zcac phase1";

function parseModelOverride(): string | undefined {
  return (
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length)
  );
}

async function main(): Promise<void> {
  const sandbox = join(tmpdir(), `zcac-e2e-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const dbPath = join(sandbox, "zcac.sqlite");
  const model = parseModelOverride() ?? "bigmodel-api/GLM-5.3-Flash@low";

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const app = await buildZcac({
    databasePath: dbPath,
    executor,
    defaultWorkingDirectory: sandbox,
    maxConcurrentTasks: 2,
  });

  const live: ClusterEvent[] = [];
  app.bus.subscribe((event) => {
    live.push(event);
    const tag = event.taskId ? ` task=${event.taskId.slice(0, 13)}…` : "";
    console.log(
      `  [event #${event.sequence}] ${event.type}${tag} ${JSON.stringify(event.payload)}`,
    );
  });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? "failed"}`}`);
    if (!ok) pass = false;
  };

  try {
    console.log(`[e2e] sandbox: ${sandbox}`);
    console.log(`[e2e] model  : ${model}`);

    const run = app.taskService.createRun({ metadata: { phase: "1", model } });
    const task = app.taskService.createTask({
      runId: run.id,
      kind: "implement",
      input: {
        prompt: [
          "Create a file named hello.txt in the current working directory.",
          `It must contain exactly this single line: ${LINE}`,
          "Then read the file back to verify, and end your reply with exactly:",
          `POC_OK <the file content you read>`,
        ].join("\n"),
        role: "coder",
        model,
        workspacePath: sandbox,
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 3_000, retryOn: ["retryable_error"] },
    });
    console.log(`[e2e] run=${run.id} task=${task.id}`);

    await app.scheduler.drain(run.id, { timeoutMs: 240_000 });

    const reopened = await (async () => {
      app.close();
      return buildZcac({
        databasePath: dbPath,
        executor,
        defaultWorkingDirectory: sandbox,
      });
    })();

    const runAfter = reopened.runs.get(run.id);
    const taskAfter = reopened.tasks.get(task.id);
    const eventsAfter = reopened.journal.listByRun(run.id);

    console.log("\n[e2e] assertions:");
    check("run.status == completed", runAfter?.status === "completed", runAfter?.status);
    check("task.status == succeeded", taskAfter?.status === "succeeded", taskAfter?.status);
    check("task.attempt == 1", taskAfter?.attempt === 1, String(taskAfter?.attempt));
    check("task.output.usage captured", taskAfter?.output?.usage?.totalTokens !== undefined);
    check("assignedAgentId present", taskAfter?.assignedAgentId !== undefined);

    let content: string | undefined;
    try {
      content = await readFile(join(sandbox, "hello.txt"), "utf8");
    } catch {
      content = undefined;
    }
    check("hello.txt exists", content !== undefined);
    check(
      "hello.txt content matches",
      content !== undefined && content.trim() === LINE,
      JSON.stringify(content),
    );

    const types: string[] = eventsAfter.map((event) => event.type);
    for (const expected of [
      "RUN_CREATED",
      "TASK_CREATED",
      "TASK_READY",
      "TASK_STARTED",
      "AGENT_ASSIGNED",
      "TASK_SUCCEEDED",
      "AGENT_RELEASED",
      "RUN_STARTED",
      "RUN_COMPLETED",
    ]) {
      check(`journal contains ${expected}`, types.includes(expected));
    }
    const sequences = eventsAfter.map((event) => event.sequence);
    check(
      "event sequence strictly increasing",
      sequences.every((seq, i) => i === 0 || seq === sequences[i - 1]! + 1),
      sequences.join(","),
    );
    check(
      "live bus saw journal-consistent events",
      live.length === eventsAfter.length || live.length >= eventsAfter.length,
      `live=${live.length} journal=${eventsAfter.length}`,
    );

    reopened.close();
    console.log(pass ? "\n[e2e] PASS ✅" : "\n[e2e] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } finally {
    await executor.dispose();
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("[e2e] fatal:", error);
  process.exitCode = 1;
});
