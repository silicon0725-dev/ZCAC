/**
 * ZCAC Ports — Clock / 事务运行器。
 *
 * 注入时间与事务边界,保证 domain/application 可测试、
 * 且 journal-first 的提交顺序由唯一的事务原语承载。
 */

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** 测试用可控时钟:lease/heartbeat/backoff 的时间推进。 */
export class FakeClock implements Clock {
  #now: number;
  readonly advanced: number[] = [];

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
    this.advanced.push(ms);
  }
}

/** 同步事务:fn 内的所有仓储写操作要么全部提交,要么全部回滚。 */
export interface TransactionRunner {
  run<T>(fn: () => T): T;
  /** 当前是否已处于事务内(嵌套复用判定;journal-first 守卫用)。 */
  readonly inTransaction: boolean;
}
