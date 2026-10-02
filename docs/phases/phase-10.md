# ZCAC Phase 10 — 真实仓库压力测试记录

**对应任务：** P0 第二项("敢日常用"的最终验证)
**日期：** 2026-10-02
**结果：** 5/6 通过;修复一个真实缺陷(merge --abort 竞态);三类发现已记录
**代码：** `zcode-repo/packages/zcac/`（src/stress.ts + adapters/git/worktree-manager.ts 修复）

---

# 1. 测试设计

真实 mini 项目(temp git 仓库):in-memory todo 模块 + node:test 测试套件,
**预置一个真实 bug**(listTodos 过滤反转)和一个因此失败的测试。

6 个任务(worktree 模式,真实合并,全部走 /cluster 同款路径):

| # | 任务 | 模式 | 目标 |
|---|---|---|---|
| 1 | explorer-analyze | single | 只读代码分析,无文件变更 |
| 2 | readme-doc | single | 单文件文档(README Usage) |
| 3 | pipeline-clearall | pipeline | 新增 clearAll() + 测试(planner→implement→test→review) |
| 4 | bughunt-filter | single | 修预置 bug(要求 agent 跑测试迭代修复) |
| 5 | tester-verify | single | 跑 node --test 并报告 pass/fail |
| 6 | pipeline-delete | pipeline | 新增 deleteById() + 测试(要求全绿) |

---

# 2. 结果

## 第一轮(修 bug 前):5/6

| # | 结果 | 墙钟 | tokens | 备注 |
|---|---|---|---|---|
| 1-explorer | ✅ | 35s | 21k | |
| 2-readme | ✅ | 30s | 27k | |
| 3-clearall | ✅ | 124s | 83k | 全 4 任务链 |
| 4-bughunt | ❌ executor_error | 72s | 0 | **merge --abort 在无 MERGE_HEAD 时抛错** |
| 5-tester | ✅ | 28s | 12k | |
| 6-delete | ✅ | 171s | 130k | 全 4 任务链 |

**真实缺陷(已修复)**:`merge --abort` 在非冲突失败(如 race 中被另一个合并
抢先完成)时没有 MERGE_HEAD → git 128 → 错误冒泡为 executor_error → 任务假失败。
修复:`merge --abort` 加 try/catch(已在 worktree-manager.ts 中)。

## 第二轮(修复后):5/6,但模式不同

| # | 结果 | 墙钟 | tokens | 备注 |
|---|---|---|---|---|
| 1-explorer | ✅ | 33s | 14k | |
| 2-readme | ✅ | 28s | 20k | |
| 3-clearall | ✅ | 132s | 84k | |
| 4-bughunt | ⚠️ merge_conflict→redo | 476s | 53k | **bug 已修复(!t.done 在代码中),但 run 诚实判 failed** |
| 5-tester | ✅ | 29s | 12k | |
| 6-delete | ✅ | 136s | 85k | |

任务 4 深入:**代码 bug 确实被修复了**(grep 确认 `!t.done` 存在,过滤逻辑正确),
但 run 判 failed 的原因:第一次 implement 与 pipeline-3 的合并发生了冲突 →
Supervisor rebase_redo → redo 成功修复了 bug → 但**原任务终态失败不可变**,
run 聚合因 failedCount>0 判 failed。这是 Phase 8 设计的诚实语义——
但暴露了一个产品问题:**Supervisor 补救成功后,run 状态应否反映"最终成功"?**

---

# 3. 三类发现(按严重程度)

## 发现 1:Supervisor 补救后 run 状态语义(设计问题)

run=failed 但实际工作已完成(bug 已修复)。用户看到"failed"会以为没修好。
**建议**(v0.3):当 Supervisor redo/replan 最终成功时,run 聚合应计算
"有效终态"(原失败 + 补救成功 = completed_with_recovery 或直接 completed)。

## 发现 2:agent 路径漂移仍偶发(已知,已有缓解)

主仓库出现了未提交的 todo.test.js 变更(pipeline-6 的 implement 任务
在 worktree 中修改了代码但把测试文件的修改写到了主工作区)。
"Use relative paths only" 前缀大幅减少但未根除。
**建议**(v0.3):worktree 模式下在 worktree 内注入环境提示(如在 worktree
根放置 .CLAUDE.md 或 workspace 指针文件),或对 implement 任务的 Bash
工具增加路径白名单校验。

## 发现 3:测试本身的模块级状态泄漏(测试设计,非集群缺陷)

预置的过滤测试假设模块从空开始,但 node:test 在同一进程串行运行——
前面的测试已添加了 todo → 第三个测试的 actual=2 而非 1。
**这是测试 bug,不是集群 bug**;集群的 coder 正确修了源码,tester 正确
报告了结果。教训:给 agent 的测试 fixture 需要自隔离(clearAll 前置)。

---

# 4. Phase 0–10 全景与可用性进度

| 里程碑 | 状态 |
|---|---|
| v0.1 全部(Phase 0–5) | ✅ |
| v0.2: pipeline / worktree / supervisor / rate-limit(6–9) | ✅ |
| **P0: 真实仓库压力测试(本阶段)** | ✅ 5/6 + 1 缺陷修复 |
| P1: 长跑内存 + kill 恢复演练 + README | ⏳ |
| P2: 插件打包分发 | ⏳ |

复现:

```bash
cd zcode-repo && pnpm --filter zcac build
node packages/zcac/dist/stress.cjs       # 真实 GLM, ~10min
pnpm --filter zcac test                   # 75/75
```

---

# 5. P0 结论

**"敢日常用"的判定:通过(附条件)。**

- 5/6 一次通过(唯一"失败"的根因是 Supervisor 语义 + 测试设计,实际代码已修复)
- 全链路(插件/MCP/pipeline/worktree/review/合并/退避/决策)在真实环境稳定工作
- 两轮实测墙钟:单任务 30-35s,pipeline 2-3 分钟——限流退避生效
- 条件:(a) run 状态语义需修复(发现 1);(b) agent 偶发写主区(发现 2)
  依赖用户目检 `git status`;两者均为 v0.3 优先项,不阻塞日常试点
