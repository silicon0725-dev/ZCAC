/**
 * ZCAC Phase 13 — ProtocolExecutor 真实 zcode 子进程冒烟(P0-4 硬门槛)。
 *
 * 用真的 `zcode.cjs app-server --stdio` 跑一个 hello 级任务:
 *   spawn → session/create(含 workspaceKey + runtimePreferences 应答)
 *         → session/send → TurnComplete → 文件真实创建
 *
 * 需要: ZCODE_CLI_BUNDLE 指向 zcode.cjs(默认推断 monorepo 路径)
 * 耗时: ~1-2 分钟(真实 GLM 调用)
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProtocolAgentExecutor } from "../src/adapters/protocol/agent-executor.js";

/** 冒烟入口显式解析 bundle 路径(本文件位于 dist/tests → 上 3 层 = repo 根)。 */
function bundlePath(): string {
  const entry = resolve(process.argv[1] ?? "");
  return resolve(entry, "../../../../..", "apps/zcode-cli/packages/cli/dist/zcode.cjs");
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "zcac-proto-smoke-"));
  const bundle = bundlePath();
  console.log(`[smoke] bundle: ${bundle}`);
  const executor = new ProtocolAgentExecutor({
    env: process.env,
    cliBundlePath: bundle,
    taskTimeoutMs: 300_000,
  });

  let pass = false;
  try {
    console.log(`[smoke] sandbox: ${sandbox}`);
    const handle = await executor.launch({
      role: "coder",
      prompt: [
        "Create a file named hello-protocol.txt in the current working directory,",
        "containing exactly one line: protocol smoke works",
        "Then read it back to verify.",
        "End your reply with: SMOKE_OK",
      ].join("\n"),
      workingDirectory: sandbox,
      ...(process.env.ZCAC_MODEL ? { model: process.env.ZCAC_MODEL } : {}),
    });
    console.log(`[smoke] launched: ${handle.agentId} session=${handle.sessionId}`);

    const result = await executor.wait(handle);
    console.log(`[smoke] status: ${result.status}`);
    console.log(`[smoke] response: ${result.response.slice(0, 300)}`);
    if (result.error) console.log(`[smoke] error: ${result.error.slice(0, 200)}`);

    const content = await readFile(join(sandbox, "hello-protocol.txt"), "utf8").catch(() => undefined);
    console.log(`[smoke] hello-protocol.txt: ${JSON.stringify(content)}`);

    pass = result.status === "completed" && content !== undefined && content.includes("protocol smoke works");

    // ---- 第二个任务:同 workspace 复用 session(events 游标 + 池复用验证) ----
    console.log("[smoke] task 2: same-workspace session reuse");
    const handle2 = await executor.launch({
      role: "coder",
      prompt: [
        "Create a file named second-task.txt in the current working directory,",
        "containing exactly one line: session reuse works",
        "End your reply with: TASK2_OK",
      ].join("\n"),
      workingDirectory: sandbox,
      ...(process.env.ZCAC_MODEL ? { model: process.env.ZCAC_MODEL } : {}),
    });
    const result2 = await executor.wait(handle2);
    console.log(`[smoke] task2 status: ${result2.status} session=${handle2.sessionId}`);
    console.log(`[smoke] task2 response: ${(result2.response || result2.error || "").slice(0, 300)}`);
    const content2 = await readFile(join(sandbox, "second-task.txt"), "utf8").catch(() => undefined);
    console.log(`[smoke] second-task.txt: ${JSON.stringify(content2)}`);
    const sameSession = handle2.sessionId === handle.sessionId;
    console.log(`[smoke] session reuse: ${sameSession} (${handle.sessionId.slice(0, 16)}...)`);
    pass =
      pass &&
      result2.status === "completed" &&
      content2 !== undefined &&
      content2.includes("session reuse works") &&
      sameSession;

    console.log(pass ? "[smoke] PASS ✅" : "[smoke] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } catch (error) {
    console.error("[smoke] fatal:", error);
    process.exitCode = 1;
  } finally {
    await executor.dispose().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

void main();
