/**
 * ZCAC Phase 14 — 默认 Skill 集 + 特化角色定义。
 *
 * 每个 role 的 skills 按 category 组织;instructions 是注入
 * worker system prompt 的方法论指令(不是工具列表——工具由
 * toolAllowlist 控制,这里只管"怎么思考、怎么做事")。
 */

import type { SkillDefinition } from "./skill.js";

export const DEFAULT_SKILLS: SkillDefinition[] = [
  // ── Planning ──
  {
    name: "task-decomposition",
    category: "planning",
    instructions: "Break the request into minimal, independently verifiable sub-tasks. Each sub-task must have: a clear acceptance criterion, an estimated complexity (S/M/L), and explicit dependencies on other sub-tasks. Prefer more small tasks over fewer large ones.",
  },
  {
    name: "risk-analysis",
    category: "planning",
    instructions: "For each planned task, identify: 1) what could go wrong, 2) blast radius if it fails, 3) mitigation or rollback strategy. Flag tasks with high blast radius as requiring review before execution.",
  },

  // ── Frontend ──
  {
    name: "react-patterns",
    category: "frontend",
    instructions: "Use functional components with hooks. Prefer composition over inheritance. State: local useState → lifted state → context → external store (in that order). Avoid premature abstraction; extract components when duplication appears, not speculatively.",
  },
  {
    name: "typescript-strict",
    category: "frontend",
    instructions: "Use strict TypeScript. Prefer interface over type for object shapes. Use discriminated unions for state machines. Avoid `any` — use `unknown` with type guards. Leverage const assertions and satisfies operator.",
  },
  {
    name: "accessibility",
    category: "frontend",
    instructions: "Always use semantic HTML elements. Add ARIA labels only when semantic elements are insufficient. Ensure keyboard navigation works. Maintain color contrast ratio ≥ 4.5:1 for text. Test with screen reader announcements in mind.",
  },
  {
    name: "component-design",
    category: "frontend",
    instructions: "Design components with a single responsibility. Props should be minimal and explicit. Use compound components for related groups. Separate logic (hooks) from presentation (JSX). Co-locate styles with components.",
  },

  // ── Backend ──
  {
    name: "api-design",
    category: "backend",
    instructions: "REST: use nouns for resources, verbs for actions. Consistent error format: { error: { code, message, details? } }. Version APIs from day one. Validate all inputs at the boundary. Return appropriate HTTP status codes — don't 200 everything.",
  },
  {
    name: "database-design",
    category: "backend",
    instructions: "Normalize first, denormalize for read performance with evidence. Every table needs a primary key and created_at/updated_at. Use foreign keys with explicit ON DELETE behavior. Index columns used in WHERE, JOIN, and ORDER BY clauses.",
  },
  {
    name: "security-basics",
    category: "backend",
    instructions: "Validate all inputs at the API boundary. Use parameterized queries — never string interpolation for SQL. Hash passwords with bcrypt/argon2. Use HTTPS everywhere. Apply principle of least privilege for API access.",
  },
  {
    name: "performance-analysis",
    category: "backend",
    instructions: "Measure before optimizing. Common bottlenecks: N+1 queries, missing indexes, unbounded queries, synchronous blocking calls. Use pagination for list endpoints. Cache expensive computations with explicit invalidation.",
  },

  // ── Design ──
  {
    name: "ux-research",
    category: "design",
    instructions: "Start with the user's goal, not the feature. Map the user journey: entry point → steps → decision points → success/failure states. Identify friction points and drop-off risks. Validate assumptions with real user data when available.",
  },
  {
    name: "user-flow",
    category: "design",
    instructions: "Design flows bottom-up: what does the user need to see, click, and know at each step? Minimize steps to completion. Handle error states gracefully — show what went wrong and how to fix it. Always provide a way back.",
  },
  {
    name: "information-architecture",
    category: "design",
    instructions: "Organize content by user mental model, not by technical structure. Use progressive disclosure: show what's needed now, hide what can wait. Navigation should be shallow — no more than 3 levels deep.",
  },
  {
    name: "design-system",
    category: "design",
    instructions: "Define and reuse design tokens: colors, spacing, typography, radius, shadows. Every component variant should map to a token change, not a hardcoded value. Document the system so developers can implement without ambiguity.",
  },
  {
    name: "visual-design",
    category: "design",
    instructions: "Hierarchy: guide the eye with size, weight, color, and spacing. Alignment: pick a grid and stick to it. Whitespace: use it to separate groups, not just to fill space. Consistency: similar elements look and behave similarly.",
  },

  // ── Testing ──
  {
    name: "test-planning",
    category: "testing",
    instructions: "Test pyramid: many unit tests, fewer integration tests, few E2E tests. Each test should verify ONE behavior. Arrange-Act-Assert pattern. Test names should describe the behavior: 'returns 404 when user not found'.",
  },
  {
    name: "regression-testing",
    category: "testing",
    instructions: "Every bug fix needs a regression test that would have caught it. Run the full suite before merging, not just new tests. Test edge cases: empty input, boundary values, concurrent access, network failure.",
  },

  // ── Review ──
  {
    name: "code-review",
    category: "review",
    instructions: "Review for: correctness, security, performance, readability, test coverage. Don't nitpick style if a linter handles it. Ask 'why' before suggesting 'how'. Approve when good enough — perfection is the enemy of shipped.",
  },
  {
    name: "security-review",
    category: "review",
    instructions: "Check: input validation, output encoding, authentication on every endpoint, authorization on every resource, secrets in code, SQL injection, XSS, CSRF. Use OWASP Top 10 as a checklist.",
  },

  // ── Research ──
  {
    name: "market-analysis",
    category: "research",
    instructions: "Identify: target market size, key competitors (direct and indirect), differentiation opportunities, pricing models, user pain points. Use concrete data over opinions. Cite sources.",
  },
  {
    name: "competitor-research",
    category: "research",
    instructions: "For each competitor: product strengths/weaknesses, target audience, pricing, technology stack, recent changes. Focus on what you can learn, not what you can copy. Look for gaps they're not addressing.",
  },

  // ── DevOps ──
  {
    name: "ci-cd",
    category: "ops",
    instructions: "Pipeline stages: install → lint → typecheck → test → build → deploy. Fail fast on first error. Keep builds under 10 minutes. Use caching aggressively. Separate staging and production deploy paths.",
  },
];

/** 按名称查找 skill。 */
export function findSkills(names: readonly string[], registry: readonly SkillDefinition[]): SkillDefinition[] {
  return names
    .map((name) => registry.find((s) => s.name === name))
    .filter((s): s is SkillDefinition => s !== undefined);
}
