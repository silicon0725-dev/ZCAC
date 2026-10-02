# ZCAC Phase 1 — Task Core 实现记录

**对应规范：** 《ZCAC Phase 1 — Task Core 实现规范》（ZCAC-0001 / 0002 / 0005 / 0009）
**日期：** 2026-10-02
**结果：** ✅ 全部完成——单元测试 30/30 通过；E2E 通过（真实 GLM 调用）；Phase 0 回归通过
**代码：** `zcode-repo/packages/zcac/`（domain / application / ports / adapters 四层）

---

# 1. 验收结果（规范 §35 对照）

## Architecture

- ✅ **Task Core 零 `@zcode/*` 依赖**：`src/domain`、`src/application`、`src/ports`、`src/adapters/sqlite` 共 19 个文件无一处 ZCode import（`grep -r "@zcode" src/domain src/application src/ports src/adapters/sqlite` 为空）；ZCode 依赖只存在于 `src/adapters/zcode/`。
- ✅ AgentExecutor port 稳定（与 Phase 0 相同的五个方法，仅 `model` 改为逻辑标识字符串）。

## E2E（真实 GLM，规范 §30）

```text
[event #1] RUN_CREATED
[event #2] TASK_CREATED   {"kind":"implement","role":"coder"}
[event #3] RUN_STARTED
[event #4] TASK_READY     {"from":"pending"}
[event #5] TASK_STARTED   {"attempt":1}
[event #6] AGENT_ASSIGNED {"agentId":"zcac-coder-001","model":"bigmodel-api/GLM-5.3-Flash"}
[event #7] TASK_SUCCEEDED {"attempt":1,"durationMs":38328}
[event #8] AGENT_RELEASED
[event #9] RUN_COMPLETED  {"tasks":1,"succeeded":1,"failed":0}
```

断言 18/18 通过：run=completed、task=succeeded、attempt=1、usage 已捕获、
hello.txt 内容精确匹配、9 种事件齐全、sequence 严格递增 1..9、
**重开 SQLite 后全部状态不变**。

## 单元测试（30 个，`pnpm --filter zcac test`）

| 套件 | 覆盖 |
|---|---|
| task（4） | 状态机合法/非法迁移、终态判定、RetryPolicy 条件、工厂默认值 |
| graph（10） | **规范 §31 全部五例**：单任务/线性链/扇出/扇入/环拒绝 + 自依赖拒绝 + 失败传导 blocked + 运行时加任务加边 + 优先级排序 + 悬空依赖校验 |
| event（4） | bus 订阅/退订/handler 隔离；sequence 单调；**事务外 append 拒绝（journal-first 守卫）**；失败回滚事件与 sequence 一致 |
| scheduler（6） | 线性链依赖顺序、并行度=容量上限、失败重试后成功（attempt=2 + TASK_RETRY）、失败传导→run failed + TASK_BLOCKED、**claim 原子性（二次 claim 返回 undefined）**、优先级优先 |
| persistence（2） | 重开后 run/task/依赖/sequence 不变且续号（§32）；**崩溃模拟（§33）**：claim 后进程死亡→重开→requeue（attempt<max）/ attempt 用尽→failed |

---

# 2. 交付结构

```text
packages/zcac/src/
├── domain/            # 纯 TS,零依赖
│   ├── task/          # task / task-status(状态机) / task-input·output / retry-policy
│   ├── run/run.ts     # Run + eventSequence
│   ├── graph/         # TaskGraph(运行时可变 DAG、环检测、readiness) + 校验类型
│   └── event/         # ClusterEvent / 事件类型 / ClusterEventBus(live)
├── ports/             # AgentExecutor / Task·Run 仓储 / EventJournal / Clock·事务
├── application/
│   ├── task-service.ts    # 生命周期唯一写入点;journal-first 事务
│   ├── graph-service.ts   # 依赖变更(先环检测后落库) / readiness / run 聚合
│   ├── scheduler.ts       # dependency-aware FIFO + drain 驱动 + retry 提升
│   ├── recovery.ts        # 崩溃遗留 running → requeue | failed
│   └── build.ts           # 组合根(装配 sqlite 适配器与 executor)
├── adapters/
│   ├── sqlite/        # node:sqlite(与 ZCode 存储层同驱动):三表 + 原子 claim + sequence
│   └── zcode/         # ZCodeAgentExecutor(逻辑模型解析) + list-models
└── e2e.ts / poc.ts

packages/zcac/tests/  # 30 个用例 + FakeExecutor/装配 helpers
```

复现：

```bash
cd zcode-repo
pnpm --filter zcac build
pnpm --filter zcac test                     # 30/30
node packages/zcac/dist/e2e.cjs             # 真实 GLM E2E
node packages/zcac/dist/poc.cjs             # Phase 0 回归
```

---

# 3. 实现要点与规范差异

1. **SQLite 驱动 = `node:sqlite`**（零新增依赖，与 ZCode `sqlite-session-store.ts` 同驱动）。表结构按规范 §21–23，`zcac_tasks` 增加 `retry_not_before` 列（retry_wait 的入队时间戳）。
2. **journal-first 双保险**：`EventJournal.append` 在事务外调用直接抛错（运行时守卫）；所有状态迁移与事件在同一 `BEGIN IMMEDIATE` 事务提交，COMMIT 后才 live emit。事件测试验证了「状态迁移失败 → 事件与 sequence 一并回滚」。
3. **claim**（规范 §26）：单条 `UPDATE ... WHERE id=? AND status='ready'`，`changes===1` 才算成功，attempt 原子 +1。scheduler 测试验证二次 claim 返回 undefined。
4. **run 聚合补强**（规范未覆盖的边界）：除「全部终态」外，新增**停滞判定**——存在 failed 且无任何可推进任务（无 pending/ready/running/retry_wait/interrupted）时 run 判 failed；下游因依赖失败而永久 blocked 的任务保持 blocked 状态（不虚报 cancelled）。这是 E2E 失败传导用例能通过的关键。
5. **`getReadyTasks` 语义**：返回 `status === "ready"`（readiness 由 `recomputeReadiness` 维护），而不是每次现算依赖——图查询 O(n) 且与持久状态一致；依赖评估只发生在 recompute。
6. **drain 确定性驱动**：Scheduler 提供 `drain(runId)`（测试/E2E 复用），内部仍是「refresh → claim+launch(不阻塞) → 等一个完成」循环；仅剩 retry_wait 时睡到最近到期点，避免忙等。
7. **崩溃恢复**（§33）：`running → interrupted（瞬时）→ ready | failed`，两步迁移均落库；completed task 不可变、不重跑。
8. **TaskService/GraphService 职责切分**：TaskService 是 Task/Run 生命周期与事件的唯一写入点；GraphService 持图、做依赖变更（环检测失败则图与库都不变）与聚合。Run 状态迁移也走 `updateRunWithEvent` 同事务（对 run 同样 journal-first）。
9. **依赖边变更暂无专属事件类型**（规范 §16 固定最小集合）；Phase 2 若需要 replay 图结构变更，增加 `DEPENDENCY_ADDED` 再说——journal 已可从任务行重建图（`graphService.loadRun`）。

---

# 4. 下一步（Phase 2 — Agent Pool + Scheduler v2，规范 §37）

1. ZCAC-0003：AgentSlot / 角色 quota / 能力匹配（ROLE_PRESETS 从 adapter 上移为 core 的 Capability Registry）。
2. ZCAC-0004 增强：并发按角色分桶、lease/heartbeat（把 claim 的租约语义补全，支撑真正的多进程）。
3. Warm Pool 评估：利用 Phase 0/1 数据（冷启动 ~19–26k input tokens、~74% 缓存命中、34–38s 墙钟）实测同 session 续聊成本，再决定是否进入 v0.2 核心路径。
4. 两条并行 E2E（规范 §50 场景）已在单测覆盖并行度,补真实 GLM 的双 Coder 并行链。
