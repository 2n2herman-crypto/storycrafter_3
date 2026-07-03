import { create } from 'zustand'
import type { ChatMessage, ExecutionEvent } from '../types'
import type { OrchestratorEngine } from '../orchestrator/orchestratorEngine'
import { useAssetStore } from './assetStore'
import { getTool } from '../orchestrator/toolRegistry'
import { classifyLLMError } from '../utils/llmError'

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

    // ② 添加用户消息，重置执行日志
    const userMsg = createUserMessage(content)
    set((state) => ({
      messages: [...state.messages, userMsg],
      isProcessing: true,
      executionLog: [],
      isLogExpanded: true,
    }))

    try {
      // ③ 调用 OrchestratorEngine（传 onEvent 实时收集执行日志 + 刷新资产卡片）
      const result = await _engine.processUserInput(content, (event) => {
        // 追加执行日志
        set((state) => ({
          executionLog: [...state.executionLog, event],
        }))

        // tool 完成时实时刷新对应资产卡片
        if (event.type === 'tool_complete' && event.toolId) {
          const toolSpec = getTool(event.toolId)
          if (toolSpec) {
            for (const writePath of toolSpec.writes) {
              useAssetStore.getState().refreshFile(writePath)
            }
          }
        }
      })

      // ④ 刷新资产文件（兜底全量刷新）
      await useAssetStore.getState().refreshAllFiles()

      // ⑤ 添加系统回复，折叠日志
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
