# ZCAC Phase 8 — Supervisor 决策循环实现记录

**对应规范：** 《ZCAC Phase 8 Supervisor 决策循环规范》
**日期：** 2026-10-02
**结果：** ✅ 单测 70/70;真实 GLM pipeline E2E 回归 PASS
**代码：** `zcode-repo/packages/zcac/`（src/application/supervisor.ts）

---

# 1. 交付:两类死终态升级为有限预算的自动决策

```text
merge_conflict(任务失败,不可重试)
  → [预算内] rebase_redo:注入 coder 任务在新基线重做
    (worktree 重建基于当前 HEAD —— 天然 rebase;prompt 携带冲突文件列表
     + 原任务意图 + "主分支已前进,先读现状再重实现")
  → [预算尽] terminal(事件记录,终态保留)

plan_unparseable / plan_cyclic / plan_empty(run 失败)
  → [预算内] replan:注入新 plan 任务(prompt 追加格式强调)
  → [预算尽] failRun(原语义)

预算:per-run 总决策数(默认 2)+ 每类单独限额(冲突重做 1 / re-plan 1),
每次决策写 SUPERVISOR_DECISION 事件(trigger/action/newTaskId/budget)。
```

review_max_rounds 本阶段维持终态(重排整个 run 的语义复杂,规范 §4 记录在案)。

## 单测(70/70,新增 4 + 3 个语义迁移)

- 冲突→redo:并行双 implement 同文件 → 后者 merge_conflict →
  redo 注入(prompt 含冲突上下文与原意图)→ 新基线重做成功落地终值 →
  run **诚实判 failed**(冲突任务终态不可变)但补救产物正确;
  SUPERVISOR_DECISION{rebase_redo} 记录
- 预算 0 → terminal(无注入,run failed,事件记录 terminal)
- re-plan:坏计划一次 → replan 注入 → 好计划 → 任务链完成;
  连续两次坏 → failRun(plan_unparseable)+ 决策序列 [replan, terminal]
- 语义迁移:pipeline/worktree 的 3 个旧测试更新到决策语义

真实 GLM 回归:e2e-pipeline(装配 Supervisor 默认开启)PASS——正常路径零影响。

---

# 2. 过程中发现并修复的问题

1. **`?:` 三元的 falsy 陷阱吞掉合法值 0**:`supervisorMaxDecisions: 0`
   被 `...(options.x ? {x} : {})` 当成"未提供"→ 默认 2 → 预算失效。
   修为 `!== undefined`。诊断路径值得一提:单测里 redo 意外被注入 →
   加事件日志复现 → EV 流直接暴露 `SUPERVISOR_DECISION{action:rebase_redo}`
   在 maxDecisions=0 时仍发生。
2. **测试时序即语义**:冲突测试必须「等 BOTH launch 再完成」——先 complete(1)
   会让第二个 worktree 的创建排进 git 串行队列的 A-merge 之后(新基线,
   冲突自然消解)。并行度与完成顺序共同决定冲突是否发生,测试必须显式控制。
3. **语义漂移是决策循环生效的证据**:3 个旧测试失败全部源于
   "原来立即终态的失败现在被决策接管"——按新语义迁移而非放宽断言。

---

# 3. Phase 0–8 总览

| Phase | 交付 | 单测 |
|---|---|---|
| 0–5 | v0.1 主线(执行面→控制面→插件) | 57 |
| 6 | Pipeline Mode | +7 |
| 7 | worktree×pipeline + 三缺陷 | +2 |
| 8 | **Supervisor 决策循环** | **+4,共 70/70** |

复现:

```bash
cd zcode-repo && pnpm --filter zcac build
pnpm --filter zcac test    # 70/70
```

---

# 4. v0.2 剩余候选

- **AIMD 接入**:429/1302 退避仍是真实 E2E 时长的主要成分;
  ZCode ConcurrencyController 可直接嵌入调度层。
- **ProtocolExecutor**:worker 换 app-server 子进程(崩溃隔离+根治内存压力)。
- review_max_rounds 的 Supervisor 决策(重规划整个 run)。
- 决策可视化:cluster_status 输出 SUPERVISOR_DECISION 摘要。
