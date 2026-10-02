/**
 * ZCAC Ports — 调度层限流退避(Rate Limit Governor)。
 *
 * 职责边界(v0.1 §17 两层并发控制的 ZCAC 侧):
 *   ZCode runtime 内部重试管"单次模型请求";
 *   Governor 管"何时允许启动新任务"——检测到限流信号(429/1302/1310)
 *   后暂停新 claim,在飞任务自然完成,冷却窗口过后恢复。
 */

export interface TaskFailureSignal {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RateLimitGovernor {
  /** 任务失败上报;返回是否被识别为限流信号(并触发冷却升级)。 */
  noteTaskFailure(signal: TaskFailureSignal): boolean;

  /** 任务成功上报(冷却衰减)。 */
  noteTaskSuccess(): void;

  /** 当前时刻是否允许启动新任务。 */
  canLaunch(now: number): boolean;

  /** 当前冷却截止时间戳(已过冷却则 <= now);观察用。 */
  cooldownUntil(): number;
}
