# ZCAC v0.1 Implementation Specification

**项目名称：** ZCode Agent Cluster（ZCAC）
**宿主：** ZCode
**目标模型：** GLM-5.3
**设计版本：** v0.1
**状态：** Implementation Draft
**基础版本：** ZCode v3.14.3
**上游约束：** ZCode 源码架构侦察报告 v1.0

---

# 1. 文档目的

ZCAC（ZCode Agent Cluster）是建立在 ZCode Agent Runtime 之上的多 Agent 编排系统。

ZCAC 的目标不是重新实现 Agent Runtime、模型调用、工具执行、上下文管理、权限系统或基础持久化，而是在 ZCode 已有执行能力之上增加：

* 多 Agent 编排
* 动态 Task Graph
* Agent Pool
* 依赖感知调度
* Cluster Event Bus
* Artifact 管理
* Review / Fix Loop
* Git Worktree 隔离
* 集群级持久化
* 崩溃恢复
* Supervisor 决策

核心原则：

> **ZCode 负责 Agent Execution Plane，ZCAC 负责 Agent Orchestration Plane。**

ZCAC 不应该成为第二个 ZCode。

---

# 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         ZCode UI / CLI                        │
│                                                              │
│   /cluster   /cluster-status   /cluster-stop   /cluster-review│
└──────────────────────────────┬───────────────────────────────┘
                               │
                               │ MCP
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     ZCAC Orchestrator                        │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │ Cluster      │   │ Task Graph   │   │ Scheduler       │  │
│  │ Controller   │──▶│              │──▶│                 │  │
│  └──────────────┘   └──────────────┘   └─────────────────┘  │
│          │                  │                    │             │
│          ▼                  ▼                    ▼             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                     Event Bus                           │  │
│  └────────────────────────────────────────────────────────┘  │
│          │                  │                    │             │
│          ▼                  ▼                    ▼             │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │ Agent Pool   │   │ ArtifactStore│   │ Persistence     │  │
│  └──────────────┘   └──────────────┘   └─────────────────┘  │
│          │                                                    │
│          ▼                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                 ZCode AgentRuntime                     │  │
│  │                                                        │  │
│  │ Planner │ Explorer │ Coder × N │ Tester │ Reviewer     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                               │
                               ▼
                       GLM-5.3 / BigModel
```

---

# 3. 核心边界

ZCAC 必须严格区分两个平面。

## 3.1 Execution Plane

由 ZCode 提供：

* AgentRuntime
* executeTurn
* 模型调用
* ToolRegistry
* ToolScheduler
* PermissionService
* ContextBuilder
* Compact
* MCP
* SubagentPort
* UsageStore
* Git 基础操作
* Session persistence

ZCAC 不重新实现这些能力。

---

## 3.2 Orchestration Plane

由 ZCAC 提供：

* Cluster
* Run
* Task
* Task Graph
* Scheduler
* Agent Pool
* Event Bus
* Artifact Store
* Review Loop
* Worktree Manager
* Lease
* Recovery
* Supervisor

这是 ZCAC 的核心价值。

---

# 4. Agent 模型

ZCAC 不创建第二套 Agent 类。

ZCode 中：

```text
AgentProfile
        +
AgentRuntime
        =
Agent
```

因此：

```text
planner
explorer
coder
tester
reviewer
integrator
supervisor
```

本质上全部是不同的 AgentProfile。

---

# 5. Agent Profile

推荐继续使用 ZCode 原生 Markdown Agent Profile：

```yaml
---
name: coder
description: Implements code changes assigned by the ZCAC scheduler.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
model: glm-5.3
permissionMode: auto
maxTurns: 40
---
```

ZCAC 不建立新的 Agent YAML 体系。

如果需要额外 Cluster 元数据，放在 ZCAC 自己的 Agent Capability Registry 中：

```typescript
interface AgentCapability {
    role: string
    capabilities: string[]
    maxConcurrency: number
    priority: number
}
```

例如：

```text
coder:
  capabilities:
    - code.write
    - code.edit
    - shell.execute

reviewer:
  capabilities:
    - code.read
    - code.review

tester:
  capabilities:
    - test.execute
    - shell.execute
```

---

# 6. Cluster 数据模型

ZCAC 的最小生命周期：

```text
Cluster
  └── Run
       ├── Task
       ├── AgentLease
       ├── Artifact
       └── Event
```

---

## 6.1 Cluster

表示一个长期存在的 Agent Cluster。

```typescript
interface Cluster {
    id: ClusterId
    name: string
    workspace: WorkspaceRef
    createdAt: number
}
```

---

## 6.2 Run

一次具体执行。

```typescript
interface Run {
    id: RunId
    clusterId: ClusterId
    status: RunStatus
    rootTaskId: TaskId
    createdAt: number
    startedAt?: number
    completedAt?: number
}
```

状态：

```text
created
planning
running
reviewing
waiting
completed
failed
cancelled
recovering
```

---

# 7. Task Model

Task 是 ZCAC 的核心调度单位。

```typescript
interface Task {
    id: TaskId
    runId: RunId

    type: TaskType
    status: TaskStatus

    input: TaskInput
    output?: TaskOutput

    dependencies: TaskId[]

    priority: number

    assignedAgent?: AgentId

    retryPolicy: RetryPolicy

    deadline?: number

    createdAt: number
    startedAt?: number
    completedAt?: number
}
```

---

# 8. Task Type

v0.1：

```text
plan
explore
implement
test
review
fix
integrate
custom
```

未来允许插件注册：

```typescript
registerTaskType({
    name: "benchmark",
    inputSchema,
    outputSchema
})
```

---

# 9. Task Status

```text
pending
blocked
ready
claimed
running
waiting
reviewing
completed
failed
cancelled
retrying
```

核心状态机：

```text
pending
   │
   ▼
blocked ─────────────┐
   │                 │
   │ dependencies    │
   ▼                 │
 ready                │
   │                 │
   ▼                 │
claimed               │
   │                 │
   ▼                 │
running               │
   │                  │
   ├── completed ─────┘
   │
   ├── retrying
   │      │
   │      └── running
   │
   └── failed
```

---

# 10. Task Graph

这是 ZCAC 第一项必须自建的核心能力。

ZCode dwf 的 Workflow Graph 不能直接承担该职责，因为：

> dwf 的图由脚本生成并在提交后冻结。

ZCAC 必须允许：

```text
Task A
   │
   ├── Task B
   ├── Task C
   │
   └── Task D
         │
         ▼
      Review
         │
       FAIL
         │
         ▼
      Fix Task
         │
         ▼
      Re-review
```

也就是说：

> Task Graph 必须是 Runtime Mutable DAG。

---

# 11. Task Graph API

```typescript
interface TaskGraph {
    addTask(task: Task): Promise<void>

    removeTask(taskId: TaskId): Promise<void>

    addDependency(
        taskId: TaskId,
        dependencyId: TaskId
    ): Promise<void>

    removeDependency(
        taskId: TaskId,
        dependencyId: TaskId
    ): Promise<void>

    getReadyTasks(): Promise<Task[]>

    getBlockedTasks(): Promise<Task[]>

    validate(): Promise<GraphValidationResult>
}
```

必须实现：

* DAG cycle detection
* dependency validation
* orphan detection
* ready-node calculation
* blocked-node calculation
* dynamic node insertion

---

# 12. Agent Pool

ZCode 的 SubagentPort 提供：

```text
launch
run
start
stop
sendMessage
```

但这不是 Agent Pool。

ZCAC Pool 是逻辑层。

```text
AgentPool
│
├── planner
│    └── slot × 1
│
├── explorer
│    └── slot × 2
│
├── coder
│    ├── slot × 1
│    ├── slot × 2
│    └── slot × 3
│
├── tester
│    └── slot × 2
│
└── reviewer
     └── slot × 1
```

---

# 13. Pool Slot

```typescript
interface AgentSlot {
    id: AgentSlotId

    role: string

    status:
        | "idle"
        | "starting"
        | "busy"
        | "stopping"

    currentTask?: TaskId

    runtime?: AgentRuntimeHandle
}
```

v0.1 不要求真正 Warm Runtime。

可以：

```text
Pool Slot
   ↓
claim
   ↓
SubagentPort.launch()
   ↓
AgentRuntime
```

因此 Pool 首先提供的是：

* 名册
* 并发限制
* 能力匹配
* 租约
* 任务绑定

而不是物理进程池。

真正 Warm Pool 可以在 v0.2 实现。

---

# 14. Scheduler

Scheduler 是 ZCAC 第二项核心自建能力。

Scheduler 输入：

```text
Task Graph
Agent Pool
Resource Limits
Retry Policy
Deadline
Priority
```

输出：

```text
Task → Agent Slot
```

---

# 15. Scheduler v0.1

v0.1 只实现：

```text
Dependency-aware FIFO
```

调度顺序：

1. 查询 READY Task
2. 按 priority 排序
3. 检查 Agent Capability
4. 检查 role quota
5. 检查全局并发
6. claim Task
7. 创建 Agent
8. 执行 Task
9. 写入 Event
10. 更新 Task 状态
11. 重新计算 Graph

---

# 16. Scheduler v0.2

增加：

```text
priority
resource budget
deadline
retry backoff
provider quota
model quota
cost budget
```

---

# 17. 并发控制

ZCode 已有：

```text
ConcurrencyController
ModelRequestAdmission
AIMD
```

ZCAC 不应该重新实现 Provider-level AIMD。

应该形成两层：

```text
ZCAC Scheduler
      │
      │ Task concurrency
      ▼
AgentRuntime
      │
      │ Model admission
      ▼
ZCode ConcurrencyController
      │
      ▼
GLM-5.3
```

这样：

> ZCAC 控制“多少个任务同时运行”，ZCode 控制“多少模型请求可以同时进入 Provider”。

---

# 18. Event Bus

ZCAC Event Bus 采用：

```text
Journal + Live Emit
```

模式。

事件：

```typescript
interface ClusterEvent {
    id: EventId

    runId: RunId

    timestamp: number

    type: ClusterEventType

    taskId?: TaskId
    agentId?: AgentId
    artifactId?: ArtifactId

    payload: unknown
}
```

---

# 19. Event Type

最小集合：

```text
CLUSTER_CREATED
CLUSTER_STARTED
CLUSTER_COMPLETED
CLUSTER_FAILED

RUN_CREATED
RUN_STARTED
RUN_COMPLETED
RUN_FAILED
RUN_RECOVERED

TASK_CREATED
TASK_READY
TASK_CLAIMED
TASK_STARTED
TASK_COMPLETED
TASK_FAILED
TASK_RETRYING
TASK_CANCELLED

AGENT_ASSIGNED
AGENT_STARTED
AGENT_MESSAGE
AGENT_COMPLETED
AGENT_FAILED

ARTIFACT_CREATED
ARTIFACT_UPDATED
ARTIFACT_REVIEWED

REVIEW_STARTED
REVIEW_PASSED
REVIEW_FAILED

WORKTREE_CREATED
WORKTREE_REMOVED
MERGE_STARTED
MERGE_COMPLETED
MERGE_CONFLICT

RECOVERY_STARTED
RECOVERY_COMPLETED
```

---

# 20. Event Sourcing 边界

ZCAC v0.1 不采用完整 Event Sourcing。

事件主要用于：

* 状态变化记录
* 实时观察
* Recovery
* Debug
* Replay

权威状态仍然保存在：

```text
tasks
runs
agents
artifacts
worktrees
```

Event 是事实记录，而不是唯一数据库。

---

# 21. Artifact System

Artifact 是 Agent 之间交换工作的正式接口。

禁止主要依赖：

```text
Agent A → 大段文本 → Agent B
```

而应该：

```text
Agent A
   │
   ▼
Artifact
   │
   ▼
Agent B
```

---

# 22. Artifact 类型

v0.1：

```text
report
finding
patch
diff
test_result
review
plan
log
```

例如：

```typescript
interface Artifact {
    id: ArtifactId

    runId: RunId
    taskId: TaskId

    type: ArtifactType

    content: ArtifactContent

    checksum: string

    createdAt: number
}
```

---

# 23. Structured Result

Worker 必须通过：

```text
zcac_submit_result
```

提交最终结果。

例如 Reviewer：

```json
{
  "status": "failed",
  "findings": [
    {
      "severity": "high",
      "file": "src/foo.ts",
      "line": 42,
      "message": "..."
    }
  ]
}
```

Schema 验证失败：

```text
submit_result
     │
     ▼
Schema validation
     │
     ├── PASS → Task completed
     │
     └── FAIL
           │
           ▼
      correction prompt
           │
           ▼
        retry
```

最多：

```text
3 attempts
```

参考 ZCode dwf 的结构化提交 + 修复循环。

---

# 24. Review Loop

Review Loop 是 ZCAC 的核心自动闭环。

```text
Implement
   │
   ▼
Test
   │
   ▼
Review
   │
   ├── PASS
   │    │
   │    ▼
   │  Complete
   │
   └── FAIL
        │
        ▼
      Finding
        │
        ▼
      Fix Task
        │
        ▼
       Test
        │
        ▼
      Review
```

---

# 25. Review Loop 限制

必须设置：

```typescript
interface ReviewPolicy {
    maxRounds: number
}
```

默认：

```text
maxRounds = 3
```

防止：

```text
Review → Fix → Review → Fix → ...
```

无限运行。

---

# 26. Supervisor

Supervisor 不是普通 Worker。

它负责：

```text
Cluster-level decision
```

例如：

```text
Reviewer FAIL
      │
      ▼
Supervisor
      │
      ├── create Fix Task
      ├── ask Coder to retry
      ├── spawn Explorer
      ├── escalate to user
      └── terminate run
```

Supervisor 不应该直接修改代码。

---

# 27. Git Isolation

这是 ZCAC 第一批必须真正从零实现的基础设施之一。

ZCode 当前没有 Worktree 创建能力。

因此：

```text
ZCAC WorktreeManager
```

必须自建。

---

# 28. Worktree 生命周期

```text
Task claimed
     │
     ▼
create worktree
     │
     ▼
bind workspaceKey
     │
     ▼
AgentRuntime
     │
     ▼
commit
     │
     ▼
Review
     │
     ├── PASS → merge
     │
     └── FAIL → continue worktree
```

---

# 29. Worktree API

```typescript
interface WorktreeManager {
    create(req: CreateWorktreeRequest): Promise<Worktree>

    remove(worktreeId: WorktreeId): Promise<void>

    get(worktreeId: WorktreeId): Promise<Worktree>

    diff(worktreeId: WorktreeId): Promise<Diff>

    commit(
        worktreeId: WorktreeId,
        message: string
    ): Promise<Commit>

    merge(
        worktreeId: WorktreeId,
        target: string
    ): Promise<MergeResult>
}
```

---

# 30. Agent ↔ Worktree 绑定

每个写入型 Agent Task 必须有：

```text
Agent
Task
Worktree
WorkspaceKey
```

四者关系：

```text
Task
 │
 ├── AgentSlot
 │
 └── Worktree
       │
       └── WorkspaceKey
```

禁止多个写入 Agent 默认共享同一个工作目录。

v0.1 如果 Worktree 尚未完成，可以暂时使用共享 workspace 作为实验模式，但必须显式标记：

```text
workspaceIsolation = "shared"
```

不能让它成为默认架构。

---

# 31. Persistence

ZCAC 使用独立 SQLite：

```text
~/.zcode/zcac/
└── zcac.sqlite
```

不直接把集群状态混进 ZCode session database。

---

# 32. 数据表

最小：

```text
zcac_clusters
zcac_runs
zcac_tasks
zcac_task_dependencies
zcac_agents
zcac_agent_leases
zcac_events
zcac_artifacts
zcac_worktrees
```

---

# 33. Task Claim

参考 ZCode：

```text
automationRepo.claimDue
```

使用原子 Claim。

伪代码：

```sql
BEGIN IMMEDIATE;

SELECT task
FROM zcac_tasks
WHERE status = 'ready'
  AND lease_until < now()
LIMIT 1;

UPDATE zcac_tasks
SET
    status = 'claimed',
    agent_id = ?,
    lease_until = ?
WHERE id = ?;

COMMIT;
```

这样可以为未来多进程 Scheduler 做准备。

---

# 34. Lease

Agent Task 不允许永久占用。

```typescript
interface Lease {
    id: string
    owner: string
    acquiredAt: number
    expiresAt: number
}
```

Scheduler 定期：

```text
heartbeat
```

如果 Agent 崩溃：

```text
lease expires
      │
      ▼
task reclaimed
      │
      ▼
retry / recovery
```

---

# 35. Recovery

Recovery 不重新执行已经确认完成的 Task。

基本原则：

> **Completed Task is immutable.**

例如：

```text
A ✓
B ✓
C running
D blocked
```

进程崩溃。

恢复：

```text
A ✓
B ✓
C → retry/resume
D → blocked
```

不会：

```text
A → rerun
B → rerun
```

---

# 36. Recovery 流程

```text
Process startup
      │
      ▼
Load Run
      │
      ▼
Replay journal
      │
      ▼
Reconcile task states
      │
      ▼
Detect expired leases
      │
      ▼
Recover incomplete tasks
      │
      ▼
Rebuild Task Graph
      │
      ▼
Resume Scheduler
```

---

# 37. ZCode Session Recovery

ZCAC 不重新实现 Agent Session Recovery。

直接利用：

```text
ColdSessionResumeCoordinator
hydrateMessageHistoryFromSession
```

以及 ZCode session persistence。

ZCAC 只负责决定：

```text
这个 Agent Task 是否需要继续？
```

---

# 38. MCP 架构

ZCAC v0.1 作为：

```text
ZCode Plugin
```

发布。

插件：

```text
zcode-agent-cluster/
├── .zcode-plugin/
│   └── plugin.json
│
├── .mcp.json
│
├── agents/
├── commands/
├── skills/
│
├── src/
│
└── dist/
    └── orchestrator.js
```

---

# 39. MCP Server

ZCAC Orchestrator 通过 stdio MCP 启动：

```text
ZCode
  │
  ▼
MCP Client
  │
  ▼
node orchestrator.js
  │
  ▼
ZCAC
```

ZCAC MCP API：

```text
cluster_create
cluster_status
cluster_start
cluster_stop
cluster_resume
cluster_cancel

task_create
task_status
task_list

agent_list
agent_status

artifact_get
artifact_list

review_start
```

---

# 40. 为什么 Orchestrator 必须独立进程

ZCode Plugin 没有：

```text
Plugin Runtime API
Plugin UI API
Plugin in-process ABI
```

因此不能：

```text
ZCode Host
   │
   └── load zcac.ts
```

而应该：

```text
ZCode Host
   │
   └── MCP
        │
        ▼
    ZCAC Process
```

这样也为 v0.2 多进程 Worker 做准备。

---

# 41. ZCAC Core 包结构

建议：

```text
zcac/
├── packages/
│
├── core/
│   ├── cluster/
│   ├── task/
│   ├── graph/
│   ├── scheduler/
│   ├── agent-pool/
│   ├── event/
│   ├── artifact/
│   ├── review/
│   ├── recovery/
│   └── supervisor/
│
├── adapters/
│   ├── zcode/
│   ├── sqlite/
│   ├── git/
│   └── filesystem/
│
├── mcp-server/
│
├── plugin/
│   ├── agents/
│   ├── commands/
│   └── skills/
│
└── tests/
```

---

# 42. Adapter Boundary

这是整个项目非常重要的一条边界：

```text
ZCAC Core
    │
    ├── ZCodeAdapter
    ├── GitAdapter
    ├── PersistenceAdapter
    └── MCPAdapter
```

Core 不应该直接大量 import ZCode 内部模块。

推荐：

```typescript
interface AgentExecutor {
    launch(req: AgentLaunchRequest): Promise<AgentHandle>
    send(handle: AgentHandle, message: string): Promise<void>
    wait(handle: AgentHandle): Promise<AgentResult>
    stop(handle: AgentHandle): Promise<void>
}
```

然后：

```text
ZCodeAgentExecutor
        ↓
SubagentPort / AgentRuntime
```

---

# 43. 为什么一定要 Adapter

ZCode 内部：

```text
@zcode/core
@zcode/bootstrap
@zcode/contracts
```

目前并没有公开稳定 API 保证。

如果 ZCode 更新：

```text
AgentRuntime
```

ZCAC 只修改：

```text
adapters/zcode/
```

而不应该修改：

```text
TaskGraph
Scheduler
ReviewLoop
Recovery
```

---

# 44. v0.1 Worker 执行方式

推荐：

```text
ZCAC
 │
 ├── AgentExecutor
 │
 ▼
ZCode SubagentPort
 │
 ▼
AgentRuntime
 │
 ▼
GLM-5.3
```

而不是：

```text
ZCAC
 │
 ▼
shell
 │
 ▼
zcode CLI
```

后者作为 v0.2 fallback。

---

# 45. v0.2 Worker Isolation

未来可以替换：

```text
ZCodeAgentExecutor
```

为：

```text
ZCodeProtocolAgentExecutor
```

架构不变：

```text
ZCAC
 │
 ▼
AgentExecutor
 │
 ├── InProcessExecutor
 │
 └── ProtocolExecutor
       │
       ▼
   app-server --stdio
```

这使 ZCAC 天然支持：

* 多进程
* 崩溃隔离
* 多机器
* Remote Worker

---

# 46. v0.3 Remote Worker

最终可以：

```text
                 ZCAC
                   │
        ┌──────────┼──────────┐
        │          │          │
        ▼          ▼          ▼
     Worker A   Worker B   Worker C
        │          │          │
      Local      Local      Remote
```

Transport：

```text
stdio
HTTP
WebSocket
```

而 Scheduler 完全不需要改变。

---

# 47. Worker Contract

无论底层 Agent 怎么启动，对 ZCAC 都统一成：

```typescript
interface Worker {
    id: WorkerId
    capabilities: Capability[]

    execute(task: Task): Promise<TaskResult>

    cancel(): Promise<void>

    heartbeat(): Promise<void>
}
```

---

# 48. First E2E

第一个完整测试不要从复杂 Coding Agent 开始。

使用：

```text
Task:
创建 hello() API
```

Task Graph：

```text
Planner
   │
   ▼
Coder
   │
   ▼
Tester
   │
   ▼
Reviewer
   │
   ├── PASS → Complete
   │
   └── FAIL → Fix
                 │
                 ▼
               Tester
```

---

# 49. First E2E Acceptance Criteria

必须证明：

```text
[ ] Cluster 创建
[ ] Run 创建
[ ] Task Graph 创建
[ ] Planner Agent 启动
[ ] Coder Agent 启动
[ ] Tester Agent 启动
[ ] Reviewer Agent 启动
[ ] GLM-5.3 正常调用
[ ] Agent 可以修改文件
[ ] Tester 可以运行测试
[ ] Reviewer 可以产生结构化 Finding
[ ] Review FAIL 可以动态创建 Fix Task
[ ] Review PASS 可以完成 Run
[ ] Event Journal 完整
[ ] Artifact 正常生成
[ ] SQLite 状态正确
```

---

# 50. 第二阶段 E2E

增加：

```text
两个并行 Coder
```

例如：

```text
          ┌── Coder A ──┐
Planner ──┤             ├── Tester ── Reviewer
          └── Coder B ──┘
```

必须验证：

```text
Agent Pool
Task claim
parallel execution
dependency scheduling
event ordering
artifact isolation
```

---

# 51. 第三阶段 E2E

增加 Review Loop：

```text
Coder
  ↓
Tester
  ↓
Reviewer
  ↓
FAIL
  ↓
Fix Task
  ↓
Coder
  ↓
Tester
  ↓
Reviewer
  ↓
PASS
```

必须验证动态 DAG。

这是证明 ZCAC 和 dwf 本质区别的第一个测试。

---

# 52. 第四阶段 E2E

增加崩溃：

```text
Coder
  ↓
process kill
```

然后重新启动 ZCAC。

预期：

```text
Run = recovering

Completed tasks:
    不重复执行

Running task:
    lease expired

Scheduler:
    reclaim

Task:
    retry/resume
```

---

# 53. 第五阶段 E2E

增加 Git Worktree：

```text
Coder A → worktree/A
Coder B → worktree/B
```

两者同时修改不同文件。

然后：

```text
Reviewer
   ↓
PASS
   ↓
Merge
```

最后测试：

```text
conflict
```

验证 Supervisor / Integrator 的处理。

---

# 54. 开发阶段

## Phase 0 — Adapter PoC

目标：

```text
ZCAC → ZCode → AgentRuntime → GLM-5.3
```

只实现：

```text
AgentExecutor
```

不实现完整 Cluster。

验收：

```text
Node script
  ↓
launch coder
  ↓
prompt
  ↓
result
```

---

## Phase 1 — Task Core

实现：

```text
Cluster
Run
Task
TaskGraph
Event
SQLite
```

暂时不做：

```text
Pool
Worktree
Review Loop
```

---

## Phase 2 — Scheduler

实现：

```text
ready calculation
claim
dependency
role matching
concurrency
lease
retry
```

---

## Phase 3 — Agent Pool

实现：

```text
slot
capability
role quota
agent lifecycle
```

---

## Phase 4 — Artifact

实现：

```text
ArtifactStore
submit_result
JSON Schema
checksum
```

---

## Phase 5 — Review Loop

实现：

```text
Review
Finding
Fix Task
Re-review
max_rounds
```

---

## Phase 6 — Git Isolation

实现：

```text
worktree add
worktree remove
workspaceKey
agent binding
commit
merge
conflict
```

---

## Phase 7 — Recovery

实现：

```text
journal replay
lease recovery
task reconciliation
resume
```

---

## Phase 8 — Plugin

最后包装：

```text
agents/
commands/
skills/
.mcp.json
```

这样开发过程中可以直接运行 ZCAC Core，而不被 Plugin Packaging 限制。

---

# 55. ZCAC-0001 ~ ZCAC-0010

## ZCAC-0001 — Task Model

实现：

```text
Task
TaskStatus
TaskInput
TaskOutput
RetryPolicy
TaskDependency
```

验收：

```text
create → update → complete
```

---

## ZCAC-0002 — Task Graph

实现：

```text
DAG
dependency
ready
blocked
cycle detection
dynamic insertion
```

验收：

```text
A → B → C

以及：

A → B
A → C
B,C → D
```

---

## ZCAC-0003 — Agent Pool

实现：

```text
AgentSlot
AgentCapability
AgentLease
role quota
```

---

## ZCAC-0004 — Scheduler

实现：

```text
dependency-aware FIFO
claim
lease
retry
concurrency
```

---

## ZCAC-0005 — Event Bus

实现：

```text
ClusterEvent
EventJournal
EventSubscriber
Replay
```

---

## ZCAC-0006 — Artifact System

实现：

```text
Artifact
ArtifactStore
checksum
version
schema
```

---

## ZCAC-0007 — Review Loop

实现：

```text
Review
Finding
FixTask
maxRounds
```

---

## ZCAC-0008 — Git Isolation

实现：

```text
WorktreeManager
workspace binding
commit
merge
conflict
```

---

## ZCAC-0009 — Persistence

实现：

```text
SQLite
transactions
claim
lease
snapshot
```

---

## ZCAC-0010 — Recovery

实现：

```text
journal replay
task reconciliation
expired lease recovery
resume
```

---

# 56. v0.1 明确不做

为了避免项目迅速膨胀，v0.1 禁止加入：

```text
多机 Cluster
Kubernetes
Remote Worker
Web Dashboard
复杂 UI
真正 Warm Agent Pool
Agent-to-Agent 自由递归
自动模型选择
多 Provider Routing
完整 Event Sourcing
复杂经济/Token Budget
```

尤其禁止：

> 为了“多 Agent”重新实现 ZCode Agent Runtime。

---

# 57. v0.1 模型策略

第一版统一：

```text
GLM-5.3
```

所有 Agent 可以使用同一个模型。

区别主要来自：

```text
System Prompt
Tool Set
Permission
Context Policy
Task Type
```

而不是模型。

后续再支持：

```text
planner → GLM-5.3
coder → GLM-5.3
reviewer → GLM-5.3
```

以及未来：

```text
planner → model A
coder → model B
reviewer → model C
```

Scheduler 不应该绑定具体模型。

---

# 58. 关键设计原则

## Principle 1

**ZCode 是执行引擎，ZCAC 是调度系统。**

---

## Principle 2

**Agent 是资源，不是 Task。**

Task 生命周期独立于 Agent 生命周期。

---

## Principle 3

**Task Graph 是权威调度结构。**

Agent 不能自行决定下一项 Task。

---

## Principle 4

**Event 是事实记录，不是唯一状态。**

---

## Principle 5

**Artifact 是 Agent 间正式通信媒介。**

---

## Principle 6

**Worktree 是写入 Agent 的隔离边界。**

---

## Principle 7

**Completed Task 不应该因为 Scheduler 重启而重复执行。**

---

## Principle 8

**所有 ZCode 内部依赖必须经过 Adapter。**

---

## Principle 9

**v0.1 不需要真正 Warm Agent Pool。**

先建立 Pool Semantic，再优化 Runtime。

---

## Principle 10

**动态 DAG 是 ZCAC 相对于 ZCode dwf 的核心新增能力。**

---

# 59. 最终 v0.1 架构

```text
                         ZCode
                           │
                     Plugin / MCP
                           │
                           ▼
                 ┌──────────────────┐
                 │ ZCAC Controller  │
                 └────────┬─────────┘
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
      Task Graph       Scheduler       Event Bus
          │               │                │
          │               ▼                │
          │          Agent Pool             │
          │               │                │
          └───────────────┼────────────────┘
                          │
                    Agent Executor
                          │
                    ZCode Adapter
                          │
                    SubagentPort
                          │
                    AgentRuntime
                          │
                       GLM-5.3
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
       Planner          Coder           Reviewer
                                           │
                                           ▼
                                      Finding
                                           │
                                           ▼
                                      Fix Task
                                           │
                                           └───────┐
                                                   │
                         ┌─────────────────────────┘
                         ▼
                     Task Graph
```

---

# 60. 开工顺序

实际开始编码时，不应该按照编号机械执行，而应该按照依赖关系：

```text
                    ┌─────────────┐
                    │ ZCode       │
                    │ Adapter PoC │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ ZCAC-0001   │
                    │ Task Model  │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ ZCAC-0002   │
                    │ Task Graph  │
                    └──────┬──────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
         ┌─────────────┐       ┌─────────────┐
         │ ZCAC-0003   │       │ ZCAC-0005   │
         │ Agent Pool  │       │ Event Bus   │
         └──────┬──────┘       └──────┬──────┘
                │                     │
                └──────────┬──────────┘
                           ▼
                    ┌─────────────┐
                    │ ZCAC-0004   │
                    │ Scheduler   │
                    └──────┬──────┘
                           │
             ┌─────────────┼──────────────┐
             ▼             ▼              ▼
       ZCAC-0006      ZCAC-0007      ZCAC-0008
       Artifact       Review Loop     Worktree
             │             │              │
             └─────────────┼──────────────┘
                           ▼
                    ┌─────────────┐
                    │ ZCAC-0009   │
                    │ Persistence │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ ZCAC-0010   │
                    │ Recovery    │
                    └─────────────┘
```

---

# 61. Definition of Done

ZCAC v0.1 只有同时满足以下条件才能认为完成：

```text
✓ 可以从 ZCode 中启动 Cluster
✓ 可以创建动态 Task Graph
✓ 可以同时运行多个 Agent
✓ Agent 能使用 GLM-5.3
✓ Scheduler 能处理依赖
✓ Agent Pool 能限制并发
✓ Task 有持久状态
✓ Event 有 journal
✓ Agent 可以提交结构化 Artifact
✓ Reviewer 可以产生 Finding
✓ FAIL 可以动态创建 Fix Task
✓ Review 可以自动循环
✓ Agent Task 有 Lease
✓ ZCAC 崩溃后可以恢复
✓ 成功 Task 不重复执行
✓ Coding Agent 可以使用独立 Git Worktree
✓ Worktree 可以合并
✓ 冲突可以进入 Supervisor 流程
✓ ZCAC 可以作为 ZCode Plugin 使用
```

---

# 62. 最终定位

ZCAC 不应该成为：

> “一个可以同时启动很多 ZCode Agent 的脚本。”

它应该成为：

> **ZCode Agent Runtime 之上的一个可靠、可恢复、可动态修改的 Agent Orchestration Runtime。**

ZCode 解决：

```text
How does an Agent work?
```

ZCAC 解决：

```text
Which Agent should work?
What should it work on?
When should it work?
What does it depend on?
Where should it work?
What happens if it fails?
How should another Agent review it?
How should the whole system recover?
```

两者组合之后：

```text
ZCode
= Agent Execution Runtime

ZCAC
= Agent Orchestration Runtime

ZCode + ZCAC
= Multi-Agent Engineering System
```

---

# Appendix A — 当前已确认的 ZCode 复用资产

| 能力                | ZCode                   | ZCAC         |
| ----------------- | ----------------------- | ------------ |
| Agent Runtime     | `AgentRuntime`          | 直接复用         |
| Worker API        | `SubagentPort`          | Adapter      |
| Agent Profile     | `AgentProfile`          | 直接复用         |
| Tool Execution    | ToolRegistry            | 直接复用         |
| Permission        | PermissionService       | 直接复用         |
| Context           | ContextBuilder          | 直接复用         |
| Compact           | Compact system          | 直接复用         |
| Model             | Provider/ModelExecution | 直接复用         |
| Usage             | UsageStore              | 直接复用         |
| AIMD              | ConcurrencyController   | 直接复用         |
| Structured Result | dwf submit_result       | 适配           |
| Journal           | dwf journal             | 参考/适配        |
| Recovery          | dwf/session recovery    | 组合           |
| Claim             | automationRepo.claimDue | 参考           |
| Agent Pool        | 无                       | 自建           |
| Dynamic DAG       | 不满足要求                   | 自建           |
| Scheduler         | 不满足要求                   | 自建           |
| Event Bus         | 部分存在                    | 自建 Cluster 层 |
| Artifact          | 部分存在                    | 扩展           |
| Review Loop       | 无                       | 自建           |
| Worktree          | 未实现                     | 自建           |
| Merge             | 未实现                     | 自建           |

---

# Appendix B — 第一批源码入口

ZCAC 开发时首先建立：

```text
adapters/zcode/
├── agent-executor.ts
├── agent-profile.ts
├── usage.ts
└── zcode-runtime.ts
```

重点验证：

```text
createZCodeApp
AgentRuntime
SubagentPort
workflow-driver
```

然后建立：

```text
core/
├── task/
├── graph/
├── scheduler/
└── event/
```

第一条真正的执行链：

```text
ZCAC Task
   ↓
Scheduler
   ↓
AgentExecutor
   ↓
SubagentPort
   ↓
AgentRuntime
   ↓
GLM-5.3
   ↓
TaskResult
   ↓
Event
```

只要这一条链打通，后面的 Agent Pool、Review、Artifact、Recovery 都是在这个基础上逐层增加，而不是重新寻找 ZCode 的入口。
