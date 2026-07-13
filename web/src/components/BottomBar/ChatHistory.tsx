import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../../types'
import { useChatStore } from '../../store/chatStore'
import { StageCard } from './StageCard'
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

export function ChatHistory({ messages }: ChatHistoryProps) {
  const isProcessing = useChatStore((s) => s.isProcessing)
  const executionLog = useChatStore((s) => s.executionLog)
  const isLogExpanded = useChatStore((s) => s.isLogExpanded)
  const toggleLogExpanded = useChatStore((s) => s.toggleLogExpanded)

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
  return (
    <div className={styles.container}>
      {messages.map((msg) =>
        // v7.1 改动3：stage_proposal 消息渲染为交互式 StageCard，其余走普通气泡
        msg.kind === 'stage_proposal' ? (
          <StageCard key={msg.id} msg={msg} />
        ) : (
          <div key={msg.id} className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.system}`}>
            <span className={`${styles.tag} ${getRoleClass(msg.role)}`}>
              {getRoleLabel(msg.role)}
            </span>
            <div className={styles.content}>
              <div className={styles.text}>{msg.content}</div>
              <span className={styles.time}>{formatTime(msg.timestamp)}</span>
            </div>
          </div>
        ),
      )}

      {/* v7.2：执行日志时间线卡片 */}
      <ExecutionLogCard
        executionLog={executionLog}
        isProcessing={isProcessing}
        isExpanded={isLogExpanded}
        onToggle={toggleLogExpanded}
      />

      {/* v7.1 改动4：处理中呼吸灯（不刷事件流） */}
      {isProcessing && (
        <div className={styles.processing}>
          <span className={styles.typingDots}>
            <span />
            <span />
            <span />
          </span>
          <span>创作中…</span>
        </div>
      )}

      {/* 自动滚动锚点 */}
      <div ref={bottomRef} />
    </div>
  )
}
