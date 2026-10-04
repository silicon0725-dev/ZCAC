/**
 * ZCAC Phase 14 — Skill Registry(domain):专业方法论的结构化定义。
 *
 * Skill = 可复用的 prompt 片段,按 role 注入 worker 的 system prompt。
 * 不做复杂 Skill Engine——Skill 就是结构化的方法论指令。
 */

export interface SkillDefinition {
  name: string;
  category: string;
  /** 方法论指令,注入 worker system prompt。 */
  instructions: string;
}

export function buildSkillInstructions(skills: readonly SkillDefinition[]): string {
  if (skills.length === 0) return "";
  return [
    "",
    "## Professional Skills",
    "",
    ...skills.map((s) => `### ${s.name}\n${s.instructions}`),
  ].join("\n");
}
