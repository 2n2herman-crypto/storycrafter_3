import { create } from 'zustand'
import type { FileManager } from '../orchestrator/fileManager'

/**
 * Phase Store（v6.1 阶段闸门状态层）
 *
 * 把「设计期 designing」与「落地期 writing」物理隔开：
 *   - lock(fm)：校验六项核心静态设定齐全且非空、收集现有 sequences/*.md 全员清单，
 *               全体拍照存入 baselines 作 UI 对照基线；置 phase='writing'。
 *   - unlock()：回退 phase 并清空快照，**保留 chapters/ 正文成果**
 *               （解锁是为了回去微调设定再续写不该丢稿子）。
 *   - reset()：彻底归位至初始 designing 空 baselines（供 reset_all 触发联动）。
 *   - isLockedPath(p)/getBaseline(p)：分别服务引擎 Guard 判定与 BaselinePanel 渲染。
 *
 * 选独立 store 而非扩 InMemoryFileManager 接口的理由：snapshot 仅服务于前端对照视图与门控判定，
 * 不应渗入 Electron 主进程 IPC 语义故留前端内存层即可；将来实现持久化版本亦不必被迫照搬这套接口。
 */

export type StoryPhase = 'designing' | 'writing'

/**
 * 固定的六项静态锁定资产（per-sequence 化后的第七项改为运行时按 _seq_/_sequences_ 前缀动态展开）。
 *
 * 注：不含 user_requirements.md（元数据始终可更新）、_check_report.md/draft_history.md/chapters/*
 * （写作期产物本身就该可写）。原 monolithic 时代的 scene_beat_outline.md 字面值随四步流水线改造退出历史舞台。
 */
export const LOCKED_STATIC_PATHS = [
  'worldbuilding.md',
  'characters.md',
  'act_map.md',
  'sequence_list.md',
  'foreshadowing.md',
  'subplots.md',
] as readonly string[]

/** 运行时按此前缀枚举已生成的场记切片并入锁定集（pipeline 终步成品所在目录）*/
const DYNAMIC_LOCKED_PREFIX = 'sequences/'

interface PhaseState {
  phase: StoryPhase
  /** key=path,value=lock() 当时的 content snapshot；含六项静态常数 + 所有现存 sequences/<ID>.md 条目 */
  baselines: Record<string, string>
  /** 写作期内记录当时存在过的 sequences paths 供 isLockedPath 精确判别是否属冻结集 */
  lockedSequencePaths: Set<string>

  lock: (fm: FileManager) => Promise<void>
  unlock: () => void
  reset: () => void
  isWriting: () => boolean
  isDesigning: () => boolean
  /** 某 path 是否落入冻结保护集（仅 writing 期为真）；含六项静态常量 + lockedSequencePaths 动态成员 */
  isLockedPath: (path: string) => boolean
  /** 取某 path 的 baseline 内容（undefined 表示未纳入或非 writing 期） */
  getBaseline: (path: string) => string | undefined
}

async function readIfExists(fm: FileManager, p: string): Promise<string> {
  try {
    return await fm.readFile(p)
  } catch {
    return ''
  }
}

/** 枚举当前 fileManager 下所有已实际写盘的 sequences/*.md 路径（pipeline 终品全集） */
async function collectExistingSequences(fm: FileManager): Promise<string[]> {
  const all = await fm.listAssetFiles()
  return all
    .filter((a) => a.path.startsWith(DYNAMIC_LOCKED_PREFIX) && a.exists)
    .map((a) => a.path)
}

export const usePhaseStore = create<PhaseState>((set, get) => ({
  phase: 'designing',
  baselines: {},
  lockedSequencePaths: new Set(),

  async lock(fm) {
    // 六项静态核心必须齐备非空；缺任一直接抛错附缺失名单让上层 toast 提示用户补全再来
    const missing: string[] = []
    for (const p of LOCKED_STATIC_PATHS) {
      const c = await readIfExists(fm, p)
      if (!c || c.length === 0) missing.push(p)
    }
    if (missing.length > 0) {
      throw new Error(`以下核心设定尚未就绪，暂不能进入写作期:${missing.join('、')}`)
    }

    const seqPaths = await collectExistingSequences(fm)

    // 全员拍照存入 baselines（UI 左视窗对照数据源）
    const snap: Record<string, string> = {}
    for (const p of [...LOCKED_STATIC_PATHS, ...seqPaths]) {
      snap[p] = await readIfExists(fm, p)
    }

    set({
      phase: 'writing',
      baselines: snap,
      lockedSequencePaths: new Set(seqPaths),
    })
  },

  unlock() {
    set({
      phase: 'designing',
      baselines: {},
      lockedSequencePaths: new Set(),
    })
  },

  reset() {
    set({
      phase: 'designing',
      baselines: {},
      lockedSequencePaths: new Set(),
    })
  },

  isWriting() {
    return get().phase === 'writing'
  },

  isDesigning() {
    return get().phase === 'designing'
  },

  isLockedPath(path) {
    const s = get()
    if (s.phase !== 'writing') return false
    return (
      LOCKED_STATIC_PATHS.includes(path) || s.lockedSequencePaths.has(path)
    )
  },

  getBaseline(path) {
    const s = get()
    if (s.phase !== 'writing') return undefined
    return s.baselines[path]
  },
}))
