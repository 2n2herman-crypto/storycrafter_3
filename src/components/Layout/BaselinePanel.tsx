import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './BaselinePanel.module.css'

interface BaselinePanelProps {
  content?: string
  filename?: string
  lastApprovedAt?: string
  isLoading?: boolean
  /** 可选子节点覆盖默认渲染 */
  children?: ReactNode
}

export function BaselinePanel({
  content,
  filename,
  lastApprovedAt,
  isLoading,
  children,
}: BaselinePanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.title}>
          {filename || '上一版本'}
          <span className={styles.badge}>上一版本</span>
        </div>
        {lastApprovedAt && (
          <span className={styles.timestamp}>{lastApprovedAt}</span>
        )}
      </div>
      <div className={styles.body}>
        {isLoading ? (
          <div className={styles.empty}>加载中...</div>
        ) : children ? (
          children
        ) : content ? (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className={styles.empty}>暂无上一版本</div>
        )}
      </div>
    </div>
  )
}
