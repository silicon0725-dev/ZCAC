# ZCAC Phase 3 — Artifact & Review Loop 实现记录

**对应任务：** ZCAC-0006（Artifact System）/ ZCAC-0007（Review Loop）
**日期：** 2026-10-02
**结果：** ✅ 单元测试 49/49；真实 GLM 动态 DAG 闭环 E2E 12/12 断言通过
**代码：** `zcode-repo/packages/zcac/`

---

# 1. E2E：动态 DAG 闭环（真实 GLM，v0.1 Spec §51 场景）

```text
Coder(写 alpha.txt,仅第一行)
  → Reviewer r1(规则:缺第二行必须 FAIL)      [真实判定 FAIL + finding]
    → ★ ReviewLoop 动态注入 ★
       Fix(coder,"补第二行",无依赖→立即可调度)
       Reviewer r2(依赖 fix,同一审查 prompt)
  → r2(文件已含两行 → PASS)
  → RUN_COMPLETED
```

```text
[e2e3] wall clock: 388.7s, total tokens: 67,708
✓ run.status == completed
✓ task count == 4 (dynamic injection)     ← 启动时只有 2 个任务
✓ 1 fix injected / 2 reviews total
✓ re-review depends on injected fix       ← 动态加边
✓ r1 FAIL verdict → r2 PASS verdict
✓ alpha.txt has both lines after fix      ← 修复真实生效
✓ fix injected after r1 verdict (事件序)
✓ artifacts per task (4) / 2 review artifacts / checksums intact
```

**这是 ZCAC 与 dwf 本质差异的第一次完整真实验证**：fix 与 re-review
在 run 启动时不存在，由 ReviewLoopService 在 r1 的 `TASK_SUCCEEDED` 事件
驱动下创建并注入运行时 Task Graph——dwf 的脚本图在提交后冻结，做不到这一点。

审查设计要点：两轮 review 使用**同一份 prompt**，结论由文件事实决定
（缺第二行 → 必然 FAIL；两行齐全 → 必然 PASS），不依赖轮次作弊。

---

# 2. 交付内容

## ZCAC-0006 — Artifact System

```text
domain/artifact/artifact.ts      # Artifact/ArtifactType/checksum(sha256 canonical JSON)
ports/artifact-repository.ts
adapters/sqlite/artifact-repository.ts   # zcac_artifacts 表
task-service.createArtifact()    # journal-first + ARTIFACT_CREATED
scheduler.#emitArtifact()        # 每个完成任务自动产出(kind→type 映射)
```

类型映射：`review→review`、`fix→patch`、`test→test_result`、`plan→plan`、其余 `report`。

## ZCAC-0007 — Review Loop

```text
application/review-loop.ts
├── parseReviewResult()      # REVIEW_VERDICT 行 + findings 列表(severity/file:line/message)
├── buildReviewPrompt()      # 统一结论格式约定(调用方与解析器共享)
├── buildFixPrompt()         # findings → fix 任务指令
└── ReviewLoopService        # 订阅 TASK_SUCCEEDED(review kind):
    PASS          → 不动作(run 聚合自然完成)
    FAIL + r<max  → 注入 Fix(coder) + Re-review(依赖 fix, round+1)
    FAIL + r≥max  → run failed(reason=review_max_rounds)
    verdict 不可解析 → run failed(reason=review_unparseable)
```

结构化提取 Phase 3 采用 response 约定格式（`REVIEW_VERDICT: PASS|FAIL` 终行 +
`- [severity] file:line message` 列表）；后续可替换为 zcac_submit_result 工具 +
JSON Schema（解析器是独立函数，替换面收敛在一处）。

## 新增测试（10 个，总计 49/49）

- 解析：verdict/findings 提取（含 file:line 拆分与裸词归 message）、无 verdict 报 undefined
- Artifact：checksum 持久化 + ARTIFACT_CREATED 事件、每完成任务自动产出
- Review Loop：PASS 无注入；**FAIL→fix+re-review 注入（含动态依赖边断言）**；
  maxRounds 耗尽 → `review_max_rounds`；verdict 不可解析 → `review_unparseable`

---

# 3. 过程中发现并修复的真实缺陷

1. **注入任务无重试预算**（第二次 E2E 失败的根因）：ReviewLoop 动态创建的
   fix/re-review 用了默认 `maxAttempts:1`，reviewer 被 429 限流打断后直接终态失败。
   修复：注入任务自带 `maxAttempts:2, backoffMs:15s`。真实教训——
   **动态注入的任务链必须显式声明重试预算**，默认值对限流环境过于脆弱。
2. **正则两处解析缺陷**：`g` 标志 lastIndex 跨行串扰；`alpha.txt:1` 的行号被
   file 组贪婪吞掉。最终规则：每行独立匹配；file 须含路径特征(`.`/`/`)且止于冒号。
3. **artifact 类型映射**：fix 的产物最初误归 "review"，改为 "patch"。

限流现实：388s 墙钟中相当比例是 429 退避（retry-after 3~6s 频繁出现）。
三层防线已就位：ZCode runtime 内部重试 → ZCAC 任务级 retry（本阶段补齐）→
角色 quota 限并发。v0.2 接 AIMD 后可把退避决策上移到调度层。

---

# 4. Phase 0–3 累计状态

| Phase | 交付 | 验证 |
|---|---|---|
| 0 | AgentExecutor 适配（createZCodeApp 组合） | PoC PASS |
| 1 | Task Core（domain/ports/sqlite/FIFO scheduler） | 30 单测 + E2E PASS |
| 2 | Agent Pool（role quota/slot）+ lease/heartbeat | +10 单测 + 双 Coder 并行 E2E |
| 3 | Artifact System + Review Loop（动态 DAG） | +9 单测 + 动态闭环 E2E |

复现：

```bash
cd zcode-repo && pnpm --filter zcac build
pnpm --filter zcac test                    # 49/49
node packages/zcac/dist/e2e-review.cjs     # 动态 DAG 闭环(真实 GLM)
```

---

# 5. 下一步（Phase 4 — Git Isolation，v0.1 Spec §54 Phase 6 / ZCAC-0008）

1. WorktreeManager：`git worktree add/remove`、worktree↔task 绑定、
   workspacePath 注入（Phase 0 已验证 workspaceKey 机制自动隔离状态）。
2. 合并流水线：PASS → merge 回主工作区；冲突 → Supervisor 流程。
3. 崩溃恢复 E2E（v0.1 Spec §52）：kill 后 resume，已完成任务不重跑
   （lease 语义 Phase 2 已就绪，Phase 4 补进程级验证）。
