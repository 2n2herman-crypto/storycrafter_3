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

// PATCH /api/projects/:id — 更新展示信息与可恢复的运行状态
projectsRouter.patch('/:id', (req, res) => {
  try {
    const patch = req.body as {
      name?: string
      description?: string
      productKind?: 'novel' | 'screenplay' | 'long_drama' | 'short_drama' | null
      phase?: 'designing' | 'writing'
      stageProposalPending?: boolean
    }
    const productKinds = new Set(['novel', 'screenplay', 'long_drama', 'short_drama'])
    if (
      patch.productKind !== undefined &&
      patch.productKind !== null &&
      !productKinds.has(patch.productKind)
    ) {
      res.status(400).json({ error: { kind: 'bad_request', message: '无效的 productKind' } })
      return
    }
    if (patch.phase !== undefined && patch.phase !== 'designing' && patch.phase !== 'writing') {
      res.status(400).json({ error: { kind: 'bad_request', message: '无效的 phase' } })
      return
    }
    if (
      patch.stageProposalPending !== undefined &&
      typeof patch.stageProposalPending !== 'boolean'
    ) {
      res
        .status(400)
        .json({ error: { kind: 'bad_request', message: '无效的 stageProposalPending' } })
      return
    }
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
