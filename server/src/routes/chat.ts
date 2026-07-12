import { Router, type Response } from 'express'
import { loadChat, appendMessage, appendEvent, clearChat } from '../services/chatStore.js'
import { getProject } from '../services/projectStore.js'

export const chatRouter = Router({ mergeParams: true })

function requireProject(req: { params: { id?: string } }, res: Response): string | null {
  const id = req.params.id
  if (!id || !getProject(id)) {
    res.status(404).json({ error: { kind: 'not_found', message: '项目不存在' } })
    return null
  }
  return id
}

// GET /api/projects/:id/chat — 拿完整对话 {messages, events}
chatRouter.get('/', (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  res.json(loadChat(id))
})

// POST /api/projects/:id/chat/messages — 追加一条消息
chatRouter.post('/messages', async (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  await appendMessage(id, req.body)
  res.json({ ok: true })
})

// POST /api/projects/:id/chat/events — 追加一条执行事件
chatRouter.post('/events', async (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  await appendEvent(id, req.body)
  res.json({ ok: true })
})

// DELETE /api/projects/:id/chat — 清空对话（不清资产）
chatRouter.delete('/', async (req, res) => {
  const id = requireProject(req, res)
  if (!id) return
  await clearChat(id)
  res.json({ ok: true })
})
