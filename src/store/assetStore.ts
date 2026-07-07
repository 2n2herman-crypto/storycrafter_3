import { create } from 'zustand'
import type { AssetCardData, AssetStatus } from '../types'
import type { FileManager } from '../orchestrator/fileManager'
import { SUBAGENT_REGISTRY, SKILLS_BY_SUBAGENT } from '../skills/skillLoader'

// ===== 文件→分组 查找表（从 Subagent × Skill 构建） =====

function buildAssetMeta(): Record<string, { group: string }> {
  const meta: Record<string, { group: string }> = {}
  for (const subagent of SUBAGENT_REGISTRY) {
    const skills = SKILLS_BY_SUBAGENT.get(subagent.id) ?? []
    for (const skill of skills) {
      for (const file of skill.writes) {
        if (!meta[file]) {
          meta[file] = { group: subagent.group }
        }
      }
    }
  }
  return meta
}

const ASSET_META = buildAssetMeta()

// ===== 文件名 → 中文展示名 映射 =====

const FILE_LABELS: Record<string, string> = {
  'worldbuilding.md': '世界观设定',
  'characters.md': '角色设定',
  'act_map.md': '幕结构设计',
  'sequence_list.md': '序列清单',
  'foreshadowing.md': '伏笔与信息披露',
  'subplots.md': '支线管理',
  'user_requirements.md': '用户需求',
}

// ===== 内部状态 =====

interface AssetState {
  content: string
  status: AssetStatus
  /** 变化前的内容（用于 diff 对照的左视窗） */
  previousContent?: string
}

/**
 * v6.3: 文件名 → 展示标签的解析规则
 * - 先查静态 FILE_LABELS
 * - sequences/S1-1.md → "序列 S1-1"
 * - chapters/S1-1.md → "章节 S1-1"
 * - 其余回退到去 .md 后缀
 */
function computeLabel(path: string): string {
  if (FILE_LABELS[path]) return FILE_LABELS[path]
  const seqMatch = path.match(/^sequences\/(.+)\.md$/)
  if (seqMatch) return `序列 ${seqMatch[1]}`
  const chMatch = path.match(/^chapters\/(.+)\.md$/)
  if (chMatch) return `章节 ${chMatch[1]}`
  return path.replace(/\.md$/, '')
}

// ===== Store 类型 =====

interface AssetStore {
  assets: Record<string, AssetState>
  fileManager: FileManager | null

  init: (fm: FileManager) => Promise<void>
  selectCard: (path: string) => Promise<void>
  refreshFile: (path: string) => Promise<void>
  refreshAllFiles: () => Promise<void>
  getAssetList: () => AssetCardData[]
  clearAll: () => void
}

// ===== 初始状态 =====

const INITIAL_ASSET_STATE: AssetState = {
  content: '',
  status: 'pending',
}

// ===== Store =====

export const useAssetStore = create<AssetStore>((set, get) => ({
  assets: {},
  fileManager: null,

  init: async (fm: FileManager) => {
    set({ fileManager: fm })
    const fileInfos = await fm.listAssetFiles()
    const assets: Record<string, AssetState> = {}

    for (const info of fileInfos) {
      assets[info.path] = { ...INITIAL_ASSET_STATE }
      if (info.exists) {
        try {
          const content = await fm.readFile(info.path)
          assets[info.path] = { ...assets[info.path], content, status: 'generated' }
        } catch {
          // 读取失败，保持 pending
        }
      }
    }

    set({ assets })
  },

  selectCard: async (path: string) => {
    const fm = get().fileManager
    if (!fm) return
    const current = get().assets[path]
    if (!current) return

    try {
      const content = await fm.readFile(path)
      set((state) => ({
        assets: { ...state.assets, [path]: { ...current, content } },
      }))
    } catch {
      // 文件不存在，保持原状态
    }
  },

  refreshFile: async (path: string) => {
    const fm = get().fileManager
    if (!fm) return

    try {
      const content = await fm.readFile(path)
      set((state) => {
        const prev = state.assets[path]
        const isChanged = prev && prev.content !== content && prev.content !== ''
        const newStatus: AssetStatus =
          isChanged
            ? 'modified'
            : content
              ? 'generated'
              : 'pending'
        return {
          assets: {
            ...state.assets,
            [path]: {
              content,
              previousContent: isChanged ? prev.content : prev?.previousContent,
              status: newStatus,
            },
          },
        }
      })
    } catch {
      set((state) => ({
        assets: {
          ...state.assets,
          [path]: { ...INITIAL_ASSET_STATE, status: 'pending' },
        },
      }))
    }
  },

  refreshAllFiles: async () => {
    const fm = get().fileManager
    if (!fm) return

    const fileInfos = await fm.listAssetFiles()
    const assets: Record<string, AssetState> = {}

    for (const info of fileInfos) {
      if (info.exists) {
        try {
          const content = await fm.readFile(info.path)
          assets[info.path] = { content, status: 'generated' }
        } catch {
          assets[info.path] = { ...INITIAL_ASSET_STATE }
        }
      } else {
        assets[info.path] = { ...INITIAL_ASSET_STATE }
      }
    }

    // 更新 modified 状态：对比旧内容，保存 previousContent
    const prevAssets = get().assets
    for (const [path, state] of Object.entries(assets)) {
      if (state.status === 'generated') {
        const prev = prevAssets[path]
        if (prev && prev.content !== state.content && prev.content !== '') {
          assets[path] = { ...state, previousContent: prev.content, status: 'modified' }
        }
      } else if (state.status === 'modified') {
        // 保持 modified 文件的 previousContent（从旧状态继承）
        const prev = prevAssets[path]
        if (prev?.previousContent) {
          assets[path] = { ...state, previousContent: prev.previousContent }
        }
      }
    }

    set({ assets })
  },

  getAssetList: () => {
    const { assets } = get()
    return Object.entries(assets)
      .filter(([path]) => !path.startsWith('_'))
      .filter(([path]) => path !== 'draft_history.md')
      .map(([path, state]) => {
      // v6.1 G.2：pipeline 终品 sequences/<ID>.md 与 writer 正文 chapters/<ID>.md 都是运行期生成、
      // 未进入构建期 ASSET_META 注册表（后者按各 skill frontmatter 静态 writes 反向建立），
      // 故此处按路径前缀兜底分组避免它们在 AssetCardPanel 堆成一坨 group='' 空 bucket。
      const meta = ASSET_META[path]
      const fallbackGroup =
        path.startsWith('sequences/')
          ? '大纲切片'
          : path.startsWith('chapters/')
            ? '剧本正文'
            : ''
      return {
        path,
        filename: computeLabel(path),
        group: meta?.group ?? fallbackGroup,
        status: state.status,
      }
    })
  },

  clearAll: () => {
    set({ assets: {}, fileManager: null })
  },
}))
