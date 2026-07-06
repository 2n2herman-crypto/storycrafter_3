import { create } from 'zustand'
import type { ChatMessage, ExecutionEvent, ConversationTurn } from '../types'
import type { OrchestratorEngine } from '../orchestrator/orchestratorEngine'
import { useAssetStore } from './assetStore'
import { classifyLLMError } from '../utils/llmError'

// ===== 常量 =====

/** 回传给引擎的对话窗口大小（最近 N 条消息，v5.5 跨轮需求记忆） */
const HISTORY_WINDOW = 6

// ===== Store 类型 =====

interface ChatStore {
  messages: ChatMessage[]
  isProcessing: boolean
  executionLog: ExecutionEvent[]
  isLogExpanded: boolean

  init: (engine: OrchestratorEngine) => void
  sendMessage: (content: string) => Promise<void>
  addMessage: (msg: ChatMessage) => void
  clearMessages: () => void
  toggleLogExpanded: () => void
  clearExecutionLog: () => void
}

// ===== 工具函数 =====

let messageCounter = 0

function nextId(): string {
  messageCounter += 1
  return `msg_${Date.now()}_${messageCounter}`
}

function createUserMessage(content: string): ChatMessage {
  return {
    id: nextId(),
    role: 'user',
    content,
    timestamp: Date.now(),
  }
}

function createSystemMessage(content: string): ChatMessage {
  return {
    id: nextId(),
    role: 'system',
    content,
    timestamp: Date.now(),
  }
}

// ===== 模块级变量（不放入 Store 响应式状态） =====

let _engine: OrchestratorEngine | null = null

// ===== Store =====

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isProcessing: false,
  executionLog: [],
  isLogExpanded: false,

  init: (engine: OrchestratorEngine) => {
    _engine = engine
  },

  sendMessage: async (content: string) => {
    const { isProcessing } = get()

    // ① 防抖检查
    if (isProcessing || !_engine) return

    // ② 采集对话窗口（推入本次 userMsg 之前，避免重复；system → assistant 映射）
    const history: ConversationTurn[] = get()
      .messages.slice(-HISTORY_WINDOW)
      .map((m) => ({
        role: m.role === 'system' ? 'assistant' : 'user',
        content: m.content,
      }))

    // ③ 添加用户消息，重置执行日志
    const userMsg = createUserMessage(content)
    set((state) => ({
      messages: [...state.messages, userMsg],
      isProcessing: true,
      executionLog: [],
      isLogExpanded: true,
    }))

    try {
      // ④ 调用 OrchestratorEngine（传对话窗口 + onEvent 实时收集执行日志 + 刷新资产卡片）
      const result = await _engine.processUserInput(content, history, (event) => {
        // 追加执行日志
        set((state) => ({
          executionLog: [...state.executionLog, event],
        }))

        // Subagent 完成时实时刷新其写入的资产卡片（writes 由事件携带，精准刷新）
        if (event.type === 'tool_complete' && event.writes) {
          for (const writePath of event.writes) {
            useAssetStore.getState().refreshFile(writePath)
          }
        }
      })

      // ⑤ 刷新资产文件（兜底全量刷新）
      await useAssetStore.getState().refreshAllFiles()

      // ⑥ 添加系统回复，折叠日志
      const sysMsg = createSystemMessage(result.response)
      set((state) => ({
        messages: [...state.messages, sysMsg],
        isLogExpanded: false,
      }))
    } catch (error) {
      const classified = classifyLLMError(error)
      const errorMsg = createSystemMessage(
        `⚠️ ${classified.message}\n${classified.detail}`,
      )
      set((state) => ({
        messages: [...state.messages, errorMsg],
      }))
    } finally {
      set({ isProcessing: false })
    }
  },

  addMessage: (msg: ChatMessage) => {
    set((state) => ({
      messages: [...state.messages, msg],
    }))
  },

  clearMessages: () => {
    set({ messages: [] })
  },

  toggleLogExpanded: () => {
    set((state) => ({ isLogExpanded: !state.isLogExpanded }))
  },

  clearExecutionLog: () => {
    set({ executionLog: [], isLogExpanded: false })
  },
}))
