import type { AssetFileInfo } from '../types'

/**
 * FileManager 抽象接口
 * Phase 1a: InMemoryFileManager（内存 Map）
 * Phase 1b: ElectronFileManager（通过 IPC 调用主进程）
 *
 * v4 精简版：移除了快照相关方法（saveApprovedSnapshot / getApprovedSnapshot / clearSnapshot）
 */
export interface FileManager {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  clearFile(path: string): Promise<void>
  listAssetFiles(): Promise<AssetFileInfo[]>
  clearAll(): Promise<void>
  /** 按 prefix 清理所有匹配的已知资产(v6.1 pipeline 临件回收 _seq/<ID>/ 等;v6.2 起 scene_beats 已不再调用,接口保留供未来他用)，双维护 files Map 与 knownAssetPaths Set 防幽灵条目残留 */
  clearByPrefix(prefix: string): Promise<void>
}

/**
 * 内存型 FileManager（Phase 1a）
 *
 * 所有文件保存在 Map<string, string> 中。
 * 刷新页面后丢失（Phase 1a 非持久化版本）。
 */
export class InMemoryFileManager implements FileManager {
  private files: Map<string, string> = new Map()
  private knownAssetPaths: Set<string> = new Set()

  constructor(knownFiles: string[] = []) {
    for (const path of knownFiles) {
      this.knownAssetPaths.add(path)
    }
  }

  // ===== 基础 CRUD =====

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) {
      throw new Error(`文件不存在: ${path}`)
    }
    return content
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
    this.knownAssetPaths.add(path)
  }

  async clearFile(path: string): Promise<void> {
    this.files.delete(path)
  }

  // ===== 清空所有 =====

  async clearAll(): Promise<void> {
    this.files.clear()
  }

  /**
   * 按 prefix 清理所有匹配的已知资产(v6.1)
   *
   * 双维护 files Map 与 knownAssetPaths Set 二者，
   * 防 clearFile 只清前者导致 listAssetFiles 反复吐 exists:false 幽灵条目污染 UI 卡片面板。
   * v6.1 主要用途:scene_beats pipeline assemble 成功后回收 _seq/<ID>/*.md 临件;
   * v6.2 起 scene_beats 已改为内存传递不产临件,本接口不再被引擎自动调用,保留供未来场景。
   */
  async clearByPrefix(prefix: string): Promise<void> {
    const matched = Array.from(this.knownAssetPaths).filter((p) =>
      p.startsWith(prefix),
    )
    for (const p of matched) {
      this.files.delete(p)
      this.knownAssetPaths.delete(p)
    }
  }

  // ===== 资产文件列表 =====

  async listAssetFiles(): Promise<AssetFileInfo[]> {
    const result: AssetFileInfo[] = []
    for (const path of this.knownAssetPaths) {
      result.push({
        path,
        filename: path.replace(/\.md$/, ''),
        group: '',
        exists: this.files.has(path),
      })
    }
    return result
  }

  /** 注册额外的已知资产路径 */
  registerKnownPaths(paths: string[]): void {
    for (const path of paths) {
      this.knownAssetPaths.add(path)
    }
  }
}

/** 9 个资产文件路径（v5：删 plot_synopsis.md，加 foreshadowing/subplots/check/draft） */
export const DEFAULT_ASSET_PATHS = [
  'worldbuilding.md',
  'characters.md',
  'act_map.md',
  'sequence_list.md',
  'scene_beat_outline.md',
  'foreshadowing.md',
  'subplots.md',
  'user_requirements.md',
  '_check_report.md',
  'draft_history.md',
]
