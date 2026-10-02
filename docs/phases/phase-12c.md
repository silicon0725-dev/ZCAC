# ZCAC Phase 12c — Layer 3: Broadcast + Task Bridge + Agent Discovery

**阶段：** Phase 12c — Layer 3(ZCAC-0014/0015)
**前置：** Phase 12(Message Bus)、12b(Layer 2)
**日期：** 2026-10-02

---

# 1. 四项能力

## 1.1 @@TASK 指令(Message → Task Graph Bridge,ZCAC-0015)

Agent 输出中直接创建新任务(运行时 Graph 变异):

```
@@TASK kind=implement role=coder
Fix the failing dependency at src/lib/missing.ts
@@END_TASK
```

可选字段:`depends=<taskId,...>` 指定依赖。

## 1.2 广播处理

`to=*` 消息路由到 CommunicationPolicy 允许接收的所有角色;
广播中的 actionable 内容可附带 @@TASK。

## 1.3 Agent Discovery(ZCAC-0014)

- `list_agents` MCP 工具:枚举可用角色 + 能力 + 配额
- Worker 系统提示注入可用 agent 列表(增强 @@MSG 的目标选择)

## 1.4 Event → Message 桥

关键 Event 自动写入 MessageBus(审计 + 可被 get_thread 查询):
- `REVIEW_FAILED` → broadcast message to coder/planner/supervisor
- `SUPERVISOR_DECISION` → finding message(记录决策)

---

# 2. 完成定义

* [ ] @@TASK 解析 + 单测
* [ ] AgentCommunicationService 处理 @@TASK(创建任务 + 依赖)
* [ ] 广播消息路由(策略过滤)
* [ ] list_agents MCP 工具
* [ ] Worker persona 注入可用 agent 列表
* [ ] Event→Message 桥(REVIEW_FAILED / SUPERVISOR_DECISION)
* [ ] 全量回归
