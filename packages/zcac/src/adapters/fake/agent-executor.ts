/**
 * ZCAC Adapter — FakeExecutor(测试专用)。
 *
 * 供单元测试与 MCP 编排器的测试钩子(ZCAC_TEST_FAKE=1)使用,
 * 不发起任何真实模型调用。
 */

import type {
  AgentExecutor,
  AgentHandle,
  AgentLaunchRequest,
  AgentResult,
} from "../../ports/agent-executor.js";

export class FakeExecutor implements AgentExecutor {
  readonly launches: AgentLaunchRequest[] = [];
  readonly #deferreds = new Map<
    string,
    { resolve: (result: AgentResult) => void; promise: Promise<AgentResult> }
  >();
  #counter = 0;

  async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const agentId = `fake-${String(++this.#counter).padStart(2, "0")}`;
    this.launches.push(request);
    let resolve!: (result: AgentResult) => void;
    const promise = new Promise<AgentResult>((res) => {
      resolve = res;
    });
    this.#deferreds.set(agentId, { resolve, promise });
    return {
      agentId,
      role: request.role,
      sessionId: `sess-${agentId}`,
      model: request.model ?? "fake/model",
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  async send(): Promise<void> {}

  async wait(handle: AgentHandle): Promise<AgentResult> {
    const deferred = this.#deferreds.get(handle.agentId);
    if (!deferred) throw new Error(`FakeExecutor: unknown handle ${handle.agentId}`);
    return deferred.promise;
  }

  async stop(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const deferred of this.#deferreds.values()) {
      deferred.resolve(fakeResult("fake", "cancelled", "disposed"));
    }
    this.#deferreds.clear();
  }

  complete(agentId: string, response = "done"): void {
    this.#deferreds.get(agentId)?.resolve(fakeResult(agentId, "completed", undefined, response));
  }

  fail(agentId: string, error = "boom"): void {
    this.#deferreds.get(agentId)?.resolve(fakeResult(agentId, "failed", error));
  }

  agentIdOfLaunch(n: number): string {
    return `fake-${String(n).padStart(2, "0")}`;
  }
}

/** launch 后自动成功(延迟可选):MCP 端到端测试钩子。 */
export class AutoFakeExecutor extends FakeExecutor {
  readonly #autoCompleteMs: number;

  constructor(autoCompleteMs = 50) {
    super();
    this.#autoCompleteMs = autoCompleteMs;
  }

  override async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const handle = await super.launch(request);
    const timer = setTimeout(() => {
      this.complete(handle.agentId, `auto-completed: ${request.prompt.slice(0, 60)}`);
    }, this.#autoCompleteMs);
    timer.unref?.();
    return handle;
  }
}

function fakeResult(
  agentId: string,
  status: AgentResult["status"],
  error?: string,
  response = "",
): AgentResult {
  return {
    status,
    agentId,
    role: "coder",
    sessionId: `sess-${agentId}`,
    model: "fake/model",
    response,
    durationMs: 1,
    ...(error ? { error } : {}),
    usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
  };
}
