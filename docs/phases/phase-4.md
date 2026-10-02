# ZCAC Phase 4 — Git Worktree 隔离实现记录

**对应任务：** ZCAC-0008（Git Isolation）+ v0.1 Spec §52（崩溃恢复）/ §53（第五阶段 E2E）
**日期：** 2026-10-02
**结果：** ✅ 单元测试 56/56；真实 GLM worktree E2E 15/15 断言通过；Phase 1 E2E 回归通过
**代码：** `zcode-repo/packages/zcac/`

---

# 1. E2E：双 Coder worktree 隔离 + 冲突检测（真实 GLM，§53 场景）

## 幕一：隔离写入 + 干净合并

```text
repo(temp git init, 含 same.txt)
Coder A → <repo外>/.zcac-worktrees-repo/<taskA>/ 写 alpha.txt ┐
Coder B → <repo外>/.zcac-worktrees-repo/<taskB>/ 写 beta.txt  ┘ 互不可见
drain → 双双 commit(带 SHA) → mergeRun → 主分支同时含 alpha/beta,git status 干净
```

✓ run completed ✓ two committed worktrees ✓ distinct paths ✓ commits have sha
✓ both merged ✓ main has alpha+beta ✓ **main tree clean**

## 幕二：同文件冲突（§53 冲突验证）

```text
Coder X → worktree: same.txt = "resolved by X"
Coder Y → worktree: same.txt = "resolved by Y"
mergeRun → 第一个 merged;第二个 MERGE_CONFLICT:
  conflictFiles=["same.txt"],主区 git merge --abort 保持 clean,内容保留 X 版本
```

✓ one merged + one conflict ✓ conflict file reported ✓ **main tree clean after abort**
✓ main keeps first merge's version
✓ 事件:WORKTREE_CREATED ≥4 / MERGE_COMPLETED ×3 / MERGE_CONFLICT ×1

冲突语义(规范 §17:「Conflict Agent 不应该盲目覆盖」):冲突分支**保留**、
主区回滚干净、事件带 conflictFiles——这是 Supervisor/Integrator 决策的输入。

---

# 2. 交付内容

```text
domain/worktree/worktree.ts        # Worktree + 状态机 created→committed→merged|conflict|abandoned
domain/event/event-types.ts        # +WORKTREE_CREATED/REMOVED, MERGE_STARTED/COMPLETED/CONFLICT
ports/worktree-repository.ts
adapters/sqlite/worktree-repository.ts   # zcac_worktrees 表
adapters/git/worktree-manager.ts   # 纯 git 层:worktree add/commit/diff/merge/冲突 abort/remove
application/worktree-service.ts    # 生命周期编排 + journal-first 事件
scheduler #execute                 # isolation=worktree 时写入型角色(role∈isolationRoles)绑 worktree:
                                   #   claim→create → launch(worktree.path) → 成功 commit / 失败 abandon
build.ts                           # isolation 配置(默认 "shared",v0.1 §30);repoRoot 自动探测
```

关键实现决策:
- **worktree 默认放仓库外**(`<repo 同级>/.zcac-worktrees-<repo名>`):不污染主仓库
  git status、无需 .gitignore——单测里主区 clean 断言倒逼出来的正确设计。
- **失败/重试即清理**:任务失败或限流重试时 worktree abandon(目录+分支删除),
  重新 claim 时建新 worktree——DB 保留历史记录(abandoned)供审计。
- **journal-first 修正**:worktree 事件最初在嵌套事务内 publish(commit 前),
  重构为「事务内 appendEvent + commit 后 publish」,并加事务外调用守卫。

## 新增测试(7 个,总计 56/56)

- 真实 git:双 worktree 隔离性(A 的未合并变更 B/主区不可见)、无冲突合并、
  **冲突检测+conflictFiles+abort 后主区干净**、空提交、清理
- Scheduler 集成:双 coder 各自 worktree 路径执行+commit+mergeRun 主分支可见;
  失败任务 worktree abandoned+WORKTREE_REMOVED;reviewer(只读角色)不建 worktree
- **§52 崩溃恢复(run 级)**:A 成功后 B 执行中"进程崩溃"(直接关库)→ 新实例
  loadRun+recover(lease 过期)→ resume drain → **A 保持 succeeded 不重跑
  (attempt=1),第二个 executor 只见过 B**

---

# 3. 过程中的真实发现

1. **限流下的重试改变工件计数**:真实 E2E 中 1302 速率限制频繁触发任务级 retry,
   每次重试产生新的 WORKTREE_CREATED/REMOVED 对与 abandoned 记录——断言必须
   按 status 过滤/下限计数。这是多 Agent 真实环境的常态,不是噪声。
2. **后台任务会被会话清理杀死**:两次 E2E 进程在中途被终止(非代码问题);
   长跑验证需前台执行。E2E 任务的 retryPolicy(maxAttempts=3, backoff=20s)
   是限流环境的必需品——再次验证 Phase 3 的教训。
3. **Windows autocrlf**:git 检出内容为 CRLF,文件断言需 trim 比较。
4. **遗留句柄**:被遗弃的 drain(崩溃模拟)的 sleep 定时器与 heartbeat interval
   会拖住进程退出——两者加 unref(产品路径无影响)。

---

# 4. Phase 0–4 累计状态

| Phase | 交付 | 验证 |
|---|---|---|
| 0 | AgentExecutor 适配 | PoC PASS |
| 1 | Task Core(domain/ports/sqlite/FIFO) | 30 单测 + E2E |
| 2 | Agent Pool + lease/heartbeat | +10 单测 + 双 Coder 并行 E2E |
| 3 | Artifact + Review Loop(动态 DAG) | +9 单测 + 动态闭环 E2E |
| 4 | Git Worktree 隔离 + 冲突 + 崩溃恢复 | +7 单测 + 双幕 E2E + §52 恢复 |

v0.1 Definition of Done(实现规范 §61)对照:任务图/并行/依赖调度/Artifact/
Review→动态 Fix/Lease/崩溃恢复不重跑/Worktree 隔离/合并/冲突进事件流——
**全部具备并经真实 GLM 验证**。剩余:Plugin 包装(Phase 8,§38/.zcode-plugin/
.mcp.json/agents/commands/skills)与 zcluster 入口。

复现:

```bash
cd zcode-repo && pnpm --filter zcac build
pnpm --filter zcac test                      # 56/56
node packages/zcac/dist/e2e-worktree.cjs     # 隔离+合并+冲突(真实 GLM)
```

---

# 5. 下一步（Phase 5 — Plugin 包装，v0.1 Spec §54 Phase 8 / §38-§40）

1. `zcode-agent-cluster/` 插件目录:plugin.json + .mcp.json(stdio 编排器)+ agents/
   (五角色 profile)+ commands/(/cluster /cluster-status /cluster-stop)+ skills/。
2. MCP server 暴露 cluster_create/status/task_list 等(实现规范 §39 最小 API);
   编排器进程 = 现有 buildZcac 组合的 MCP 壳。
3. 端到端:在 ZCode 内 /cluster 触发一次真实 run。
