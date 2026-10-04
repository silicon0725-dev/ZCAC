/**
 * ZCAC Phase 14 — 特化角色定义(domain):扩展 5 个泛化角色为专业化分工。
 *
 * 每个特化角色 = AgentCapabilityRegistry 角色 + Skill 引用 + 通信白名单。
 * 泛化角色(planner/coder/explorer/tester/reviewer)保留,作为 fallback。
 */

import type { SkillDefinition } from "./skill.js";
import { findSkills } from "./default-skills.js";
import { DEFAULT_SKILLS } from "./default-skills.js";

// ---------------------------------------------------------------------------
// Agent Skill Profile: role → skills + peers
// ---------------------------------------------------------------------------

export interface AgentSkillProfile {
  role: string;
  category: "engineer" | "designer" | "analyst" | "qa" | "planning" | "ops";
  description: string;
  /** 引用 SkillRegistry 的 skill name。 */
  skills: readonly string[];
  tools: readonly string[];
  defaultQuota: number;
  /** 通信白名单(CommunicationPolicy.canSendTo)。 */
  communicationPeers: readonly string[];
}

// ---------------------------------------------------------------------------
// 默认特化角色集
// ---------------------------------------------------------------------------

export const SPECIALIZED_PROFILES: readonly AgentSkillProfile[] = [
  {
    role: "frontend-coder",
    category: "engineer",
    description: "UI implementation engineer — React/TypeScript/CSS specialist",
    skills: ["react-patterns", "typescript-strict", "accessibility", "component-design"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoWrite"],
    defaultQuota: 2,
    communicationPeers: ["ux-designer", "ui-designer", "reviewer", "planner"],
  },
  {
    role: "backend-coder",
    category: "engineer",
    description: "Backend engineer — API/database/security specialist",
    skills: ["api-design", "database-design", "security-basics", "performance-analysis"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoWrite"],
    defaultQuota: 2,
    communicationPeers: ["explorer", "reviewer", "planner"],
  },
  {
    role: "ux-designer",
    category: "designer",
    description: "UX designer — user flows, information architecture, interaction design",
    skills: ["ux-research", "user-flow", "information-architecture"],
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    defaultQuota: 1,
    communicationPeers: ["ui-designer", "frontend-coder", "planner"],
  },
  {
    role: "ui-designer",
    category: "designer",
    description: "UI designer — visual system, design tokens, component library",
    skills: ["design-system", "visual-design"],
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    defaultQuota: 1,
    communicationPeers: ["ux-designer", "frontend-coder", "planner"],
  },
  {
    role: "integration-tester",
    category: "qa",
    description: "Integration/E2E tester — API testing, regression, browser automation",
    skills: ["test-planning", "regression-testing"],
    tools: ["Read", "Bash", "Grep", "Glob"],
    defaultQuota: 1,
    communicationPeers: ["coder", "reviewer"],
  },
  {
    role: "devops",
    category: "ops",
    description: "DevOps engineer — CI/CD, Docker, deployment, monitoring",
    skills: ["ci-cd"],
    tools: ["Read", "Write", "Bash", "Grep", "Glob"],
    defaultQuota: 1,
    communicationPeers: ["planner", "backend-coder"],
  },
  {
    role: "market-researcher",
    category: "analyst",
    description: "Market researcher — competitive analysis, trend analysis, user research",
    skills: ["market-analysis", "competitor-research"],
    tools: ["Read", "WebSearch", "WebFetch"],
    defaultQuota: 1,
    communicationPeers: ["planner"],
  },
];

/** 泛化角色的 skill 映射(已有角色也能受益于 skill 注入)。 */
export const GENERIC_ROLE_SKILLS: Readonly<Record<string, readonly string[]>> = {
  planner: ["task-decomposition", "risk-analysis"],
  coder: ["react-patterns", "api-design", "security-basics"],
  explorer: [],
  tester: ["test-planning", "regression-testing"],
  reviewer: ["code-review", "security-review"],
};

// ---------------------------------------------------------------------------
// 注入函数
// ---------------------------------------------------------------------------

/** 查 role 的 skills 并编译为 system prompt 片段。 */
export function skillsForRole(
  role: string,
  profiles: readonly AgentSkillProfile[],
  skillRegistry: readonly SkillDefinition[],
): SkillDefinition[] {
  const profile = profiles.find((p) => p.role === role);
  const skillNames = profile?.skills ?? GENERIC_ROLE_SKILLS[role] ?? [];
  return findSkills(skillNames, skillRegistry);
}

/** 通信白名单:特化角色 → communicationPeers;泛化角色 → 默认策略。 */
export function peersForRole(
  role: string,
  profiles: readonly AgentSkillProfile[],
): readonly string[] {
  return profiles.find((p) => p.role === role)?.communicationPeers ?? [];
}
