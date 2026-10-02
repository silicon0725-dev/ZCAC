# ZCAC Phase 11 — P1 记录(kill 恢复 + 内存 + README)

**对应任务：** P1(长跑内存验证 + kill 恢复真实演练 + README)
**日期：** 2026-10-02
**结果：** ✅ kill 恢复 PASS(修复一个真实缺陷);内存 ✅ 无泄漏;README 完成
**代码：** `zcode-repo/packages/zcac/`(src/p1-drill.ts + pipeline.ts 修复 + plugin/README.md)

---

# 1. Kill 恢复真实演练(真实 GLM)

```text
1. 启动 pipeline run(calc.js 加 subtract+multiply,lease=30s)
2. 等 plan 完成 + implement 开始执行
3. 模拟崩溃:直接关库杀进程(不走优雅关闭)
4. 等 35s(lease 过期)
5. 新进程重开同一 SQLite → Recovery → resume drain

结果(修复后):
✅ recovery: requeued=1 failed=0
✅ plan NOT re-executed(attempt=1 不变,completed task immutable)
✅ run completed(implement 重跑一次 attempt=2,最终全链通过)
✅ calc.js subtract=true multiply=true(真实产物)
```

## 修复的真实缺陷

**`PIPELINE_RETRY_POLICY` 的 `retryOn` 缺少 `"interrupted"`**:
Pipeline 动态注入的任务(implement/test/review/fix)默认重试策略只允许
`"retryable_error"`,不含 `"interrupted"` → 崩溃恢复时被判不可重试 →
直接终态 failed 而非 requeue。修复:加入 `"interrupted"`。

这是 Phase 3 教训("注入任务必须有重试预算")的延伸:
**注入任务的重试策略必须覆盖所有预期恢复路径(含崩溃)。**

---

# 2. 长跑内存监控(5 连续真实 GLM 任务)

| Run | heapUsed | RSS |
|---|---|---|
| 1 | 156.0 MB | 246.3 MB |
| 2 | 155.6 MB | 246.5 MB |
| 3 | 155.7 MB | 246.9 MB |
| 4 | 156.5 MB | 247.4 MB |
| 5 | 157.0 MB | 248.3 MB |

```text
heap growth over 5 runs: +1.0 MB(每 run +0.25 MB)
rss  growth over 5 runs: +2.0 MB
→ ✅ no significant leak(wait-dispose 修复有效)
```

基线 ~155MB(编排器 + 内置 ZCode runtime 库的惰性加载);每任务增量可忽略。

---

# 3. README

已写入 `plugin/README.md`(~200 行):安装(inline 插件注册)、快速开始
(/cluster 命令 + MCP 工具表)、架构图 + 关键设计决策表、代码布局、
测试命令(75 单测 + 7 个 E2E)、故障排查表(7 种已知症状)、卸载、已知限制。

---

# 4. Phase 0–11 全景与可用性进度

| 里程碑 | 状态 |
|---|---|
| v0.1 全部(Phase 0–5) | ✅ |
| v0.2: pipeline / worktree / supervisor / rate-limit / 压测(6–10) | ✅ |
| **P1: kill 恢复 + 内存 + README(本阶段)** | ✅ |
| P2: 插件打包分发 | ⏳ |

**"好用"判定:通过。** 日常使用所需的全部能力已验证:
创建 → 并行执行 → 隔离 → 审查 → 冲突处理 → 崩溃恢复 → 内存稳定 → 文档。

复现:

```bash
cd zcode-repo && pnpm --filter zcac build
node --expose-gc packages/zcac/dist/p1-drill.cjs    # kill + 内存(~8min)
pnpm --filter zcac test                              # 75/75
```
