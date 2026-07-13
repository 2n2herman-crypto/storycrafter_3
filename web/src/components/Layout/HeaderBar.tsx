import { useCallback } from 'react'
import type { ProjectMeta } from '../../api/projects'
import styles from './HeaderBar.module.css'

interface HeaderBarProps {
  title?: string
  onOpenSettings?: () => void
  /** v7.1 M4：多项目选择器（降级模式不传 → 隐藏） */
  projects?: ProjectMeta[]
  currentProject?: ProjectMeta | null
  onSwitchProject?: (p: ProjectMeta) => void | Promise<void>
  onCreateProject?: (name: string) => void | Promise<void>
  onDeleteProject?: (p: ProjectMeta) => void | Promise<void>
}

/**
 * 顶栏（v7.1 改动1：瘦身）
 * 只保留：品牌标识 + 项目选择器/新建/删除 + 设置入口。
 * 产品选择器 → 下放到 ModeBar；阶段切换 → 下放到对话流 StageCard；进度概览 → 资产面板顶部。
 */
export function HeaderBar({
  title = 'StoryCrafter',
  onOpenSettings,
  projects,
  currentProject,
  onSwitchProject,
  onCreateProject,
  onDeleteProject,
}: HeaderBarProps) {
  const handleCreate = useCallback(() => {
    if (!onCreateProject) return
    const name = window.prompt('新项目名称')
    if (name?.trim()) void onCreateProject(name.trim())
  }, [onCreateProject])

  const handleDelete = useCallback(() => {
    if (!onDeleteProject || !currentProject) return
    const ok = window.confirm(`确定删除项目「${currentProject.name}」吗？该项目的所有资产与对话记录将永久删除，无法恢复。`)
    if (ok) void onDeleteProject(currentProject)
  }, [onDeleteProject, currentProject])

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.brandDot} />
        <span className={styles.logo}>{title}</span>
        <span className={styles.brandSub}>STORY STUDIO</span>
      </div>

      {/* v7.1 M4：多项目选择器（降级模式隐藏） */}
      {projects && currentProject && onSwitchProject && (
        <div className={styles.projectSelector}>
          <select
            className={styles.projectSelect}
            value={currentProject.id}
            onChange={(e) => {
              const p = projects.find((item) => item.id === e.target.value)
              if (p) void onSwitchProject(p)
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {onCreateProject && (
            <button
              className={styles.newProjectBtn}
              onClick={handleCreate}
              title="新建项目"
            >
              +
            </button>
          )}
          {onDeleteProject && projects.length > 1 && (
            <button
              className={styles.deleteProjectBtn}
              onClick={handleDelete}
              title="删除当前项目"
              aria-label="删除当前项目"
            >
              ×
            </button>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {/* v7.1：设置入口 */}
        {onOpenSettings && (
          <button
            className={styles.iconBtn}
            onClick={onOpenSettings}
            title="设置"
          >
            ⚙
          </button>
        )}
      </div>
    </header>
  )
}
