/**
 * ZCAC-0002 — Task Graph 校验结果类型 (domain)。
 */

import type { TaskId } from "../task/task.js";

export interface GraphIssue {
  code:
    | "cycle"
    | "missing_dependency"
    | "self_dependency"
    | "cross_run_dependency"
    | "orphan_task";
  message: string;
  taskId?: TaskId;
  dependencyId?: TaskId;
  /** 仅 cycle:构成环的路径。 */
  path?: TaskId[];
}

export interface GraphValidationResult {
  ok: boolean;
  issues: readonly GraphIssue[];
}
