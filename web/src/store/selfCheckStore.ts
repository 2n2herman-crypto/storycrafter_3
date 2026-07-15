import { create } from 'zustand'

/**
 * SelfCheckStore（v7.3 新增）—— 自检模式开关
 *
 * 控制质检 subagent（quality_checker）是否出现在 Orchestrator 的 FC 工具列表中。
 * - 关闭时：quality_checker 从 FC 工具列表彻底移除，对 Orchestrator 不可见
 * - 开启时：quality_checker 正常参与 FC 选择（默认值）
 *
 * 会话级状态，用户可在对话过程中随时切换，不影响质检 subagent 本身的执行逻辑。
 */

interface SelfCheckState {
  selfCheckEnabled: boolean
  enable: () => void
  disable: () => void
  toggle: () => void
}

export const useSelfCheckStore = create<SelfCheckState>((set, get) => ({
  selfCheckEnabled: true,

  enable: () => set({ selfCheckEnabled: true }),
  disable: () => set({ selfCheckEnabled: false }),
  toggle: () => set({ selfCheckEnabled: !get().selfCheckEnabled }),
}))
