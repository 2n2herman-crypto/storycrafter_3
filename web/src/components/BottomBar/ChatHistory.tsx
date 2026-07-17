import { Fragment, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ExecutionEvent } from '../../types'
import { useChatStore } from '../../store/chatStore'
import { ExecutionLogCard } from './ExecutionLogCard'
import styles from './ChatHistory.module.css'

// ===== 辅助函数 =====

/** 角色 → 中文标签 */
function getRoleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'user': return '你'
    case 'system': return '系统'
  }
}

/** 角色 → 标签样式类名 */
function getRoleClass(role: ChatMessage['role']): string {
  switch (role) {
    case 'user': return styles.tagUser
    case 'system': return styles.tagSystem
  }
}

/** 格式化时间戳 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// ===== 主组件 =====

interface ChatHistoryProps {
  messages: ChatMessage[]
}

interface TurnExecutionLogProps {
  executionLog: ExecutionEvent[]
  isCurrentTurn: boolean
  isProcessing: boolean
  isExpanded: boolean
  onToggle: () => void
}

function TurnExecutionLog({
  executionLog,
  isCurrentTurn,
  isProcessing,
  isExpanded,
  onToggle,
}: TurnExecutionLogProps) {
  const [historyExpanded, setHistoryExpanded] = useState(false)

  return (
    <ExecutionLogCard
      executionLog={executionLog}
      isProcessing={isCurrentTurn && isProcessing}
      isExpanded={isCurrentTurn ? isExpanded : historyExpanded}
      onToggle={isCurrentTurn ? onToggle : () => setHistoryExpanded((value) => !value)}
    />
  )
}

export function ChatHistory({ messages }: ChatHistoryProps) {
  const isProcessing = useChatStore((s) => s.isProcessing)
  const executionLog = useChatStore((s) => s.executionLog)
  const executionLogsByTurn = useChatStore((s) => s.executionLogsByTurn)
  const executionTurnId = useChatStore((s) => s.executionTurnId)
  const isLogExpanded = useChatStore((s) => s.isLogExpanded)
  const toggleLogExpanded = useChatStore((s) => s.toggleLogExpanded)
  const isFinalizing = executionLog[executionLog.length - 1]?.type === 'engine_finalizing'

  const bottomRef = useRef<HTMLDivElement>(null)

  // 消息或处理态变化时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isProcessing, isLogExpanded])

  // ===== 空状态 =====
  if (messages.length === 0 && !isProcessing) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>开始对话，创作你的故事</div>
      </div>
    )
  }

  // ===== 渲染 =====
  const renderMessage = (msg: ChatMessage) => (
    <div className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.system}`}>
      <span className={`${styles.tag} ${getRoleClass(msg.role)}`}>
        {getRoleLabel(msg.role)}
      </span>
      <div className={styles.content}>
        {msg.role === 'system' ? (
          <div className={`${styles.text} ${styles.markdown}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        ) : (
          <div className={styles.text}>{msg.content}</div>
        )}
        <span className={styles.time}>{formatTime(msg.timestamp)}</span>
      </div>
    </div>
  )

  const currentResultExists = executionTurnId
    ? messages.some((msg) => msg.kind === 'turn_result' && msg.turnId === executionTurnId)
    : false

  return (
    <div className={styles.container}>
      {messages.map((msg) => {
        const turnLog = msg.turnId ? (executionLogsByTurn[msg.turnId] ?? []) : []
        const isCurrentTurn = Boolean(msg.turnId && msg.turnId === executionTurnId)
        const logForRender = isCurrentTurn ? executionLog : turnLog

        return (
          <Fragment key={msg.id}>
            {msg.kind === 'turn_result' && logForRender.length > 0 && (
              <TurnExecutionLog
                executionLog={logForRender}
                isCurrentTurn={isCurrentTurn}
                isProcessing={isProcessing}
                isExpanded={isLogExpanded}
                onToggle={toggleLogExpanded}
              />
            )}
            {renderMessage(msg)}
          </Fragment>
        )
      })}

      {!currentResultExists && executionLog.length > 0 && (
        <TurnExecutionLog
          executionLog={executionLog}
          isCurrentTurn={true}
          isProcessing={isProcessing}
          isExpanded={isLogExpanded}
          onToggle={toggleLogExpanded}
        />
      )}

      {/* v7.1 改动4：处理中呼吸灯（不刷事件流） */}
      {isProcessing && (
        <div className={styles.processing}>
          <span className={styles.typingDots}>
            <span />
            <span />
            <span />
          </span>
          <span>{isFinalizing ? '正在整理本轮结果…' : '创作中…'}</span>
        </div>
      )}

      {/* 自动滚动锚点 */}
      <div ref={bottomRef} />
    </div>
  )
}
