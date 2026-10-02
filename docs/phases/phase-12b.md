# ZCAC Phase 12b — Layer 2: Agent Direct Message（任务链通信）

**阶段：** Phase 12b — Agent Direct Message via Task Chaining
**前置：** Phase 12(Message Bus + Layer 1 Handoff)
**日期：** 2026-10-02

---

# 1. 架构决策

Worker 是 fire-and-forget(launch → wait),无法实时暂停等回复。
Layer 2 通过**任务链**实现等效通信:

```text
Coder Task 1 完成 → 输出含 @@MSG question to=explorer
  ↓ AgentCommunicationService 解析
  ↓ MessageBus 记录 question(thread_001)
  ↓ 自动创建 Explorer 子任务(prompt=问题)
Explorer 完成 → 输出即答案
  ↓ MessageBus 记录 finding(thread_001, replyTo=question)
  ↓ 自动创建 Coder 续接任务(prompt=原上下文+答案)
Coder Task 2 → 带着答案继续工作
```

全程持久化(MessageBus)、可审计(thread)、受控(深度限制)。

# 2. 结构化标记格式

Worker 输出中的通信指令(LLM 易于生成和解析):

```
@@MSG to=explorer type=question
What does src/foo.ts export?
@@END
```

- `to=<role>`:目标角色
- `type=question|finding|request`:question 触发子任务;finding 仅记录
- `@@END` 结束标记

Worker 的系统提示(persona)中注入通信指令说明。

# 3. AgentCommunicationService

```typescript
class AgentCommunicationService {
  // Scheduler 在任务完成后调用
  onTaskCompleted(task: Task): void;

  // 解析 @@MSG 块
  parseMessages(response: string): ParsedMessage[];

  // question → 创建子任务 + 续接任务
  // finding → 仅记录 Message
  // request → 创建子任务(无续接)
  routeMessages(task: Task, messages: ParsedMessage[]): void;
}
```

# 4. 防护

- **深度限制**: 续接任务最多 2 层(防无限对话)
- **通信策略**: 沿用 CommunicationPolicy
- **限速**: 沿用 maxMessagesPerTask
- **线程**: 全链同一 threadId(可完整审计)

# 5. 完成定义

* [ ] @@MSG 解析器 + 单测
* [ ] AgentCommunicationService(路由 + 子任务 + 续接 + 深度限制)
* [ ] Scheduler 集成(完成后调用)
* [ ] Worker persona 注入通信指令
* [ ] 单测:解析/question 触发子任务/续接注入答案/finding 记录/深度限制
* [ ] 全量回归
