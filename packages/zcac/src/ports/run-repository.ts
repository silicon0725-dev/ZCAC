/**
 * ZCAC Ports — Run 仓储。
 */

import type { Run } from "../domain/run/run.js";

export interface RunRepository {
  insert(run: Run): void;
  update(run: Run): void;
  get(runId: string): Run | undefined;
}
