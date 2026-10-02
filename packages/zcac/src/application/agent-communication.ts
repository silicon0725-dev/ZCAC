/**
 * ZCAC Phase 12b/12c — Layer 2 + Layer 3: Agent Communication。
 *
 * Layer 2: @@MSG → 任务链(question → answer → continuation)
 * Layer 3: @@TASK → 直接 Graph 变异 + 广播路由 + Agent Discovery
 */

import type { Task, TaskId } from "../domain/task/task.js";
import type { Clock } from "../ports/clock.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { MessageBus } from "./message-bus.js";
import type { TaskService } from "./task-service.js";
import type { AgentCapabilityRegistry } from "../domain/agent/agent-pool.js";
import { CommunicationDeniedError } from "../domain/message/agent-message.js";

// ---------------------------------------------------------------------------
// @@MSG 解析(Layer 2)
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  to: string;
  type: "question" | "finding" | "request" | "broadcast";
  content: string;
}

const MSG_BLOCK = /@@MSG\s+to=(\S+)\s+type=(question|finding|request|broadcast)\s*\n([\s\S]*?)@@END/g;

/** 从 worker 输出中提取全部 @@MSG 块。 */
export function parseAgentMessages(response: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let match: RegExpExecArray | null;
  MSG_BLOCK.lastIndex = 0;
  while ((match = MSG_BLOCK.exec(response)) !== null) {
    messages.push({
      to: match[1]!,
      type: match[2] as ParsedMessage["type"],
      content: match[3]!.trim(),
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// @@TASK 解析(Layer 3: Message → Task Graph Bridge)
// ---------------------------------------------------------------------------

export interface ParsedTaskDirective {
  kind: string;
  role: string;
  dependsOn: string[];
  content: string;
}

const TASK_BLOCK = /@@TASK\s+kind=(\S+)\s+role=(\S+)(?:\s+depends=(\S+))?\s*\n([\s\S]*?)@@END_TASK/g;

/** 从 worker 输出中提取全部 @@TASK 指令。 */
export function parseTaskDirectives(response: string): ParsedTaskDirective[] {
  const tasks: ParsedTaskDirective[] = [];
  let match: RegExpExecArray | null;
  TASK_BLOCK.lastIndex = 0;
  while ((match = TASK_BLOCK.exec(response)) !== null) {
    tasks.push({
      kind: match[1]!,
      role: match[2]!,
      dependsOn: (match[3] ?? "").split(",").filter((d) => d.trim().length > 0),
      content: match[4]!.trim(),
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Worker 系统提示注入
// ---------------------------------------------------------------------------

export function buildCommunicationInstructions(canSendTo: readonly string[]): string {
  if (canSendTo.length === 0) return "";
  return [
    "",
    "## Agent Communication",
    "",
    `You can send messages to: ${canSendTo.join(", ")}.`,
    "",
    "### Send a message (ask a question or share a finding):",
    "```",
    "@@MSG to=<role> type=question",
    "Your question here",
    "@@END",
    "```",
    "- type=question: another agent investigates; you get a follow-up task with their answer.",
    "- type=finding: share info (no reply).",
    "- type=broadcast: notify all agents (use sparingly).",
    "",
    "### Create a new task directly:",
    "```",
    "@@TASK kind=implement role=coder",
    "Task description here",
    "@@END_TASK",
    "```",
    "- kind: implement | test | explore | review | plan",
    "- role: coder | tester | explorer | reviewer | planner",
    "- Optional: depends=<taskId> to sequence after an existing task.",
    "",
    "Only use these when genuinely needed.",
  ].join("\n");
}

/** Agent Discovery: 构造可用 agent 列表(注入系统提示)。 */
export function buildAgentDiscoveryInstructions(
  registry: AgentCapabilityRegistry,
): string {
  const roles = registry.list();
  if (roles.length === 0) return "";
  const lines = roles.map(
    (r) => `- ${r.role} (${r.capabilities.join(", ")}): max ${r.defaultQuota} concurrent`,
  );
  return [
    "",
    "## Available Agents",
    "",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// AgentCommunicationService
// ---------------------------------------------------------------------------

export interface AgentCommunicationDeps {
  messageBus: MessageBus;
  taskService: TaskService;
  tasks: TaskRepository;
  runs: RunRepository;
  clock: Clock;
  /** 续接任务最大深度(防无限对话链);默认 2。 */
  maxContinuationDepth?: number;
  /** Agent 能力注册表(Agent Discovery);注入后 worker 提示包含可用 agent 列表。 */
  registry?: AgentCapabilityRegistry;
}

export class AgentCommunicationService {
  readonly #maxDepth: number;
  readonly #registry?: AgentCapabilityRegistry;

  constructor(private readonly deps: AgentCommunicationDeps) {
    this.#maxDepth = deps.maxContinuationDepth ?? 2;
    this.#registry = deps.registry;
  }

  /**
   * Scheduler 在任务完成后调用:解析 @@MSG + @@TASK → 路由/创建任务。
   */
  onTaskCompleted(task: Task): void {
    const response = task.output?.response ?? "";
    const hasMsg = response.includes("@@MSG");
    const hasTask = response.includes("@@TASK");
    if (!hasMsg && !hasTask) return;

    const fromAgent = task.input.role ?? "coder";
    const continuationDepth =
      (task.input.metadata?.continuationDepth as number | undefined) ?? 0;

    if (hasMsg) {
      const parsed = parseAgentMessages(response);
      for (const msg of parsed) {
        this.#routeMessage(task, fromAgent, msg, continuationDepth);
      }
    }

    if (hasTask) {
      const directives = parseTaskDirectives(response);
      for (const directive of directives) {
        this.#createTaskFromDirective(task, fromAgent, directive);
      }
    }
  }

  #routeMessage(
    task: Task,
    fromAgent: string,
    msg: ParsedMessage,
    continuationDepth: number,
  ): void {
    let sent;
    try {
      sent = this.deps.messageBus.send({
        runId: task.runId,
        fromAgent,
        toAgent: msg.to,
        type: msg.type,
        content: msg.content,
        taskId: task.id,
      });
    } catch (error) {
      if (error instanceof CommunicationDeniedError) return;
      throw error;
    }

    // finding/broadcast 仅记录
    if (msg.type === "finding" || msg.type === "broadcast") return;

    // 深度限制
    if (continuationDepth >= this.#maxDepth) return;

    // question/request → 创建子任务
    const answerTask = this.deps.taskService.createTask({
      runId: task.runId,
      kind: msg.type === "question" ? "explore" : "implement",
      input: {
        prompt: [
          `Another agent (${fromAgent}) is asking you:`,
          "",
          msg.content,
          "",
          msg.type === "question"
            ? "Investigate and provide a clear answer. End with 'ANSWER: <summary>'."
            : "Handle this request. End with a summary.",
        ].join("\n"),
        role: msg.to,
        workspacePath: task.input.workspacePath,
        model: task.input.model,
        metadata: {
          communication: true,
          replyToMessageId: sent.id,
          threadId: sent.threadId,
          askedBy: fromAgent,
          askedByTaskId: task.id,
        },
      },
    });

    // question → 续接任务
    if (msg.type === "question") {
      this.deps.taskService.createTask({
        runId: task.runId,
        kind: task.kind,
        dependencies: [answerTask.id],
        input: {
          prompt: [
            `You asked ${msg.to}: "${msg.content.slice(0, 200)}"`,
            "Their answer is in the upstream context below.",
            "Continue your original task.",
            "",
            ...(task.input.metadata?.targetPrompt
              ? [`Original task: ${task.input.metadata.targetPrompt}`]
              : []),
          ].join("\n"),
          role: fromAgent,
          workspacePath: task.input.workspacePath,
          model: task.input.model,
          metadata: {
            continuation: true,
            continuationDepth: continuationDepth + 1,
            continuedFrom: task.id,
            targetPrompt:
              (task.input.metadata?.targetPrompt as string | undefined) ??
              task.input.prompt,
          },
        },
      });
    }
  }

  /**
   * Layer 3:@@TASK → 直接在 Graph 中创建新任务。
   * 支持依赖指定(depends=<taskId,...>,引用同一 run 中已有的 taskId)。
   */
  #createTaskFromDirective(
    sourceTask: Task,
    fromAgent: string,
    directive: ParsedTaskDirective,
  ): void {
    // 验证角色存在
    if (this.#registry) {
      const roleDef = this.#registry.get(directive.role);
      if (!roleDef) return; // 未知角色,静默忽略
    }

    // 解析依赖:depends 值是 taskId 列表(逗号分隔)
    const dependencies = directive.dependsOn
      .map((dep) => dep.trim())
      .filter((dep) => {
        // 只允许引用同一 run 中已存在的任务
        const depTask = this.deps.tasks.get(dep);
        return depTask && depTask.runId === sourceTask.runId;
      });

    const newTask = this.deps.taskService.createTask({
      runId: sourceTask.runId,
      kind: directive.kind,
      dependencies,
      input: {
        prompt: directive.content,
        role: directive.role,
        workspacePath: sourceTask.input.workspacePath,
        model: sourceTask.input.model,
        metadata: {
          createdBy: fromAgent,
          createdByTaskId: sourceTask.id,
          graphMutation: true,
        },
      },
    });

    // 记录到 MessageBus(审计)
    try {
      this.deps.messageBus.send({
        runId: sourceTask.runId,
        fromAgent,
        toAgent: directive.role,
        type: "request",
        content: `@@TASK created: ${directive.kind}/${directive.role} → ${newTask.id}`,
        taskId: sourceTask.id,
      });
    } catch {
      // 审计消息失败不影响任务创建
    }
  }

  /**
   * 子任务(answer task)完成后:将答案写回 MessageBus(同 thread,replyTo)。
   */
  onAnswerTaskCompleted(task: Task): void {
    const replyToId = task.input.metadata?.replyToMessageId as string | undefined;
    if (!replyToId) return;

    const answerContent = task.output?.response ?? "";
    const answerMatch = answerContent.match(/ANSWER:\s*([\s\S]+)/);
    const answer = (answerMatch?.[1] ?? answerContent).trim();

    try {
      this.deps.messageBus.send({
        runId: task.runId,
        fromAgent: task.input.role ?? "explorer",
        toAgent: (task.input.metadata?.askedBy as string) ?? "coder",
        type: "finding",
        content: answer,
        taskId: task.id,
        threadId: task.input.metadata?.threadId as string | undefined,
        replyTo: replyToId,
      });
    } catch {
      // 策略拒绝或限速
    }
  }
}
