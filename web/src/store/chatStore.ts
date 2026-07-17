import { create } from 'zustand'
import type { ChatMessage, ExecutionEvent, ConversationTurn } from '../types'
import type { ProductKind } from '../types/product'
import type { OrchestratorEngine } from '../orchestrator/orchestratorEngine'
import { useAssetStore } from './assetStore'
import { usePhaseStore } from './phaseStore'
import { classifyLLMError } from '../utils/llmError'
import { loadChat, appendChatMessage, appendChatEvent, clearChat } from '../api/chat'
import { updateProject } from '../api/projects'

// ===== 常量 =====

/** 回传给引擎的对话窗口大小（最近 N 条消息，v5.5 跨轮需求记忆） */
const HISTORY_WINDOW = 24
/** 对话历史字符预算：在扩大轮数的同时避免超长回复挤爆模型上下文 */
const HISTORY_CHAR_BUDGET = 16_000

// ===== Store 类型 =====

interface ChatStore {
  messages: ChatMessage[]
  isProcessing: boolean
  executionLog: ExecutionEvent[]
  /** v7.4：按轮次持久恢复的执行日志；刷新后仍显示在对应对话记录内。 */
  executionLogsByTurn: Record<string, ExecutionEvent[]>
  /** v7.4：当前 executionLog 所属轮次；用于把日志稳定放在该轮结果之前。 */
  executionTurnId: string | null
  isLogExpanded: boolean
  /** v6.6：当前锁定的产品方向（null=未选产品，UI 须先引导选择）*/
  product: ProductKind | null

  init: (engine: OrchestratorEngine, projectId: string | null) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  addMessage: (msg: ChatMessage) => void
  clearMessages: () => void
  toggleLogExpanded: () => void
  clearExecutionLog: () => void
  /** UI 产品选择器落定项目产品档案；选定后不可在项目内切换。 */
  setProduct: (kind: ProductKind) => void
  /** v6.6：投喂文件落到 _input_raw.md（input_normalizer 生产端）*/
  appendInputRaw: (filename: string, content: string) => Promise<void>
}

// ===== 工具函数 =====

let messageCounter = 0

function nextId(): string {
  messageCounter += 1
  return `msg_${Date.now()}_${messageCounter}`
}

function createUserMessage(content: string, turnId: string): ChatMessage {
  return {
    id: nextId(),
    role: 'user',
    content,
    timestamp: Date.now(),
    turnId,
  }
}

function createSystemMessage(
  content: string,
  options?: { turnId?: string; kind?: ChatMessage['kind'] },
): ChatMessage {
  return {
    id: nextId(),
    role: 'system',
    content,
    timestamp: Date.now(),
    turnId: options?.turnId,
    kind: options?.kind,
  }
}

function nextTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function truncateHistoryContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const marker = '\n\n...[消息过长，已截断中间内容]...\n\n'
  if (maxChars <= marker.length) return content.slice(-maxChars)
  const available = maxChars - marker.length
  const headChars = Math.floor(available / 2)
  const tailChars = available - headChars
  return `${content.slice(0, headChars)}${marker}${content.slice(-tailChars)}`
}

function groupEventsByTurn(events: ExecutionEvent[]): Record<string, ExecutionEvent[]> {
  const grouped: Record<string, ExecutionEvent[]> = {}
  for (const event of events) {
    if (!event.turnId) continue
    grouped[event.turnId] = [...(grouped[event.turnId] ?? []), event]
  }
  return grouped
}

// ===== 模块级变量（不放入 Store 响应式状态） =====

let _engine: OrchestratorEngine | null = null
/** v7.1 M4：当前项目 id（null=降级 InMemoryFileManager 模式，不持久化对话） */
let _projectId: string | null = null

/** 持久化辅助：仅持久化模式触发，fire-and-forget 不阻塞对话流，失败仅记日志 */
function persistMessage(msg: ChatMessage): void {
  if (!_projectId) return
  void appendChatMessage(_projectId, msg).catch((e) =>
    console.error('[chatStore] 持久化消息失败', e),
  )
}

function persistEvent(event: ExecutionEvent): void {
  if (!_projectId) return
  void appendChatEvent(_projectId, event).catch((e) =>
    console.error('[chatStore] 持久化事件失败', e),
  )
}

// ===== Store =====

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isProcessing: false,
  executionLog: [],
  executionLogsByTurn: {},
  executionTurnId: null,
  isLogExpanded: false,
  product: null,

  init: async (engine: OrchestratorEngine, projectId: string | null) => {
    _engine = engine
    _projectId = projectId ?? null
    // 重置 state（首次 init / 切项目都走此路径）
    set({
      messages: [],
      executionLog: [],
      executionLogsByTurn: {},
      executionTurnId: null,
      isLogExpanded: false,
      isProcessing: false,
      product: engine.getProfile()?.kind ?? null,
    })
    // 拉历史对话（仅持久化模式；events 按 turnId 回填到对应轮次）
    if (_projectId) {
      try {
        const history = await loadChat(_projectId)
        set({
          messages: [...history.messages],
          executionLogsByTurn: groupEventsByTurn(history.events),
        })
      } catch (e) {
        console.error('[chatStore] 加载对话历史失败', e)
      }
    }
  },

  sendMessage: async (content: string) => {
    const { isProcessing } = get()

    // ① 防抖检查
    if (isProcessing || !_engine) return

    // ② 采集对话窗口（推入本次 userMsg 之前，避免重复；system → assistant 映射）
    const recentMessages = get().messages.slice(-HISTORY_WINDOW)
    let historyChars = 0
    const history: ConversationTurn[] = []
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const m = recentMessages[i]
      const remainingChars = HISTORY_CHAR_BUDGET - historyChars
      if (remainingChars <= 0) break
      // 更早的消息按字符预算整条淘汰，避免截断多条消息的语义。
      if (history.length > 0 && m.content.length > remainingChars) break
      const historyContent = truncateHistoryContent(m.content, remainingChars)
      history.unshift({
        role: m.role === 'system' ? 'assistant' : 'user',
        content: historyContent,
      })
      historyChars += historyContent.length
    }

    // ③ 添加用户消息，重置执行日志
    const turnId = nextTurnId()
    const userMsg = createUserMessage(content, turnId)
    let resultDelivered = false
    set((state) => ({
      messages: [...state.messages, userMsg],
      isProcessing: true,
      executionLog: [],
      executionLogsByTurn: {
        ...state.executionLogsByTurn,
        [turnId]: [],
      },
      executionTurnId: turnId,
      isLogExpanded: true,
    }))
    persistMessage(userMsg)

    try {
      // ④ 调用 OrchestratorEngine（传对话窗口 + onEvent 实时收集执行日志 + 刷新资产卡片）
      const result = await _engine.processUserInput(content, history, (event) => {
        const turnEvent: ExecutionEvent = { ...event, turnId }
        // 追加执行日志
        set((state) => ({
          executionLog: [...state.executionLog, turnEvent],
          executionLogsByTurn: {
            ...state.executionLogsByTurn,
            [turnId]: [...(state.executionLogsByTurn[turnId] ?? []), turnEvent],
          },
        }))
        persistEvent(turnEvent)

        // Subagent 完成时实时刷新其写入的资产卡片（writes 由事件携带，精准刷新）
        if (turnEvent.type === 'tool_complete' && turnEvent.writes) {
          for (const writePath of turnEvent.writes) {
            useAssetStore.getState().refreshFile(writePath)
          }
        }
      })

      // ⑤ 先添加确定性结果并结束处理态；兜底全量刷新不再阻塞用户看到回复。
      const sysMsg = createSystemMessage(result.response, { turnId, kind: 'turn_result' })
      set((state) => ({
        messages: [...state.messages, sysMsg],
        isProcessing: false,
        isLogExpanded: false,
      }))
      persistMessage(sysMsg)
      resultDelivered = true

      void useAssetStore.getState().refreshAllFiles().catch((e) =>
        console.error('[chatStore] 兜底刷新资产失败', e),
      )
    } catch (error) {
      const classified = classifyLLMError(error)
      const errorMsg = createSystemMessage(
        `⚠️ ${classified.message}\n${classified.detail}`,
        { turnId, kind: 'turn_result' },
      )
      set((state) => ({
        messages: [...state.messages, errorMsg],
        isProcessing: false,
        isLogExpanded: false,
      }))
      persistMessage(errorMsg)
      resultDelivered = true
    } finally {
      if (!resultDelivered) {
        const fallbackMsg = createSystemMessage(
          '## 本轮已中止\n\n执行意外结束，已完成的资产均已保留，可以重新发送指令继续。',
          { turnId, kind: 'turn_result' },
        )
        set((state) => ({
          messages: [...state.messages, fallbackMsg],
          isLogExpanded: false,
        }))
        persistMessage(fallbackMsg)
      }
      const product = _engine?.getProfile()?.kind ?? null
      const phase = usePhaseStore.getState().phase
      set({ isProcessing: false, product })
      // v7.4：持久化当前项目的产品方向与创作阶段，供切换项目或重启后恢复。
      if (_projectId) {
        try {
          await updateProject(_projectId, { productKind: product, phase })
        } catch (e) {
          console.error('[chatStore] 持久化项目运行状态失败', e)
        }
      }
    }
  },

  addMessage: (msg: ChatMessage) => {
    set((state) => ({
      messages: [...state.messages, msg],
    }))
    persistMessage(msg)
  },

  clearMessages: () => {
    set({ messages: [], executionLog: [], executionLogsByTurn: {}, executionTurnId: null })
    if (_projectId) {
      void clearChat(_projectId).catch((e) =>
        console.error('[chatStore] 清空后端对话失败', e),
      )
    }
  },

  toggleLogExpanded: () => {
    set((state) => ({ isLogExpanded: !state.isLogExpanded }))
  },

  clearExecutionLog: () => {
    const currentTurnId = get().executionTurnId
    set((state) => ({
      executionLog: [],
      executionLogsByTurn: currentTurnId
        ? { ...state.executionLogsByTurn, [currentTurnId]: [] }
        : state.executionLogsByTurn,
      isLogExpanded: false,
    }))
  },

  setProduct: (kind: ProductKind) => {
    if (!_engine) return
    // 产品方向按项目锁定；需要其他方向时新建项目。
    if (_engine.getProfile() !== null) return
    _engine.lockProfile(kind)
    set({ product: kind })
    if (_projectId) {
      void updateProject(_projectId, { productKind: kind }).catch((e) =>
        console.error('[chatStore] 持久化产品方向失败', e),
      )
    }
  },

  appendInputRaw: async (filename: string, content: string) => {
    if (!_engine) return
    await _engine.appendInputRaw(filename, content)
  },
}))
