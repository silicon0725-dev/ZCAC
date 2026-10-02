/**
 * ZCAC-0001 — RetryPolicy (domain)
 *
 * Phase 1 最小实现:attempt < maxAttempts 且 error.retryable 即重试。
 * 指数退避 / AIMD / 429 配额感知留给 Scheduler v2 (Phase 2+)。
 */

export type RetryCondition = "retryable_error" | "interrupted" | "timeout";

export interface RetryPolicy {
  /** 最大执行次数(含首次),即 attempt 上限。 */
  maxAttempts: number;
  /** 两次执行之间的基础等待(ms)。Phase 1 固定等待,不做指数退避。 */
  backoffMs: number;
  maxBackoffMs?: number;
  retryOn?: readonly RetryCondition[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: 5_000,
  retryOn: ["retryable_error", "interrupted"],
};

export function shouldRetry(
  attempt: number,
  policy: RetryPolicy,
  error: { retryable: boolean; condition?: RetryCondition },
): boolean {
  if (!error.retryable) return false;
  if (attempt >= policy.maxAttempts) return false;
  if (error.condition !== undefined && policy.retryOn && policy.retryOn.length > 0) {
    return policy.retryOn.includes(error.condition);
  }
  return true;
}
