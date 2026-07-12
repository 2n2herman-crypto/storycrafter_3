import { useRef, type ChangeEvent } from 'react'
import styles from './FileImporter.module.css'

interface FileImporterProps {
  onFileImport: (file: File) => void
  disabled?: boolean
}

/**
 * 文件导入组件
 *
 * 支持 .md（浏览器直读文本）与 .docx（后端 mammoth+turndown 转 markdown，v7.1 M3）。
 * 分流在 BottomPanel.handleFileImport，本组件只负责选文件/拖拽并透传 File。
 */
export function FileImporter({ onFileImport, disabled = false }: FileImporterProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    onFileImport(file)
    // 重置 input 以允许重复选择同一文件
    e.target.value = ''
  }

  const handleClick = () => {
    if (disabled) return
    inputRef.current?.click()
  }

  const isSupported = (name: string) => {
    const lower = name.toLowerCase()
    return lower.endsWith('.md') || lower.endsWith('.docx')
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (disabled) return
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!isSupported(file.name)) return
    onFileImport(file)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  return (
    <div
      className={`${styles.bar} ${disabled ? styles.disabled : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <span className={styles.hint}>📎 拖拽 .md / .docx 文件到这里，或</span>
      <button className={styles.btn} onClick={handleClick} disabled={disabled}>
        选择文件
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.docx"
        className={styles.fileInput}
        onChange={handleFileChange}
        hidden
      />
    </div>
  )
}
