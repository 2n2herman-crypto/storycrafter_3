import { useCallback } from 'react'
import styles from './BottomPanel.module.css'

import { ChatInput } from './ChatInput'
import { FileImporter } from './FileImporter'
import { ChatHistory } from './ChatHistory'

import { useChatStore } from '../../store/chatStore'
import { useImportStore } from '../../store/importStore'
import { importDocx } from '../../api/importExport'

/**
 * 对话记录栏（四栏布局第 2 栏）
 * 纵向：栏标题头 → 聊天历史（占主高度，可滚动） → 文件导入 → 输入框（固定底部）
 */
export function BottomPanel() {
  // ===== Stores =====
  const messages = useChatStore((s) => s.messages)
  const chatProcessing = useChatStore((s) => s.isProcessing)
  const sendMessage = useChatStore((s) => s.sendMessage)

  const showImportPreview = useImportStore((s) => s.showPreview)

  // ===== Handlers =====

  /** 发送消息 */
  const handleSend = useCallback(
    (content: string) => {
      sendMessage(content)
    },
    [sendMessage],
  )

  /** 文件导入（.md 直读文本；.docx 走后端转 markdown，复用同一预览链路） */
  const handleFileImport = useCallback(
    async (file: File) => {
      try {
        if (file.name.toLowerCase().endsWith('.docx')) {
          const { markdown } = await importDocx(file)
          showImportPreview(markdown, file.name)
        } else {
          const text = await file.text()
          showImportPreview(text, file.name)
        }
      } catch (e) {
        useChatStore.getState().addMessage({
          id: `import_err_${Date.now()}`,
          role: 'system',
          content: `文件导入失败: ${file.name}${e instanceof Error ? `（${e.message}）` : ''}`,
          timestamp: Date.now(),
        })
      }
    },
    [showImportPreview],
  )

  // ===== 渲染 =====

  return (
    <div className={styles.panel}>
      {/* 栏标题头 */}
      <div className={styles.panelHeader}>
        <div className={styles.title}>对话</div>
      </div>

      {/* 对话历史（占主高度，可滚动） */}
      <div className={styles.historyArea}>
        <ChatHistory messages={messages} />
      </div>

      {/* 文件导入 */}
      <FileImporter
        onFileImport={handleFileImport}
        disabled={chatProcessing}
      />

      {/* 输入框（固定底部） */}
      <div className={styles.controlsRow}>
        <ChatInput
          onSend={handleSend}
          disabled={chatProcessing}
        />
      </div>
    </div>
  )
}
