import type { ExecutionEvent } from '../../types'
import { useExecutionSteps } from './useExecutionSteps'
import styles from './ExecutionLogCard.module.css'

interface ExecutionLogCardProps {
  executionLog: ExecutionEvent[]
  isProcessing: boolean
  isExpanded: boolean
  onToggle: () => void
}

/** v7.2：执行日志时间线卡片，替代原呼吸灯+3秒提示的极简态展示 */
export function ExecutionLogCard({ executionLog, isProcessing, isExpanded, onToggle }: ExecutionLogCardProps) {
  const steps = useExecutionSteps(executionLog)

  if (steps.length === 0) return null

  const doneCount = steps.filter((s) => s.status === 'done').length
  const summary = isProcessing && doneCount === 0 ? '处理中…' : `已完成 ${doneCount} 个步骤`

  return (
    <div className={styles.card}>
      <button type="button" className={styles.header} onClick={onToggle} aria-expanded={isExpanded}>
        <span className={styles.headerTitle}>执行日志</span>
        <span className={styles.headerRight}>
          <span className={styles.summary}>{summary}</span>
          <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`} aria-hidden="true" />
        </span>
      </button>

      {isExpanded && (
        <div className={styles.body}>
          {steps.map((step, i) => (
            <div key={step.key} className={`${styles.row} ${styles[step.status]}`}>
              {i < steps.length - 1 && <span className={styles.connector} aria-hidden="true" />}
              <span className={styles.glyph} aria-hidden="true">{step.glyph}</span>
              <div className={styles.rowContent}>
                <div className={styles.rowTitle}>{step.title}</div>
                <div className={styles.rowReason}>{step.reason}</div>
                <div className={styles.rowSubtitle}>{step.subtitle}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
