/** 用户源 Skill 注册表 API（v7.1 M5）：后端扫 server/data/skills/ 返回 raw，前端解析 overlay */
import { apiFetch } from './client'

export interface SkillFileEntry {
  subagentId: string
  skillId: string
  raw: string
  source: 'user'
}

export interface SubagentFileEntry {
  subagentId: string
  raw: string
  source: 'user'
}

export interface SkillRegistryError {
  path: string
  message: string
}

export interface SkillRegistrySnapshot {
  subagents: SubagentFileEntry[]
  skills: SkillFileEntry[]
  errors: SkillRegistryError[]
}

/** 拉取用户源 Skill 快照（GET /api/skills） */
export function fetchSkills(): Promise<SkillRegistrySnapshot> {
  return apiFetch<SkillRegistrySnapshot>('/api/skills')
}

/** 触发后端重扫 server/data/skills/ 并返回新快照（POST /api/skills/refresh） */
export function refreshSkills(): Promise<SkillRegistrySnapshot> {
  return apiFetch<SkillRegistrySnapshot>('/api/skills/refresh', { method: 'POST' })
}
