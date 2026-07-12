import { create } from 'zustand'

// ===== 类型 =====

interface UIStore {
  /** 当前选中的资产卡片路径 */
  selectedCard: string | null
  /** 左侧栏基线 Tab */
  baselineTab: 'approved' | 'pre-edit'

  /** v6.4：折叠状态 key=group name，值为 true 表示该组已折叠 */
  collapsedSections: Record<string, boolean>

  setSelectedCard: (path: string | null) => void
  setBaselineTab: (tab: 'approved' | 'pre-edit') => void
  /** v6.4：切换单个分组的折叠状态 */
  toggleSection: (group: string) => void
  /** v6.4：批量设置折叠状态 */
  setSectionCollapsed: (group: string, collapsed: boolean) => void
  /** v6.4：重置全部折叠（写作→设计期切换用） */
  clearCollapsedSections: () => void
  reset: () => void
}

// ===== 初始状态 =====

const INITIAL_STATE: Pick<UIStore, 'selectedCard' | 'baselineTab' | 'collapsedSections'> = {
  selectedCard: null,
  baselineTab: 'approved',
  collapsedSections: {},
}

// ===== Store =====

export const useUIStore = create<UIStore>((set) => ({
  ...INITIAL_STATE,

  setSelectedCard: (path: string | null) => {
    set({ selectedCard: path })
  },

  setBaselineTab: (tab: 'approved' | 'pre-edit') => {
    set({ baselineTab: tab })
  },

  toggleSection: (group: string) =>
    set((s) => ({
      collapsedSections: { ...s.collapsedSections, [group]: !s.collapsedSections[group] },
    })),

  setSectionCollapsed: (group: string, collapsed: boolean) =>
    set((s) => ({
      collapsedSections: { ...s.collapsedSections, [group]: collapsed },
    })),

  clearCollapsedSections: () => set({ collapsedSections: {} }),

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
