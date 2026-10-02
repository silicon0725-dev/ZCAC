# ZCAC Phase 0 — Adapter PoC 记录

**对应规范：** 《ZCAC v0.1 Implementation Specification.md》§54 Phase 0 / §60 开工顺序
**日期：** 2026-10-01
**结果：** ✅ PASS（验收标准「Node script → launch coder → prompt → result」全部达成）
**代码位置：** `zcode-repo/packages/zcac/`（ZCode 克隆的 workspace 内，依赖 `workspace:*` 直连）

---

# 1. 验收结果

```
[poc] launched  : zcac-coder-001 (session sess_cee9c1d6-3973-443a-9637-1015cb7d51be)
[poc] model     : bigmodel-api/GLM-5.3-Flash
[poc] status    : completed
[poc] duration  : 35721 ms
[poc] usage     : {"modelRequestCount":4,"inputTokens":25793,"outputTokens":194,
                   "totalTokens":25987,"cacheReadTokens":19136}
[poc] response  : Created and verified ...hello.txt ... POC_OK hello from zcac
[poc] hello.txt : "hello from zcac\n"
[poc] PASS ✅
```

已验证的执行链（规范 §44）：

```text
Node script (poc.ts)
   ↓ launch({role:"coder"})
ZCodeAgentExecutor            ← ZCAC 适配层（spec §42 接口）
   ↓
createZCodeApp + AgentRuntime   ← 复用，未改动一行上游代码
   ↓
GLM-5.3-Flash (bigmodel-api)    ← 4 次模型请求，账号鉴权通过
   ↓
Write / Read 工具真实执行        ← 沙箱目录中创建并读回 hello.txt
   ↓
TurnResult → AgentResult        ← response + usage + duration
```

复现命令：

```bash
cd zcode-repo
pnpm --filter zcac build
node packages/zcac/dist/poc.cjs                                   # 默认模型
ZCAC_MODEL=bigmodel-api/GLM-5.3-Flash@low node packages/zcac/dist/poc.cjs
node packages/zcac/dist/list-models.cjs                           # 枚举可用模型
```

---

# 2. 实现内容

```text
packages/zcac/
├── package.json          # workspace 成员;esbuild 打包(同 CLI 自身方式)
├── tsconfig.json
└── src/
    ├── agent-executor.ts # AgentExecutor 契约 + ZCodeAgentExecutor + 5 个角色预设
    ├── list-models.ts    # Provider Registry 模型枚举工具
    └── poc.ts            # Phase 0 验收脚本(沙箱 + 断言 + 清理)
```

- `AgentExecutor` 接口与规范 §42 一致：`launch / send / wait / stop / dispose`。
- 角色预设（规范 §5 Capability Registry 雏形）：`coder / explorer / planner / tester / reviewer`，各自带工具白名单、persona、maxTurns、capabilities。reviewer/explorer 为只读白名单（落实「最小权限」原则）。
- 进程级共享一份 `startProcessProviderRegistryRuntime`（所有 worker 复用同一模型目录），与 CLI `-p` 的组合方式逐字对齐（`prompt-command.ts` 的接线：registryService + configuredDefaultModelSelection + providerRuntimeHeadersPort）。

---

# 3. 关键发现（影响后续 Phase）

## 3.1 SubagentPort 未公开导出 → v0.1 worker 改为「每 worker 一个 createZCodeApp」

规范 §44 设想 `AgentExecutor → SubagentPort → AgentRuntime`。实际（v3.14.3）：

- `AgentRuntime.subagentPort` 是 **private**（`core/src/runtime/agent-runtime.ts:175`）；
- `createDefaultSubagentPort` 未出现在 `@zcode/core` 公开导出中；
- 全仓库只有 Agent 工具（模型驱动）在进程内调用它。

替代实现（本 PoC 采用，且与 dwf actor 的构造方式等价）：**worker = 独立的 `createZCodeApp` 组合**——`toolAllowlist`（角色工具面）+ `subagentContext.agentPrompt`（persona）+ `subagents:{enabled:false}`（mono-agent）+ `mode:"yolo"`。这正是 `script-workflow-child-runtime.ts` 造 dwf actor 的形状。

**影响：** `AgentExecutor` 接口不变，后续若上游导出 SubagentPort 或启用 ProtocolExecutor（§45 v0.2），只改 `agent-executor.ts` 一个文件。已在该文件头注释中记录此决策。

## 3.2 `@zcode/shared` 是纯源码包 → ZCAC 必须打包分发

`packages/shared` 的 exports 直接指向 `src/*.ts`（无构建产物），Node 无法裸跑（`.js` 后缀指向 `.ts` 文件）。CLI 自己也是 esbuild 打成 `zcode.cjs` 解决的。ZCAC 照抄：esbuild `--bundle --platform=node --format=cjs`，external 同 CLI：`@zcode/tui, playwright-core, koffi`。产物 ~27MB。

## 3.3 模型选择必须带 reasoningLevel

`ModelSelection` 对 `bigmodel-api/*` 强制要求 `options.reasoningLevel`（`low|high|max`），缺省抛 `ModelProtocolError: Reasoning level is required`。ZCAC 的模型覆盖格式定为 `providerId/modelId@level`（如 `bigmodel-api/GLM-5.3-Flash@low`）。

## 3.4 配额事实（本机账号）

- 注册表可用模型：`bigmodel-api` → `GLM-5.3`、`GLM-5.3-Flash`（账号鉴权，runtime headers 生效）。
- 首次运行用 GLM-5.3 被 **429 拒绝**：「每周/每月使用上限，2026-10-02 01:14:13 重置」——链路与鉴权全部正确，纯粹是账号配额。
- **GLM-5.3-Flash 配额独立，PoC 一次通过**。ZCAC Scheduler 的模型配额感知（§16 v0.2）在真实环境已经必要：429 的 `retry-after` 语义 AIMD 控制器可消费。
- `configuredDefaultModelSelection` 为 null（用户未设默认），app 自动解析到 GLM-5.3。

## 3.5 Token 成本事实（对集群设计直接相关）

单次 coder 冷启动：4 次模型请求，输入 25,793 tokens（系统提示为大头），但其中 **19,136（74%）命中 prompt cache**（anthropic-messages 端点的 cacheControl 生效；有一条「>4 breakpoints」警告无害）。含义：

- 设计文档 §20「Context Compression」的方向被数据支持：worker 间靠 Artifact/Summary 传递，而不是复制对话历史；
- 同一 worker 会话内续聊（SendMessage/多 turn）成本远低于新开 worker——将来 Warm Pool（v0.2）有真实收益。

## 3.6 每 Agent 用量记账免费可用

`TurnResult.usage` 直接给出 inputTokens/outputTokens/reasoningTokens/cacheRead/modelRequestCount——ZCAC-0004（调度）和后续 Token Budget 无需额外埋点。

---

# 4. 偏差与遗留

| 项 | 状态 |
|---|---|
| 规范 §44 执行链的「SubagentPort」一环 | 以 createZCodeApp 组合替代（§3.1），接口不变，风险受控 |
| `send / stop / dispose` 生命周期方法 | 已实现未在 PoC 中演练（Phase 1 Task Core 会覆盖） |
| 每次 launch 的 createZCodeApp 组装耗时 | 未单独计量（含插件/技能扫描；Pool 语义落地时再测） |
| AI SDK 缓存断点警告（>4 breakpoints ignored） | 无害，上游已知行为 |

---

# 5. 下一步（Phase 1 — Task Core，规范 §54）

1. `core/task/`：Task / TaskStatus / TaskInput / TaskOutput / RetryPolicy 类型（ZCAC-0001）
2. `core/graph/`：运行时可变 DAG + cycle detection + ready/blocked 计算（ZCAC-0002）
3. `core/event/`：ClusterEvent + Journal + Live emit（ZCAC-0005）
4. SQLite 持久化（ZCAC-0009 最小表：zcac_runs / zcac_tasks / zcac_events）
5. 把 PoC 的 executor 接到真实 Task 上：`Scheduler(最简 FIFO) → AgentExecutor → TaskResult → Event`
