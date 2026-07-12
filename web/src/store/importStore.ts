import { create } from 'zustand'
import { useChatStore } from './chatStore'

// ===== Store 类型 =====

interface ImportStore {
  /** 导入文件的解析后内容（预览用） */
  previewContent: string | null
  /** 导入文件原始名 */
  previewFilename: string | null
  /** 用户选择的导入方式 */
  pendingAction: 'reference' | 'asset' | null
  /** 是否正在导入中 */
  isImporting: boolean

  showPreview: (content: string, filename: string) => void
  dismissPreview: () => void
  setPendingAction: (action: 'reference' | 'asset' | null) => void
  confirmImportToAsset: (targetPath: string) => Promise<void>
  confirmImportAsReference: () => void
}

// ===== Store =====

export const useImportStore = create<ImportStore>((set, get) => ({
  previewContent: null,
  previewFilename: null,
  pendingAction: null,
  isImporting: false,

  showPreview: (content: string, filename: string) => {
    set({ previewContent: content, previewFilename: filename, pendingAction: null, isImporting: false })
  },

  dismissPreview: () => {
    set({ previewContent: null, previewFilename: null, pendingAction: null, isImporting: false })
  },

  setPendingAction: (action: 'reference' | 'asset' | null) => {
    set({ pendingAction: action })
  },

  confirmImportToAsset: async (targetPath: string) => {
    // v6.6：投喂文件落 _input_raw.md（input_normalizer 生产端），不再"待实现"。
    // 单文件直写、多文件追加合并（带 <<< 来源:文件名 >>> 分隔）。
    set({ isImporting: true })
    try {
      const { previewContent, previewFilename } = get()
      if (previewContent) {
        // 无论 targetPath 传何值，统一落 _input_raw.md 交由 input_normalizer 归一化
        await useChatStore.getState().appendInputRaw(
          previewFilename ?? targetPath,
          previewContent,
        )
      }
      const msg: import('../types').ChatMessage = {
        id: `import_${Date.now()}`,
        role: 'system',
        content: `已将 [${previewFilename}] 落入 _input_raw.md，将在下一轮对话前由「输入归一化」自动分类为种子资产`,
        timestamp: Date.now(),
      }
      useChatStore.getState().addMessage(msg)
    } finally {
      set({ isImporting: false, previewContent: null, previewFilename: null, pendingAction: null })
    }
  },

  confirmImportAsReference: () => {
    const { previewContent, previewFilename } = get()
    if (!previewContent) return

    const truncated = previewContent.length > 200 ? previewContent.slice(0, 200) + '…' : previewContent
    const refMsg: import('../types').ChatMessage = {
      id: `ref_${Date.now()}`,
      role: 'system',
      content: `📎 参考素材 [${previewFilename}]\n\n${truncated}`,
      timestamp: Date.now(),
    }

    useChatStore.getState().addMessage(refMsg)
    set({ previewContent: null, previewFilename: null, pendingAction: null })
  },
}))
