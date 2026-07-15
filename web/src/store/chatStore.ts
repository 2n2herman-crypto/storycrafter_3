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
  isLogExpanded: boolean
  /** v6.6：当前锁定的产品方向（null=未选产品，UI 须先引导选择）*/
  product: ProductKind | null

  init: (
    engine: OrchestratorEngine,
    projectId: string | null,
    stageProposalPending?: boolean,
  ) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  addMessage: (msg: ChatMessage) => void
  clearMessages: () => void
  toggleLogExpanded: () => void
  clearExecutionLog: () => void
  /** v6.6：UI 产品选择器落定产品档案（仅在未锁定时生效；切换须 reset_all）*/
  setProduct: (kind: ProductKind) => void
  /** v6.6：投喂文件落到 _input_raw.md（input_normalizer 生产端）*/
  appendInputRaw: (filename: string, content: string) => Promise<void>
  /** v7.1 改动3：StageCard 用户点选阶段——复用 phaseStore.lock/unlock，并把该卡置只读态 */
  resolveStage: (msgId: string, stage: 'designing' | 'writing') => Promise<void>
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

function truncateHistoryContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const marker = '\n\n...[消息过长，已截断中间内容]...\n\n'
  if (maxChars <= marker.length) return content.slice(-maxChars)
  const available = maxChars - marker.length
  const headChars = Math.floor(available / 2)
  const tailChars = available - headChars
  return `${content.slice(0, headChars)}${marker}${content.slice(-tailChars)}`
}

/** v7.4：生成项目级待选 StageCard；卡片内容不进聊天记录，pending 状态写项目 metadata。 */
function createStageProposalMessage(): ChatMessage {
  return {
    id: nextId(),
    role: 'system',
    content: '请选择创作阶段',
    timestamp: Date.now(),
    kind: 'stage_proposal',
    stageState: 'pending',
  }
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
  isLogExpanded: false,
  product: null,

  init: async (
    engine: OrchestratorEngine,
    projectId: string | null,
    stageProposalPending = false,
  ) => {
    _engine = engine
    _projectId = projectId ?? null
    // 重置 state（首次 init / 切项目都走此路径）
    set({
      messages: [],
      executionLog: [],
      isLogExpanded: false,
      isProcessing: false,
      product: engine.getProfile()?.kind ?? null,
    })
    // 拉历史对话（仅持久化模式；events 历史不回填 executionLog，前端只展示当前轮）
    if (_projectId) {
      try {
        const history = await loadChat(_projectId)
        const messages = [...history.messages]
        if (
          stageProposalPending &&
          !messages.some((m) => m.kind === 'stage_proposal' && m.stageState === 'pending')
        ) {
          messages.push(createStageProposalMessage())
        }
        set({ messages })
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
    const userMsg = createUserMessage(content)
    set((state) => ({
      messages: [...state.messages, userMsg],
      isProcessing: true,
      executionLog: [],
      isLogExpanded: true,
    }))
    persistMessage(userMsg)

    try {
      // ④ 调用 OrchestratorEngine（传对话窗口 + onEvent 实时收集执行日志 + 刷新资产卡片）
      const result = await _engine.processUserInput(content, history, (event) => {
        // 追加执行日志
        set((state) => ({
          executionLog: [...state.executionLog, event],
        }))
        persistEvent(event)

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
      persistMessage(sysMsg)

      // ⑥.5 v7.1 改动3：引擎探测到"全部场记完成且仍处设计期" → 追加一张 StageCard 提问。
      //      避免重复：对话流中若已存在待选（pending）的 StageCard 则不再追加。
      if (result.stageProposal) {
        const hasPendingCard = get().messages.some(
          (m) => m.kind === 'stage_proposal' && m.stageState === 'pending',
        )
        if (!hasPendingCard) {
          set((state) => ({ messages: [...state.messages, createStageProposalMessage()] }))
          if (_projectId) {
            try {
              await updateProject(_projectId, { stageProposalPending: true })
            } catch (e) {
              console.error('[chatStore] 持久化待选阶段卡失败', e)
            }
          }
        }
      }
    } catch (error) {
      const classified = classifyLLMError(error)
      const errorMsg = createSystemMessage(
        `⚠️ ${classified.message}\n${classified.detail}`,
      )
      set((state) => ({
        messages: [...state.messages, errorMsg],
      }))
      persistMessage(errorMsg)
    } finally {
      // v6.6：同步产品锁定状态（reset_all 执行后会释放 profileLock，UI 须感知）
      const product = _engine?.getProfile()?.kind ?? null
      const phase = usePhaseStore.getState().phase
      set((state) => ({
        isProcessing: false,
        product,
        // reset_all 会释放产品锁并清空资产，同时撤销当前项目的待选阶段卡。
        messages: product === null
          ? state.messages.filter(
              (m) => !(m.kind === 'stage_proposal' && m.stageState === 'pending'),
            )
          : state.messages,
      }))
      // v7.4：覆盖 reset_all 等引擎内状态变更，保证重启后 profile/phase/待选卡可恢复。
      if (_projectId) {
        try {
          await updateProject(_projectId, {
            productKind: product,
            phase,
            ...(product === null ? { stageProposalPending: false } : {}),
          })
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
    set({ messages: [] })
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
    set({ executionLog: [], isLogExpanded: false })
  },

  setProduct: (kind: ProductKind) => {
    if (!_engine) return
    // 仅在未锁定产品时允许选择；已锁定须 reset_all 后重选（守 03 §1.3 切换=reset）
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

  resolveStage: async (msgId: string, stage: 'designing' | 'writing') => {
    const phase = usePhaseStore.getState()
    // 写作阶段 → 复用 phaseStore.lock（拍照 baselines/冻结序列/Guard 生效）；
    // 设计阶段 → 写作期则 unlock 回退，已在设计期则 NOP。lock 前置校验失败时保留卡片可重试。
    try {
      if (stage === 'writing') {
        const fm = useAssetStore.getState().fileManager
        if (!fm) return
        await phase.lock(fm)
      } else if (phase.isWriting()) {
        phase.unlock()
      }
    } catch (e) {
      // lock 校验未过（核心设定缺失）→ 提示用户，保留 StageCard 待选态
      get().addMessage(
        createSystemMessage(`⚠️ ${e instanceof Error ? e.message : String(e)}`),
      )
      return
    }
    if (_projectId) {
      try {
        await updateProject(_projectId, {
          phase: usePhaseStore.getState().phase,
          stageProposalPending: false,
        })
      } catch (e) {
        console.error('[chatStore] 持久化创作阶段失败', e)
      }
    }
    // 该卡片置只读态，记录落定阶段
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === msgId
          ? { ...m, stageState: 'resolved' as const, resolvedStage: stage }
          : m,
      ),
    }))
  },
}))
