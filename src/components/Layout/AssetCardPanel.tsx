import { useEffect, useRef, useState } from 'react'
import type { AssetCardData, AssetStatus } from '../../types'
import { AssetCard } from '../AssetCard'
import styles from './AssetCardPanel.module.css'

interface AssetCardPanelProps {
  cards: AssetCardData[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

/** 分组后的卡片列表 */
interface GroupedCards {
  group: string
  cards: AssetCardData[]
}

// ===== 聚合常量 =====

/** 进入折叠视图的分组名（其余组保持平铺） */
const COLLAPSIBLE_GROUPS = new Set(['大纲切片', '剧本正文'])

/** 子项数量 ≤ 此值时降级为平铺（不折叠） */
const COLLAPSE_MIN_COUNT = 2

// ===== 聚合状态类型 =====

type GroupStatus =
  | { kind: 'idle' }              // 全 pending
  | { kind: 'partial'; done: number; total: number }  // 部分生成
  | { kind: 'ready' }             // 全 generated
  | { kind: 'modified'; count: number }  // 有 modified

function aggregate(cards: AssetCardData[]): GroupStatus {
  const modified = cards.filter((c) => c.status === 'modified').length
  const generated = cards.filter((c) => c.status === 'generated').length
  const pending = cards.filter((c) => c.status === 'pending').length
  const total = cards.length

  if (modified > 0) return { kind: 'modified', count: modified }
  if (generated === total) return { kind: 'ready' }
  if (pending === total) return { kind: 'idle' }
  return { kind: 'partial', done: generated, total }
}

function statusIconAndLabel(status: GroupStatus): { icon: string; label: string } {
  switch (status.kind) {
    case 'idle': return { icon: '○', label: '待生成' }
    case 'partial': return { icon: '◔', label: `${status.done}/${status.total} 已生成` }
    case 'ready': return { icon: '✓', label: '全部就绪' }
    case 'modified': return { icon: '●', label: `${status.count} 项已更新` }
  }
}

/** 按 group 对卡片进行分组 */
function groupBySection(cards: AssetCardData[]): GroupedCards[] {
  const groups = new Map<string, AssetCardData[]>()
  for (const card of cards) {
    const g = groups.get(card.group) || []
    g.push(card)
    groups.set(card.group, g)
  }
  return Array.from(groups.entries()).map(([group, groupCards]) => ({
    group,
    cards: groupCards,
  }))
}

// ===== 可折叠分组子组件 =====

interface CollapsibleSectionProps {
  group: string
  cards: AssetCardData[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

function CollapsibleSection({
  group,
  cards,
  selectedPath,
  onSelect,
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const prevStatusRef = useRef<Map<string, AssetStatus>>(new Map())
  const status = aggregate(cards)
  const { icon: statusIcon, label: statusLabel } = statusIconAndLabel(status)

  // 有 modified 子项时自动展开（只在 pending→modified 跳变时触发一次，避免抖动）
  useEffect(() => {
    const prev = prevStatusRef.current
    let shouldExpand = false
    for (const card of cards) {
      const prevStatus = prev.get(card.path)
      if (prevStatus === 'pending' && card.status === 'modified') {
        shouldExpand = true
        break
      }
    }
    if (shouldExpand) setExpanded(true)
    // 记录当前状态供下次比较
    for (const card of cards) {
      prev.set(card.path, card.status)
    }
  }, [cards])

  // 子项 ≤2 降级为平铺——不套折叠壳
  if (cards.length <= COLLAPSE_MIN_COUNT) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionLabel}>{group}</div>
        {cards.map((card) => (
          <AssetCard
            key={card.path}
            data={card}
            isSelected={card.path === selectedPath}
            onSelect={() => onSelect(card.path)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <div
        className={styles.groupHeader}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
      >
        <span className={styles.groupArrow}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.groupTitle}>{group}</span>
        <span className={styles.groupCount}>
          ({cards.length})
        </span>
        <span className={styles.groupStatusBadge} data-kind={status.kind}>
          {statusIcon} {statusLabel}
        </span>
      </div>
      {expanded && (
        <div className={styles.subList}>
          {cards.map((card) => (
            <AssetCard
              key={card.path}
              data={card}
              isSelected={card.path === selectedPath}
              onSelect={() => onSelect(card.path)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 主组件 =====

export function AssetCardPanel({
  cards,
  selectedPath,
  onSelect,
}: AssetCardPanelProps) {
  const sections = groupBySection(cards)

  if (cards.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.title}>资产卡片</div>
        </div>
        <div className={styles.body}>
          <div className={styles.empty}>暂无资产卡片</div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.title}>资产卡片</div>
      </div>
      <div className={styles.body}>
        {sections.map(({ group, cards: sectionCards }) =>
          COLLAPSIBLE_GROUPS.has(group) ? (
            <CollapsibleSection
              key={group}
              group={group}
              cards={sectionCards}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ) : (
            <div key={group} className={styles.section}>
              <div className={styles.sectionLabel}>{group}</div>
              {sectionCards.map((card) => (
                <AssetCard
                  key={card.path}
                  data={card}
                  isSelected={card.path === selectedPath}
                  onSelect={() => onSelect(card.path)}
                />
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  )
}
