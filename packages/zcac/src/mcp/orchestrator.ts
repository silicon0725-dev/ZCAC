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
 *   ZCAC_MODEL_PLANNER  planner 角色专属模型(multi-model;空=用默认)
 *   ZCAC_MODEL_CODER     coder 角色专属模型
 *   ZCAC_MODEL_TESTER    tester 角色专属模型
 *   ZCAC_MODEL_REVIEWER  reviewer 角色专属模型
 *   ZCAC_MODEL_EXPLORER  explorer 角色专属模型
 *   ZCAC_ISOLATION   shared | worktree(默认 shared)
 *   ZCAC_DATA_DIR    状态目录(默认 ~/.zcode/zcac)
 *   ZCAC_WORKSPACE   默认工作目录(默认 process.cwd(),插件拉起时即工作区)
 *   ZCAC_CONCURRENCY 全局任务并发(默认 2)
 *   ZCAC_DASHBOARD_PORT Web Dashboard 端口(0=关闭;默认 0)
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
import { ProtocolAgentExecutor } from "../adapters/protocol/agent-executor.js";
import { AutoFakeExecutor } from "../adapters/fake/agent-executor.js";
import type { AgentExecutor } from "../ports/agent-executor.js";
import type { Task } from "../domain/task/task.js";
import type { TaskStatus } from "../domain/task/task-status.js";
import { DashboardServer } from "./dashboard-server.js";

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

  // multi-model:按角色分配模型(空值跳过;未配置的角色回退到全局默认)
  const roleModels: Record<string, string> = {};
  for (const role of ["planner", "coder", "tester", "reviewer", "explorer"] as const) {
    const model = env(`ZCAC_MODEL_${role.toUpperCase()}`);
    if (model) roleModels[role] = model;
  }

  // v0.3: worker 模式切换(in-process 默认;protocol = 独立子进程,崩溃隔离)
  const workerMode = env("ZCAC_WORKER_MODE") === "protocol" ? "protocol" : "in-process";
  const executor: AgentExecutor =
    env("ZCAC_TEST_FAKE") === "1"
      ? new AutoFakeExecutor()
      : workerMode === "protocol"
        ? new ProtocolAgentExecutor({
            env: process.env,
            ...(env("ZCODE_CLI_BUNDLE") ? { cliBundlePath: env("ZCODE_CLI_BUNDLE")! } : {}),
            // Rust 等重编译任务 10 分钟默认值不够;未配置时保持原默认
            ...(env("ZCAC_TASK_TIMEOUT_MS") ? { taskTimeoutMs: Number(env("ZCAC_TASK_TIMEOUT_MS")) } : {}),
          })
        : new ZCodeAgentExecutor({ env: process.env });

  const app: ZcacApp = await buildZcac({
    databasePath: join(dataDir, "zcac.sqlite"),
    executor,
    defaultWorkingDirectory: workspace,
    maxConcurrentTasks: concurrency,
    isolation,
    ...(Object.keys(roleModels).length > 0 ? { roleModels } : {}),
  });

  console.error(
    `[zcac] orchestrator ready (mode=${workerMode}, workspace=${workspace}, isolation=${isolation}, data=${dataDir}` +
      `${Object.keys(roleModels).length > 0 ? `, roleModels=${JSON.stringify(roleModels)}` : ""})`,
  );

  // ---- 实时 stderr 日志流:所有事件格式化输出到编排器 stderr ----
  // 用户在 ZCode 终端/输出面板中可以直接看到集群在干什么。
  const EVENT_ICONS: Record<string, string> = {
    RUN_CREATED: "🚀", RUN_STARTED: "▶️", RUN_COMPLETED: "✅", RUN_FAILED: "❌",
    TASK_CREATED: "📋", TASK_READY: "🟡", TASK_STARTED: "⚙️", TASK_SUCCEEDED: "✅",
    TASK_FAILED: "❌", TASK_RETRY: "🔄", TASK_BLOCKED: "🔒",
    AGENT_ASSIGNED: "👤", AGENT_RELEASED: "👋",
    ARTIFACT_CREATED: "📦",
    WORKTREE_CREATED: "🌲", WORKTREE_REMOVED: "🗑️",
    MERGE_STARTED: "🔀", MERGE_COMPLETED: "🔀", MERGE_CONFLICT: "⚠️",
    SUPERVISOR_DECISION: "🧠",
    ERROR: "💥",
  };

  const activeTasks = new Map<string, { kind: string; role: string; status: string }>();

  app.bus.subscribe((event) => {
    const icon = EVENT_ICONS[event.type] ?? "•";
    const taskId = event.taskId?.slice(0, 13) ?? "";
    const payload = event.payload as Record<string, unknown> ?? {};

    // 追踪任务状态用于进度条
    if (event.type === "TASK_CREATED" && event.taskId) {
      activeTasks.set(event.taskId, {
        kind: String(payload.kind ?? "?"),
        role: String(payload.role ?? "?"),
        status: "pending",
      });
    }
    const tracked = event.taskId ? activeTasks.get(event.taskId) : undefined;
    if (tracked && event.type.startsWith("TASK_")) {
      const statusMap: Record<string, string> = {
        TASK_READY: "ready", TASK_STARTED: "running", TASK_SUCCEEDED: "done",
        TASK_FAILED: "failed", TASK_RETRY: "retrying", TASK_BLOCKED: "blocked",
      };
      const newStatus = statusMap[event.type];
      if (newStatus) tracked.status = newStatus;
    }

    // 格式化 stderr 行
    let detail = "";
    if (event.type === "TASK_STARTED") {
      detail = payload.attempt ? ` (attempt ${payload.attempt})` : "";
    } else if (event.type === "TASK_SUCCEEDED") {
      const dur = payload.durationMs ? ` ${Math.round(Number(payload.durationMs) / 1000)}s` : "";
      detail = dur;
    } else if (event.type === "AGENT_ASSIGNED") {
      detail = ` → ${payload.agentId} [${payload.model}]`;
    } else if (event.type === "SUPERVISOR_DECISION") {
      detail = ` ${payload.action} (trigger: ${payload.trigger})`;
    } else if (event.type === "MERGE_CONFLICT") {
      detail = ` files: ${JSON.stringify(payload.conflictFiles)}`;
    } else if (event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED") {
      const total = activeTasks.size;
      const done = [...activeTasks.values()].filter((t) => ["done", "succeeded", "failed", "cancelled"].includes(t.status)).length;
      detail = ` ${done}/${total} tasks`;
    }

    console.error(`  ${icon} ${event.type.padEnd(22)} ${taskId.padEnd(15)} ${detail}`);
  });

  // ---- 实时 Web Dashboard(HTTP + SSE) ----
  const dashPort = Number(env("ZCAC_DASHBOARD_PORT") ?? "0");
  if (dashPort > 0) {
    const dashboard = new DashboardServer({
      getRun: () => {
        const runId = latestRunId(app);
        return runId ? app.runs.get(runId) : undefined;
      },
      getTasks: () => {
        const runId = latestRunId(app);
        return runId ? app.tasks.listByRun(runId) : [];
      },
      getMessages: (rid: string) => {
        if (!app.messageBus) return [];
        return app.messageBus.getMessages({ runId: rid }).slice(-10);
      },
      getEvents: (rid: string) => app.journal.listByRun(rid).slice(-30),
      port: dashPort,
    });
    dashboard.start();
    app.bus.subscribe((event) => dashboard.broadcastEvent(event));
  }

  // 定期输出进度摘要(每 30s 如果有活动任务)
  const progressInterval = setInterval(() => {
    if (activeDrains.size === 0) return;
    const runId = [...activeDrains.keys()][0];
    if (!runId) return;
    const tasks = app.tasks.listByRun(runId);
    if (tasks.length === 0) return;
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ");
    console.error(`  📊 [${new Date().toISOString().slice(11, 19)}] ${summary}`);
  }, 30_000);
  progressInterval.unref();

  // 后台 run 登记表:cluster_status 聚合 + 崩溃语义。
  const activeDrains = new Map<string, Promise<void>>();

  const server = new McpServer(
    { name: "zcac", version: "0.3.0" },
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

  // -------------------------------------------------------------------------
  // ZCAC-0011: Agent Communication MCP tools
  // -------------------------------------------------------------------------

  registerZcacTool(
    "send_message",
    {
      description:
        "Send a structured message from one agent to another via the ZCAC Message Bus. Communication policy is enforced (some routes may be denied). Supports threads for multi-turn conversations.",
      inputSchema: {
        runId: z.string().describe("Run ID (defaults to latest)"),
        fromAgent: z.string().describe("Sender role (e.g. coder, planner, explorer)"),
        toAgent: z.string().describe("Receiver role, or '*' for broadcast"),
        type: z.enum(["question", "finding", "request", "broadcast"]).describe("Message type"),
        content: z.string().describe("Message content"),
        taskId: z.string().optional().describe("Related task ID"),
        threadId: z.string().optional().describe("Thread ID for multi-turn conversation"),
        replyTo: z.string().optional().describe("Message ID being replied to"),
      },
    },
    async (input: {
      runId?: string;
      fromAgent: string;
      toAgent: string;
      type: string;
      content: string;
      taskId?: string;
      threadId?: string;
      replyTo?: string;
    }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) throw new Error("no run found");
        if (!app.messageBus) throw new Error("message bus not configured");
        const message = app.messageBus.send({
          runId,
          fromAgent: input.fromAgent,
          toAgent: input.toAgent,
          type: input.type as "question" | "finding" | "request" | "broadcast",
          content: input.content,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        });
        return ok({
          messageId: message.id,
          threadId: message.threadId,
          delivered: true,
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "get_messages",
    {
      description:
        "Retrieve messages from the ZCAC Message Bus. Filter by agent, thread, or task. Returns messages with thread/reply correlation.",
      inputSchema: {
        runId: z.string().optional().describe("Run ID (defaults to latest)"),
        toAgent: z.string().optional().describe("Filter: messages sent to this agent"),
        fromAgent: z.string().optional().describe("Filter: messages from this agent"),
        threadId: z.string().optional().describe("Filter: messages in this thread"),
        taskId: z.string().optional().describe("Filter: messages related to this task"),
      },
    },
    async (input: {
      runId?: string;
      toAgent?: string;
      fromAgent?: string;
      threadId?: string;
      taskId?: string;
    }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) return ok({ messages: [] });
        if (!app.messageBus) throw new Error("message bus not configured");
        // 只按 runId 查询(单一参数化条件);可选过滤在下方内存执行,
        // 消除 tool input → SQL 的跨文件污点路径(安全扫描器阻塞项)。
        const allMessages = app.messageBus.getMessages({ runId });
        let messages = allMessages;
        if (input.toAgent) {
          messages = messages.filter((m) => m.toAgent === input.toAgent || m.toAgent === "*");
        }
        if (input.fromAgent) {
          messages = messages.filter((m) => m.fromAgent === input.fromAgent);
        }
        if (input.threadId) {
          messages = messages.filter((m) => m.threadId === input.threadId);
        }
        if (input.taskId) {
          messages = messages.filter((m) => m.taskId === input.taskId);
        }
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            from: m.fromAgent,
            to: m.toAgent,
            type: m.type,
            content: m.content.slice(0, 500),
            taskId: m.taskId,
            replyTo: m.replyTo,
            createdAt: m.createdAt,
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "reply_message",
    {
      description:
        "Reply to a specific message. Automatically joins the sender's thread and routes to the original sender.",
      inputSchema: {
        messageId: z.string().describe("ID of the message being replied to"),
        fromAgent: z.string().describe("Replying agent role"),
        content: z.string().describe("Reply content"),
      },
    },
    async (input: { messageId: string; fromAgent: string; content: string }) => {
      try {
        if (!app.messageBus) throw new Error("message bus not configured");
        const reply = app.messageBus.reply(input.messageId, input.fromAgent, input.content);
        return ok({ messageId: reply.id, threadId: reply.threadId, delivered: true });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "get_thread",
    {
      description:
        "Get all messages in a conversation thread, ordered by time. Shows the full communication chain between agents.",
      inputSchema: {
        threadId: z.string().describe("Thread ID"),
      },
    },
    async (input: { threadId: string }) => {
      try {
        if (!app.messageBus) throw new Error("message bus not configured");
        const messages = app.messageBus.getThread(input.threadId);
        return ok({
          threadId: input.threadId,
          count: messages.length,
          messages: messages.map((m) => ({
            from: m.fromAgent,
            to: m.toAgent,
            type: m.type,
            content: m.content.slice(0, 300),
            createdAt: m.createdAt,
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Agent Discovery (ZCAC-0014)
  // -------------------------------------------------------------------------

  registerZcacTool(
    "cluster_dashboard",
    {
      description:
        "Get a formatted real-time dashboard of the cluster run. Returns a text table showing each agent's current activity, status bar, elapsed time, and latest events. Designed for the main model to present directly to the user in the conversation.",
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async (input: { runId?: string }) => {
      try {
        const runId = input.runId ?? latestRunId(app);
        if (!runId) return ok({ dashboard: "No active run." });
        const run = app.runs.get(runId);
        if (!run) throw new Error(`run not found: ${runId}`);
        const tasks = app.tasks.listByRun(runId);
        const events = app.journal.listByRun(runId);
        const now = Date.now();

        // 状态图标
        const icons: Record<string, string> = {
          pending: "⏳", ready: "🟡", running: "⚙️", blocked: "🔒",
          succeeded: "✅", failed: "❌", retry_wait: "🔄", cancelled: "🚫", interrupted: "⚡",
        };

        // 计算时间
        // 从最早的任务 startedAt 计算 elapsed(或从 run.createdAt)
        const startedAt = tasks
          .map((t) => t.startedAt ?? t.createdAt)
          .reduce((min, v) => Math.min(min, v), Number.MAX_SAFE_INTEGER);
        const elapsed = startedAt < Number.MAX_SAFE_INTEGER
          ? Math.round((now - startedAt) / 1000)
          : Math.round((now - run.createdAt) / 1000);
        const timeStr = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

        // 任务表格
        const taskRows = tasks.map((task) => {
          const icon = icons[task.status] ?? "?";
          const role = (task.input.role ?? "coder").padEnd(8);
          const kind = task.kind.padEnd(10);
          const status = task.status.padEnd(10);
          const dur = task.startedAt
            ? task.completedAt
              ? `${Math.round((task.completedAt - task.startedAt) / 1000)}s`
              : `${Math.round((now - task.startedAt) / 1000)}s…`
            : "—";
          const attempt = task.attempt > 1 ? ` r${task.attempt}` : "";
          const summary = task.output?.summary?.slice(0, 40) ?? task.error?.code ?? "";
          return `  ${icon} ${role} ${kind} ${status} ${dur.padStart(5)}${attempt}  ${summary}`;
        });

        // 事件尾(最近 8 条)
        const eventTail = events.slice(-8).map((e) => {
          const icon = EVENT_ICONS[e.type] ?? "•";
          return `  ${icon} #${e.sequence} ${e.type}`;
        });

        // 最新消息
        const recentMessages = app.messageBus
          ? app.messageBus.getMessages({ runId }).slice(-5)
          : [];
        const messageLines = recentMessages.map((m) =>
          `  ${m.fromAgent} → ${m.toAgent}: ${m.content.slice(0, 60)}`);

        const dashboard = [
          `## 📊 ZCAC Cluster Dashboard`,
          ``,
          `**Run:** \`${runId.slice(0, 18)}…\`  **Status:** ${run.status}  **Elapsed:** ${timeStr}`,
          `**Tasks:** ${tasks.length} total | ${tasks.filter((t) => t.status === "succeeded").length} ✅ | ${tasks.filter((t) => t.status === "running").length} ⚙️ | ${tasks.filter((t) => t.status === "failed").length} ❌`,
          ``,
          `### Agents`,
          "```",
          ...taskRows,
          "```",
          ``,
          `### Recent Events`,
          "```",
          ...eventTail,
          "```",
          ...(messageLines.length > 0
            ? [``, `### Messages`, "```", ...messageLines, "```"]
            : []),
        ].join("\n");

        return ok({ dashboard, runId, status: run.status });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "list_agents",
    {
      description:
        "List all available agent roles with their capabilities, quotas, and current pool status. Use this to understand which agents the cluster can dispatch.",
      inputSchema: {},
    },
    async () => {
      try {
        const roles = app.registry.list();
        return ok({
          count: roles.length,
          agents: roles.map((role) => ({
            role: role.role,
            capabilities: role.capabilities,
            maxConcurrent: role.defaultQuota,
            currentlyBusy: app.pool.busyCount(role.role),
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Settings: list_models / configure
  // -------------------------------------------------------------------------

  registerZcacTool(
    "list_models",
    {
      description:
        "List all available models from the Provider Registry with their reasoning levels. Use this to show the user a selection of models for cluster workers (e.g. 'Which model should the coder use?').",
      inputSchema: {},
    },
    async () => {
      try {
        if (!(executor instanceof ZCodeAgentExecutor)) {
          return err(new Error("list_models requires a real executor (not test mode)"));
        }
        const models = await executor.listModels();
        return ok({
          count: models.length,
          models: models.map((m) => ({
            id: `${m.providerId}/${m.modelId}`,
            provider: m.providerName,
            model: m.modelId,
            enabled: m.enabled,
            reasoningLevels: m.reasoningLevels.length > 0 ? m.reasoningLevels : undefined,
            contextWindow: m.contextWindow,
            supportsImage: m.supportsImage,
          })),
        });
      } catch (error) {
        return err(error);
      }
    },
  );

  registerZcacTool(
    "configure",
    {
      description:
        "Get or set ZCAC cluster configuration at runtime. Settings: defaultModel, roleModels (per-role model assignment), isolation, concurrency. Changes take effect immediately for new tasks. Use list_models first to see valid model IDs.",
      inputSchema: {
        action: z.enum(["get", "set"]).describe("'get' to read current settings, 'set' to modify"),
        defaultModel: z.string().optional().describe("Default model for all roles (providerId/modelId[@level])"),
        roleModels: z.record(z.string(), z.string()).optional().describe("Per-role model assignment: {coder: 'id', planner: 'id', ...}"),
        isolation: z.enum(["shared", "worktree"]).optional().describe("Workspace isolation mode"),
        concurrency: z.number().optional().describe("Max concurrent tasks"),
      },
    },
    async (input: {
      action: "get" | "set";
      defaultModel?: string;
      roleModels?: Record<string, string>;
      isolation?: "shared" | "worktree";
      concurrency?: number;
    }) => {
      try {
        if (input.action === "get") {
          return ok({
            defaultModel: env("ZCAC_MODEL") ?? DEFAULT_MODEL,
            roleModels: app.scheduler.getRoleModels(),
            isolation,
            concurrency,
          });
        }

        // action === "set"
        const changes: Record<string, unknown> = {};
        if (input.roleModels) {
          app.scheduler.setRoleModels(input.roleModels);
          changes.roleModels = input.roleModels;
        }
        if (input.defaultModel) {
          process.env.ZCAC_MODEL = input.defaultModel;
          changes.defaultModel = input.defaultModel;
        }
        if (input.isolation) {
          changes.isolation = input.isolation;
          // isolation is process-level (set at build); note limitation
        }
        if (input.concurrency) {
          changes.concurrency = input.concurrency;
          // concurrency is process-level; note limitation
        }
        return ok({
          updated: true,
          changes,
          note:
            input.isolation || input.concurrency
              ? "isolation and concurrency changes take effect on orchestrator restart"
              : undefined,
          currentRoleModels: app.scheduler.getRoleModels(),
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
