# ZCAC Phase 2 — Agent Pool & Scheduler v2 实现记录

**对应规范：** 《ZCAC Phase 2 Agent Pool 规范》（ZCAC-0003 / ZCAC-0004 增强）
**日期：** 2026-10-02
**结果：** ✅ 全部完成——单元测试 40/40；双 Coder 并行 E2E 通过（真实 GLM）；Phase 0/1 回归通过
**代码：** `zcode-repo/packages/zcac/`

---

# 1. 验收结果（规范 §7 对照）

## E2E：双 Coder 真并行（真实 GLM，规范 §5 / v0.1 Spec §50 场景）

```text
Coder A(写 alpha.txt) ──┐
                        ├──→ Tester(验证两文件, VERDICT_PASS) ──→ RUN_COMPLETED
Coder B(写 beta.txt) ───┘
```

```text
[e2e2] wall clock: 137.4s        （3 个真实 GLM 任务，总 56,522 tokens）
✓ run.status == completed
✓ 3 tasks all succeeded
✓ tester verdict PASS
✓ two coders overlapped in time (真并行:两任务执行区间重叠)
✓ tester started after both coders started
✓ alpha.txt / beta.txt 内容精确匹配
✓ event order: coder starts precede tester start
✓ sequence strictly increasing (#1..#22)
✓ slot accounting (2 distinct coder slots)
```

事件时间线（节选）：`#9 TASK_STARTED(coderA)`、`#10 TASK_STARTED(coderB)`（并行启动）
→ `#13/#15 TASK_SUCCEEDED×2` → `#17 TASK_READY(tester)` → `#20 TASK_SUCCEEDED(tester)` → `#22 RUN_COMPLETED`。

## 单元测试 40/40（新增 10 个）

| 套件 | 覆盖 |
|---|---|
| registry（2） | 未知 role 在 **createTask 即抛错**（配置错误早失败）；默认五角色配额表 |
| pool（4） | per-role quota 满 → acquire=undefined；idle slot 复用（totalTasks 计数）；全局上限跨角色生效；角色间配额独立 |
| lease（3） | claim 写 leaseUntil；heartbeat 续约；**Recovery 尊重租约**：未过期 → stillLeased 不动（他进程持有），过期 → requeue |
| 并行约束（2） | quota=1 时第二个任务不启动；quota=2 时两任务同时在飞 |

Phase 1 的 30 个用例全部保持通过；Phase 1 E2E 回归 PASS。

---

# 2. 交付内容

```text
src/domain/agent/agent-pool.ts     # AgentSlot / RoleDefinition / AgentCapabilityRegistry
                                   #（默认五角色:coder2/explorer2/planner1/tester1/reviewer1）
src/application/agent-pool.ts      # AgentPool:acquire/release/hasCapacity/名册/idle 复用
src/application/scheduler.ts       # v2:pool 准入先于 claim;执行期 heartbeat;finally 归还 slot
src/application/task-service.ts    # claimTask 写 lease(默认120s);heartbeatTask;createTask 校验 role
src/application/recovery.ts        # lease 过期判定(未过期 → stillLeased,过期 → requeue|failed)
src/adapters/sqlite/*              # zcac_tasks.lease_until 列(+幂等 ALTER 迁移);claim/heartbeat
src/ports/clock.ts                 # + FakeClock(测试时间推进)
src/e2e-parallel.ts                # 双 Coder 并行 E2E
```

Scheduler v2 准入链：

```text
ready(priority DESC, createdAt ASC)
  → pool.hasCapacity(role)?        ← role quota + 全局上限
  → pool.acquire(role, taskId)     ← idle 复用优先
  → claimTask(原子, 写 lease_until)
  → launch → AGENT_ASSIGNED{slotId}
  → setInterval heartbeat(lease/3)
  → complete/fail → pool.release → AGENT_RELEASED
```

---

# 3. 过程中发现并修复的两个真实缺陷

1. **Provider Registry 并发初始化竞态**（首跑 E2E 挂死 32 分钟的根因）：
   `ensureRegistry` 用 `this.field ??= await init()` ——两个并行 launch 都看到字段为空，
   各自启动一个 Registry 实例，第二个卡在凭据文件锁/内置配置下载上。
   修复：缓存 **promise** 而非结果（第二次调用 await 同一个实例）；失败时清缓存允许重试。
   这是 Phase 3（多 worker 常态并行）必须踩掉的雷。

2. **drain 超时误判**：deadline 检查放在循环头，任务实际在执行中只是慢（模型限流重试）
   也会在任务完成后被误报超时。修复：deadline 只在「停滞且无可推进」（无 in-flight、
   无 ready、无 retry 到期）时判定；等待 race 加入睡到 deadline 的兜底唤醒。
   另给 E2E 的 `executor.dispose()` 加 15s 限时——模型流关闭可能挂起导致进程僵死。

3. **实测确认**：GLM-5.3-Flash 在连续请求下也会被 429 限流（ZCode runtime 内部静默重试），
   3 任务 E2E 墙钟 137s 中相当部分是限流等待。这直接验证了 v0.1 Spec §17「两层并发控制」
   的必要性——Scheduler v2 的 per-role quota 是第一层，后续接 ZCode AIMD 是第二层。

---

# 4. 下一步（Phase 3 — Review Loop / Artifact，v0.1 Spec §54 Phase 4-5）

1. ZCAC-0006：ArtifactStore（zcac_artifacts 表 + checksum + 类型）。
2. ZCAC-0007：Review Loop——reviewer 角色产出结构化 Finding（submit schema），
   FAIL → 动态创建 Fix Task 注入 Graph（Phase 1 已验证的运行时可变 DAG 正是为这一步准备的），
   max_rounds=3。这是 ZCAC 与 dwf 本质区别的第一个完整闭环（v0.1 Spec §51）。
3. Phase 4 崩溃 E2E（v0.1 Spec §52）：kill -9 后 resume 不重跑已完成任务——lease 语义已就绪。
