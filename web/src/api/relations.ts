/**
 * 文件关系系统预留 API（v7.1 M6）。
 * 当前后端端点返回 501，此处仅为前端调用方预留契约；调用会抛 ApiRequestError，
 * 调用方应自行 catch。未来文件关系系统实现后，此处补全真实读写。
 */
import { apiFetch } from './client'
import type { AssetRelation } from '../types'

/** 列出项目内资产关系（当前后端 501） */
export async function listRelations(projectId: string): Promise<AssetRelation[]> {
  const data = await apiFetch<AssetRelation[]>(`/api/projects/${projectId}/relations`)
  return Array.isArray(data) ? data : []
}

/** 创建一条资产关系（当前后端 501） */
export async function createRelation(
  projectId: string,
  relation: AssetRelation,
): Promise<void> {
  await apiFetch(`/api/projects/${projectId}/relations`, {
    method: 'POST',
    body: JSON.stringify(relation),
  })
}
