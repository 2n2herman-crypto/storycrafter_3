import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DiffViewer } from '../DiffViewer'
import { usePhaseStore } from '../../store/phaseStore'
import { downloadText, triggerDownload } from '../../utils/exportMd'
import { exportDocx } from '../../api/importExport'
import styles from './CurrentPanel.module.css'

interface CurrentPanelProps {
  content?: string
  baselineContent?: string
  filename?: string
  isModified?: boolean
  isLoading?: boolean
  /** v6.4：当前选中的资产路径，用于判断只读状态 */
  selectedPath?: string
  children?: ReactNode
}

export function CurrentPanel({
  content,
  baselineContent,
  filename,
  isModified,
  isLoading,
  selectedPath,
  children,
}: CurrentPanelProps) {
  const showDiff = !isLoading && content && baselineContent && !children
  const isLocked = selectedPath ? usePhaseStore.getState().isLockedPath(selectedPath) : false
  const [exporting, setExporting] = useState(false)

  const handleExportWord = async () => {
    if (!content || !filename) return
    setExporting(true)
    try {
      const blob = await exportDocx(content, filename)
      triggerDownload(blob, `${filename}.docx`)
    } catch (e) {
      alert(`Word 导出失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.title}>
          {filename || '当前版本'}
          <span className={styles.badge}>当前</span>
        </div>
        {isModified !== undefined && (
          <span
            className={`${styles.statusIndicator} ${
              isModified ? styles.statusModified : styles.statusUnmodified
            }`}
          >
            {isModified ? '⚡ 已修改' : '✓ 未修改'}
          </span>
        )}
        {content && filename && (
          <div className={styles.exportGroup}>
            <button
              className={styles.exportBtn}
              onClick={() => downloadText(`${filename}.md`, content)}
            >
              导出 MD
            </button>
            <button
              className={styles.exportBtn}
              onClick={handleExportWord}
              disabled={exporting}
            >
              {exporting ? '导出中...' : '导出 Word'}
            </button>
          </div>
        )}
      </div>
      <div className={styles.body}>
        {/* v6.4：写作期设计资产只读提示 */}
        {isLocked && (
          <div className={styles.readonlyBanner}>
            🔒 当前为设计期资产的锁定快照。如需修改，请点 HeaderBar 解锁回设计期。
          </div>
        )}
        {isLoading ? (
          <div className={styles.empty}>加载中...</div>
        ) : children ? (
          children
        ) : showDiff ? (
          <DiffViewer
            baselineText={baselineContent}
            currentText={content}
          />
        ) : content ? (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className={styles.empty}>选择资产卡片查看内容</div>
        )}
      </div>
    </div>
  )
}
