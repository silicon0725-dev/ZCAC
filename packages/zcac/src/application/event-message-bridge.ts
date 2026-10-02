/**
 * ZCAC Phase 12c — Event → Message 桥(application)。
 *
 * 把关键集群事件自动写入 MessageBus(system 发送,免策略),
 * 让 get_thread / get_messages 能看到完整的事件叙事而不只是 agent 对话:
 *
 *   REVIEW_FAILED        → broadcast message(to=*, 记录 findings)
 *   SUPERVISOR_DECISION  → finding message(记录决策 + 预算)
 *   MERGE_CONFLICT       → finding message(记录冲突文件)
 *   RUN_FAILED           → broadcast message(记录 reason)
 *
 * Event Journal 仍是 source of truth(观察/重放);
 * 桥只做"叙事投射",消息丢失不影响恢复。
 */

import type { ClusterEvent } from "../domain/event/cluster-event.js";
import type { MessageBus } from "./message-bus.js";

/** 需要投射到 MessageBus 的事件类型。 */
const BRIDGED_EVENTS: ReadonlySet<string> = new Set([
  "REVIEW_FAILED",
  "SUPERVISOR_DECISION",
  "MERGE_CONFLICT",
  "RUN_FAILED",
]);

export class EventMessageBridge {
  constructor(private readonly messageBus: MessageBus) {}

  /**
   * 处理单个事件(由 build.ts 的 EventBus 订阅回调调用)。
   * 系统消息免检,任何失败静默(叙事投射不能影响控制流)。
   */
  onEvent(event: ClusterEvent): void {
    if (!BRIDGED_EVENTS.has(event.type)) return;
    try {
      this.messageBus.send({
        runId: event.runId,
        fromAgent: "system",
        toAgent: "*",
        type: "broadcast",
        content: JSON.stringify({
          eventType: event.type,
          sequence: event.sequence,
          taskId: event.taskId,
          agentId: event.agentId,
          payload: event.payload,
        }),
        ...(event.taskId ? { taskId: event.taskId } : {}),
        metadata: { bridge: true, sourceEvent: event.type },
      });
    } catch {
      // 叙事投射失败不影响控制流
    }
  }
}
