import { useEffect, useRef } from 'react'
import type { ChatMessage, ExecutionEvent } from '../../types'
import { useChatStore } from '../../store/chatStore'
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

/** 事件类型 → CSS 类名（映射到 logEntryXxx 类） */
function getLogEntryClass(type: ExecutionEvent['type']): string {
  switch (type) {
    case 'orchestrator_thinking': return styles.logEntryThinking
    case 'tool_start': return styles.logEntryToolStart
    case 'tool_retry': return styles.logEntryToolRetry
    case 'tool_complete': return styles.logEntryToolComplete
    case 'tool_error': return styles.logEntryToolError
    case 'engine_complete': return styles.logEntryEngineComplete
    case 'engine_error': return styles.logEntryEngineError
  }
}

/** 事件类型 → 显示图标 */
function getEventIcon(type: ExecutionEvent['type']): string {
  switch (type) {
    case 'orchestrator_thinking': return '🤔'
    case 'tool_start': return '🔧'
    case 'tool_retry': return '⚠️'
    case 'tool_complete': return '✅'
    case 'tool_error': return '❌'
    case 'engine_complete': return '✅'
    case 'engine_error': return '❌'
  }
}

// ===== 子组件：执行日志区块 =====

interface ExecutionLogBlockProps {
  log: ExecutionEvent[]
  isExpanded: boolean
  onToggle: () => void
}

function ExecutionLogBlock({ log, isExpanded, onToggle }: ExecutionLogBlockProps) {
  // 生成折叠状态的摘要文字
  const successCount = log.filter((e) => e.type === 'tool_complete').length
  const errorCount = log.filter((e) => e.type === 'tool_error').length
  const totalTools = log.filter((e) => e.type === 'tool_start').length

  let summary = ''
  if (totalTools > 0) {
    summary = `✅ 已完成 ${successCount}/${totalTools} 个工具调用`
    if (errorCount > 0) summary += `（${errorCount} 个失败）`
  } else {
    summary = '✅ 处理完成'
  }

  if (!isExpanded) {
    return (
      <div className={styles.logBlock}>
        <div className={styles.logSummary} onClick={onToggle}>
          <span>{summary}</span>
          <span className={styles.logExpandIcon}>▶</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.logBlock}>
      {/* 标题栏（可点击折叠） */}
      <div className={styles.logSummary} onClick={onToggle}>
        <span>⚡ 执行日志</span>
        <span className={`${styles.logExpandIcon} ${styles.logExpandIconOpen}`}>▶</span>
      </div>

      {/* 日志条目列表 */}
      {log.map((entry, i) => (
        <div key={i} className={`${styles.logEntry} ${getLogEntryClass(entry.type)}`}>
          <span className={styles.logIcon}>{getEventIcon(entry.type)}</span>
          <span>{entry.message}</span>
        </div>
      ))}
    </div>
  )
}

// ===== 主组件 =====

interface ChatHistoryProps {
  messages: ChatMessage[]
}

export function ChatHistory({ messages }: ChatHistoryProps) {
  const executionLog = useChatStore((s) => s.executionLog)
  const isProcessing = useChatStore((s) => s.isProcessing)
  const isLogExpanded = useChatStore((s) => s.isLogExpanded)
  const toggleLogExpanded = useChatStore((s) => s.toggleLogExpanded)

  const bottomRef = useRef<HTMLDivElement>(null)

  // 当执行日志更新时，自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [executionLog.length, messages.length])

  // ===== 空状态 =====
  if (messages.length === 0 && executionLog.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>开始对话，创作你的故事</div>
      </div>
    )
  }

  // ===== 渲染 =====
  const showLog = executionLog.length > 0 || isProcessing

  return (
    <div className={styles.container}>
      {messages.map((msg) => (
        <div key={msg.id} className={styles.message}>
          <span className={`${styles.tag} ${getRoleClass(msg.role)}`}>
            {getRoleLabel(msg.role)}
          </span>
          <div className={styles.content}>
            <div className={styles.text}>{msg.content}</div>
            <span className={styles.time}>{formatTime(msg.timestamp)}</span>
          </div>
        </div>
      ))}

      {/* 执行日志区块 */}
      {showLog && (
        <ExecutionLogBlock
          log={executionLog}
          isExpanded={isLogExpanded}
          onToggle={toggleLogExpanded}
        />
      )}

      {/* 自动滚动锚点 */}
      <div ref={bottomRef} />
    </div>
  )
}
