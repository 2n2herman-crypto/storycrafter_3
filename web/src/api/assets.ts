import { apiFetch } from './client'
import type { FileManager } from '../orchestrator/fileManager'
import type { AssetFileInfo } from '../types'

interface AssetEntry {
  path: string
  size: number
  updatedAt: string
}

interface AssetContent {
  path: string
  content: string
  updatedAt: string
}

/**
 * HTTP 型 FileManager（v7.1 M3）
 *
 * 六方法逐字对齐 FileManager 接口，所有操作经 /api/projects/:id/assets/*。
 * 资产落 server/data/projects/<id>/assets/*.md，刷新页面不丢。
 * clearByPrefix 无后端端点，前端编排 list+逐个 delete（v6.2 起无调用方，保留以满足接口）。
 * listAssetFiles 返回的 AssetFileInfo.exists 恒为 true（后端只列已存在文件；
 * assetStore 只消费 exists:true，行为与 InMemoryFileManager 等价）。
 */
export class HttpFileManager implements FileManager {
  constructor(private projectId: string) {}

  private base(): string {
    return `/api/projects/${this.projectId}/assets`
  }

  async readFile(path: string): Promise<string> {
    const r = await apiFetch<AssetContent>(`${this.base()}/${path}`)
    return r.content
  }

  async writeFile(path: string, content: string): Promise<void> {
    await apiFetch(`${this.base()}/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    })
  }

  async clearFile(path: string): Promise<void> {
    await apiFetch(`${this.base()}/${path}`, { method: 'DELETE' })
  }

  async listAssetFiles(): Promise<AssetFileInfo[]> {
    const entries = await apiFetch<AssetEntry[]>(this.base())
    return entries.map((e) => ({
      path: e.path,
      filename: e.path.replace(/\.md$/, ''),
      group: '',
      exists: true,
    }))
  }

  async clearAll(): Promise<void> {
    await apiFetch(this.base(), { method: 'DELETE' })
  }

  async clearByPrefix(prefix: string): Promise<void> {
    const files = await this.listAssetFiles()
    const matched = files.filter((f) => f.path.startsWith(prefix))
    await Promise.all(matched.map((f) => this.clearFile(f.path)))
  }
}
