# ZCAC Phase 9 — 调度层限流退避实现记录

**对应任务：** P0 第一项("敢日常用"的关键缺陷)/v0.1 §17 两层并发控制的 ZCAC 侧补全
**日期：** 2026-10-02
**结果：** ✅ 单测 75/75;真实 GLM pipeline E2E PASS 且墙钟 326–877s → **106.7s**
**代码：** `zcode-repo/packages/zcac/`（ports/rate-governor.ts + application/rate-governor.ts）

---

# 1. 交付:RateLimitGovernor(调度层 admission control)

```text
任务失败 → isRateLimitSignal?(429 / 1302 / 1310 / rate limit / 速率限制 / 使用上限 / too many requests)
  是 → 冷却 = base × 2^n(连续命中,封顶 max;信号叠加不缩短既有冷却)
       冷却中 claimAndLaunch 暂停(在飞任务自然完成,不被打断)
  成功任务 → 冷却减半(吞吐回升优先于保守)

ExponentialBackoffGovernor(默认 base 15s / max 5min,Clock 注入可测)
build 默认装配(governorBaseCooldownMs: 0 关闭)
drain 集成:冷却与 retry 到期统一作为唤醒点;ready-but-cooling 睡待不忙转
```

边界遵守:core/application 无 `@zcode/*`(没有重新实现 Provider 层 AIMD——
那层在 ZCode runtime 内部已存在;本层只管"何时允许启动新任务")。

## 效果(真实 GLM 实测)

| 场景 | 之前 | 本阶段 |
|---|---|---|
| pipeline E2E(同类任务)墙钟 | 326s / 398s / 877s | **106.7s** |
| 限流耗尽重试 → run failed | Phase 7 真实发生过 | 冷却门禁 + 预算内重试 |

## 单测(75/75,新增 5)

- 信号识别:四种实测错误形态全命中;普通失败不误伤(boom 500 等)
- 退避:base→×2→×4→封顶;成功减半;时钟注入精确断言
- 非限流失败不触发冷却
- **调度集成**:并行两任务,A 限流失败 → 冷却门禁(3s)→ B 正常完成 →
  冷却过后 A 重试 claim → 第二次成功(attempt=2)→ run completed

---

# 2. 过程笔记

1. 测试期望"限流自动恢复"必须给任务重试预算——默认 maxAttempts=1 下
   限流失败直接终态(governor 只管启动时机,重试仍由 RetryPolicy 决定,
   两层各司其职)。
2. drain 的 ready-but-cooling 分支若只 continue 会忙转——冷却结束时间
   与 retry 到期统一进唤醒点计算。
3. 集成测试里"重试后的 launch 必须被驱动",否则 wait 永挂——
   FakeExecutor 驱动式测试的老朋友了。

---

# 3. Phase 0–9 总览与"正常使用"进度

| 里程碑 | 状态 |
|---|---|
| v0.1 全部(Phase 0–5) | ✅ |
| v0.2: pipeline / worktree 组合 / Supervisor(6–8) | ✅ |
| **P0-1: AIMD/退避(本阶段)** | ✅ 墙钟降 ~3–8× |
| P0-2: 真实仓库 10 任务压力测试 | ⏳ 下一步 |
| P1: 长跑内存验证 + kill 恢复真实演练 + README | ⏳ |
| P2: 插件打包分发 | ⏳ |

复现:

```bash
cd zcode-repo && pnpm --filter zcac build && pnpm --filter zcac test   # 75/75
node packages/zcac/dist/e2e-pipeline.cjs                               # 真实 GLM
```
