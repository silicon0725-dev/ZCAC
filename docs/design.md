# ZCode Agent Cluster

## 基于 ZCode 的 GLM-5.3 多 Agent 集群扩展

**文档版本：** v0.1
**状态：** Draft
**目标：** 在 ZCode 现有 Agent / Subagent / Workflow / MCP / Plugin 基础设施之上，实现可并行、可协作、可恢复、可审计的多 Agent Coding Cluster。

---

# 1. 项目定位

ZCode Agent Cluster（以下简称 ZCAC）不是一个新的 IDE，也不是重新实现一个 Coding Agent。

ZCAC 是 ZCode 的 Cluster Orchestration Layer。

核心思想：

```text
┌─────────────────────────────────────────────┐
│                    ZCode                    │
│                                             │
│  Editor / Workspace / Git / MCP / Tools     │
│                                             │
│              Agent Runtime                  │
└──────────────────────┬──────────────────────┘
                       │
                       │ Cluster API
                       ↓
┌─────────────────────────────────────────────┐
│              ZCode Agent Cluster             │
│                                             │
│  Supervisor                                 │
│  Planner                                    │
│  Scheduler                                  │
│  Agent Pool                                 │
│  Event Bus                                  │
│  Shared State                               │
│  Task Graph                                 │
│  Review / Retry                             │
│  Artifact Manager                           │
└───────────┬──────────┬──────────┬───────────┘
            │          │          │
            ↓          ↓          ↓
        GLM-5.3    GLM-5.3    GLM-5.3
        Agent A    Agent B    Agent C
```

ZCAC 不应该复制 ZCode 已经拥有的能力。

原则：

> ZCode 负责 Agent 的执行能力，ZCAC 负责 Agent 的组织能力。

---

# 2. 核心目标

ZCAC v1 必须解决以下问题：

1. 一个任务可以拆分成多个 Agent Task。
2. 多个 Agent 可以并行运行。
3. Agent 可以拥有不同职责。
4. Agent 可以共享结构化状态。
5. Agent 可以读取其他 Agent 的产物。
6. Agent 可以向 Supervisor 报告结果。
7. 失败任务可以自动 Retry。
8. Agent 可以进行 Review → Fix → Re-review。
9. 所有 Agent 行为都可以追踪。
10. 集群状态可以恢复。
11. Git 工作区不会因为多个 Agent 并行修改而失控。
12. ZCode 原有单 Agent 工作方式必须继续可用。

---

# 3. 非目标

v1 不做：

* 自己实现新的 LLM Runtime
* 自己实现 IDE
* 自己实现 Git
* 自己实现 MCP
* 自己实现文件编辑器
* 自己实现代码搜索引擎
* 自己实现终端
* 自己替换 ZCode Agent Runtime
* 强制所有任务使用 Cluster

ZCAC 是增量层。

---

# 4. 总体架构

```text
                         User
                           │
                           ↓
                     ZCode UI / CLI
                           │
                           ↓
                 ┌───────────────────┐
                 │ Cluster Controller │
                 └─────────┬─────────┘
                           │
             ┌─────────────┼─────────────┐
             ↓             ↓             ↓
         Planner       Scheduler      Supervisor
             │             │             │
             └─────────────┼─────────────┘
                           ↓
                     Task Graph
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
          Agent A       Agent B       Agent C
          Research      Coding        Testing
              │            │            │
              └────────────┼────────────┘
                           ↓
                      Event Bus
                           │
                           ↓
                     Shared State
                           │
                           ↓
                       Reviewer
                           │
                    ┌──────┴──────┐
                    ↓             ↓
                   PASS          FAIL
                    │             │
                    ↓             ↓
                 Finish          Retry
```

---

# 5. 核心组件

## 5.1 Cluster Controller

Cluster Controller 是整个系统的入口。

职责：

* 创建 Cluster
* 加载 Cluster 配置
* 启动 Scheduler
* 启动 Agent
* 管理生命周期
* 暂停 / 恢复 Cluster
* 处理异常
* 保存状态
* 对外提供 API

生命周期：

```text
CREATED
   ↓
PLANNING
   ↓
SCHEDULING
   ↓
RUNNING
   ↓
REVIEWING
   ↓
COMPLETED
```

异常状态：

```text
RUNNING
   ↓
FAILED
   ↓
RECOVERING
   ↓
RUNNING
```

---

# 6. Agent Model

每一个 Agent 都必须具有明确的身份。

```yaml
agent:
  id: architect
  name: Architect
  role: architecture
  model: glm-5.3

  capabilities:
    - repository_analysis
    - architecture_design
    - dependency_analysis

  tools:
    - filesystem
    - git
    - search

  permissions:
    filesystem: read
    git: read
```

Agent 不应该简单理解为：

> 一个 Prompt。

Agent 是：

```text
Identity
+
Role
+
Capabilities
+
Tools
+
Permissions
+
Context Policy
+
Execution Policy
```

---

# 7. 推荐的默认 Agent Pool

ZCAC 默认提供：

```text
supervisor
planner
explorer
researcher
architect
coder
tester
reviewer
integrator
```

其中：

### Supervisor

负责：

* 全局任务状态
* 决策
* 失败处理
* Agent 协调

### Planner

负责：

* 将用户任务拆分成 Task Graph
* 判断依赖关系
* 判断哪些任务可以并行

### Explorer

只读分析：

* Repository
* 文件结构
* 调用关系
* 现有实现

### Researcher

负责：

* 文档
* API
* 外部资料
* 技术调研

### Architect

负责：

* 架构
* API
* 数据结构
* 模块边界

### Coder

负责：

* 实际代码修改

### Tester

负责：

* 测试
* 构建
* 静态检查
* Regression

### Reviewer

负责：

* Diff Review
* Architecture Review
* Security Review
* Regression Review

### Integrator

负责：

* 合并结果
* 处理冲突
* 最终验证

---

# 8. Task Graph

ZCAC 不应该简单采用：

```text
Agent A → Agent B → Agent C
```

而应该采用 DAG。

例如：

```text
             ┌───────────┐
             │ Research  │
             └─────┬─────┘
                   │
             ┌─────▼─────┐
             │ Architect │
             └─────┬─────┘
                   │
          ┌────────┴────────┐
          ↓                 ↓
       Coding A          Coding B
          │                 │
          └────────┬────────┘
                   ↓
                Testing
                   │
                   ↓
                Review
```

Task Graph：

```typescript
interface Task {
    id: string;
    type: TaskType;

    agent: string;

    dependencies: string[];

    input: TaskInput;

    output?: TaskOutput;

    status: TaskStatus;

    retryCount: number;
}
```

状态：

```text
PENDING
READY
RUNNING
WAITING
SUCCEEDED
FAILED
CANCELLED
BLOCKED
```

---

# 9. Scheduler

Scheduler 是集群最重要的组件之一。

职责：

```text
Task Graph
    ↓
寻找 READY Task
    ↓
检查 Agent Capacity
    ↓
检查依赖
    ↓
检查资源
    ↓
启动 Agent
```

例如：

```text
MAX_CONCURRENCY = 6

READY:
    Task A
    Task B
    Task C
    Task D

Scheduler:

A → Agent 1
B → Agent 2
C → Agent 3
D → Queue
```

Scheduler v1 采用：

```text
Dependency-aware FIFO
```

后续可以增加：

```text
Priority
Cost
Token Budget
Agent Capability
Resource Affinity
```

---

# 10. Agent Pool

不要为每一个 Task 永久创建 Agent。

采用：

```text
Agent Pool
   ↓
Acquire
   ↓
Execute Task
   ↓
Release
```

例如：

```text
Coder Pool

coder-01
coder-02
coder-03
coder-04
```

Scheduler 可以：

```text
Task → Capability Matching → Agent
```

例如：

```text
Rust Task
    ↓
Agent capability:
rust
    ↓
coder-02
```

---

# 11. Shared State

Agent 之间不能通过巨大 Prompt 互相传递所有信息。

必须建立结构化 Shared State。

```text
Cluster State
├── metadata
├── task_graph
├── agents
├── artifacts
├── decisions
├── findings
├── errors
└── events
```

例如：

```json
{
  "finding_id": "F-001",
  "source_agent": "explorer",
  "severity": "high",
  "file": "src/runtime/vm.ts",
  "description": "Scheduler state is shared between threads",
  "evidence": "..."
}
```

Agent B 可以直接读取 Finding。

---

# 12. Artifact System

Agent 输出不应该只有文本。

支持：

```text
Artifact
├── code
├── patch
├── diff
├── report
├── test_result
├── research
├── architecture
├── decision
└── log
```

例如：

```yaml
artifact:
  id: ART-001
  type: patch
  producer: coder-01

  files:
    - src/runtime/scheduler.ts

  checksum: ...

  status: pending_review
```

---

# 13. Event Bus

Agent 间通信使用事件，而不是直接互相调用。

```text
Agent
 ↓
Event Bus
 ↓
Subscribers
```

事件类型：

```text
TASK_CREATED
TASK_READY
TASK_STARTED
TASK_PROGRESS
TASK_COMPLETED
TASK_FAILED

ARTIFACT_CREATED
ARTIFACT_UPDATED

REVIEW_STARTED
REVIEW_FAILED
REVIEW_PASSED

AGENT_STARTED
AGENT_STOPPED

CLUSTER_PAUSED
CLUSTER_RESUMED
CLUSTER_FAILED
CLUSTER_COMPLETED
```

这样可以保证系统未来能够：

* Web UI
* CLI
* 日志系统
* Monitoring
* Replay
* Debugger

同时订阅 Cluster 状态。

---

# 14. Review Loop

这是 ZCAC 与普通 Subagent 最大的区别之一。

标准 Coding Pipeline：

```text
Explore
   ↓
Plan
   ↓
Code
   ↓
Test
   ↓
Review
```

Review Fail：

```text
Review
  ↓
FAIL
  ↓
Generate Findings
  ↓
Create Fix Tasks
  ↓
Coder
  ↓
Test
  ↓
Review
```

最多：

```yaml
review:
  max_rounds: 3
```

防止无限循环。

---

# 15. Failure Recovery

Agent 失败不能直接导致整个 Cluster 失败。

例如：

```text
Agent A FAILED

        ↓

Retry #1
        ↓
FAILED

        ↓

Retry #2
        ↓
FAILED

        ↓

Escalate to Supervisor
```

Supervisor 决策：

```text
Retry
Reassign
Skip
Block
Abort
```

---

# 16. Git Isolation

这是 Coding Cluster 必须重点设计的部分。

禁止多个 Agent 无控制地同时修改同一个工作目录。

推荐：

```text
Workspace
│
├── main
│
├── agent/coder-01
├── agent/coder-02
├── agent/coder-03
└── agent/tester
```

即：

```text
Agent
 ↓
Git Worktree
 ↓
Modify
 ↓
Test
 ↓
Commit
 ↓
Review
 ↓
Merge
```

例如：

```text
coder-01
   ↓
worktree/coder-01
   ↓
commit
   ↓
review
   ↓
integrator
```

这样可以显著降低并行 Coding 的文件冲突。

---

# 17. Conflict Resolution

如果：

```text
coder-01 → src/a.ts
coder-02 → src/a.ts
```

产生冲突：

```text
Git Merge
    ↓
Conflict
    ↓
Conflict Agent
    ↓
Analyze
    ↓
Resolve
    ↓
Test
    ↓
Review
```

Conflict Agent 不应该盲目覆盖其中一个 Agent。

必须获取：

```text
Base
Ours
Theirs
Task Intent
Architecture Constraints
```

然后进行语义合并。

---

# 18. Model Layer

ZCAC v1 默认模型：

```text
GLM-5.3
```

但是模型层必须抽象。

```typescript
interface ModelProvider {
    id: string;

    generate(
        request: ModelRequest
    ): Promise<ModelResponse>;
}
```

未来允许：

```text
GLM-5.3
GPT
Claude
Qwen
Local Model
```

但默认配置只使用 GLM-5.3。

---

# 19. Agent Context

Agent Context 分为四层：

```text
Global Context
      ↓
Cluster Context
      ↓
Task Context
      ↓
Agent Context
```

例如：

```text
Global:
    Repository rules

Cluster:
    Current feature

Task:
    Implement Scheduler

Agent:
    Coding instructions
```

避免每次调用都发送整个 Cluster 历史。

---

# 20. Context Compression

Agent 集群非常容易产生 Context 爆炸。

因此必须建立：

```text
Raw Events
    ↓
Summarizer
    ↓
Task Summary
    ↓
Agent Context
```

不要：

```text
Agent B
读取 Agent A 全部对话
```

而是：

```text
Agent A
 ↓
Findings
 ↓
Artifacts
 ↓
Summary
 ↓
Agent B
```

---

# 21. Permission Model

每个 Agent 必须拥有权限。

例如：

```yaml
permissions:

  filesystem:
    read: true
    write: false

  git:
    read: true
    write: false

  terminal:
    execute: false
```

Coder：

```yaml
filesystem:
  read: true
  write: true

git:
  read: true
  write: true

terminal:
  execute: true
```

Reviewer：

```yaml
filesystem:
  read: true
  write: false

git:
  read: true
  write: false
```

原则：

> 最小权限。

---

# 22. ZCode Integration

ZCAC 应尽可能复用 ZCode。

复用：

```text
Agent Runtime
Tool Runtime
MCP
Filesystem
Terminal
Git
Workspace
Plugin System
Subagent
Workflow
Authentication
Model Provider
```

新增：

```text
Cluster Controller
Scheduler
Task Graph
Agent Pool
Shared State
Event Bus
Artifact Manager
Review Engine
Recovery Engine
```

---

# 23. Plugin Integration

ZCAC 最终应该作为 ZCode Plugin。

推荐：

```text
zcode-agent-cluster/
```

结构：

```text
zcode-agent-cluster/
├── .zcode-plugin/
│   └── plugin.json
│
├── agents/
│   ├── supervisor.md
│   ├── planner.md
│   ├── explorer.md
│   ├── architect.md
│   ├── coder.md
│   ├── tester.md
│   └── reviewer.md
│
├── commands/
│   ├── cluster.md
│   ├── cluster-status.md
│   ├── cluster-stop.md
│   └── cluster-review.md
│
├── skills/
│   └── cluster-orchestration/
│       └── SKILL.md
│
├── src/
│   ├── controller/
│   ├── scheduler/
│   ├── agents/
│   ├── tasks/
│   ├── events/
│   ├── artifacts/
│   ├── state/
│   ├── git/
│   └── model/
│
└── README.md
```

---

# 24. Command Interface

建议提供：

```text
/cluster <task>
```

例如：

```text
/cluster implement ARC-0004
```

系统自动：

```text
Planner
 ↓
Explorer
 ↓
Architect
 ↓
Coder × N
 ↓
Tester
 ↓
Reviewer
```

状态：

```text
/cluster-status
```

停止：

```text
/cluster-stop
```

恢复：

```text
/cluster-resume
```

Review：

```text
/cluster-review
```

---

# 25. Cluster Configuration

例如：

```yaml
cluster:
  name: default

  model:
    provider: glm
    model: glm-5.3

  scheduler:
    max_concurrency: 6

  retry:
    max_attempts: 2

  review:
    enabled: true
    max_rounds: 3

  git:
    isolation: worktree

  agents:

    explorer:
      enabled: true

    architect:
      enabled: true

    coder:
      count: 3

    tester:
      count: 1

    reviewer:
      count: 2
```

---

# 26. 第一阶段 MVP

不要一开始实现完整 Cluster。

MVP 只做：

```text
Cluster Controller
        +
Task Graph
        +
Scheduler
        +
3 Agent
        +
Event Bus
```

三个 Agent：

```text
Planner
Coder
Reviewer
```

流程：

```text
User Task
   ↓
Planner
   ↓
Task Graph
   ↓
Coder
   ↓
Reviewer
   ↓
PASS / FAIL
```

先证明：

> 一个任务可以由多个 GLM-5.3 Agent 自动协作完成。

---

# 27. MVP-2

增加：

```text
Explorer
Tester
Retry
Shared State
Artifact
```

变成：

```text
Planner
   ↓
Explorer
   ↓
Coder
   ↓
Tester
   ↓
Reviewer
   ↓
Retry
```

---

# 28. MVP-3

增加真正的并行：

```text
          Planner
             ↓
        ┌────┴────┐
        ↓         ↓
     Coder A   Coder B
        ↓         ↓
        └────┬────┘
             ↓
           Tester
             ↓
          Reviewer
```

同时加入：

```text
Agent Pool
Concurrency Limit
Task Priority
Git Worktree
Conflict Detection
```

---

# 29. MVP-4

加入：

```text
Persistent State
Crash Recovery
Cluster Resume
Event Replay
Token Accounting
Agent Metrics
```

此时 ZCAC 才真正成为一个稳定的 Agent Cluster。

---

# 30. v1.0

最终目标：

```text
                    User
                     │
                     ↓
              Cluster Supervisor
                     │
              ┌──────┴──────┐
              ↓             ↓
           Planner       Research
              │
         Task Graph
              │
      ┌───────┼────────┐
      ↓       ↓        ↓
   Coding   Coding   Architecture
      │       │        │
      └───────┼────────┘
              ↓
            Test
              ↓
           Review
              ↓
          Integration
              ↓
            Done
```

具备：

* Parallel Agents
* Dynamic Task Graph
* Agent Pool
* GLM-5.3
* Shared State
* Artifact System
* Git Worktree
* Automatic Retry
* Review Loop
* Conflict Resolution
* Persistent State
* Crash Recovery
* Event Replay
* Metrics
* Plugin API

---

# 31. 关键设计原则

## 原则 1：ZCode 是 Runtime，不是 Cluster

不要重复实现 ZCode 已经实现的能力。

---

## 原则 2：Agent 是 Worker

Agent 不应该拥有整个系统的状态。

---

## 原则 3：Supervisor 是控制平面

Supervisor 管理：

```text
Decision
Task
Dependency
Failure
Review
```

---

## 原则 4：Event 是通信基础

不要让 Agent 互相直接调用。

---

## 原则 5：Artifact 是 Agent 输出的正式载体

不要把自然语言聊天记录当作系统状态。

---

## 原则 6：Task Graph 是执行真相

Cluster 当前做什么，由 Task Graph 决定。

---

## 原则 7：Git 是代码修改的边界

多个 Coding Agent 不应该无约束共享一个工作目录。

---

## 原则 8：默认最小权限

Researcher 默认只读。

Reviewer 默认只读。

Coder 才拥有写权限。

---

## 原则 9：模型可替换

v1 使用 GLM-5.3，但架构不能把 GLM-5.3 写死在核心类型中。

---

## 原则 10：Cluster 必须可以暂停、恢复和重放

如果电脑崩溃：

```text
Cluster
 ↓
Resume
 ↓
Continue unfinished Tasks
```

而不是重新执行整个任务。

---

# 32. 第一批必须实现的接口

```typescript
interface ClusterController {
    create(config: ClusterConfig): Promise<Cluster>;
    start(id: string): Promise<void>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    status(id: string): Promise<ClusterStatus>;
}
```

Scheduler：

```typescript
interface Scheduler {
    enqueue(task: Task): Promise<void>;
    schedule(): Promise<void>;
    cancel(taskId: string): Promise<void>;
}
```

Agent：

```typescript
interface Agent {
    id: string;
    capabilities: Capability[];

    execute(task: Task): Promise<TaskResult>;
}
```

Event Bus：

```typescript
interface EventBus {
    publish(event: ClusterEvent): Promise<void>;

    subscribe(
        type: EventType,
        handler: EventHandler
    ): Unsubscribe;
}
```

Artifact：

```typescript
interface ArtifactStore {
    create(artifact: Artifact): Promise<void>;
    get(id: string): Promise<Artifact>;
    list(taskId: string): Promise<Artifact[]>;
}
```

---

# 33. 目录设计

最终推荐：

```text
src/
│
├── cluster/
│   ├── controller/
│   ├── lifecycle/
│   └── config/
│
├── scheduler/
│   ├── scheduler.ts
│   ├── queue.ts
│   ├── priority.ts
│   └── resources.ts
│
├── task/
│   ├── task.ts
│   ├── graph.ts
│   ├── dependency.ts
│   └── state.ts
│
├── agent/
│   ├── agent.ts
│   ├── pool.ts
│   ├── registry.ts
│   └── capability.ts
│
├── supervisor/
│   ├── supervisor.ts
│   ├── decision.ts
│   └── recovery.ts
│
├── event/
│   ├── bus.ts
│   ├── event.ts
│   └── replay.ts
│
├── artifact/
│   ├── store.ts
│   ├── artifact.ts
│   └── resolver.ts
│
├── review/
│   ├── reviewer.ts
│   ├── findings.ts
│   └── loop.ts
│
├── git/
│   ├── worktree.ts
│   ├── merge.ts
│   └── conflict.ts
│
├── model/
│   ├── provider.ts
│   ├── glm.ts
│   └── context.ts
│
├── persistence/
│   ├── state.ts
│   └── snapshot.ts
│
└── integration/
    ├── zcode/
    ├── mcp/
    └── tools/
```

---

# 34. 开发顺序

不要按照 UI → Agent → Scheduler 的方式开发。

应该按照：

```text
1. Task Model
       ↓
2. Task Graph
       ↓
3. Event Model
       ↓
4. Agent Interface
       ↓
5. Scheduler
       ↓
6. Single Agent Execution
       ↓
7. Multi Agent Execution
       ↓
8. Artifact
       ↓
9. Review Loop
       ↓
10. Git Isolation
       ↓
11. Persistence
       ↓
12. Recovery
       ↓
13. UI
```

原因是：

> UI 是 Cluster 的观察面，而不是 Cluster 本身。

---

# 35. 第一条完整测试链

第一条 E2E 测试不要做复杂功能。

选择一个简单 Coding Task：

```text
"给项目增加一个 hello() API，并添加测试。"
```

预期：

```text
User
 ↓
Planner
 ↓
Task Graph
 ↓
Coder
 ↓
Tester
 ↓
Reviewer
 ↓
PASS
```

验证：

```text
✓ Agent 创建
✓ Task 创建
✓ Dependency
✓ Scheduler
✓ GLM-5.3 调用
✓ 文件修改
✓ 测试
✓ Review
✓ Event
✓ Artifact
✓ Cluster 完成
```

全部通过后再增加并行。

---

# 36. 最终愿景

ZCAC 最终不应该只是：

> “让几个 AI 同时写代码。”

真正目标是：

> 建立一个运行在 ZCode 之上的、可观察、可恢复、可并行、可验证的 Agent Operating Layer。

最终用户只需要：

```text
/cluster

Implement the new runtime scheduler.
```

然后：

```text
Supervisor
      ↓
Planner
      ↓
Explorer × N
      ↓
Architect
      ↓
Coder × N
      ↓
Tester × N
      ↓
Reviewer × N
      ↓
Integrator
      ↓
Regression
      ↓
Supervisor
      ↓
DONE
```

而 ZCode 本身继续负责：

```text
Editor
Workspace
Terminal
Git
MCP
Tools
Agent Runtime
Model Access
```

ZCAC 负责：

```text
Orchestration
Scheduling
Coordination
State
Recovery
Parallelism
Verification
```

两者形成清晰的控制平面 / 执行平面分离。

---

# 37. v0.1 验收标准

ZCAC v0.1 不以 UI 完整为验收条件。

必须满足：

```text
[ ] 可以创建 Cluster
[ ] 可以创建 Task Graph
[ ] 可以启动 GLM-5.3 Agent
[ ] 可以运行至少 3 个不同角色 Agent
[ ] 可以并行执行至少 2 个 Task
[ ] Agent 可以读取 Artifact
[ ] Agent 可以产生 Artifact
[ ] Event Bus 可以记录完整生命周期
[ ] Reviewer 可以触发 Retry
[ ] Cluster 可以保存状态
[ ] Cluster 可以恢复
[ ] 原有 ZCode Agent 工作流仍然正常
```

达到这些条件后，ZCAC 才进入 v0.2。

---

# 38. 最重要的架构结论

ZCAC 不应该成为：

```text
ZCode
 ↓
另一个 Agent Runtime
```

而应该成为：

```text
                 ZCode
                   │
        ┌──────────┴──────────┐
        │                     │
   Agent Runtime        Agent Cluster
        │                     │
   单 Agent 执行          多 Agent 编排
        │                     │
        └──────────┬──────────┘
                   ↓
              GLM-5.3
```

也就是说：

**ZCode 负责“怎么让 Agent 工作”，ZCAC 负责“让哪些 Agent 在什么时候，以什么依赖关系，共同完成什么任务”。**

这是整个项目最重要的边界。

---

# 39. 项目暂定名称

推荐：

```text
ZCode Agent Cluster
```

缩写：

```text
ZCAC
```

仓库：

```text
zcode-agent-cluster
```

内部架构名称：

```text
ZCAC Core
```

CLI：

```text
zcluster
```

示例：

```bash
zcluster run "Implement ARC-0004"
```

ZCode 内：

```text
/cluster Implement ARC-0004
```

---

# 40. 下一阶段

第一阶段不要直接写完整系统。

先对 ZCode 当前源码进行一次架构侦察：

```text
ZCode Repository
       ↓
Agent Runtime
       ↓
Subagent
       ↓
Workflow
       ↓
Plugin
       ↓
MCP
       ↓
Model Provider
       ↓
Git / Workspace
```

明确哪些能力可以直接复用，哪些地方需要 Adapter。

然后建立：

```text
ZCAC-0001
Task Model

ZCAC-0002
Task Graph

ZCAC-0003
Agent Pool

ZCAC-0004
Scheduler

ZCAC-0005
Event Bus

ZCAC-0006
Artifact System

ZCAC-0007
Review Loop

ZCAC-0008
Git Isolation

ZCAC-0009
Persistence

ZCAC-0010
Recovery
```

只有完成这些基础设施后，再开始做 Cluster UI。

zcoed仓库地址：https://github.com/zai-org/ZCode