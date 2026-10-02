/**
 * ZCAC Phase 0 PoC (实现规范 §54 Phase 0 验收):
 *
 *   Node script → launch coder → prompt → result
 *
 * 验证链路: ZCAC AgentExecutor → createZCodeApp → AgentRuntime → GLM → 工具执行 → TurnResult
 * 通过条件: coder agent 在沙箱目录中真实创建 hello.txt 且内容正确。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSelection } from "@zcode/contracts";
import { ZCodeAgentExecutor } from "./adapters/zcode/agent-executor.js";

const LINE = "hello from zcac";

/** --model providerId/modelId 或 ZCAC_MODEL;缺省继承 ZCode 默认模型。 */
function parseModelOverride(): ModelSelection | undefined {
  const raw =
    process.env.ZCAC_MODEL ??
    process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length);
  if (!raw) return undefined;
  // 格式: providerId/modelId 或 providerId/modelId@reasoningLevel (low|high|max)
  const [ids, level] = raw.split("@");
  const [providerId, modelId] = (ids ?? "").split("/");
  if (!providerId || !modelId) {
    throw new Error(`--model must look like providerId/modelId[@level], got: ${raw}`);
  }
  return {
    providerId,
    modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

async function main(): Promise<void> {
  const sandbox = join(tmpdir(), `zcac-poc-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });

  const executor = new ZCodeAgentExecutor({ env: process.env });
  const modelOverride = parseModelOverride();
  if (modelOverride) {
    console.log(`[poc] model override: ${modelOverride.providerId}/${modelOverride.modelId}`);
  }
  try {
    console.log(`[poc] sandbox: ${sandbox}`);
    const handle = await executor.launch({
      role: "coder",
      description: "Phase 0 PoC: create and verify hello.txt",
      workingDirectory: sandbox,
      ...(modelOverride ? { modelSelection: modelOverride } : {}),
      prompt: [
        "Create a file named hello.txt in the current working directory.",
        `It must contain exactly this single line: ${LINE}`,
        "Then read the file back to verify, and end your reply with exactly:",
        `POC_OK <the file content you read>`,
      ].join("\n"),
    });
    console.log(`[poc] launched  : ${handle.agentId} (session ${handle.sessionId})`);
    console.log(`[poc] model     : ${handle.model}`);

    const result = await executor.wait(handle);
    console.log(`[poc] status    : ${result.status}`);
    console.log(`[poc] duration  : ${result.durationMs} ms`);
    console.log(`[poc] usage     : ${JSON.stringify(result.usage ?? null)}`);
    console.log(`[poc] response  :\n${indent(result.response)}`);
    if (result.error) {
      console.log(`[poc] error     : ${result.error}`);
    }

    let fileContent: string | undefined;
    try {
      fileContent = await readFile(join(sandbox, "hello.txt"), "utf8");
      console.log(`[poc] hello.txt : ${JSON.stringify(fileContent)}`);
    } catch {
      console.log(`[poc] hello.txt : <missing>`);
    }

    const pass =
      result.status === "completed" &&
      fileContent !== undefined &&
      fileContent.includes(LINE);
    console.log(pass ? "[poc] PASS ✅" : "[poc] FAIL ❌");
    process.exitCode = pass ? 0 : 1;
  } finally {
    await executor.dispose();
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

main().catch((error: unknown) => {
  console.error("[poc] fatal:", error);
  process.exitCode = 1;
});
