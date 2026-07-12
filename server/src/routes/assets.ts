import { Router, type Response } from 'express'
import {
  listAssets,
  readAsset,
  writeAsset,
  deleteAsset,
  clearAssets,
  getProject,
  ProjectNotFound,
  AssetNotFound,
} from '../services/projectStore.js'

export const assetsRouter = Router({ mergeParams: true })

/** 项目存在检查；返回 projectId 或 null（null 时已写 404） */
function requireProject(req: { params: { id?: string } }, res: Response): string | null {
  const id = req.params.id
  if (!id || !getProject(id)) {
    res.status(404).json({ error: { kind: 'not_found', message: '项目不存在' } })
    return null
  }
  return id
}

// 列出全部资产: GET /api/projects/:id/assets
// 必须先于 '/*' 定义，避免通配抢匹配根路径
assetsRouter.get('/', (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  res.json(listAssets(id))
})

// 清空全部（reset_all）: DELETE /api/projects/:id/assets
assetsRouter.delete('/', async (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  await clearAssets(id)
  res.json({ ok: true })
})

// 读单文件: GET /api/projects/:id/assets/*
assetsRouter.get('/*', (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  const relPath = (req.params as Record<string, string>)[0]
  try {
    res.json(readAsset(id, relPath))
  } catch (e) {
    if (e instanceof AssetNotFound) {
      res.status(404).json({ error: { kind: 'not_found', message: e.message } })
      return
    }
    res
      .status(400)
      .json({ error: { kind: 'bad_request', message: e instanceof Error ? e.message : String(e) } })
  }
})

// 覆盖写: PUT /api/projects/:id/assets/*
assetsRouter.put('/*', async (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  const relPath = (req.params as Record<string, string>)[0]
  const { content } = req.body as { content?: string }
  if (typeof content !== 'string') {
    res.status(400).json({ error: { kind: 'bad_request', message: '缺少 content 字段' } })
    return
  }
  try {
    const result = await writeAsset(id, relPath, content)
    res.json({ path: relPath, updatedAt: result.updatedAt })
  } catch (e) {
    if (e instanceof ProjectNotFound) {
      res.status(404).json({ error: { kind: 'not_found', message: e.message } })
      return
    }
    res
      .status(400)
      .json({ error: { kind: 'bad_request', message: e instanceof Error ? e.message : String(e) } })
  }
})

// 删单文件: DELETE /api/projects/:id/assets/*
assetsRouter.delete('/*', (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  const relPath = (req.params as Record<string, string>)[0]
  try {
    deleteAsset(id, relPath)
    res.json({ ok: true })
  } catch (e) {
    res
      .status(400)
      .json({ error: { kind: 'bad_request', message: e instanceof Error ? e.message : String(e) } })
  }
})
