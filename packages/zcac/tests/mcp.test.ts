/**
 * ZCAC Phase 5 — MCP orchestrator 端到端测试。
 *
 * spawn 插件的 orchestrator.cjs(ZCAC_TEST_FAKE=1,AutoFakeExecutor,
 * 无真实模型调用),用 MCP client SDK 走完整 stdio 协议:
 * 握手 → listTools → cluster_create → 轮询 cluster_status →
 * task_list / artifact_list / events。
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ORCHESTRATOR = resolve(import.meta.dirname, "../../plugin/dist/orchestrator.cjs");

interface ToolPayload {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as ToolPayload;
  const text = result.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (result.isError) {
    throw new Error(`tool ${name} error: ${text}`);
  }
  return parsed;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("mcp orchestrator (stdio, full protocol)", () => {
  it("handshake, listTools, create → complete → inspect", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "zcac-mcp-"));
    let child: ChildProcess | undefined;
    const client = new Client({ name: "zcac-test-client", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ORCHESTRATOR],
      env: {
        ...process.env,
        ZCAC_TEST_FAKE: "1",
        ZCAC_DATA_DIR: dataDir,
        ZCAC_WORKSPACE: dataDir,
      },
    });
    try {
    await client.connect(transport);
    child = (transport as unknown as { _process: ChildProcess })._process;

    // 1) 工具清单
    const tools = (await client.listTools()) as { tools: Array<{ name: string }> };
    const names = tools.tools.map((tool) => tool.name);
    for (const expected of [
      "cluster_create",
      "cluster_status",
      "cluster_stop",
      "task_list",
      "artifact_list",
      "events",
    ]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }

    // 2) 创建 run(后台)
    const created = await callTool(client, "cluster_create", {
      task: "create hello.txt with one line: hello from mcp",
    });
    const runId = created.runId as string;
    const taskId = created.taskId as string;
    assert.ok(typeof runId === "string" && runId.startsWith("run_"));
    assert.equal(created.status, "started");

    // 3) 轮询到完成(AutoFake 50ms 完成)
    let statusPayload: Record<string, unknown> = {};
    await waitFor(() => {
      void callTool(client, "cluster_status", { runId })
        .then((payload) => {
          statusPayload = payload;
        })
        .catch(() => undefined);
      const runs = statusPayload.runs as Array<{ status?: string }> | undefined;
      return runs?.[0]?.status === "completed";
    });
    assert.equal(
      (statusPayload.runs as Array<{ status: string }>)[0]!.status,
      "completed",
    );

    // 4) task_list:单任务 succeeded
    const tasks = await callTool(client, "task_list", { runId });
    const taskRows = tasks.tasks as Array<{ taskId: string; status: string; attempt: number }>;
    assert.equal(taskRows.length, 1);
    assert.equal(taskRows[0]!.taskId, taskId);
    assert.equal(taskRows[0]!.status, "succeeded");
    assert.equal(taskRows[0]!.attempt, 1);

    // 5) artifact_list:每任务一个
    const artifacts = await callTool(client, "artifact_list", { runId });
    const artifactRows = artifacts.artifacts as Array<{ type: string; checksum: string }>;
    assert.equal(artifactRows.length, 1);
    assert.match(artifactRows[0]!.checksum, /^[0-9a-f]{64}$/);

    // 6) events:游标 replay
    const all = await callTool(client, "events", { runId });
    const sequences = (all.events as Array<{ sequence: number }>).map((e) => e.sequence);
    assert.deepEqual(
      sequences.every((seq, i) => i === 0 || seq === sequences[i - 1]! + 1),
      true,
    );
    const tail = await callTool(client, "events", { runId, afterSequence: sequences.length - 2 });
    assert.equal((tail.events as unknown[]).length, 2);
    } finally {
      await client.close().catch(() => undefined);
      child?.kill();
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
