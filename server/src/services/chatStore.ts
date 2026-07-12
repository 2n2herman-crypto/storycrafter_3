import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { enqueue } from '../util/fsQueue.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')

function chatHistoryPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, 'chat_history.json')
}

function executionLogPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, 'execution_log.jsonl')
}

/** 原子写：临时文件 + rename（崩溃安全） */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export interface ChatHistory {
  messages: unknown[]
  events: unknown[]
}

/**
 * 加载对话历史（messages + events）。
 * 后端只存不解释（消息/事件结构由前端 types 定义），故用 unknown 透传。
 */
export function loadChat(projectId: string): ChatHistory {
  const result: ChatHistory = { messages: [], events: [] }
  const ch = chatHistoryPath(projectId)
  if (fs.existsSync(ch)) {
    try {
      const data = JSON.parse(fs.readFileSync(ch, 'utf-8'))
      if (Array.isArray(data)) result.messages = data
    } catch {
      // 坏文件忽略，从空开始
    }
  }
  const el = executionLogPath(projectId)
  if (fs.existsSync(el)) {
    try {
      const lines = fs.readFileSync(el, 'utf-8').split('\n').filter((l) => l.trim())
      result.events = lines.map((l) => JSON.parse(l))
    } catch {
      // 坏文件忽略
    }
  }
  return result
}

/** 追加一条消息到 chat_history.json（读改写，过队列串行） */
export function appendMessage(projectId: string, msg: unknown): Promise<void> {
  return enqueue(projectId, () => {
    const ch = chatHistoryPath(projectId)
    let messages: unknown[] = []
    if (fs.existsSync(ch)) {
      try {
        const data = JSON.parse(fs.readFileSync(ch, 'utf-8'))
        if (Array.isArray(data)) messages = data
      } catch {
        // 坏文件从空开始
      }
    }
    messages.push(msg)
    atomicWrite(ch, JSON.stringify(messages, null, 2))
  })
}

/** 追加一条事件到 execution_log.jsonl（appendFile，过队列串行） */
export function appendEvent(projectId: string, event: unknown): Promise<void> {
  return enqueue(projectId, () => {
    const el = executionLogPath(projectId)
    const dir = path.dirname(el)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(el, JSON.stringify(event) + '\n', 'utf-8')
  })
}

/** 清空对话（不清资产），reset_all 用 */
export function clearChat(projectId: string): Promise<void> {
  return enqueue(projectId, () => {
    const ch = chatHistoryPath(projectId)
    const el = executionLogPath(projectId)
    if (fs.existsSync(ch)) atomicWrite(ch, '[]')
    if (fs.existsSync(el)) fs.writeFileSync(el, '', 'utf-8')
  })
}
