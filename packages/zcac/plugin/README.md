# ZCAC — ZCode Agent Cluster

**多 Agent 编排层,构建在 ZCode Agent Runtime 之上。**

ZCode 负责单个 Agent 的执行(模型调用、工具、上下文管理、权限);
ZCAC 负责让哪些 Agent 在什么时候、以什么依赖关系,共同完成什么任务:

```
/cluster "Add a REST endpoint with tests"
  ↓
Planner(分解任务)
  → Coder × N(并行实现,各自 git worktree)
    → Tester(跑测试)
      → Reviewer(审查;FAIL → 自动注入 Fix → Re-review,最多 3 轮)
  ↓
Run completed(所有变更已合并回主分支)
```

---

## 快速开始

### 前置条件

- **ZCode** v3.14.3+(桌面版或 CLI)
- **Node.js** ≥24(编排器进程用)
- 模型访问(GLM-5.3 / GLM-5.3-Flash via BigModel Coding Plan)

### 安装(开发模式)

```bash
# 1. 克隆 ZCode 仓库(包含 zcac 包)
git clone https://github.com/zai-org/ZCode zcode-repo
cd zcode-repo

# 2. 安装依赖并构建 zcac(含插件编排器)
pnpm install --filter @zcode/cli...
pnpm --filter zcac build

# 3. 注册为 ZCode inline 插件
node -e "
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME, '.zcode/cli/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.plugins = config.plugins || {};
  const pluginDir = path.resolve('packages/zcac/plugin');
  config.plugins.dirs = [...new Set([...(config.plugins.dirs || []), pluginDir])];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('Registered:', pluginDir);
"
```

### 使用

在 ZCode 中:

```
/cluster <任务描述>          # 运行任务(非平凡任务自动走 pipeline 模式)
/cluster-status              # 查看最近 run 的状态
/cluster-stop                # 停止运行中的 run
```

Agent 也可以通过 MCP 工具直接交互(工具名以 `mcp__zcac__` 开头):

| 工具 | 用途 |
|---|---|
| `cluster_create` | 创建 run;`mode=pipeline` 先分解再执行 |
| `cluster_status` | run 状态 + 任务计数 + 事件尾 |
| `cluster_stop` | 停止在飞 Agent,标记 run cancelled |
| `task_list` | 每个任务的 kind/status/attempts/摘要 |
| `artifact_list` | run 产出的 Artifact 列表 |
| `events` | 完整事件日志,支持 `afterSequence` 游标 |

### 配置

ZCode 插件设置中的 `userConfig`:

| 选项 | 默认 | 说明 |
|---|---|---|
| `zcacModel` | `bigmodel-api/GLM-5.3-Flash@low` | Worker 使用的模型 |
| `zcacIsolation` | `shared` | `shared`(共享工作区)或 `worktree`(每个写入任务独立 git worktree,成功后合并) |
| `zcacConcurrency` | `2` | 最大并行任务数 |

环境变量(高级):

| 变量 | 说明 |
|---|---|
| `ZCAC_DATA_DIR` | 状态目录(默认 `~/.zcode/zcac`) |
| `ZCAC_CONCURRENCY` | 全局任务并发 |

---

## 架构

```text
ZCode(桌面/CLI)
  │  /cluster 命令 → MCP 工具调用
  ▼
ZCAC Orchestrator(插件内 stdio MCP server)
  │
  ├── Task Graph(运行时可变 DAG)
  ├── Scheduler(依赖感知 + 角色配额 + 限流退避)
  ├── Agent Pool(slot 管理 + 租约)
  ├── Review Loop(FAIL → Fix → Re-review, max 3 轮)
  ├── Pipeline(planner 分解 → 动态注入任务链)
  ├── Supervisor(冲突重做 / re-plan,预算封顶)
  ├── Worktree Manager(git worktree 隔离 + 成功即合并)
  └── Event Journal(SQLite, journal-first)
  │
  ▼
ZCode Agent Runtime(每 worker 一个 AgentRuntime)
  │
  ▼
GLM-5.3 / GLM-5.3-Flash
```

### 关键设计决策

| 决策 | 理由 |
|---|---|
| Worker = 独立 `createZCodeApp` 组合 | SubagentPort 未公开导出;与 dwf actor 构造等价 |
| implement 成功即 commit+merge | 下游 test/review 在主区可见;冲突任务级处理 |
| journal-first(先 SQLite 后 live emit) | 崩溃后无幽灵事件 |
| 限流指数退避 + 成功减半 | 实测墙钟降 3-8× |
| Completed task 不可变 | 崩溃恢复不重跑已确认的工作 |

### 代码布局

```
packages/zcac/
├── src/
│   ├── domain/          # Task/Graph/Run/Event/Agent/Worktree/Artifact(纯 TS,零 @zcode 依赖)
│   ├── ports/           # AgentExecutor/仓储/Clock/事务/RateLimitGovernor
│   ├── application/     # TaskService/GraphService/Scheduler/ReviewLoop/Pipeline/Supervisor/WorktreeService
│   ├── adapters/
│   │   ├── zcode/       # ZCodeAgentExecutor(所有 @zcode import 集中在此)
│   │   ├── sqlite/      # node:sqlite 持久化
│   │   └── git/         # GitWorktreeManager
│   └── mcp/orchestrator.ts  # 插件 MCP server 入口
├── plugin/              # ZCode 插件(manifest/agents/commands/skills/.mcp.json)
├── tests/               # 75 个单元测试(node:test)
└── dist/                # esbuild 产物(orchestrator.cjs 等)
```

---

## 测试

```bash
cd zcode-repo
pnpm --filter zcac test                        # 75/75 单元测试
node packages/zcac/dist/e2e.cjs                 # 单任务(真实 GLM)
node packages/zcac/dist/e2e-parallel.cjs        # 双 Coder 并行
node packages/zcac/dist/e2e-review.cjs          # Review→Fix→Re-review 动态 DAG
node packages/zcac/dist/e2e-worktree.cjs        # worktree 隔离+冲突
node packages/zcac/dist/e2e-pipeline.cjs        # planner 分解流水线
node packages/zcac/dist/e2e-pipeline-worktree.cjs  # 组合
node packages/zcac/dist/stress.cjs              # 6 任务压力测试
```

---

## 故障排查

| 症状 | 可能原因 | 处置 |
|---|---|---|
| run 状态 `failed`,reason=`rate_limit` | 模型配额/限流 | 检查 BigModel 用量;调低 `zcacConcurrency`;等退避 |
| run 状态 `failed`,reason=`merge_conflict` | 并行修改同一文件 | Supervisor 自动注入 rebase redo;或检查 `git worktree list` 手动处理 |
| run 状态 `failed`,reason=`plan_unparseable` | planner 输出不符合格式 | Supervisor 自动 re-plan(1 次);仍失败则人工干预 |
| run 状态 `failed`,reason=`review_max_rounds` | 3 轮 review 未通过 | 检查 `events` 中的 findings;考虑换模型或分解任务 |
| 主工作区有未提交变更 | agent 路径漂移(偶发) | `git status` 检查;worktree 模式下偶尔写入主区 |
| 编排器不启动 | plugin 目录未注册 / Node 版本 | `zcode plugins list` 检查;确认 Node ≥24 |
| 崩溃后 run 卡在 `running` | lease 未过期 | 等待(默认 120s)或重启编排器(自动 recovery) |

---

## 卸载

```bash
# 从 config.json 移除 plugins.dirs 中的 zcac plugin 路径
# 或恢复备份: cp ~/.zcode/cli/config.json.zcac-backup ~/.zcode/cli/config.json
# 数据目录(可选清理): rm -rf ~/.zcode/zcac
```

---

## 已知限制(v0.2)

- 单进程编排器(所有 worker 在同一 Node 进程);ProtocolExecutor(v0.3)将引入子进程隔离
- Supervisor 补救成功后 run 仍报 `failed`(终态不可变语义);v0.3 将引入"有效终态"
- 无 Web UI;观察依赖 `cluster_status` / `events` MCP 工具
- 插件以 inline 目录注册(开发模式);正式分发需打包(v0.3)

---

**文档:** [设计](ZCode Agent Cluster.md) | [实现规范](ZCAC v0.1 Implementation Specification.md) | [架构侦察](ZCode 源码架构侦察报告.md) | [各阶段记录](ZCAC Phase 0 PoC 记录.md)
