import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configRouter } from './routes/config.js'
import { llmRouter } from './routes/llm.js'
import { projectsRouter } from './routes/projects.js'
import { assetsRouter } from './routes/assets.js'
import { chatRouter } from './routes/chat.js'
import { relationsRouter } from './routes/relations.js'
import { skillsRouter } from './routes/skills.js'
import { importExportRouter } from './routes/importExport.js'

const app = express()
const PORT = 3001

// M3 Word 导入会走 multipart，JSON 体上限预留 10mb
app.use(express.json({ limit: '10mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'storycrafter-server' })
})

app.use('/api/config', configRouter)
app.use('/api/llm', llmRouter)
app.use('/api/skills', skillsRouter)
// assets/chat/relations 先挂（更具体路径），避免 projects 的 /:id 抢匹配子路径
app.use('/api/projects/:id/assets', assetsRouter)
app.use('/api/projects/:id/chat', chatRouter)
app.use('/api/projects/:id/relations', relationsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api', importExportRouter)

// M6.2 生产单端口：托管前端构建产物 web/dist（开发模式由 Vite 5173 提供，此块不触发）
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIST = path.resolve(__dirname, '../../web/dist')
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST))
  // SPA fallback：非 /api 路由回退 index.html；未注册的 /api 返回 404 JSON
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      res.status(404).json({ error: { kind: 'not_found', message: '未知 API 端点' } })
      return
    }
    res.sendFile(path.join(WEB_DIST, 'index.html'))
  })
  console.log(`[server] 生产模式：托管前端静态资源 ${WEB_DIST}`)
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})
