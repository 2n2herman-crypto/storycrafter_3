import { Router } from 'express'
import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  ProjectNotFound,
} from '../services/projectStore.js'

export const projectsRouter = Router()

// GET /api/projects — 项目列表
projectsRouter.get('/', (_req, res) => {
  res.json(listProjects())
})

// POST /api/projects — 新建项目
projectsRouter.post('/', (req, res) => {
  const { name } = req.body as { name?: string }
  res.json(createProject(name ?? '未命名项目'))
})

// GET /api/projects/:id — 项目 metadata
projectsRouter.get('/:id', (req, res) => {
  const meta = getProject(req.params.id)
  if (!meta) {
    res.status(404).json({ error: { kind: 'not_found', message: '项目不存在' } })
    return
  }
  res.json(meta)
})

// PATCH /api/projects/:id — 更新 name/description
projectsRouter.patch('/:id', (req, res) => {
  try {
    const patch = req.body as { name?: string; description?: string }
    res.json(updateProject(req.params.id, patch))
  } catch (e) {
    if (e instanceof ProjectNotFound) {
      res.status(404).json({ error: { kind: 'not_found', message: e.message } })
      return
    }
    res
      .status(500)
      .json({ error: { kind: 'internal', message: e instanceof Error ? e.message : String(e) } })
  }
})

// DELETE /api/projects/:id — 硬删
projectsRouter.delete('/:id', (req, res) => {
  deleteProject(req.params.id)
  res.json({ ok: true })
})
