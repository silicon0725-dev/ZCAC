/**
 * ZCAC Application — 指数退避限流治理器。
 *
 *   连续限流信号 → cooldown = base × 2^n(封顶 max)
 *   每个成功任务  → cooldown 减半(最低归零,恢复吞吐)
 *
 * 限流信号识别覆盖实测出现过的错误形态:
 *   GLM: [1302]速率限制 / [1310]每周月使用上限 / HTTP 429 / rate_limit_error
 * 以及 provider 透传 message 中的同义文本。
 */

import type {
  RateLimitGovernor,
  TaskFailureSignal,
} from "../ports/rate-governor.js";
import type { Clock } from "../ports/clock.js";

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /\b1302\b/,
  /\b1310\b/,
  /rate[_\s-]?limit/i,
  /速率限制/,
  /使用上限/,
  /too many requests/i,
  /account.*limit/i,
];

export function isRateLimitSignal(signal: TaskFailureSignal): boolean {
  const haystack = `${signal.code} ${signal.message}`;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(haystack));
}

export interface ExponentialBackoffGovernorOptions {
  /** 首次冷却时长(默认 15s)。 */
  baseCooldownMs?: number;
  /** 冷却封顶(默认 5 分钟)。 */
  maxCooldownMs?: number;
  /** 注入时钟(测试);默认 Date.now。 */
  clock?: Clock;
}

export class ExponentialBackoffGovernor implements RateLimitGovernor {
  readonly #baseCooldownMs: number;
  readonly #maxCooldownMs: number;
  readonly #now: () => number;
  #consecutiveLimitHits = 0;
  #cooldownUntil = 0;

  constructor(options: ExponentialBackoffGovernorOptions = {}) {
    this.#baseCooldownMs = options.baseCooldownMs ?? 15_000;
    this.#maxCooldownMs = options.maxCooldownMs ?? 5 * 60_000;
    this.#now = options.clock ? () => options.clock!.now() : () => Date.now();
  }

  noteTaskFailure(signal: TaskFailureSignal): boolean {
    if (!isRateLimitSignal(signal)) return false;
    this.#consecutiveLimitHits += 1;
    const growth = Math.min(
      this.#consecutiveLimitHits - 1,
      Math.ceil(Math.log2(this.#maxCooldownMs / this.#baseCooldownMs)) + 1,
    );
    const cooldown = Math.min(
      this.#baseCooldownMs * 2 ** growth,
      this.#maxCooldownMs,
    );
    // 冷却从"当前冷却结束或现在"的较晚者起算,信号叠加不缩短既有冷却。
    this.#cooldownUntil = Math.max(this.#cooldownUntil, this.#now() + cooldown);
    return true;
  }

  noteTaskSuccess(): void {
    this.#consecutiveLimitHits = 0;
    const remaining = this.#cooldownUntil - this.#now();
    if (remaining <= 0) {
      this.#cooldownUntil = 0;
      return;
    }
    // 成功即恢复一半:吞吐回升优先于保守
    this.#cooldownUntil = this.#now() + Math.floor(remaining / 2);
  }

  canLaunch(now: number): boolean {
    return now >= this.#cooldownUntil;
  }

  cooldownUntil(): number {
    return this.#cooldownUntil;
  }
}
