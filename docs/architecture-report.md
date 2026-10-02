# ZCode 源码架构侦察报告

**对应设计文档：** 《ZCode Agent Cluster.md》第 40 节「下一阶段」
**侦察对象：** https://github.com/zai-org/ZCode （v3.14.3，浅克隆于 `zcode-repo/`）
**报告版本：** v1.0（2026-10-01）
**目的：** 明确 ZCAC 可以直接复用哪些 ZCode 能力、哪些需要 Adapter、哪些必须自建，并据此修订 ZCAC-0001 ~ ZCAC-0010 的任务定义。

---

# 0. 结论摘要（TL;DR）

1. **ZCode 已经拥有一个可观的多 Agent 基础设施**，远超设计文档第 22 节「复用」清单的假设：
   - `AgentRuntime` 可以按 session 无限实例化，子 Agent = 同进程的子 `AgentRuntime`；
   - `SubagentPort` 是**程序化**（不经模型选择工具）的 Agent 启动 API，含前台/后台、SendMessage 双向通信、终态复活；
   - Dynamic Workflow（dwf）引擎提供：并行 actor 会话、类型化结果校验、SQLite journal、确定性重放、崩溃恢复（resume）、amend 缓存导入、AIMD 并发治理。
2. **设计文档中 ZCAC-0005（Event Bus）、ZCAC-0009（Persistence）、ZCAC-0010（Recovery）的大部分语义已由 dwf 引擎实现**——ZCAC 应在其模式之上构建，而不是重写。
3. **三个 ZCAC 关键缺口确认为自建**：
   - 运行时可变的 Task Graph + 调度器（dwf 的"图"是脚本控制流，提交后冻结）；
   - Agent Pool（暖池、能力匹配、跨 run 名册）——现有 subagent 是冷启动、单发、无池化；
   - **Git Worktree 隔离完全没有实现**：全仓库唯一的 worktree 钩子在 `script-workflow-runtime.ts:283` 直接抛 `"workflow agent isolation 'worktree' is not implemented yet."`。
4. **ZCAC 有三条经过验证的宿主路径**：进程内组合（`createZCodeApp`/`AgentRuntime`）、stdio 协议子进程（`zcode app-server --stdio` + NDJSON 协议）、HTTP/WS 服务（`zcode-server`）。v0.1 推荐进程内组合。
5. **ZCAC 作为插件发布完全可行**：`agents/ + commands/ + skills/ + .mcp.json(stdio server)` 均受支持；但插件**不能**加 UI、不能在宿主进程内执行代码——编排器必须作为独立进程（MCP stdio 子进程或 http MCP）存在。

---

# 1. 仓库与进程架构

## 1.1 Monorepo 布局

```text
zcode-repo/
├── apps/zcode-cli/packages/        ← ★ Agent CLI 与运行时（ZCAC 最关心）
│   ├── core/                       ← AgentRuntime、工具、权限、subagent、上下文、压缩
│   ├── contracts/                  ← 所有 Port 接口（SubagentPort、McpPort、ToolEntry 契约…）
│   ├── adapters/                   ← 存储(SQLite)、MCP 客户端、模型执行、插件加载
│   ├── bootstrap/                  ← createZCodeApp 组合根、协议服务器、dwf 宿主接线
│   ├── dynamic-workflow/           ← dwf 引擎（纯域包，可嵌入）
│   ├── dynamic-workflow-runtime/   ← dwf 子进程 harness（vm 沙箱 + NDJSON）
│   ├── cli/ / tui/                 ← CLI 与终端 UI
│   └── bundled-skills/             ← 内置技能（含 dynamic-workflows 技能）
├── packages/
│   ├── provider / provider-node    ← 模型 Provider 注册表与配置
│   ├── services/                   ← 桌面/服务端业务层（git、session、plugins、subagents、hooks…）
│   ├── server/                     ← zcode-server：stdio + HTTP/WS 宿主
│   ├── shared/                     ← 协议 schema（zcode-protocol v1/v4）、共享类型
│   ├── desktop / web / ui / client / rpc
│   └── zcode-cua / model-option-map / formal-proof
└── DESIGN.md / AGENTS.md / CONTEXT.md   ← UI 规范 / 仓库工程规则 / 插件商店词汇
```

## 1.2 进程树（桌面形态）

```text
Electron Main
   │  (每窗口 fork 一个 Host 进程)
   ↓
Local Host（@zcode/services，~40 个服务）
   │  (每个 workspaceKey 一个 CLI 子进程, NDJSON ZCode Protocol over stdio)
   ↓
zcode app-server --stdio
   │  (进程内 SessionResidentPool: 目标 8 个常驻 session / 峰值 16 / 空闲 10min 回收)
   ├── AgentRuntime (session A)
   │     ├── AgentRuntime (subagent_child A1)   ← 同进程子 runtime
   │     └── AgentRuntime (subagent_child A2)
   ├── AgentRuntime (session B)
   └── dwf 运行时子进程 (node, vm 沙箱) → 每 actor 一个 AgentRuntime
        ↓
     GLM (bigmodel API)
```

**关键结论：** "一个 Agent" 在 ZCode 中就是「一个 `AgentRuntime` 实例 + 一份配置（profile）」。
不存在独立的 "Agent 类"——supervisor / planner / coder 对 ZCAC 而言只是**不同的 `AgentProfile` + 工具白名单 + 模型选择**。

---

# 2. Agent Runtime（执行平面）

## 2.1 核心机制

| 概念 | 实现 | 位置 |
|---|---|---|
| 运行时 | `AgentRuntime`（每 session 一个实例，~150 个方法由 mixin 安装） | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` |
| 回合循环 | `executeTurn` → `runRegularTurnLoop`（while 循环：模型调用→工具执行→再循环） | `core/src/runtime/methods/turn.ts`, `turn-loop.ts`, `turn-model-step.ts`, `turn-tools.ts` |
| 工具注册 | `ToolRegistry` + `builtInTools`（约 45 个内置工具） | `core/src/tool/registry.ts`, `core/src/tool/handlers/index.ts` |
| 并行调度 | `ToolScheduler`：按 `readOnly/concurrentSafe/destructive` 元数据分并行组，默认并发 10 | `core/src/tool/scheduler.ts` |
| 工具管道 | validate → resolveInput → PreToolUse hook → **权限检查** → handler → 结果预算序列化 | `core/src/tool/executor/impl.ts` + `executor/*` |
| 权限 | `PermissionService`（build/edit/plan/yolo 模式 + 项目规则 + 会话级授权）；`PermissionBrokerPort` 处理 "ask" | `core/src/permission/service.ts`, `broker.ts` |
| 上下文 | `ContextBuilder`（类型化 section + cacheHint）；`workflowActor {name, persona}` 人设覆盖 | `core/src/context/builder.ts` + `sections/` |
| 压缩 | auto-compact / microcompact / 手动 compact，`buildCompactPrompt` 可直接复用 | `core/src/compact/*`, `runtime/methods/compact-active.ts` |

## 2.2 对 ZCAC 直接重要的三个模式

**(a) 只读 Agent 的现成做法（Explore 模式）**
内置 Explore agent = 工具白名单（`EXPLORE_AGENT_ALLOWED_TOOLS`：Bash/Glob/Grep/Read/WebFetch/WebSearch/TodoWrite）+ 全新 `PermissionService` + `yolo` 模式（因白名单排除写工具而安全）。
ZCAC 的 Researcher/Reviewer/Explorer 权限模型可以照抄此模式，成本为零。

**(b) 每个工具调用的完整上下文**
`ToolExecutionContext` 携带 `runtimeScope: "main" | "subagent"`、`subagentPort`、`abortSignal`、sessionId/turnId 等——工具可以在子 Agent 作用域内自我限制。ZCAC 自定义工具（如 `report_finding`、`submit_artifact`）可以按此契约注册到 worker runtime 的 `ToolRegistry`。

**(c) 三条无头（headless）入口**

| 入口 | 文件 | 适用 |
|---|---|---|
| 进程内 API | `createZCodeApp(options)` → `ZCodeApp.submitPrompt() / .runtime` | **ZCAC v0.1 推荐**：编排器与 worker 同进程 |
| stdio 协议 | `zcode app-server --stdio`（`runZCodeProtocolAgent`） | 跨进程驱动：`session/create` → `session/send` → v4 订阅 → 回答 `interaction/requestPermission` |
| HTTP/WS | `packages/server/src/entry-http.ts`（Hono，`/ws` + `/api/*`，`ZCODE_SERVER_AUTH_TOKEN`） | 远程/多机扩展：`IZCodeAgentService.createSession / sendConversationCommandV4` |

---

# 3. Subagent 系统（ZCAC 的 Worker 候选底座）

## 3.1 Agent 类型 = Markdown Profile

```yaml
# <plugin>/agents/coder.md 或 ~/.zcode/agents/coder.md 或 <ws>/.zcode/agents/coder.md
name: coder
description: 负责 actual code changes
tools: [Read, Write, Edit, Bash, Grep, Glob]   # ["*"] 或缺省 = 继承父级
model: glm-5.3                                  # 可选，缺省继承父会话
permissionMode: auto                            # auto | plan（项目级 profile 会被剥离）
mcpServers: [zcac-orchestrator]                 # 可借用父级指定 MCP server
maxTurns: 40
memory: project                                 # 可选持久 MEMORY.md
```

- 类型定义：`AgentProfile`（`core/src/subagent/profile.ts`）；插件 agent 自动命名空间为 `${pluginName}:${agentName}`。
- **插件可以贡献 agent 类型**（`PluginManifest.agents`，`contracts/src/plugins/index.ts:142`）——ZCAC 插件的 `agents/` 目录方案成立。
- 内置只有 `general-purpose` 与 `Explore` 两个；其余全部来自 markdown。

## 3.2 程序化启动 API（不经模型）

```typescript
// contracts/src/interfaces/subagent.port.ts
interface SubagentPort {
    launch(req): Promise<AgentHandle>;      // 前台
    run(req): Promise<AgentCompletedOutput>;
    start(req): Promise<AgentBackgroundedOutput>;   // 后台
    getTask(taskId); waitForTask(taskId); stopTask(taskId);
    sendMessage(agentId, message): Promise<"steered" | "resumed_background" | ...>;
}
```

- 实现：`createExploreSubagentPort`（`core/src/subagent/runner.ts`，2142 行）；在 `AgentRuntime` 构造时创建并注入工具执行上下文。
- **spawn 机制**：同进程、新 sessionId（`subagent_agent_<uuid>`）、全新系统提示（不复制父对话）、借用父级 MCP（只读包装）、工具白名单强制过滤（`filterSubagentChildToolNames`）。
- **并行**：`Agent` 工具 `concurrentSafe: true`，一条助手消息里的多个 Agent 调用并发执行，受全局工具并发上限（默认 10）约束。
- **消息**：`SendMessage`（父→子，运行中 steer 注入 / 终态复活续聊）+ `RespondToCoordinator`（子→父回传队列）；后台任务完成时以 `task-notification` 命令唤醒父级下一回合。
- **持久化**：子会话完整落 SQLite（`task_type = "subagent_child"`，`parent_id` 列）；磁盘工件 `<cliStorageRoot>/agents/<parentSessionId>/<agentId>/{metadata.json, output.txt}`。

## 3.3 对 ZCAC 的限制（必须自建的部分）

| 限制 | 影响 | ZCAC 对策 |
|---|---|---|
| **无递归**：子 Agent 强制 `subagents.enabled = false`，Agent/Task 工具被剥离 | 编排树只能一层 | ZCAC 扁平化为一层 coordinator + N worker；层级由 ZCAC 调度器逻辑表达 |
| **无池化**：每次 launch 都是冷启动 runtime；SendMessage 复活 = 粘性上下文续聊，不是干净的任务槽 | 无 "coder-01 复用执行第二个任务" 语义 | ZCAC 自建 Agent Pool 语义（按 profile 记账，实现层仍可每次冷启动，对上层透明） |
| **无能力匹配/优先级/配额**：类型选择是纯名字查找；并发只有全局 10 | 调度器缺失 | 正是 ZCAC-0004 的职责 |
| **结果只有最终文本 + usage** | 无结构化输出契约 | 仿 dwf 的 `submit_result` + JSON Schema 校验模式给 worker 加类型化提交工具 |
| 任务注册表纯内存，进程死即失 | 跨重启恢复弱 | ZCAC 状态自持久（ZCAC-0009） |
| `maxTurns` 已接线但回合循环不强制执行 | 不能当预算护栏 | 用 `inactivityTimeoutMs` / `autoBackgroundMs` + ZCAC 侧截止时间 |

---

# 4. Dynamic Workflow 引擎（被低估的宝藏）

> 注意：仓库里有**两套** workflow。旧的 `core/src/workflow/`（`/expert`，依赖图调度器，可参考其 `readyExecutableNodes/blockedExecutableNodes` 实现）；新的 dwf（`CreateWorkflow` 工具）才是重点。

## 4.1 机制

```text
模型写 TypeScript 编排脚本
   ↓ compileWorkflowScript（虚拟 TS host，strict 类型检查）
   ↓ 用户确认（脚本 + 因果图）
   ↓ lowerWorkflowScript（每个 facade 调用改写为 __host.*，静态 siteId）
   ↓ 独立子进程: node <cwd>/.zcode/workflow-runs/<runId>.mjs
       （vm.createContext 沙箱，禁 Date.now/Math.random，NDJSON over stdio）
   ↓ WorkflowEngine（纯确定性状态机，零 I/O）
       ├── AskScheduler: 每 actor FIFO + 全局 maxConcurrency（可运行中调整）
       ├── 每 actor = 一个持久子 AgentRuntime（mono-agent，带 submit_result/escalate 工具）
       ├── 结果按 ask 站点的 JSON Schema 校验，违规进入修复循环（3 次）
       └── 每次状态迁移 → journal.appendEvent（持久）+ driver.emit（实时）
```

## 4.2 ZCAC 可以直接借走的资产

| 资产 | 位置 | 对应 ZCAC 任务 |
|---|---|---|
| Journal 表（`dwf_run/actor/node/event`，SQLite） | `adapters/src/storage/session-store/repositories/dwf-journal.ts` | ZCAC-0009 Persistence |
| 确定性重放 + resume（仅 `stopped` 可续；按 `siteId@ordinal` 输入哈希命中跳过重放） | `engine/engine.ts` resume 分支, `bootstrap/.../dynamic-workflow-run-observation.ts` | ZCAC-0010 Recovery |
| Amend 缓存导入（按 actor 名 + 指令哈希前缀匹配，首次工作区写即关缓存） | `bootstrap/src/app/dynamic-workflow-import.ts` | ZCAC-0010 |
| AIMD 并发治理（每 provider key：过载 ×0.75，连续成功 +1，Retry-After 冷却） | `engine/concurrency.ts`, `bootstrap/.../workflow-concurrency-governor.ts` | ZCAC-0004 Scheduler |
| 类型化提交 + 修复循环 | `schema/synthesize.ts`, driver 的 `submit_result` 桥 | ZCAC-0001 Task Model |
| 升级通道（actor 阻塞问题 → `escalate` → 主 Agent `ResolveWorkflowQuestion`） | `engine/types.ts`, tool handler | ZCAC Supervisor 决策 |
| 事件总线模式（journal + live emit 双写） | `engine/engine.ts` | ZCAC-0005 Event Bus |

## 4.3 dwf 的边界（为什么 ZCAC 不能只用 dwf）

1. **脚本即图，提交即冻结**：运行中不能从外部注入新任务；仅有的运行时控制是 `cancel` / `resolveQuestion` / `setMaxConcurrency`。Review-FAIL→动态创建 Fix Task 的循环要求**运行时可变图**。
2. **无依赖/优先级调度**：只有 per-actor FIFO + 一个并发数字；没有 DAG 就绪计算、任务级重试策略。
3. **事件单向**：`RunEvent` 只做观察（journal + emit），引擎不从事件接受外部决策。
4. **默认功能关闭**：`DEFAULT_DYNAMIC_WORKFLOW_MODE = "disabled"`（`packages/shared/src/dynamic-workflow-feature.ts:23`，env `ZCODE_DYNAMIC_WORKFLOW_MODE` 开启）。
5. 单进程假设：governor、孤儿 run 对账都是单进程语义。

**结论：** dwf 是 ZCAC 的「参考实现 + 零件库」，不是 ZCAC 的骨架。ZCAC 自建控制平面（动态 Task Graph + 调度器 + 双向事件），执行平面复用 `AgentRuntime` 组合模式（dwf driver 正是这么做的：`bootstrap/src/app/workflow-driver.ts` 程序化构造 actor runtime）。

---

# 5. Plugin / Skills / Commands / Hooks（ZCAC 的发布形态）

## 5.1 插件能做什么

| 贡献 | 机制 | ZCAC 用法 |
|---|---|---|
| **agent 类型** | `agents/*.md` → 注册为 `${plugin}:coder` | supervisor/planner/coder/tester/reviewer 全套 profile |
| **斜杠命令** | `commands/*.md`（frontmatter: description/argument-hint/model/allowed-tools；`$ARGUMENTS`/`$1..$n` 展开；**不支持**动态 shell 语法） | `/cluster`, `/cluster-status`, `/cluster-stop`, `/cluster-review` |
| **技能** | `skills/*/SKILL.md`（frontmatter name/description；注入系统提示列表，Skill 工具按需加载全文 ≤100KB） | `cluster-orchestration` 技能 |
| **MCP server** | `.mcp.json` / manifest `mcpServers`：stdio（任意命令行）/ http / sse；模板变量 `${ZCODE_PLUGIN_ROOT}` `${ZCODE_PLUGIN_DATA}` `${user_config.*}` | **ZCAC 编排器进程的宿主通道** |
| **Hooks** | 7 个事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop）；exit 2 = 阻断；JSON 输出可注入上下文/改写输入 | 可选：SessionStart 引导 |
| **userConfig** | 类型化配置项（string/number/boolean/directory/file，`sensitive: true` 加密展示） | 集群端点、API key、并发上限 |
| **持久数据** | `~/.zcode/cli/plugins/data/<id>/`（`${ZCODE_PLUGIN_DATA}`） | 集群状态旁路存储 |

## 5.2 插件不能做什么（硬边界）

- **不能加 UI**：无自定义视图/webview；`channels/outputStyles/settings/lspServers` 仅诊断性识别。
- **不能在宿主进程内执行代码**：无插件 API/ABI；可执行代码只能跑在进程外（MCP stdio 子进程或 hook shell 命令）。
- **不能注册新的核心工具/新 hook 事件**：只能加 MCP 工具。
- **无常驻守护**：一切懒加载、随宿主生命周期。若编排器必须常驻，用 `http` MCP transport 指向独立服务。

## 5.3 ZCAC 插件推荐形态

```text
zcode-agent-cluster/
├── .zcode-plugin/plugin.json
├── .mcp.json                 # { "zcac": { "type":"stdio",
│                             #     "command":"node",
│                             #     "args":["${ZCODE_PLUGIN_ROOT}/dist/orchestrator.js"] } }
├── agents/                   # supervisor.md planner.md explorer.md coder.md tester.md reviewer.md integrator.md
├── commands/                 # cluster.md cluster-status.md cluster-stop.md cluster-review.md
├── skills/cluster-orchestration/SKILL.md
├── src/                      # ZCAC Core（编排器本体）
└── dist/orchestrator.js      # 编排器入口（作为 MCP stdio 子进程运行）
```

ZCode agent 调用 ZCAC 的工具将呈现为 `mcp__plugin_zcac_<tool>`（MCP 工具默认 `needsApproval: true`，可用 `toolAllowlist` 预授权）。

---

# 6. MCP 集成

- ZCode 是 **MCP 客户端**（仅 `@modelcontextprotocol/client`，仓库内没有 MCP server 实现可复用）——ZCAC 暴露编排 API 时需用 MCP SDK 自行实现 server。
- 配置 scope：user（`~/.zcode/cli/config.json` 的 `mcp.servers`）、workspace（`<repo>/.zcode/config.json`）、plugin（自动命名空间 `plugin:<id>:<server>`）、**session 级注入**（`session/create` 参数 `mcpServers` —— 集群场景最干净的编程路径）。
- 连接：stdio（进程树管理 + Windows Job Object）/ http / sse；`isolation: "workspace"` 可让多 session 共享一条连接（否则每 session 一个 server 进程——ZCAC 必须注意，避免 N 个 worker 拉起 N 个编排器进程）。
- 工具命名 `mcp__<server>__<tool>`；全部走权限门控。
- 子 Agent 对 MCP 是「借用」语义（`createBorrowedSubagentMcpAccess`）：只能 callTool，不能连接/断开。

---

# 7. Model Provider 层

- 注册表：内置（`config/provider/zcode-builtin.json`，含 GLM/bigmodel 端点）⊕ 账号权益 ⊕ 个人配置（`~/.zcode/v2/provider_config.json`），经 `ProviderRegistryService` 发布。
- **直接调用模型层完全可行**：`@zcode/provider` + `@zcode/provider-node` + `@zcode/adapters/model` 是无 UI 依赖的普通 TS 库；api-key 型 provider（GLM）进程内自足（流式、工具调用、重试、用量归一化都有）。`zhipu-account`（OAuth/闲时）型需要宿主服务，ZCAC v1 应限定 key 型。
- 每 Agent 模型选择：profile `model:` frontmatter → 否则继承父会话；`reasoningLevel` 受 `optionSpecs` 校验。
- 用量记账：`UsageStorePort.recordModelUsage`（input/output/reasoning/cache tokens）+ `session/usage` 协议查询——**ZCAC 每 Agent 成本归因几乎免费**。
- 并发治理：`ModelRequestAdmission` port + AIMD `ConcurrencyController` 可直接嵌入 ZCAC 调度器。

---

# 8. Git / Workspace / 持久化 / 恢复

## 8.1 Git 能力现状

| 能力 | 状态 |
|---|---|
| status/diff/commit/branch/push 等（`IGitService`） | ✅ 有（`packages/services/src/git/repo/gitCliRepo.ts`） |
| pull/merge/rebase/clone | ❌ 无 |
| **worktree 创建** | ❌ **无**（唯一钩子 `script-workflow-runtime.ts:283` 抛 "not implemented yet"，已亲自验证） |
| worktree 检测（workspace kind = `linked-worktree`） | ✅ 有；checkpoint/status/diff 全部 worktree 安全 |
| 隐患：**工作目录无排他租约** | 多进程指向同一目录会竞争文件（仅 checkpoint 用 blob-hash 检测漂移） |

**ZCAC-0008 结论：** 自建 `git worktree add` 供给逻辑；把每个 worktree 注册为独立 `workspacePath/workspaceKey`——身份哈希/会话目录/checkpoint 机制随即自动隔离。合并/冲突解决也自建（`IGitService` 不含 merge）。

## 8.2 持久化布局

```text
~/.zcode/
├── cli/db/db.sqlite          ← 主会话库（messages/parts/todos/usage/dwf journal）
├── v2/tasks-index.sqlite     ← 任务索引 + automations + off_peak_tasks
├── v2/checkpoints/{wsHash}/  ← git checkpoint manifests（隐藏 ref 快照）
├── v2/sessions/{wsHash}/     ← 旧版任务 JSON 快照
├── cli/agents/...            ← subagent 工件（metadata.json/output.txt）
└── v2/credentials.json       ← 加密凭据
```

- 会话是 **SQLite 行级增量持久**（非 JSONL）；冷恢复：`ColdSessionResumeCoordinator` + `hydrateMessageHistoryFromSession`（中断的工具调用标记为 interrupted）。
- 跨进程原语：`acquireFileLock`（目录锁 + pid 活性检测）、原子写（temp+rename，Windows EPERM 重试）、SQLite `BEGIN IMMEDIATE` claim。
- **现成的集群调度模板**：`automationRepo.claimDue`（原子认领 + runId 幂等 + 僵尸回收 + 租约续期）和 `remoteDeployLock`（mkdir 锁 + 心跳 + 过期接管）——ZCAC 调度器的持久化认领应照此实现。
- 环境隔离：`ZCODE_DATA_BASE_DIR` / `ZCODE_STORAGE_DIR` 可让 ZCAC 给集群节点/工作池独立数据根。

---

# 9. 复用矩阵（ZCAC 需求 × ZCode 现状）

| ZCAC 需求 | ZCode 现状 | 结论 |
|---|---|---|
| Agent 执行（回合循环/工具/流式） | `AgentRuntime` + 45 内置工具 | ✅ 直接复用 |
| 只读 Agent（Reviewer/Explorer） | Explore 模式（白名单+新 PermissionService+yolo） | ✅ 直接复用 |
| Worker 启动 API | `SubagentPort`（launch/start/sendMessage/stop） | ✅ 直接复用 |
| Worker 双向消息 | SendMessage + RespondToCoordinator + task-notification | ✅ 直接复用 |
| Agent 人格/工具/模型配置 | `AgentProfile` markdown（插件可贡献） | ✅ 直接复用 |
| 结构化任务结果 | dwf `submit_result` + Schema 校验 + 修复循环 | 🔧 适配（把该模式搬到 ZCAC worker 工具） |
| 上下文压缩 | compact/microcompact + `ReadSessionContext` 跨会话读取 | ✅ 直接复用 |
| 并发治理 | AIMD `ConcurrencyController` + `ModelRequestAdmission` | ✅ 直接复用 |
| Token 记账 | `UsageStorePort` + `session/usage` | ✅ 直接复用 |
| 持久 journal / 恢复 / amend | dwf journal + resume + imported cache | 🔧 适配（借用模式与表设计，ZCAC 自建表） |
| Task Graph（运行时可变 DAG） | ❌（dwf 图=脚本冻结；旧 workflow 有依赖图但属废弃系统） | 🔨 自建（ZCAC-0002） |
| 调度器（依赖/优先级/重试/配额） | ❌（仅 FIFO+全局并发数） | 🔨 自建（ZCAC-0004） |
| Agent Pool（暖池/能力匹配/名册） | ❌（冷启动单发、无递归） | 🔨 自建（ZCAC-0003） |
| 双向 Event Bus | dwf RunEvent 单向观察 | 🔧 适配（沿用 journal+emit 双写模式，加控制通道） |
| Artifact 系统 | dwf artifact（版本/上限/`zcode-artifact://`）+ subagent 磁盘工件 | 🔧 适配（扩展为集群级 ArtifactStore） |
| Review Loop 服务化 | ❌（仅技能中的脚本惯用法） | 🔨 自建（ZCAC-0007） |
| **Git Worktree 隔离** | ❌（显式 stub） | 🔨 自建（ZCAC-0008，worktree add + workspaceKey 注册） |
| Merge/冲突解决 | ❌（git 服务无 merge） | 🔨 自建 |
| 持久化任务认领/租约 | `claimDue` + `remoteDeployLock` 模式 | 🔧 适配（照抄语义） |
| 崩溃后恢复集群 | 冷恢复 + 断点续跑（session 级）+ automation 僵尸回收 | 🔧 适配（ZCAC-0010 组合这些） |
| 发布为插件 | manifest 全面支持 agents/commands/skills/MCP/hooks | ✅ 直接复用 |
| 集群 UI | ❌ 插件不能加 UI | 🔨 观察面走 CLI/日志/事件流（后期协议 UI 另议） |

---

# 10. 对《ZCode Agent Cluster.md》的修订建议

1. **第 22 节「复用」清单偏保守**：Subagent / Workflow / Artifact / 部分持久化已存在实现，应从「假设可复用」升级为「确认复用 + 具体文件锚点」（见本报告第 9 节矩阵）。
2. **第 26-28 节 MVP 路线可以加速**：原计划 MVP-2 才引入 Artifact/Shared State、MVP-4 才引入持久化——由于 dwf 模式与 `UsageStorePort` 现成，建议 MVP-1 就带最小 journal（事件追加日志）与用量记账，避免返工。
3. **第 16 节 Git Isolation 是唯一从零开始的执行平面项**，且 ZCode 侧明确未实现；worktree 供给 + workspaceKey 注册 + 合并流水线应作为独立里程碑（ZCAC-0008）提前设计。
4. **第 6 节 Agent Model 与实现一致**：`AgentProfile` 已是 Identity+Role+Capabilities+Tools+Permissions+Context Policy 的载体；ZCAC 的 `agent:` YAML 配置应直接映射为 profile 生成器，而不是发明平行格式。
5. **新增边界事实**：子 Agent 无递归 → 编排拓扑必须一层；插件不能加 UI → v1 观察面 = CLI + 事件流；MCP server 需自写；dwf 默认关闭不影响 ZCAC（只借代码，不依赖其运行时开关）。
6. **第 32 节接口定义微调**：`Scheduler.enqueue/schedule` 建议改为持久化队列 + `claimDue` 语义（参照 automationRepo），`ClusterController` 增加基于 journal 的 `replay(id)`。

---

# 11. ZCAC-0001 ~ ZCAC-0010 修订定义

| 编号 | 名称 | 构建基座（ZCode 资产） | ZCAC 新增 |
|---|---|---|---|
| ZCAC-0001 | Task Model | dwf `askSpecs`/`NodeRecord` 类型化提交模式 | Task/TaskStatus/TaskInput(schema)/TaskOutput 类型；finding/artifact 引用 |
| ZCAC-0002 | Task Graph | 参考 `core/src/workflow/scheduler/graph.ts`（旧系统 ready/blocked 计算） | 运行时可变 DAG：动态加节点、就绪计算、拓扑校验、循环检测 |
| ZCAC-0003 | Agent Pool | `AgentProfile` + `SubagentPort` | 池语义（槽位/角色计数/忙闲名册）+ 能力匹配路由 + 每角色配额（底层仍可冷启动） |
| ZCAC-0004 | Scheduler | AIMD `ConcurrencyController`、`ModelRequestAdmission`、`claimDue` 模式 | 依赖感知 FIFO v1（→优先级/预算 v2）、重试策略、租约认领、截止时间 |
| ZCAC-0005 | Event Bus | dwf journal+emit 双写模式；`SessionEventStorePort` seam | 集群事件 schema（TASK_*/ARTIFACT_*/REVIEW_*/CLUSTER_*）、双向控制通道、订阅 API |
| ZCAC-0006 | Artifact System | dwf artifact store（版本/上限）+ `~/.zcode/cli/agents/` 工件 | 集群级 ArtifactStore（patch/diff/report/test_result + checksum + review 状态机） |
| ZCAC-0007 | Review Loop | Explore 只读模式（Reviewer 权限）+ 结构化 submit（findings schema） | Review→FAIL→Fix Task 注入（依赖 ZCAC-0002 动态图）→Re-review，max_rounds |
| ZCAC-0008 | Git Isolation | worktree 检测 + workspaceKey 身份机制 + git checkpoint（回滚） | `worktree add/remove` 供给器、worktree↔agent 绑定、合并流水线、冲突处理 |
| ZCAC-0009 | Persistence | SQLite 模式（`adapters/.../repositories/*`）、`acquireFileLock`、原子写 | zcac_* 表（runs/tasks/events/artifacts/agents）、快照、多进程写安全 |
| ZCAC-0010 | Recovery | 冷恢复 hydrator、dwf resume 语义、automation 僵尸回收/租约 | 集群 Resume（续未完任务，不重跑成功任务）、事件重放、Supervisor 升级决策 |

---

# 12. 推荐 v0.1 技术方案

## 12.1 拓扑

```text
ZCode 会话（用户）
   │ /cluster <task>         （插件命令）+ cluster-orchestration 技能
   ↓
ZCAC 编排器（独立 Node 进程，MCP stdio 子进程形态）
   │  Cluster Controller / Task Graph / Scheduler / Event Bus / State
   │  （进程内直接 import @zcode/* 库）
   ├── Planner worker    = AgentRuntime（profile: planner, 只读）
   ├── Explorer worker   = AgentRuntime（profile: explorer, Explore 模式只读）
   ├── Coder worker ×N   = AgentRuntime（profile: coder, 写权限, v0.1 共享主工作区, v0.2 worktree）
   ├── Tester worker     = AgentRuntime（profile: tester, Bash）
   └── Reviewer worker   = AgentRuntime（profile: reviewer, 只读 + findings submit 工具）
```

- **v0.1 单进程**：编排器 import `@zcode/bootstrap` 级库，程序化构造 worker runtime（照抄 `bootstrap/src/app/workflow-driver.ts` 的 actor 构造方式，即 `createZCodeApp`/子 `AgentRuntime` 组合）。不依赖 dwf 运行时开关。
- **结构化结果**：每个 worker 注册 ZCAC 自定义工具 `zcac_submit_result`（JSON Schema 按 task type 校验，失败即修复循环）。
- **持久化**：编排器自建 `~/.zcode/zcac/` SQLite（runs/tasks/events），事件双写（journal + 实时订阅）。
- **v0.2+**：多进程扩展时把 worker 换成 `app-server --stdio` 子进程（协议已有：session/create、v4 订阅、requestPermission 应答），编排器不动——因为 ZCAC 对 worker 的接口本来就是自己的 `SubagentPort` 适配层。
- **发布**：插件包（第 5.3 节结构）；编排器 = `.mcp.json` stdio server；`userConfig` 存端点/并发/key。

## 12.2 与设计文档第 35 节第一条 E2E 测试链的对齐

"hello() API + 测试" 任务在 v0.1 拓扑下的验收点全部可由现有资产支撑：Agent 创建（profile）、Task/依赖（ZCAC 新增）、调度（ZCAC）、GLM 调用/文件修改/测试（AgentRuntime 内置工具）、Review（只读 reviewer + findings）、Event/Artifact（ZCAC）、Cluster 完成与恢复（ZCAC journal）。

---

# 13. 风险与开放问题

1. **包的对外稳定性**：`@zcode/core` 等包为 monorepo 内部包，无公开 npm 发布与语义化兼容承诺——ZCAC 应锁定 commit 版本，并将对 core 的 import 收敛到一个适配层模块，降低上游升级成本。
2. **权限 UX**：无头编排器的 worker 默认 broker 是拒绝 ask 的。v0.1 方案：worker 全部走 Explore 式「白名单+yolo」，写权限只给 coder/tester 且白名单最小化；v0.2 再做编排器级 `PermissionBrokerPort` 汇聚 ask。
3. **同进程资源上限**：单进程多 worker 共享事件循环与内存；AIMD 治理模型请求，但不治理本地工具并发——ZCAC 调度器需对 Bash 类任务单独限流。
4. **worktree 与 workspaceKey 的注册细节**：worktree 作为新 workspace 后，宿主侧服务（文件监视/git 面板）如何感知，需要 PoC 验证（最简路径：让 ZCAC 编排器自己作为该 workspace 的宿主进程）。
5. **Windows 环境细节**：仓库工程链（pnpm 10.33.2 / Node 24.14 / oxlint）与本机 Git Bash 兼容；`acquireFileLock`、MCP stdio、Job Object 均有 Windows 专门处理，风险较低但 E2E 需在 win32 实测。
6. **dwf 复用边界**：借其代码模式（journal schema、AIMD、submit 修复循环）而非其运行时，避免受 feature flag 与「脚本冻结」约束。

---

# 14. 附录：关键文件速查

| 领域 | 文件 |
|---|---|
| 程序化入口 | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`（`createZCodeApp`） |
| 运行时 | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` + `runtime/methods/*` |
| 工具系统 | `core/src/tool/{registry,scheduler,executor}.ts`, `tool/handlers/index.ts` |
| 权限 | `core/src/permission/{service,broker}.ts` |
| Subagent | `core/src/subagent/{runner,profile,tool-policy,borrowed-mcp-port,message-steering}.ts`; `contracts/src/interfaces/subagent.port.ts` |
| dwf 引擎 | `apps/zcode-cli/packages/dynamic-workflow/src/{engine,compiler,lowering,schema,facade}/` |
| dwf 宿主接线 | `apps/zcode-cli/packages/bootstrap/src/app/{workflow-driver,dynamic-workflow-run-submit,dynamic-workflow-import}.ts` |
| actor 构造先例 | `bootstrap/src/app/workflow-facade.ts`, `script-workflow-child-runtime.ts` |
| 插件 | `apps/zcode-cli/packages/adapters/src/plugins/index.ts`; `contracts/src/plugins/index.ts` |
| MCP 客户端 | `apps/zcode-cli/packages/adapters/src/mcp/{index,pool,stdio-transport}.ts`; `core/src/mcp/index.ts` |
| 模型层 | `packages/provider/src/{registry,resolver,effective-model-selection}.ts`; `adapters/src/model/{model-execution,runner}.ts` |
| 协议 | `packages/shared/src/zcode-protocol/index.ts` + `zcode-protocol-v4/`; `bootstrap/src/zcode-protocol/server.ts` |
| HTTP 宿主 | `packages/server/src/{http,entry-http,entry-stdio}.ts` |
| 会话存储 | `apps/zcode-cli/packages/adapters/src/storage/session-store/{sqlite-session-store,repositories/*}.ts` |
| Git/检查点 | `packages/services/src/git/{gitService,repo/gitCliRepo,repo/gitCheckpointRepo}.ts` |
| 调度先例 | `packages/services/src/session/automationRepo.ts`（claimDue）; `packages/server/src/remote/remoteDeployLock.ts` |
| worktree stub | `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts:283` |

---

*侦察方法：六路并行代码勘探（runtime / subagent / workflow / plugin / mcp+model / git+persistence），关键结论已逐条回源码验证（worktree stub、subagent 禁用递归、`createZCodeApp`、dwf 默认关闭、`claimDue`）。*
