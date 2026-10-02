# ZCAC — ZCode Agent Cluster

**多 Agent 编排层，构建在 ZCode Agent Runtime 之上。**

ZCode 负责单个 Agent 的执行（模型调用、工具、上下文管理、权限）；ZCAC 负责让哪些 Agent 在什么时候、以什么依赖关系，共同完成什么任务——以及 **Agent 之间如何协作**。

```
/cluster "Add a REST endpoint with tests"
  ↓
Planner → Coder × N (parallel, git worktree isolation) → Tester → Reviewer
  ↓ (FAIL → auto-inject Fix → Re-review, max 3 rounds)
Run completed (all changes merged back)
```

**Agent 协作**（Coder 执行中向 Explorer 提问，ZCAC 自动编排问答任务链）：

```
Coder: "@@MSG to=explorer type=question / Does foo.ts export bar()?"
  → Explorer 子任务回答 → Coder 续接任务带着答案继续
Coder: "@@TASK kind=test role=tester / Run integration tests"
  → ZCAC 自动在 Task Graph 中创建并调度该任务
```

## Status

| Milestone | Status |
|---|---|
| v0.1 core (executor / task graph / scheduler / pool / lease / review / worktree / plugin) | ✅ |
| v0.2 (pipeline / worktree+pipeline / supervisor / rate-limit backoff / multi-model) | ✅ |
| v0.25 Agent Communication (Message Bus / handoff / task chaining / task bridge / discovery) | ✅ |
| Real-repo stress test (6 tasks) | ✅ 5/6 |
| Kill recovery + memory stability | ✅ |
| **94 unit tests** | ✅ 94/94 |

## Quick Start

### Prerequisites

- [ZCode](https://github.com/zai-org/ZCode) v3.14.3+ (desktop or CLI)
- Node.js ≥24
- GLM model access (BigModel Coding Plan)；可选：其他 OpenAI 兼容 Provider（MiMo、DeepSeek 等）

### Install

```bash
# 1. Clone ZCode (the upstream runtime ZCAC depends on)
git clone https://github.com/zai-org/ZCode zcode-repo
cd zcode-repo
pnpm install --filter @zcode/cli...

# 2. Copy ZCAC into the monorepo
git clone https://github.com/silicon0725-dev/ZCAC zcac-source
cp -r zcac-source/packages/zcac packages/

# 3. Install ZCAC dependencies and build
pnpm install --filter zcac
pnpm --filter zcac build    # compiles TS + bundles the MCP orchestrator

# 4. Register as ZCode inline plugin
node zcac-source/scripts/install-inline.js "$(pwd)/packages/zcac/plugin"

# 5. Restart ZCode and try:
#    /cluster hello world test
```

### Usage

```
/cluster <task>        # Run a task (auto-selects single/pipeline mode)
/cluster-status        # Check latest run status
/cluster-stop          # Stop a running cluster
```

### Model Selection (multi-model)

在 `/cluster` 对话中，主模型会先调 `list_models` 展示可用模型供你选择（"快速(Flash) 还是 智能(Pro)？"）；也可以直接指定：

| 工具 | 用途 |
|---|---|
| `list_models` | 枚举全部模型（含 reasoning levels / 上下文窗口） |
| `configure` | 运行时读写配置（roleModels 立即生效，不需重启） |

示例：让 GLM 做规划/审查、MiMo 做编码——在插件设置或 `configure` 里设置 roleModels。

### MCP Tools

**编排：**

| 工具 | 用途 |
|---|---|
| `cluster_create` | 创建 run；`mode=pipeline` 先分解再执行 |
| `cluster_status` | run 状态 + 任务计数 + 事件尾 |
| `cluster_stop` | 停止在飞 Agent |
| `task_list` | 每个任务的状态/重试/摘要 |
| `artifact_list` | Artifacts（含 checksum） |
| `events` | 完整事件日志，游标 replay |

**模型与配置：**

| 工具 | 用途 |
|---|---|
| `list_models` | 枚举可用模型（下拉选择数据源） |
| `configure` | 运行时改 roleModels / 默认模型 |

**Agent 通信（三层）：**

| 工具 | 用途 |
|---|---|
| `send_message` | 发消息（policy 强制） |
| `get_messages` | 查询消息（agent/thread/task 过滤） |
| `reply_message` | 回复（自动加入线程） |
| `get_thread` | 完整对话链 |
| `list_agents` | 可用角色 + 能力 + 配额 + 忙闲 |

**Agent 间通信协议**（worker 在输出中使用，ZCAC 自动处理）：

```
@@MSG to=explorer type=question     ← 触发子任务回答 + 续接任务
Does foo.ts export bar()?
@@END

@@TASK kind=test role=tester        ← 直接创建任务（Graph 变异）
Run integration tests
@@END_TASK
```

### Configuration

在 ZCode 插件设置（`zcode-agent-cluster`）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `zcacModel` | `bigmodel-api/GLM-5.3-Flash@low` | 默认模型（所有角色的回退） |
| `zcacModelCoder/Planner/Tester/Reviewer/Explorer` | 空 | 按角色指定模型（multi-model 协作） |
| `zcacIsolation` | `shared` | `worktree` = 每个写入任务独立 git worktree，成功自动合并 |
| `zcacConcurrency` | `2` | 最大并行任务数 |

## Architecture

```text
ZCode (desktop/CLI)
  │  /cluster → MCP tools
  ▼
ZCAC Orchestrator (stdio MCP server, persistent SQLite)
  ├── Task Graph        (runtime-mutable DAG + @@TASK bridge)
  ├── Scheduler         (dependency-aware + role quotas + rate-limit backoff + multi-model)
  ├── Agent Pool        (slots + leases + heartbeats)
  ├── Review Loop       (FAIL → Fix → Re-review, max 3 rounds)
  ├── Pipeline          (planner decomposition → dynamic task injection)
  ├── Supervisor        (conflict redo / re-plan, budgeted)
  ├── Worktree Manager  (git worktree isolation, merge-on-success)
  ├── Message Bus       (3-layer agent communication, policy-enforced)
  └── Event Journal     (SQLite, journal-first, cursor replay)
  ▼
ZCode Agent Runtime (one per worker)
  ▼
GLM-5.3 / GLM-5.3-Flash / MiMo / (any OpenAI-compatible provider)
```

### 四个边界

| 子系统 | 回答的问题 | 语义 |
|---|---|---|
| **Task Graph** | 做什么 | 执行真相；@@TASK 桥让 Agent 直接变异 |
| **Scheduler** | 谁什么时候做 | 依赖/配额/退避/多模型 |
| **Message Bus** | Agent 怎么协作 | 通信真相；thread 完整审计 |
| **Event Journal** | 系统发生过什么 | 观察真相；关键事件自动桥接为 system 消息 |

### Agent 通信三层

| 层级 | 机制 | 触发 |
|---|---|---|
| Layer 1 | Task Handoff | 自动：任务完成 → 下游 prompt 注入上游上下文 |
| Layer 2 | Direct Message | `@@MSG question` → answer 子任务 → 续接任务 |
| Layer 3 | Broadcast + Task Bridge | `@@MSG to=*` 广播；`@@TASK` 直接创建任务 |

防护：CommunicationPolicy（角色白名单 + 广播权限 + 每任务消息上限）+ 续接深度限制（默认 2 层）。

### 关键设计决策

| 决策 | 理由 |
|---|---|
| Worker = 独立 `createZCodeApp` 组合 | SubagentPort 未公开导出；与 dwf actor 构造等价 |
| Merge-on-success for worktrees | 下游任务始终看到已合并的主区状态 |
| Journal-first（先 SQLite 后 live emit） | 崩溃后无幽灵事件 |
| Event ≠ Message | Event=观察事实，Message=通信意图；语义不混 |
| 系统消息免策略 | handoff/桥接是系统行为，不受 agent 通信策略限制 |
| Completed task 不可变 | 崩溃恢复不重跑已确认的工作 |

## Development

```bash
# Inside zcode-repo with packages/zcac present:
pnpm --filter zcac test                    # 94 unit tests
pnpm --filter zcac build                   # compile + bundle orchestrator

# E2E tests (real GLM, costs tokens):
node packages/zcac/dist/e2e.cjs            # single task
node packages/zcac/dist/e2e-parallel.cjs   # dual coder parallel
node packages/zcac/dist/e2e-review.cjs     # review→fix→re-review loop
node packages/zcac/dist/e2e-worktree.cjs   # worktree isolation + conflict
node packages/zcac/dist/e2e-pipeline.cjs   # planner pipeline
node packages/zcac/dist/e2e-pipeline-worktree.cjs  # combination
node packages/zcac/dist/stress.cjs         # 6-task stress test
```

## Documentation

- [Design document](docs/design.md) — original architecture vision
- [Implementation spec](docs/implementation-spec.md) — v0.1 specification
- [Architecture reconnaissance](docs/architecture-report.md) — ZCode source analysis
- [Phase records](docs/phases/) — implementation phases with findings

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| run `failed`, `rate_limit` | Model quota | Wait; lower concurrency; governor auto-backs-off |
| run `failed`, `merge_conflict` | Parallel write to same file | Supervisor auto-redo; branch preserved |
| run `failed`, `plan_unparseable` | Planner output malformed | Supervisor re-plans once |
| run `failed`, `review_max_rounds` | 3 review rounds failed | Check findings via `get_thread` / `events` |
| Dirty files in main workspace | Agent path drift (rare) | `git status`; use worktree mode |
| Stuck in `running` after crash | Lease not expired | Wait 120s or restart ZCode |

## Known Limitations (v0.25)

- Single-process orchestrator (ProtocolExecutor planned for v0.3 — Message Bus 传输层可替换，协议不变)
- Run status stays `failed` when Supervisor recovery succeeds (terminal immutability)
- No native UI dropdown for model selection; `list_models` + 主模型对话提供等价体验
- Plugin registered as inline directory (dev mode); proper distribution needs packaging

## License

Apache-2.0
