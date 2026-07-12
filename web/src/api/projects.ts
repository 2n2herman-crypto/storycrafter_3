import { apiFetch } from './client'

export interface ProjectMeta {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
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

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
}
