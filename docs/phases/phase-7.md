# ZCAC Phase 7 — Worktree × Pipeline 组合实现记录

**对应规范：** 《ZCAC Phase 7 Worktree×Pipeline 规范》
**日期：** 2026-10-02
**结果：** ✅ 单测 66/66;组合 E2E 9/9(真实 GLM,含 ReviewLoop 真实触发);Phase 4 E2E 迁移新语义后 PASS
**代码：** `zcode-repo/packages/zcac/`

---

# 1. 组合缺陷与修复

**缺陷**:worktree 模式下 implement 产物停留在各 worktree 分支,
pipeline 下游 test/review 在主区看不到成果——依赖语义断裂。

**设计决策:implement 成功即 commit + merge**(写入过程仍隔离,合并时点提前):

```text
implement@worktree → commit → merge 进主分支(立即)
   ├─ merged/noop → TASK_SUCCEEDED(下游主区可见)
   └─ conflict    → TASK_FAILED(merge_conflict,不可重试,分支保留,主区干净)
```

与 v0.1 §28「Review PASS → merge」的偏离正式记录:合并时点=任务成功时点。
mergeRun 降级为崩溃恢复兜底(已合并分支返回空)。

## 组合 E2E(真实 GLM,9/9)

```text
implement(coder,独立 worktree)→ 成功即 commit+merge → 主分支含 zcac 提交
  → test(tester,主区: greet.js 已可见,真实 node 执行验证)
  → review → [真实触发 ReviewLoop: FAIL → fix 注入 → re-review PASS]
  → RUN_COMPLETED(5 任务,111,971 tokens)

✓ implement ran in worktree and merged on success
✓ only write-role tasks (implement/fix) got worktrees
✓ main branch contains zcac implement commit
✓ greet.js merged into main workspace / test worked against merged main
✓ final review PASS
✓ implement merged before test started ← 组合缺陷修复的直接时序证据
```

---

# 2. 过程中发现并修复的三个真实缺陷

1. **并行 git 写操作竞争**(index.lock):两个 implement 同时 commit+merge 到同一
   主仓库,后者异常进 executor_error。修复:WorktreeService 的全部 git 写操作
   (create/commit+merge/abandon)走**进程内串行队列**(promise 链)。
2. **worker app 内存泄漏 → OOM**:完成的 worker `createZCodeApp` 实例从不释放
   (active Map 持有),3 个任务即触宿主 OOM——对常驻的插件编排器进程是必然泄漏。
   修复:`wait` 一次性语义,turn 结束即 `dispose(handle)` 释放该 worker 的 app。
3. **注入任务路径漂移**:pipeline 注入的 implement 描述无目录约束,真实 GLM
   把文件写到主仓库而非 worktree(worktree 无变更 → commit empty → 伪成功)。
   修复:注入 prompt 统一加前缀
   "Work strictly inside the current working directory; use relative paths only."

## 限流环境的断言哲学(Phase 4 E2E 迁移)

act2(同文件冲突)在真实环境有**三条合法路径**:(a) 任务级 merge_conflict;
(b) retry 后 worktree 基线前移(含首个提交)→ 冲突自然消解;(c) 限流耗尽重试
→ 普通失败。任务级冲突语义由**单测确定性覆盖**(FakeExecutor 并行双 implement
同文件 → 后者 merge_conflict 不可重试、主区干净、冲突分支保留);
E2E 只断言**系统不变量**:任意路径下主区必须干净、run 到达一致终态、
失败任务有明确 error code。本轮实测恰好走了路径 (a),全部成立。

---

# 3. 交付清单

```text
worktree-service.ts   # +commitAndMergeTask;#mergeOne 抽取;git 串行队列
scheduler.ts          # 成功路径:commit+merge 先于 complete;conflict → failTask
adapters/zcode/agent-executor.ts   # wait 后自动 dispose(修内存泄漏)
pipeline.ts           # 注入 prompt 目录约束前缀
tests/pipeline-worktree.test.ts    # 确定性组合单测(WritingFakeExecutor 真写文件)
tests/worktree.test.ts             # 成功即合并/mergeRun noop/任务级冲突(更新+新增)
src/e2e-pipeline-worktree.ts       # 真实 GLM 组合 E2E
src/e2e-worktree.ts                # 断言迁移到新语义(不变量化)
```

---

# 4. Phase 0–7 总览

| Phase | 交付 | 单测 |
|---|---|---|
| 0–5 | v0.1 主线(执行面→控制面→插件) | 57 |
| 6 | Pipeline Mode(planner 分解) | +7 |
| 7 | **worktree×pipeline 组合 + 三缺陷修复** | **+2,共 66/66** |

复现:

```bash
cd zcode-repo && pnpm --filter zcac build
pnpm --filter zcac test                              # 66/66
node packages/zcac/dist/e2e-pipeline-worktree.cjs    # 组合 E2E(真实 GLM)
node packages/zcac/dist/e2e-worktree.cjs             # 隔离/冲突 E2E(新语义)
```

---

# 5. v0.2 剩余候选

- **Supervisor 决策循环**:merge_conflict / review_max_rounds / plan_unparseable
  目前是终态 → 升级为决策(重试/换角色/重规划/升级用户)。
- **AIMD 接入**:429/1302 信号喂调度层(ZCode ConcurrencyController 可直接嵌入);
  本阶段再次实测限流是 E2E 时长的主要成分(158s 墙钟中大量退避)。
- **ProtocolExecutor**:worker 换 app-server 子进程,崩溃隔离(顺带解决
  单进程内存压力——wait 后 dispose 已缓解,多进程是根治)。
