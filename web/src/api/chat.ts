/** 对话持久化 API：消息走 chat_history.json，执行事件走 execution_log.jsonl */
import { apiFetch } from './client'
import type { ChatMessage, ExecutionEvent } from '../types'

export interface ChatHistory {
  messages: ChatMessage[]
  events: ExecutionEvent[]
}

/** 加载项目完整对话历史（messages + events） */
export async function loadChat(projectId: string): Promise<ChatHistory> {
  const data = await apiFetch<Partial<ChatHistory>>(`/api/projects/${projectId}/chat`)
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    events: Array.isArray(data.events) ? data.events : [],
  }
}

/** 追加一条对话消息到后端（fire-and-forget 调用方自行 .catch） */
export async function appendChatMessage(projectId: string, msg: ChatMessage): Promise<void> {
  await apiFetch(`/api/projects/${projectId}/chat/messages`, {
    method: 'POST',
    body: JSON.stringify(msg),
  })
}

/** 追加一条执行事件到后端 */
export async function appendChatEvent(projectId: string, event: ExecutionEvent): Promise<void> {
  await apiFetch(`/api/projects/${projectId}/chat/events`, {
    method: 'POST',
    body: JSON.stringify(event),
  })
}

/** 清空后端对话（不清资产） */
export async function clearChat(projectId: string): Promise<void> {
  await apiFetch(`/api/projects/${projectId}/chat`, { method: 'DELETE' })
}
