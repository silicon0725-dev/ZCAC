# ZCAC Phase 5 — Plugin 包装实现记录

**对应规范：** v0.1 Implementation Spec §38–§40（MCP 架构 / Plugin 结构）/ §54 Phase 8 / §61 DoD 最后一条
**日期：** 2026-10-02
**结果：** ✅ 全链路验证通过——ZCode 内 `/cluster <task>` 触发真实 GLM 集群 run;单测 57/57
**代码：** `zcode-repo/packages/zcac/`（src/mcp/ + plugin/）

---

# 1. 决定性验证：`/cluster` 全链路（真实 GLM）

```bash
zcode -p "/cluster create a file named from-plugin.txt containing one line: cluster via plugin works. Report the final run outcome."
```

```text
/cluster 命令展开(prompt 模板)
  → 主模型调用 mcp__plugin_zcode-agent-cluster_zcac__cluster_create
  → 插件 orchestrator 进程(stdio MCP server,ZCode 自动拉起)
  → buildZcac 组合 → ZCodeAgentExecutor → 真实 GLM coder worker
  → from-plugin.txt 创建(内容精确)
  → 主模型轮询 cluster_status → 报告:

  Run status: completed (run_5ff45347…)
  Task task_bdb12fb8 (implement, coder): succeeded, attempt 1, ~14s
  artifact 已记录,无重试

文件内容核验: cluster via plugin works ✅
```

这就是 v0.1 §61 Definition of Done 的最后一条:**「ZCAC 可以作为 ZCode Plugin 使用」**。

## 插件装配验证(zcode CLI 实测)

| 检查项 | 结果 |
|---|---|
| 插件发现/启用 | ✅ `zcode-agent-cluster@inline [enabled]`,MCP 注册为 `plugin:zcode-agent-cluster:zcac` |
| 五角色 agents | ✅ 全部注册(命名空间 + 裸名别名):coder/explorer/planner/tester/reviewer |
| MCP 工具可见 | ✅ 6 个 `mcp__plugin_zcode-agent-cluster_zcac__*`(= MCP server 真实拉起+握手) |
| 斜杠命令 | ✅ `/cluster <task>` `/cluster-status` `/cluster-stop` 全部加载 |
| MCP 协议端到端 | ✅ 单测:stdio 握手 → listTools → create → 轮询 completed → task/artifact/events 游标 replay |

---

# 2. 交付内容

```text
src/mcp/orchestrator.ts        # stdio MCP server(buildZcac 组合的壳)
  工具:cluster_create(后台 drain,立即返回) / cluster_status(默认最新 run)
       cluster_stop / task_list / artifact_list / events(afterSequence 游标)
  环境变量:ZCAC_MODEL / ZCAC_ISOLATION / ZCAC_DATA_DIR / ZCAC_WORKSPACE
          / ZCAC_CONCURRENCY / ZCAC_TEST_FAKE(测试钩子)
  ⚠ stdout 归 MCP 协议,日志全部走 stderr
src/adapters/fake/agent-executor.ts  # FakeExecutor 上移共享 + AutoFakeExecutor(launch 后自动完成)
plugin/
├── .zcode-plugin/plugin.json   # agents/commands/skills + userConfig(模型/隔离/并发)
├── .mcp.json                   # stdio server → node ${ZCODE_PLUGIN_ROOT}/dist/orchestrator.cjs
│                               #   env 注入 ${user_config.*}
├── agents/                     # coder/explorer/planner/tester/reviewer(与 core preset 对齐)
├── commands/                   # cluster / cluster-status / cluster-stop
├── skills/cluster-orchestration/SKILL.md   # 何时/如何用集群工具
└── dist/orchestrator.cjs       # esbuild 产物(~28MB,自包含)
```

注册方式(本机验证用):`~/.zcode/cli/config.json` 的 `plugins.dirs` 加入插件目录
(inline 来源,默认启用)。**撤销**:删除该 dirs 条目;原配置已备份为
`config.json.zcac-backup`。

---

# 3. 过程中的真实发现

1. **MCP server SDK 靠 client 包传递依赖获得**:`@modelcontextprotocol/sdk`
   v1.29(hoisted)。zod4 shape 运行时完全兼容,但其类型声明(zod-compat)与
   zod4 主入口结构性不匹配——类型摩擦收敛到编排器里**单一 cast 点**的
   `registerZcacTool` 包装(运行时经真实 stdio 握手验证)。
2. **编排器日志纪律**:stdio 被 MCP 协议占用,任何 console.log 到 stdout 都会
   破坏协议帧——全部日志走 stderr。
3. **cluster_create 立即返回 + 后台 drain**:编排器进程常驻,run 状态持久在
   `~/.zcode/zcac/zcac.sqlite`,`cluster_status` 按 journal 聚合——
   主模型只需要轮询,不需要盯着长调用。
4. `zcode plugins list` 的 commands 计数显示与实际不符(显示 1,实际 3 个全部
   加载)——以 `zcode commands` 的权威列表为准;无头 -p 下模型对 slash 命令
   可见性的自述也不可靠(说 No 但命令已加载),验证要以 CLI 输出与实际展开为准。

---

# 4. Phase 0–5 总览(v0.1 主线全部完成)

| Phase | 交付 | 验证 |
|---|---|---|
| 0 | AgentExecutor 适配 | PoC PASS |
| 1 | Task Core(四层/SQLite/FIFO/journal-first) | 30 单测 + E2E |
| 2 | Agent Pool + lease/heartbeat | +10 单测 + 双 Coder 并行 E2E |
| 3 | Artifact + Review Loop(动态 DAG) | +9 单测 + 动态闭环 E2E |
| 4 | Git Worktree 隔离 + 冲突 + 崩溃恢复 | +7 单测 + 双幕 E2E + §52 |
| 5 | Plugin(MCP 编排器/agents/commands/skill) | +1 单测(MCP 协议) + **/cluster 真实 run** |

**单测 57/57。** v0.1 Implementation Spec §61 Definition of Done 逐条达成:
✓ 从 ZCode 启动 Cluster ✓ 动态 Task Graph ✓ 多 Agent 并行 ✓ GLM
✓ 依赖调度 ✓ Pool 限并发 ✓ 持久状态 ✓ Event journal
✓ 结构化 Artifact ✓ Reviewer Finding ✓ FAIL→动态 Fix Task ✓ 自动 Review 循环
✓ Lease ✓ 崩溃恢复不重跑 ✓ 独立 Worktree ✓ 合并 ✓ 冲突进事件流 ✓ 作为 Plugin 使用

复现:

```bash
cd zcode-repo && pnpm --filter zcac build       # 含 plugin/dist/orchestrator.cjs
pnpm --filter zcac test                         # 57/57
# ZCode 内(插件已注册):
#   /cluster <task>   /cluster-status   /cluster-stop
# 直接测试编排器:node packages/zcac/plugin/dist/orchestrator.cjs(需 MCP client)
```

---

# 5. v0.1 之后的候选方向

- **多任务 cluster_create**:一次 run 接受任务分解(planner 角色)而非单任务;
  MCP 增加 task_create 依赖参数。
- **ProtocolExecutor(v0.2)**:worker 换 `app-server --stdio` 子进程,
  编排器与执行隔离(崩溃隔离/多机)。
- **AIMD 接入**:把 429/1302 信号喂给调度层(ZCode ConcurrencyController 可直接嵌入)。
- **Supervisor 决策**:MERGE_CONFLICT/review_max_rounds 之后的选择题
  (retry/reassign/escalate to user)目前是终态,应升级为决策循环。
- **Warm Pool 评估**:冷启动 ~25k input tokens、74% 缓存命中的实测数据
  支持先量化同 session 续聊收益再决定。
