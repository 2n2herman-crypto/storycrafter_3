import type { SkillSpec } from '../types'
import { getSkills } from '../skills/skillLoader'

/**
 * Skill Router（四层框架第 3 层）
 *
 * 职责：在某个 Subagent 的可用 Skill 中，选出最适合当前指令的一个。
 * 不决定业务目标（那是 Orchestrator + Subagent 的事）。
 *
 * 选择策略：
 *   - 0 skill → 抛错（配置错误，loader 已保证不会发生）
 *   - 1 skill → 直接返回，不调 LLM（零成本；本轮所有 Subagent 都是这种情况）
 *   - ≥2 skill → 确定性打分：按 when 关键词命中 / description 词匹配 instruction，
 *                唯一最高分胜出；平局或零命中回退到第一个 Skill。
 *
 * （未来可在 ≥2 分支接入轻量 LLM tiebreak，复用 llm.sendMessage；本轮不接。）
 */
export function selectSkill(subagentId: string, instruction: string): SkillSpec {
  const skills = getSkills(subagentId)
  ensureSkillsAvailable(subagentId, skills)

  // 单 Skill：零成本直选
  if (skills.length === 1) {
    return skills[0]
  }

  return selectBestScoredSkill(skills, instruction)
}

function ensureSkillsAvailable(subagentId: string, skills: SkillSpec[]): void {
  if (skills.length === 0) {
    throw new Error(`[skillRouter] Subagent "${subagentId}" 没有可用 Skill`)
  }
}

function selectBestScoredSkill(skills: SkillSpec[], instruction: string): SkillSpec {
  const text = instruction.toLowerCase()
  const result = scoreSkills(skills, text)

  // 平局且零命中 → 回退到第一个 Skill（稳定、可预测）
  if (result.tie && result.bestScore <= 0) {
    return skills[0]
  }

  return result.best
}

type ScoreResult = {
  best: SkillSpec
  bestScore: number
  tie: boolean
}

function scoreSkills(skills: SkillSpec[], text: string): ScoreResult {
  let best = skills[0]
  let bestScore = -1
  let tie = false

  for (const skill of skills) {
    const score = scoreSkill(skill, text)
    if (score > bestScore) {
      bestScore = score
      best = skill
      tie = false
    } else if (score === bestScore) {
      tie = true
    }
  }

  return { best, bestScore, tie }
}

/** 对单个 Skill 相对指令打分：when 关键词命中权重更高，description 词匹配为辅。 */
function scoreSkill(skill: SkillSpec, text: string): number {
  return scoreKeywordMatches(skill.when, text) + scoreDescriptionMatches(skill.description, text)
}

function scoreKeywordMatches(keywords: string[], text: string): number {
  let score = 0

  for (const keyword of keywords) {
    if (keyword && text.includes(keyword.toLowerCase())) {
      score += 2
    }
  }

  return score
}

function scoreDescriptionMatches(description: string, text: string): number {
  let score = 0

  for (const token of tokenizeDescription(description)) {
    if (token.length >= 2 && text.includes(token)) {
      score += 1
    }
  }

  return score
}

function tokenizeDescription(description: string): string[] {
  return description.toLowerCase().split(/[\s，、。/]+/)
}
