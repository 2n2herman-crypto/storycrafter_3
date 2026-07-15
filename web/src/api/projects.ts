import { apiFetch } from './client'
import type { ProductKind } from '../types/product'
import type { StoryPhase } from '../store/phaseStore'

export interface ProjectMeta {
  id: string
  name: string
  description?: string
  productKind?: ProductKind
  phase?: StoryPhase
  stageProposalPending?: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectPatch {
  name?: string
  description?: string
  /** null 表示项目尚未选择产品方向（用于新项目与旧数据迁移） */
  productKind?: ProductKind | null
  phase?: StoryPhase
  stageProposalPending?: boolean
}

export function listProjects(): Promise<ProjectMeta[]> {
  return apiFetch<ProjectMeta[]>('/api/projects')
}

export function createProject(name: string): Promise<ProjectMeta> {
  return apiFetch<ProjectMeta>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function getProject(id: string): Promise<ProjectMeta> {
  return apiFetch<ProjectMeta>(`/api/projects/${id}`)
}

export function updateProject(id: string, patch: ProjectPatch): Promise<ProjectMeta> {
  return apiFetch<ProjectMeta>(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
}
