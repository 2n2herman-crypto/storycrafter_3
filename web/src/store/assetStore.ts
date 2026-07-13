import { create } from 'zustand'
import type { AssetCardData, AssetStatus, AssetRelation } from '../types'
import type { FileManager } from '../orchestrator/fileManager'
import { SUBAGENT_REGISTRY, SKILLS_BY_SUBAGENT } from '../skills/skillLoader'
import { usePhaseStore } from './phaseStore'

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
  'worldbuilding.md': '世界观',
  'characters.md': '角色',
  'act_map.md': '幕结构',
  'sequence_list.md': '序列清单',
  'foreshadowing.md': '伏笔',
  'subplots.md': '支线',
  'user_requirements.md': '需求清单',
}

// ===== 内部状态 =====

interface AssetState {
  content: string
  status: AssetStatus
  /** 变化前的内容（用于 diff 对照的左视窗） */
  previousContent?: string
  /** v6.4：中文字数缓存（仅 chapters/* 计算） */
  wordCount?: number
  /** v7.1 M6 预留：资产关系（init/refresh 不填充，文件关系系统未实现） */
  relations?: AssetRelation[]
}

/**
 * v6.3: 文件名 → 展示标签的解析规则
 * - 先查静态 FILE_LABELS
 * - sequences/S1-1.md → "场记 S1-1"（v7.1）
 * - chapters/S1-1.md → "正文 S1-1"（v7.1）
 * - chapters/E01-E12.md → "第1-12集"（v6.9 短剧）/ chapters/E05.md → "第5集"（v6.9 长剧）
 * - 其余回退到去 .md 后缀
 */
function computeLabel(path: string): string {
  if (FILE_LABELS[path]) return FILE_LABELS[path]
  const seqMatch = path.match(/^sequences\/(.+)\.md$/)
  if (seqMatch) return `场记 ${seqMatch[1]}`
  const chMatch = path.match(/^chapters\/(.+)\.md$/)
  if (chMatch) {
    const name = chMatch[1]
    // v6.9：短剧 E01-E12 → "第1-12集"，长剧 E05 → "第5集"，其余 chapters/<seqId>.md → "正文 <seqId>"
    const range = name.match(/^E(\d+)-E(\d+)$/)
    if (range) return `第${Number(range[1])}-${Number(range[2])}集`
    const single = name.match(/^E(\d+)$/)
    if (single) return `第${Number(single[1])}集`
    return `正文 ${name}`
  }
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
          const wordCount = computeWordCount(info.path, content)
          assets[info.path] = { ...assets[info.path], content, status: 'generated', wordCount }
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
        // v6.4：章节文件计算中文字数
        const wordCount = computeWordCount(path, content)
        return {
          assets: {
            ...state.assets,
            [path]: {
              content,
              previousContent: isChanged ? prev.content : prev?.previousContent,
              status: newStatus,
              wordCount,
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
          const wordCount = computeWordCount(info.path, content)
          assets[info.path] = { content, status: 'generated', wordCount }
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
          assets[path] = {
            ...state,
            previousContent: prev.content,
            status: 'modified',
            wordCount: state.wordCount,
          }
        }
      } else if (state.status === 'modified') {
        // 保持 modified 文件的 previousContent（从旧状态继承）
        const prev = prevAssets[path]
        if (prev?.previousContent) {
          assets[path] = { ...state, previousContent: prev.previousContent, wordCount: state.wordCount }
        }
      }
    }

    set({ assets })
  },

  getAssetList: () => {
    const { assets } = get()
    const phaseStore = usePhaseStore.getState()
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
          ? '细纲'
          : path.startsWith('chapters/')
            ? '剧本'
            : ''
      return {
        path,
        filename: computeLabel(path),
        group: meta?.group ?? fallbackGroup,
        status: state.status,
        // v6.4 扩展
        locked: phaseStore.isLockedPath(path),
        wordCount: state.wordCount,
        metaInfo: path.startsWith('chapters/')
          ? path.replace(/^chapters\//, '').replace(/\.md$/, '')
          : undefined,
      }
    })
  },

  clearAll: () => {
    set({ assets: {}, fileManager: null })
  },
}))

// ===== v6.4 辅助函数 =====

/** 计算中文汉字数（仅 chapters/* 路径计算，其余返回 undefined） */
function computeWordCount(path: string, content: string): number | undefined {
  if (!path.startsWith('chapters/')) return undefined
  if (!content) return 0
  const chineseChars = content.match(/[一-鿿]/g)
  return chineseChars ? chineseChars.length : 0
}
