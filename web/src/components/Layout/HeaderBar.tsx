import { useState, useCallback } from 'react'
import { usePhaseStore } from '../../store/phaseStore'
import { useAssetStore } from '../../store/assetStore'
import { useChatStore } from '../../store/chatStore'
import { PRODUCT_PROFILES } from '../../types/product'
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
}

export function HeaderBar({
  title = 'StoryCrafter',
  onOpenSettings,
  projects,
  currentProject,
  onSwitchProject,
  onCreateProject,
}: HeaderBarProps) {
  const phase = usePhaseStore((s) => s.phase)
  const lock = usePhaseStore((s) => s.lock)
  const product = useChatStore((s) => s.product)
  const setProduct = useChatStore((s) => s.setProduct)
  const phaseLock = useCallback(
    () => {
      const fm = useAssetStore.getState().fileManager
      if (fm) lock(fm)
    },
    [lock],
  )
  const [progressOpen, setProgressOpen] = useState(false)

  // v6.4：写作进度概览——统计章数/序列数
  const cards = useAssetStore((s) => s.getAssetList())
  const chapterCards = cards.filter((c) => c.path.startsWith('chapters/'))
  const sequenceCards = cards.filter((c) => c.path.startsWith('sequences/'))
  const totalChapters = sequenceCards.length
  const writtenCount = chapterCards.length
  const sequenceChapters = sequenceCards.map((seq) => {
    const seqId = seq.path.replace(/^sequences\//, '').replace(/\.md$/, '')
    const chapter = chapterCards.find((c) => c.metaInfo === seqId)
    return {
      seq: seqId,
      chapterPath: chapter?.path,
      wordCount: chapter?.wordCount,
    }
  })

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark}>
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className={styles.logo}>
          {title}
          <span className={styles.version}>v6.6</span>
        </span>
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
              onClick={() => {
                const name = window.prompt('新项目名称')
                if (name?.trim()) void onCreateProject(name.trim())
              }}
              title="新建项目"
            >
              +
            </button>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {/* v6.6：产品方向选择器（设计期+未选产品时可选；选定后显示徽标，切换须 reset_all）*/}
        {product !== null ? (
          <span className={styles.productBadge} title="产品方向已锁定，切换需重置">
            {PRODUCT_PROFILES[product].displayName}
          </span>
        ) : phase === 'designing' ? (
          <div className={styles.productSelector}>
            {Object.values(PRODUCT_PROFILES).map((p) => (
              <button
                key={p.kind}
                className={styles.productBtn}
                onClick={() => setProduct(p.kind)}
                title={`选择 ${p.displayName} 方向`}
              >
                {p.displayName}
              </button>
            ))}
          </div>
        ) : (
          <span className={styles.productHint}>未选产品</span>
        )}

        {/* v6.4：Phase Gate 锁/解锁 CTA + 进度概览 */}
        {/* 进度概览 */}
        {phase === 'writing' && (
          <div
            className={styles.progressBadge}
            onClick={() => setProgressOpen((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setProgressOpen((v) => !v) } }}
          >
            已写 {writtenCount} 章 / 共 {totalChapters} 序列
            <span className={styles.progressArrow}>{progressOpen ? '▴' : '▾'}</span>
            {progressOpen && (
              <div className={styles.progressPanel}>
                {sequenceChapters.map(({ seq, chapterPath, wordCount }) => (
                  <div key={seq} className={styles.progressRow}>
                    <span className={styles.progressSeq}>{seq}</span>
                    <span className={styles.progressStatus}>
                      {chapterPath ? `✅ ${wordCount && wordCount > 0 ? `${wordCount}字` : '--'}` : '⬜ 未开始'}
                    </span>
                  </div>
                ))}
                {sequenceChapters.length === 0 && (
                  <div className={styles.progressEmpty}>暂无序列，先去设计期生成大纲</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 锁/解锁按钮 */}
        <button
          className={`${styles.phaseBtn} ${phase === 'writing' ? styles.phaseBtnLocked : styles.phaseBtnUnlocked}`}
          onClick={phaseLock}
          title={phase === 'writing' ? '解锁回设计期' : '锁定大纲→进入写作期'}
        >
          {phase === 'writing' ? '🔒 写作期' : '🔓 设计期'}
        </button>

        {/* v7.1：设置入口 */}
        {onOpenSettings && (
          <button
            className={styles.phaseBtn}
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
