import { Router, type Response } from 'express'
import { getProject } from '../services/projectStore.js'

/**
 * 文件关系系统预留端点（v7.1 M6）。
 * 当前未实现任何功能，统一返回 501，仅为未来文件关系系统预留路由与契约。
 */
export const relationsRouter = Router({ mergeParams: true })

function requireProject(req: { params: { id?: string } }, res: Response): string | null {
  const id = req.params.id
  if (!id || !getProject(id)) {
    res.status(404).json({ error: { kind: 'not_found', message: '项目不存在' } })
    return null
  }
  return id
}

const NOT_IMPLEMENTED = {
  error: { kind: 'not_implemented', message: '文件关系系统尚未实现（v7.1 M6 预留）' },
}

// GET /api/projects/:id/relations → 501（预留）
relationsRouter.get('/', (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  res.status(501).json(NOT_IMPLEMENTED)
})

// POST /api/projects/:id/relations → 501（预留）
relationsRouter.post('/', (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  res.status(501).json(NOT_IMPLEMENTED)
})
