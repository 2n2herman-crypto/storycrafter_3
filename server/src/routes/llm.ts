import { Router } from 'express'
import { proxyChat, testProfile, ProxyError, type ChatRequestBody } from '../services/llmProxy.js'

export const llmRouter = Router()

llmRouter.post('/chat', async (req, res) => {
  try {
    const body = req.body as ChatRequestBody
    const result = await proxyChat(body)
    res.json(result)
  } catch (e) {
    if (e instanceof ProxyError) {
      res.status(e.status).json({ error: { kind: e.kind, message: e.message, detail: e.detail } })
    } else {
      res.status(500).json({ error: { kind: 'internal', message: '内部错误', detail: e instanceof Error ? e.message : String(e) } })
    }
  }
})

llmRouter.post('/test', async (req, res) => {
  try {
    const { profileId } = req.body as { profileId: string }
    if (!profileId) {
      res.status(400).json({ error: { kind: 'bad_request', message: '缺少 profileId' } })
      return
    }
    const result = await testProfile(profileId)
    res.json(result)
  } catch (e) {
    if (e instanceof ProxyError) {
      res.status(e.status).json({ error: { kind: e.kind, message: e.message } })
    } else {
      res.status(500).json({ error: { kind: 'internal', message: '内部错误' } })
    }
  }
})
