# ZCAC Phase 12 — Agent Communication Layer 规范

**阶段：** Phase 12 — 受控 Agent 通信(v0.3 核心)
**前置：** Phase 0–11(v0.2 完整)
**状态：** Ready for Implementation
**日期：** 2026-10-02
**对应任务：** ZCAC-0011 ~ ZCAC-0015

---

# 1. 原则

> **受控结构化通信,不是自由聊天。**

- Event = 观察事实("发生了什么")→ 已有 Event Journal
- Message = 通信意图("我希望另一个 Agent 做什么/知道什么")→ 本阶段新增
- 所有 Message 经 ZCAC Message Bus 路由(鉴权/持久化/关联/限速)
- Agent 不能直接互调;通信能力由 Communication Policy 控制

---

# 2. 三层通信

## Layer 1: Task Communication(优先实现)

任务完成时,输出结构化上下文给下游任务:

```ts
interface TaskMessage {
  type: "task.handoff";
  fromTaskId: TaskId;
  toTaskId: TaskId;
  summary: string;        // "API 已实现,入口 src/api.ts"
  artifacts: ArtifactReference[];
  files: string[];        // 变更文件列表
}
```

下游任务启动时,其 prompt 自动附带上游 handoff 消息——
Tester 不需要重新扫描 workspace。

## Layer 2: Agent Direct Message

```ts
interface AgentMessage {
  id: string;
  runId: RunId;
  threadId: string;       // 会话链
  fromAgent: string;      // role or agentId
  toAgent: string;        // role or agentId
  type: "question" | "finding" | "request" | "handoff" | "broadcast";
  content: string;
  taskId?: TaskId;
  replyTo?: string;       // 前一条消息 id
  createdAt: number;
}
```

MCP 工具暴露给编排器/主模型:
- `zcac_send_message(to, content, type, taskId?)`
- `zcac_get_messages(agent?, threadId?, taskId?)`
- `zcac_reply(messageId, content)`

## Layer 3: Broadcast

复用现有 Event Journal(不新建);Supervisor/Pipeline 已消费事件。

---

# 3. Communication Policy

```ts
interface CommunicationPolicy {
  [role: string]: {
    canSendTo: string[];        // 允许发送目标角色
    canBroadcast: boolean;
    maxMessagesPerTask: number; // 默认 10
  };
}
```

默认策略:
```json
{
  "coder":     { "canSendTo": ["explorer", "tester", "planner"], "canBroadcast": false, "maxMessagesPerTask": 10 },
  "planner":   { "canSendTo": ["*"], "canBroadcast": true,  "maxMessagesPerTask": 20 },
  "explorer":  { "canSendTo": ["coder", "planner"], "canBroadcast": false, "maxMessagesPerTask": 10 },
  "tester":    { "canSendTo": ["coder", "reviewer"], "canBroadcast": false, "maxMessagesPerTask": 10 },
  "reviewer":  { "canSendTo": ["supervisor"], "canBroadcast": true, "maxMessagesPerTask": 5 }
}
```

---

# 4. 持久化

`zcac_messages` 表(SQLite,与 Event Journal 共库但语义分离):

```sql
CREATE TABLE zcac_messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    task_id TEXT,
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);
```

---

# 5. Message → Task Graph Bridge(ZCAC-0015)

第二阶段实现:特定 type 的 Message(如 `request.create_task`)可以触发
Graph 变更——由 Pipeline/Supervisor 消费 Message 并注入新 Task。

---

# 6. 完成定义

* [ ] AgentMessage 域模型 + CommunicationPolicy
* [ ] MessageBus(routing + authorization + persistence)
* [ ] zcac_messages 表
* [ ] MCP 工具:send/get/reply
* [ ] Task handoff:任务完成时自动生成 handoff Message
* [ ] 下游任务 prompt 注入上游 handoff 上下文
* [ ] 通信策略强制(越权发送被拒)
* [ ] 单测:消息路由/鉴权/线程/限速/handoff 注入
