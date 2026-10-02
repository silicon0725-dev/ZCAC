/**
 * ZCAC Phase 12b — Layer 2: Agent Direct Message via Task Chaining。
 *
 * Worker 是 fire-and-forget,无法实时暂停等回复。
 * 本层通过任务链实现等效通信:
 *
 *   Coder 完成(含 @@MSG question) → 自动创建 Explorer 子任务回答
 *     → 自动创建 Coder 续接任务(prompt 注入答案) → Coder 继续工作
 *
 * 全程 MessageBus 持久化(thread 完整审计)、深度限制防无限链。
 */

import type { Task, TaskId } from "../domain/task/task.js";
import type { Clock } from "../ports/clock.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { MessageBus } from "./message-bus.js";
import type { TaskService } from "./task-service.js";
import { CommunicationDeniedError } from "../domain/message/agent-message.js";

// ---------------------------------------------------------------------------
// @@MSG 解析
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  to: string;
  type: "question" | "finding" | "request";
  content: string;
}

const MSG_BLOCK = /@@MSG\s+to=(\S+)\s+type=(question|finding|request)\s*\n([\s\S]*?)@@END/g;

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
// Worker 系统提示注入(告知 agent 可以用 @@MSG 通信)
// ---------------------------------------------------------------------------

export function buildCommunicationInstructions(canSendTo: readonly string[]): string {
  if (canSendTo.length === 0) return "";
  return [
    "",
    "## Agent Communication",
    "",
    `You can send messages to these agents: ${canSendTo.join(", ")}.`,
    "Use this format at the END of your response:",
    "",
    "```",
    "@@MSG to=<role> type=question",
    "Your question here",
    "@@END",
    "```",
    "",
    "- type=question: asks another agent to investigate; a follow-up task",
    "  will be created for you with their answer.",
    "- type=finding: shares information with another agent (no reply expected).",
    "- Only use this when you genuinely need input you cannot get yourself.",
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
}

export class AgentCommunicationService {
  readonly #maxDepth: number;

  constructor(private readonly deps: AgentCommunicationDeps) {
    this.#maxDepth = deps.maxContinuationDepth ?? 2;
  }

  /**
   * Scheduler 在任务完成后调用:解析 @@MSG → 路由 → 按需创建子任务/续接。
   */
  onTaskCompleted(task: Task): void {
    const response = task.output?.response ?? "";
    if (!response.includes("@@MSG")) return;

    const parsed = parseAgentMessages(response);
    if (parsed.length === 0) return;

    const fromAgent = task.input.role ?? "coder";
    const continuationDepth =
      (task.input.metadata?.continuationDepth as number | undefined) ?? 0;

    for (const msg of parsed) {
      this.#routeMessage(task, fromAgent, msg, continuationDepth);
    }
  }

  #routeMessage(
    task: Task,
    fromAgent: string,
    msg: ParsedMessage,
    continuationDepth: number,
  ): void {
    // 1) 记录到 MessageBus(thread 关联)
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
      if (error instanceof CommunicationDeniedError) return; // 策略拒绝,静默
      throw error;
    }

    // 2) finding 仅记录,不触发任务
    if (msg.type === "finding") return;

    // 3) 深度限制:续接链不超限
    if (continuationDepth >= this.#maxDepth) return;

    // 4) question/request → 创建子任务让目标 agent 回答
    const answerTask = this.deps.taskService.createTask({
      runId: task.runId,
      kind: msg.type === "question" ? "explore" : "implement",
      input: {
        prompt: [
          `Another agent (${fromAgent}) is asking you:`,
          "",
          msg.content,
          "",
          "Investigate and provide a clear, actionable answer.",
          "End with a concise summary starting with 'ANSWER:'.",
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

    // 5) question → 续接任务(带答案回来继续)
    if (msg.type === "question") {
      this.deps.taskService.createTask({
        runId: task.runId,
        kind: task.kind,
        dependencies: [answerTask.id],
        input: {
          prompt: [
            `You previously asked ${msg.to}: "${msg.content.slice(0, 200)}"`,
            "Their answer is provided in the upstream context below.",
            "Continue your original task with this information.",
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
   * 子任务(answer task)完成后:将答案写回 MessageBus(同 thread,replyTo)。
   * Scheduler 同样在完成后调用此方法。
   */
  onAnswerTaskCompleted(task: Task): void {
    const replyToId = task.input.metadata?.replyToMessageId as string | undefined;
    if (!replyToId) return;

    const answerContent = task.output?.response ?? "";
    // 提取 ANSWER: 之后的部分;找不到则全文
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
        // 同 thread + replyTo 原始 question
        threadId: task.input.metadata?.threadId as string | undefined,
        replyTo: replyToId,
      });
    } catch {
      // 策略拒绝或限速:答案仍在 task output 中,续接任务可通过 handoff 拿到
    }
  }
}
