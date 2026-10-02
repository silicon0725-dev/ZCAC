# ZCAC Phase 6 — Pipeline Mode 实现记录

**对应规范：** 《ZCAC Phase 6 Pipeline Mode 规范》（v0.2 方向第一条）
**日期：** 2026-10-02
**结果：** ✅ 单测 64/64；真实 GLM pipeline E2E 9/9 断言通过
**代码：** `zcode-repo/packages/zcac/`（src/application/pipeline.ts + orchestrator mode + e2e-pipeline）

---

# 1. E2E：完整流水线（真实 GLM）

```text
cluster_create(mode=pipeline) "greet.js 模块 + node:test 测试"
  ↓ Planner(真实分解,PLAN_BEGIN/END 约定格式)
  ↓ [PipelineService 事件驱动注入]
implement → test(依赖自动补齐) → review(autoReview 终审)
  ↓ RUN_COMPLETED

✓ run completed(877s,含限流重试;94,705 tokens,4 任务)
✓ plan succeeded & planner produced >=2 tasks
✓ all tasks succeeded
✓ test started after all implements(事件序验证)
✓ test depends on at least one implement
✓ final review exists and passed(REVIEW_VERDICT: PASS)
✓ greet.js exists & exports greet(真实产物)
```

这是 v0.1 设计文档 §24/§36 愿景链(**Planner → Coder×N → Tester → Reviewer**)
第一次以真实 GLM 全链跑通——全部建立在 Phase 1–3 的动态 DAG、
角色配额、Review Loop、journal-first 之上,零改动既有执行面。

## 单测 64/64（新增 7 个）

- parsePlan:格式解析(行/依赖/去重)、无标记/悬空依赖 → undefined、
  拓扑排序(乱序 seq/循环检测)、buildPlanPrompt 契约
- 注入链:plan 成功 → 3 计划任务 + autoReview = 5 任务,seq→taskId 依赖映射,
  注入任务带重试预算(maxAttempts=3)
- 兜底:plan 不可解析 → `plan_unparseable`;循环计划 → `plan_cyclic`

---

# 2. 交付内容

```text
src/application/pipeline.ts
├── parsePlan()          # PLAN_BEGIN/END + "N. [kind] desc (depends: N,...)" 约定格式
├── topologicalOrder()   # 依赖先行排序 + 环检测(planner 可信输出防御)
├── buildPlanPrompt()    # 统一计划格式契约
└── PipelineService      # 订阅 TASK_SUCCEEDED(kind=plan) → 注入任务链
                         #   防御性编排:test 无依赖时自动依赖全部 implement
                         #   autoReview:计划无 review 时追加终审(依赖全部任务)
src/mcp/orchestrator.ts  # cluster_create + mode: single | pipeline(默认 single)
plugin/commands/cluster.md  # 命令模板:非平凡任务默认 pipeline
src/e2e-pipeline.ts
```

---

# 3. 过程中的真实发现

1. **planner 输出不可控,防御性编排必要**(两次 E2E 实测):
   第一次 test 只依赖部分 implement;第二次完全没写依赖。系统层修正:
   `test 无依赖 → 自动依赖全部 implement`——计划语义的底线由编排器保证,
   而不是信任模型输出的完备性。与 Phase 3「注入任务必须带重试预算」同一原则:
   **动态注入的一切都要在系统层防御**。
2. 拓扑排序单遍创建(而非两遍建任务再连边):依赖只引用已创建任务,
   `createTask` 的 dependencies 参数即可表达,无需运行时 addDependency。
3. planner 的角色配额(quota=1)天然防止多个 plan 并发——无需额外互斥。

---

# 4. Phase 0–6 总览

| Phase | 交付 | 验证 |
|---|---|---|
| 0 | AgentExecutor 适配 | PoC |
| 1 | Task Core | 30 单测 + E2E |
| 2 | Agent Pool + lease | +10 + 并行 E2E |
| 3 | Artifact + Review Loop(动态 DAG) | +9 + 闭环 E2E |
| 4 | Git Worktree 隔离 + 冲突 + 恢复 | +7 + 双幕 E2E |
| 5 | Plugin(MCP/agents/commands) | +1 + /cluster 真实 run |
| 6 | **Pipeline Mode(planner 分解)** | **+7 + 流水线 E2E,共 64/64** |

复现:

```bash
cd zcode-repo && pnpm --filter zcac build
pnpm --filter zcac test                        # 64/64
node packages/zcac/dist/e2e-pipeline.cjs       # 真实 GLM 流水线
# ZCode 内:/cluster <task>(命令模板已默认 pipeline)
```

---

# 5. 下一步候选（v0.2 继续）

- **Supervisor 决策循环**:plan_unparseable / plan_cyclic / review_max_rounds /
  MERGE_CONFLICT 目前是终态 → 升级为决策(重规划/换角色/升级用户)。
- **worktree × pipeline 组合 E2E**:pipeline 模式下 implement×N 各自 worktree、
  PASS 后统一 mergeRun(两个能力都已各自验证,组合场景待实测)。
- **AIMD 接入**:429 信号喂调度层(ZCode ConcurrencyController 可直接嵌入)。
- **ProtocolExecutor**:worker 换 app-server 子进程,崩溃隔离。
