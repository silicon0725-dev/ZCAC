/**
 * ZCAC MCP Orchestrator — ZCode 插件的 stdio MCP server(实现规范 §38-§40)。
 *
 * 进程模型:ZCode 通过 .mcp.json 以 stdio 拉起本进程;进程内持有
 * buildZcac 组合(持久 SQLite),cluster_create 后台驱动 drain 并立即返回。
 *
 * ⚠ stdout 被 MCP 协议占用:所有日志必须走 console.error。
 *
 * 环境变量:
 *   ZCAC_MODEL       默认逻辑模型(provider/model@level)
 *   ZCAC_ISOLATION   shared | worktree(默认 shared)
 *   ZCAC_DATA_DIR    状态目录(默认 ~/.zcode/zcac)
 *   ZCAC_WORKSPACE   默认工作目录(默认 process.cwd(),插件拉起时即工作区)
 *   ZCAC_CONCURRENCY 全局任务并发(默认 2)
 *   ZCAC_TEST_FAKE   =1 时用 AutoFakeExecutor(测试钩子,无真实模型调用)
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildZcac, type ZcacApp } from "../application/build.js";
import { buildPlanPrompt } from "../application/pipeline.js";
import { ZCodeAgentExecutor } from "../adapters/zcode/agent-executor.js";
import { AutoFakeExecutor } from "../adapters/fake/agent-executor.js";
import type { AgentExecutor } from "../ports/agent-executor.js";
import type { Task } from "../domain/task/task.js";
import type { TaskStatus } from "../domain/task/task-status.js";

const DEFAULT_MODEL = "bigmodel-api/GLM-5.3-Flash@low";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const dataDir = env("ZCAC_DATA_DIR") ?? join(homedir(), ".zcode", "zcac");
  mkdirSync(dataDir, { recursive: true });
  const workspace = env("ZCAC_WORKSPACE") ?? process.cwd();
  const isolation = env("ZCAC_ISOLATION") === "worktree" ? ("worktree" as const) : ("shared" as const);
  const concurrency = Number(env("ZCAC_CONCURRENCY") ?? "2") || 2;

  const executor: AgentExecutor =
    env("ZCAC_TEST_FAKE") === "1"
      ? new AutoFakeExecutor()
      : new ZCodeAgentExecutor({ env: process.env });

  const app: ZcacApp = await buildZcac({
    databasePath: join(dataDir, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: workspace,
    maxConcurrentTasks: concurrency,
    isolation,
  });

  console.error(`[zcac] orchestrator ready (workspace=${workspace}, isolation=${isolation}, data=${dataDir})`);

  // 后台 run 登记表:cluster_status 聚合 + 崩溃语义。
  const activeDrains = new Map<string, Promise<void>>();

  const server = new McpServer(
    { name: "zcac", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // SDK 1.29 zod-compat 类型与 zod4 主入口声明存在结构性摩擦(运行时已验证兼容);
  // 类型转换收敛到这一处,避免六处调用各自 cast。
  type AnyHandler = (input: any) => Promise<CallToolResult>;
  const registerZcacTool = (
    name: string,
    config: { description: string; inputSchema: object },
    handler: AnyHandler,
  ): void => {
    (server.registerTool as unknown as (
      toolName: string,
      toolConfig: { description: string; inputSchema: object },
      toolHandler: AnyHandler,
    ) => void)(name, config, handler);
  };

  const ok = (payload: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  });
  const err = (error: unknown): CallToolResult => ({
    content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
    isError: true,
  });

  registerZcacTool(
    "cluster_create",
    {
      description:
        "Create a ZCAC cluster run for a coding task. mode=single (default): one implement task. mode=pipeline: a planner decomposes the task first, then implement/test tasks are injected dynamically (plus a final review). Work continues in the background; poll cluster_status.",
      inputSchema: {
        task: z.string().describe("Full task description for the coder agent"),
        mode: z.enum(["single", "pipeline"]).optional().describe("single (default) or pipeline (planner decomposes first)"),
        role: z.string().optional().describe("Worker role for single mode (default coder)"),
        model: z.string().optional().describe("Logical model providerId/modelId[@level]"),
        maxAttempts: z.number().optional().describe("Max attempts per task (default 3)"),
      },
    },
    async (input: {
      task: string;
      mode?: "single" | "pipeline";
      role?: string;
      model?: string;
      maxAttempts?: number;
    }) => {
      try {
        const model = input.model ?? env("ZCAC_MODEL") ?? DEFAULT_MODEL;
        const pipeline = input.mode === "pipeline";
        const run = app.taskService.createRun({
          metadata: {
            source: "mcp",
            mode: pipeline ? "pipeline" : "single",
            workspace,
            createdAt: new Date().toISOString(),
          },
        });
        const task = app.taskService.createTask({
          runId: run.id,
          kind: pipeline ? "plan" : "implement",
          input: {
            prompt: pipeline ? buildPlanPrompt(input.task) : input.task,
            role: pipeline ? "planner" : (input.role ?? "coder"),
            model,
            workspacePath: workspace,
            ...(pipeline ? { metadata: { targetPrompt: input.task } } : {}),
          },
          retryPolicy: {
            maxAttempts: input.maxAttempts ?? 3,
            backoffMs: 20_000,
            retryOn: ["retryable_error"],
          },
        });
        const drain = app.scheduler
          .drain(run.id, { timeoutMs: 30 * 60_000 })
          .catch((error: unknown) => {
            console.error(`[zcac] run ${run.id} drain failed:`, error);
          })
          .finally(() => {
            activeDrains.delete(run.id);
          });
        activeDrains.set(run.id, drain);
        return ok({
          runId: run.id,
          taskId: task.id,
          status: "started",
          mode: pipeline ? "pipeline" : "single",
          model,
          isolation,
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "cluster_status",
    {
      description:
        "Status of a ZCAC run (defaults to the most recent): run state, task counts, latest events tail.",
      inputSchema: {
        runId: z.string().optional(),
        eventTail: z.number().optional().describe("Last N events (default 10)"),
      },
    },
    async (input: { runId?: string; eventTail?: number }) => {
      try {
        const runs = [input.runId ?? latestRunId(app) ?? ""].filter((id) => id.length > 0);
        if (runs.length === 0) return ok({ runs: [] });
        const report = runs.map((runId) => {
          const run = app.runs.get(runId);
          if (!run) throw new Error(`run not found: ${runId}`);
          const tasks = app.tasks.listByRun(runId);
          const events = app.journal.listByRun(runId);
          const tail = events.slice(-(input.eventTail ?? 10));
          return {
            runId,
            status: run.status,
            active: activeDrains.has(runId),
            createdAt: run.createdAt,
            tasks: summarizeTasks(tasks),
            events: tail.map((e) => `#${e.sequence} ${e.type}${e.taskId ? ` ${e.taskId.slice(0, 13)}` : ""}`),
          };
        });
        return ok({ runs: report });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "cluster_stop",
    {
      description: "Stop a ZCAC run: abort in-flight agents and mark the run cancelled. Completed tasks stay immutable.",
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async (input: { runId?: string }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) throw new Error("no run to stop");
        await app.scheduler.stopInFlight();
        const run = app.runs.get(runId);
        if (run && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
          app.taskService.updateRunWithEvent(runId, { status: "cancelled" }, "RUN_FAILED", {
            reason: "cancelled_by_user",
          });
        }
        return ok({ runId, status: "stopping" });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "task_list",
    {
      description: "List tasks of a ZCAC run (defaults to the most recent) with status, attempts and assignments.",
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async (input: { runId?: string }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) return ok({ tasks: [] });
        return ok({
          runId,
          tasks: app.tasks.listByRun(runId).map((task) => ({
            taskId: task.id,
            kind: task.kind,
            role: task.input.role ?? "coder",
            status: task.status,
            attempt: task.attempt,
            agent: task.assignedAgentId,
            durationMs:
              task.startedAt !== undefined && task.completedAt !== undefined
                ? task.completedAt - task.startedAt
                : undefined,
            summary: task.output?.summary?.slice(0, 120),
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "artifact_list",
    {
      description: "List artifacts produced by a ZCAC run (defaults to the most recent).",
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async (input: { runId?: string }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) return ok({ artifacts: [] });
        return ok({
          runId,
          artifacts: app.artifacts.listByRun(runId).map((a) => ({
            artifactId: a.id,
            taskId: a.taskId,
            type: a.type,
            checksum: a.checksum,
            createdAt: a.createdAt,
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "events",
    {
      description: "Journal events of a ZCAC run, optionally after a sequence cursor (replay support).",
      inputSchema: {
        runId: z.string().optional(),
        afterSequence: z.number().optional(),
      },
    },
    async (input: { runId?: string; afterSequence?: number }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) return ok({ events: [] });
        return ok({
          runId,
          events: app.journal.listByRun(runId, input.afterSequence).map((e) => ({
            sequence: e.sequence,
            type: e.type,
            taskId: e.taskId,
            agentId: e.agentId,
            payload: e.payload,
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[zcac] MCP server connected (stdio)");

  const shutdown = (): void => {
    void (async () => {
      await executor.dispose().catch(() => undefined);
      app.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function latestRunId(app: ZcacApp): string | undefined {
  const rows = app.database.db
    .prepare("SELECT id FROM zcac_runs ORDER BY created_at DESC LIMIT 1")
    .all() as unknown as Array<{ id: string }>;
  return rows[0]?.id;
}

function summarizeTasks(tasks: Task[]): Record<TaskStatus | "total", number> {
  const summary: Record<string, number> = { total: tasks.length };
  for (const task of tasks) {
    summary[task.status] = (summary[task.status] ?? 0) + 1;
  }
  return summary as Record<TaskStatus | "total", number>;
}

main().catch((error: unknown) => {
  console.error("[zcac] fatal:", error);
  process.exit(1);
});
