/**
 * ZCAC Adapter — ZCodeAgentExecutor(规范 §27/§42 的 ZCode 实现)。
 *
 * ZCAC 逻辑模型标识 "providerId/modelId[@reasoningLevel]" 在本适配层解析为
 * ZCode ModelSelection;Task Core 不感知 ZCode 类型(规范 §7)。
 *
 * Phase 0 结论:SubagentPort 在 ZCode v3.14.3 未公开导出
 * (core/src/runtime/agent-runtime.ts:175 为 private),
 * 因此 worker = 独立 createZCodeApp 组合(mono-agent、工具白名单、persona),
 * 与 dwf actor 的构造方式(script-workflow-child-runtime.ts)等价。
 * 将来换 SubagentPort / ProtocolExecutor 只改本文件。
 */

import {
  createZCodeApp,
  startProcessProviderRegistryRuntime,
} from "@zcode/bootstrap";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { ModelSelection } from "@zcode/contracts";
import type { AgentExecutor, AgentHandle, AgentLaunchRequest, AgentResult } from "../../ports/agent-executor.js";
import type { UsageSummary } from "../../domain/task/task-input.js";

type ZCodeAppInstance = Awaited<ReturnType<typeof createZCodeApp>>;
type ProviderRegistryRuntime = Awaited<
  ReturnType<typeof startProcessProviderRegistryRuntime>
>;

// ---------------------------------------------------------------------------
// 角色预设(spec §5 Capability Registry 雏形;Phase 2 Agent Pool 时上移到 core)
// ---------------------------------------------------------------------------

export interface RolePreset {
  role: string;
  capabilities: readonly string[];
  tools: readonly string[];
  agentPrompt: string;
  mode: "plan" | "build" | "edit" | "yolo" | "auto";
  maxTurns: number;
}

import {
  buildCommunicationInstructions,
  buildAgentDiscoveryInstructions,
} from "../../application/agent-communication.js";
import { createDefaultCapabilityRegistry } from "../../domain/agent/agent-pool.js";
import { findSkills, DEFAULT_SKILLS } from "../../domain/agent/default-skills.js";
import { buildSkillInstructions } from "../../domain/agent/skill.js";
import { SPECIALIZED_PROFILES, GENERIC_ROLE_SKILLS } from "../../domain/agent/specialized-profiles.js";

const DEFAULT_REGISTRY = createDefaultCapabilityRegistry();
for (const profile of SPECIALIZED_PROFILES) {
  DEFAULT_REGISTRY.register({
    role: profile.role,
    capabilities: [...profile.skills],
    defaultQuota: profile.defaultQuota,
  });
}
const AGENT_DISCOVERY = buildAgentDiscoveryInstructions(DEFAULT_REGISTRY);

function skillInstructionsFor(role: string): string {
  const profile = SPECIALIZED_PROFILES.find((p) => p.role === role);
  const names = profile?.skills ?? GENERIC_ROLE_SKILLS[role] ?? [];
  return buildSkillInstructions(findSkills(names, DEFAULT_SKILLS));
}

const CODER_PROMPT = [
  "You are a ZCAC Coder worker agent inside the ZCode Agent Cluster.",
  "You implement exactly the change described in the task prompt — nothing more.",
  "Work only inside the current working directory.",
  "When the change is done, reply with a short summary: the files you changed and what you did.",
].join("\n") +
  buildCommunicationInstructions(["explorer", "tester", "planner", "backend-coder", "frontend-coder", "ux-designer", "ui-designer", "market-researcher"]) +
  AGENT_DISCOVERY +
  skillInstructionsFor("coder");

const EXPLORER_PROMPT = [
  "You are a ZCAC Explorer worker agent inside the ZCode Agent Cluster.",
  "You are read-only: analyze the repository, never modify files.",
  "Report findings as a concise structured summary (files, symbols, call relations) with evidence paths.",
].join("\n") +
  buildCommunicationInstructions(["coder", "planner", "backend-coder", "frontend-coder", "market-researcher"]) +
  AGENT_DISCOVERY +
  skillInstructionsFor("explorer");

const PLANNER_PROMPT = [
  "You are a ZCAC Planner worker agent inside the ZCode Agent Cluster.",
  "You decompose a feature request into an ordered task list with dependencies.",
  "You do not write product code. Output a numbered plan with file-level pointers.",
].join("\n") +
  skillInstructionsFor("planner");

const TESTER_PROMPT = [
  "You are a ZCAC Tester worker agent inside the ZCode Agent Cluster.",
  "You run builds, tests and static checks, then report pass/fail with command output evidence.",
].join("\n") +
  buildCommunicationInstructions(["coder", "reviewer", "integration-tester"]) +
  AGENT_DISCOVERY +
  skillInstructionsFor("tester");

const REVIEWER_PROMPT = [
  "You are a ZCAC Reviewer worker agent inside the ZCode Agent Cluster.",
  "You are read-only. Review diffs/code against the task intent and report findings with severity, file and line.",
].join("\n") +
  skillInstructionsFor("reviewer");

export const ROLE_PRESETS: Record<string, RolePreset> = {
  coder: {
    role: "coder",
    capabilities: ["code.write", "code.edit", "shell.execute"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoWrite"],
    agentPrompt: CODER_PROMPT,
    mode: "yolo",
    maxTurns: 40,
  },
  explorer: {
    role: "explorer",
    capabilities: ["code.read", "repo.analysis"],
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
    agentPrompt: EXPLORER_PROMPT,
    mode: "yolo",
    maxTurns: 30,
  },
  planner: {
    role: "planner",
    capabilities: ["code.read", "plan.authoring"],
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
    agentPrompt: PLANNER_PROMPT,
    mode: "yolo",
    maxTurns: 30,
  },
  tester: {
    role: "tester",
    capabilities: ["test.execute", "shell.execute"],
    tools: ["Read", "Bash", "Grep", "Glob"],
    agentPrompt: TESTER_PROMPT,
    mode: "yolo",
    maxTurns: 40,
  },
  reviewer: {
    role: "reviewer",
    capabilities: ["code.read", "code.review"],
    tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    agentPrompt: REVIEWER_PROMPT,
    mode: "yolo",
    maxTurns: 30,
  },
};

// ---------------------------------------------------------------------------
// ZCAC 逻辑模型标识解析:"providerId/modelId[@reasoningLevel]"
// ---------------------------------------------------------------------------

export function parseLogicalModel(raw: string): ModelSelection {
  const [ids, level] = raw.split("@");
  const [providerId, modelId] = (ids ?? "").split("/");
  if (!providerId || !modelId) {
    throw new Error(
      `Invalid ZCAC logical model "${raw}": expected providerId/modelId[@level]`,
    );
  }
  return {
    providerId,
    modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ActiveAgent {
  agentId: string;
  app: ZCodeAppInstance;
  abort: AbortController;
  startedAtMs: number;
  turn: Promise<
    | { ok: true; turn: Awaited<ReturnType<ZCodeAppInstance["submitPrompt"]>> }
    | { ok: false; error: unknown }
  >;
}

export interface ZCodeAgentExecutorOptions {
  env?: NodeJS.ProcessEnv;
  rolePresets?: Record<string, RolePreset>;
}

export class ZCodeAgentExecutor implements AgentExecutor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly presets: Record<string, RolePreset>;
  private registryRuntime?: ProviderRegistryRuntime;
  private readonly active = new Map<string, ActiveAgent>();
  private seq = 0;

  constructor(options: ZCodeAgentExecutorOptions = {}) {
    this.env = options.env ?? process.env;
    this.presets = options.rolePresets ?? ROLE_PRESETS;
  }

  private registryPromise?: Promise<ProviderRegistryRuntime>;

  /**
   * 进程级共享一份 Provider Registry(所有 worker 复用同一模型目录)。
   * 缓存 promise 而非结果:并行 launch 时第二个调用必须等同一个实例
   * 初始化完成,否则会并发启动两个 Registry(凭据文件锁/内置配置下载互踩)。
   */
  private ensureRegistry(): Promise<ProviderRegistryRuntime> {
    this.registryPromise ??= startProcessProviderRegistryRuntime(this.env, {
      standalone: {},
    });
    return this.registryPromise;
  }

  /**
   * 枚举 Provider Registry 中所有可用模型(含 reasoning levels)。
   * 供 MCP list_models 工具使用 — 主模型可展示给用户做下拉选择。
   */
  async listModels(): Promise<
    Array<{
      providerId: string;
      providerName: string;
      modelId: string;
      enabled: boolean;
      reasoningLevels: string[];
      contextWindow?: number;
      supportsImage?: boolean;
    }>
  > {
    const registry = await this.ensureRegistry();
    const providers = registry.runtime.registryService.listProviders();
    const models: Array<{
      providerId: string;
      providerName: string;
      modelId: string;
      enabled: boolean;
      reasoningLevels: string[];
      contextWindow?: number;
      supportsImage?: boolean;
    }> = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        const config = model.config as unknown as Record<string, unknown>;
        const optionSpecs = (config?.optionSpecs ?? {}) as Record<string, unknown>;
        const reasoning = optionSpecs.reasoningLevel as Record<string, unknown> | undefined;
        const levels = Array.isArray(reasoning?.values)
          ? (reasoning.values as string[])
          : [];
        const properties = (config?.properties ?? {}) as Record<string, unknown>;
        const inputFormat = (properties?.inputFormat ?? {}) as Record<string, unknown>;
        models.push({
          providerId: provider.providerId,
          providerName: provider.providerName ?? provider.providerId,
          modelId: model.modelId,
          enabled: config?.enabled !== false,
          reasoningLevels: levels,
          ...(typeof properties?.contextWindow === "number"
            ? { contextWindow: properties.contextWindow }
            : {}),
          ...(typeof inputFormat?.supportsImage === "boolean"
            ? { supportsImage: inputFormat.supportsImage }
            : {}),
        });
      }
    }
    return models;
  }

  async launch(request: AgentLaunchRequest): Promise<AgentHandle> {
    const preset = this.presets[request.role];
    if (!preset) {
      throw new Error(
        `Unknown ZCAC agent role "${request.role}". Known roles: ${Object.keys(this.presets).join(", ")}`,
      );
    }
    let registry: ProviderRegistryRuntime;
    try {
      registry = await this.ensureRegistry();
    } catch (error) {
      // 初始化失败不缓存:下一次 launch 可以重试。
      this.registryPromise = undefined;
      throw error;
    }

    const modelSelection = request.model ? parseLogicalModel(request.model) : undefined;
    const runtimeConfig: AgentRuntimeConfig = {
      workingDirectory: request.workingDirectory,
      mode: preset.mode,
      maxTurns: request.maxTurns ?? preset.maxTurns,
      toolAllowlist: request.tools ?? preset.tools,
      agentName: `zcac-${preset.role}`,
      // worker = mono-agent:走 subagent 形态的 context builder,持有角色 persona
      subagentContext: { agentPrompt: request.agentPrompt ?? preset.agentPrompt },
      subagents: { enabled: false },
      dynamicWorkflowEnabled: false,
      modelStreaming: "on",
      ...(modelSelection ? { modelSelection } : {}),
    };

    const app = await createZCodeApp({
      env: this.env,
      providerRegistry: registry.runtime.registryService,
      ...(registry.configuredDefaultModelSelection
        ? { configuredDefaultModelSelection: registry.configuredDefaultModelSelection }
        : {}),
      ...(registry.providerRuntimeHeadersPort
        ? { providerRuntimeHeadersPort: registry.providerRuntimeHeadersPort }
        : {}),
      runtimeConfig,
    });

    const agentId = `zcac-${preset.role}-${String(++this.seq).padStart(3, "0")}`;
    const abort = new AbortController();
    const startedAtMs = Date.now();
    const turn = app
      .submitPrompt(request.prompt, { abortSignal: abort.signal })
      .then(
        (result) => ({ ok: true as const, turn: result }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    this.active.set(agentId, { agentId, app, abort, startedAtMs, turn });
    return {
      agentId,
      role: preset.role,
      sessionId: app.sessionId,
      model: app.getModel(),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  async send(handle: AgentHandle, message: string): Promise<void> {
    const agent = this.requireAgent(handle);
    await agent.app.sendInput(message);
  }

  async wait(handle: AgentHandle): Promise<AgentResult> {
    const agent = this.requireAgent(handle);
    const outcome = await agent.turn;
    const base = {
      agentId: agent.agentId,
      role: handle.role,
      sessionId: agent.app.sessionId,
      model: agent.app.getModel(),
      durationMs: Date.now() - agent.startedAtMs,
      ...(handle.metadata ? { metadata: handle.metadata } : {}),
    };
    // wait 是一次性的:turn 结束即释放该 worker 的 app(27MB bundle 的运行时很重,
    // 常驻编排器进程不释放必然累积泄漏 → OOM,Phase 7 实测)。
    await this.dispose(handle).catch(() => undefined);
    if (outcome.ok) {
      return {
        ...base,
        status: "completed",
        response: outcome.turn.response,
        ...(outcome.turn.usage
          ? { usage: mapUsage(outcome.turn.usage) }
          : {}),
      };
    }
    return {
      ...base,
      status: agent.abort.signal.aborted ? "cancelled" : "failed",
      response: "",
      error: String(outcome.error),
    };
  }

  async stop(handle: AgentHandle): Promise<void> {
    const agent = this.requireAgent(handle);
    agent.abort.abort(new Error("stopped by ZCAC"));
    await agent.app.close?.().catch(() => undefined);
    this.active.delete(agent.agentId);
  }

  async dispose(handle?: AgentHandle): Promise<void> {
    if (handle) {
      const agent = this.active.get(handle.agentId);
      if (agent) {
        await agent.app.close?.().catch(() => undefined);
        this.active.delete(handle.agentId);
      }
      return;
    }
    await Promise.allSettled(
      [...this.active.values()].map((agent) =>
        agent.app.close?.().catch(() => undefined),
      ),
    );
    this.active.clear();
    const registry = this.registryPromise;
    this.registryPromise = undefined;
    if (registry) {
      await registry.then((runtime) => runtime.dispose()).catch(() => undefined);
    }
  }

  private requireAgent(handle: AgentHandle): ActiveAgent {
    const agent = this.active.get(handle.agentId);
    if (!agent || agent.agentId !== handle.agentId) {
      throw new Error(`Unknown or disposed ZCAC agent handle: ${handle.agentId}`);
    }
    return agent;
  }
}

/** ZCode ModelUsageSummary → ZCAC UsageSummary(领域字段挑选)。 */
function mapUsage(usage: {
  modelRequestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}): UsageSummary {
  return {
    ...(usage.modelRequestCount !== undefined
      ? { modelRequestCount: usage.modelRequestCount }
      : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
    ...(usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: usage.cacheReadTokens }
      : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  };
}
