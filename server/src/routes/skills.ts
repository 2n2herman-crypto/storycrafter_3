import { Router } from 'express'
import { scanUserSkills, type SkillRegistrySnapshot } from '../services/skillRegistry.js'

export const skillsRouter = Router()

// 模块级缓存：首启动扫一次，refresh 时重扫
let snapshot: SkillRegistrySnapshot = scanUserSkills()

// GET /api/skills — 拿用户源 Skill 快照（subagent.md + SKILL.md 的 raw + errors）
skillsRouter.get('/', (_req, res) => {
  res.json(snapshot)
})

// POST /api/skills/refresh — 重扫 server/data/skills/，返回新快照
skillsRouter.post('/refresh', (_req, res) => {
  snapshot = scanUserSkills()
  res.json(snapshot)
})

// GET /api/skills/errors — 仅拿扫描错误（坏文件/坏目录结构）
skillsRouter.get('/errors', (_req, res) => {
  res.json({ errors: snapshot.errors })
})
