import { useEffect, useRef, useState } from 'react'
import type { AssetCardData, AssetStatus } from '../../types'
import { AssetCard } from '../AssetCard'
import { useUIStore } from '../../store/uiStore'
import { usePhaseStore } from '../../store/phaseStore'
import { useAssetStore } from '../../store/assetStore'
import { buildAllMarkdown, downloadText, triggerDownload } from '../../utils/exportMd'
import { exportDocx } from '../../api/importExport'
import styles from './AssetCardPanel.module.css'

interface AssetCardPanelProps {
  cards: AssetCardData[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /** v7.1 改动5：Word 全量导出是否可用（降级模式无后端 → 关闭） */
  wordExportAvailable?: boolean
}

/** 分组后的卡片列表 */
interface GroupedCards {
  group: string
  cards: AssetCardData[]
}

// ===== 聚合常量 =====

/** 进入折叠视图的分组名（其余组保持平铺） */
const COLLAPSIBLE_GROUPS = new Set(['细纲', '剧本'])

/** 子项数量 ≤ 此值时降级为平铺（不折叠） */
const COLLAPSE_MIN_COUNT = 2

/** v6.4: 写作期父级折叠的组名 */
const PARENT_DESIGN_GROUP = '大纲设计'

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
  /** v6.4：外部控制的折叠状态（可选） */
  expanded?: boolean
  /** v6.4：外部控制的折叠切换回调（可选） */
  onToggle?: () => void
  /** v6.4：强制折叠壳（即使子项 ≤2 也套壳） */
  forceCollapse?: boolean
}

function CollapsibleSection({
  group,
  cards,
  selectedPath,
  onSelect,
  expanded: externalExpanded,
  onToggle,
  forceCollapse,
}: CollapsibleSectionProps) {
  const [localExpanded, setLocalExpanded] = useState(false)
  const prevStatusRef = useRef<Map<string, AssetStatus>>(new Map())
  const status = aggregate(cards)
  const { icon: statusIcon, label: statusLabel } = statusIconAndLabel(status)

  // 展开/收起的控制权：外部传入则从外部读取，否则本地管理
  const expanded = externalExpanded !== undefined ? externalExpanded : localExpanded
  const toggleExpanded = onToggle ?? (() => setLocalExpanded((v) => !v))

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
    if (shouldExpand && onToggle) {
      onToggle() // 外部控制时通过回调
    } else if (shouldExpand) {
      setLocalExpanded(true)
    }
    // 记录当前状态供下次比较
    for (const card of cards) {
      prev.set(card.path, card.status)
    }
  }, [cards, onToggle])

  // 子项 ≤2 且非强制折叠状态 → 降级为平铺
  if (!forceCollapse && cards.length <= COLLAPSE_MIN_COUNT) {
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
        onClick={toggleExpanded}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded() } }}
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

// ===== 全量导出头部 =====

interface ExportHeaderProps {
  cards: AssetCardData[]
  wordExportAvailable?: boolean
}

/**
 * v7.1 改动5：资产面板全量导出。
 * 把所有已生成/已修改资产的内容按卡片顺序合并为单一 Markdown（buildAllMarkdown），
 * MD 纯前端下载；Word 复用后端 /api/export/docx 单次转换（降级模式关闭）。
 */
function ExportHeader({ cards, wordExportAvailable }: ExportHeaderProps) {
  const [exporting, setExporting] = useState(false)
  const assets = useAssetStore((s) => s.assets)

  const items = cards
    .map((c) => ({ title: c.filename, content: assets[c.path]?.content ?? '' }))
    .filter((it) => it.content.trim())
  const hasContent = items.length > 0

  const handleExportMd = () => {
    downloadText('全量资产.md', buildAllMarkdown(items))
  }

  const handleExportWord = async () => {
    setExporting(true)
    try {
      const blob = await exportDocx(buildAllMarkdown(items), '全量资产')
      triggerDownload(blob, '全量资产.docx')
    } catch (e) {
      alert(`Word 导出失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={styles.panelHeader}>
      <div className={styles.title}>资产卡片</div>
      <div className={styles.exportGroup}>
        <button
          className={styles.exportBtn}
          onClick={handleExportMd}
          disabled={!hasContent}
          title={hasContent ? '导出全部资产为 Markdown' : '暂无可导出内容'}
        >
          全量 MD
        </button>
        <button
          className={styles.exportBtn}
          onClick={handleExportWord}
          disabled={!hasContent || exporting || !wordExportAvailable}
          title={
            !wordExportAvailable
              ? '降级模式下 Word 导出不可用'
              : hasContent
                ? '导出全部资产为 Word'
                : '暂无可导出内容'
          }
        >
          {exporting ? '导出中...' : '全量 Word'}
        </button>
      </div>
    </div>
  )
}

// ===== 主组件 =====

export function AssetCardPanel({
  cards,
  selectedPath,
  onSelect,
  wordExportAvailable,
}: AssetCardPanelProps) {
  const sections = groupBySection(cards)
  const phase = usePhaseStore((s) => s.phase)
  const collapsedSections = useUIStore((s) => s.collapsedSections)
  const toggleSection = useUIStore((s) => s.toggleSection)
  const setSectionCollapsed = useUIStore((s) => s.setSectionCollapsed)
  const prevPhaseRef = useRef(phase)

  // v6.4：phase 切换时联动折叠状态
  useEffect(() => {
    if (prevPhaseRef.current === 'designing' && phase === 'writing') {
      // 进入写作期：折叠所有非「剧本」组，展开「剧本」
      for (const { group } of sections) {
        if (group === '剧本') {
          setSectionCollapsed(group, false)
        } else {
          setSectionCollapsed(group, true)
        }
      }
      // 父级「大纲设计」默认折叠
      setSectionCollapsed(PARENT_DESIGN_GROUP, true)
    } else if (prevPhaseRef.current === 'writing' && phase === 'designing') {
      // 回到设计期：全部展开
      for (const { group } of sections) {
        setSectionCollapsed(group, false)
      }
      setSectionCollapsed(PARENT_DESIGN_GROUP, false)
    }
    prevPhaseRef.current = phase
  }, [phase, sections, setSectionCollapsed])

  if (cards.length === 0) {
    return (
      <div className={styles.panel}>
        <ExportHeader cards={cards} wordExportAvailable={wordExportAvailable} />
        <div className={styles.body}>
          <div className={styles.empty}>暂无资产卡片</div>
        </div>
      </div>
    )
  }

  // v6.4：写作期分组——「剧本」单独放，其余全部收入「大纲设计」父级
  const isWriting = phase === 'writing'
  const bodySections = sections.filter(({ group }) => group === '剧本')
  const designSections = sections.filter(({ group }) => group !== '剧本')

  // 设计期渲染：所有组独立折叠
  if (!isWriting) {
    return (
      <div className={styles.panel}>
        <ExportHeader cards={cards} wordExportAvailable={wordExportAvailable} />
        <div className={styles.body}>
          {sections.map(({ group, cards: sectionCards }) =>
            COLLAPSIBLE_GROUPS.has(group) ? (
              <CollapsibleSection
                key={group}
                group={group}
                cards={sectionCards}
                selectedPath={selectedPath}
                onSelect={onSelect}
                expanded={collapsedSections[group] === false ? true : collapsedSections[group] === true ? false : undefined}
                onToggle={() => toggleSection(group)}
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

  // 写作期渲染：「大纲设计」父级折叠 + 「剧本」独立折叠
  const designParentExpanded = collapsedSections[PARENT_DESIGN_GROUP] === false
  const allDesignCards = designSections.flatMap(({ cards: c }) => c)
  const designParentStatus = aggregate(allDesignCards)
  const { icon: dIcon, label: dLabel } = statusIconAndLabel(designParentStatus)

  return (
    <div className={styles.panel}>
      <ExportHeader cards={cards} wordExportAvailable={wordExportAvailable} />
      <div className={styles.body}>
        {/* 大纲设计 - 父级折叠 */}
        <div className={styles.section}>
          <div
            className={styles.groupHeader}
            onClick={() => toggleSection(PARENT_DESIGN_GROUP)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleSection(PARENT_DESIGN_GROUP)
              }
            }}
          >
            <span className={styles.groupArrow}>{designParentExpanded ? '▾' : '▸'}</span>
            <span className={styles.groupTitle}>🔒 {PARENT_DESIGN_GROUP}</span>
            <span className={styles.groupCount}>
              ({allDesignCards.length})
            </span>
            <span className={styles.groupStatusBadge} data-kind={designParentStatus.kind}>
              {dIcon} {dLabel}
            </span>
          </div>
          {designParentExpanded && (
            <div className={styles.subList}>
              {designSections.map(({ group, cards: sectionCards }) =>
                COLLAPSIBLE_GROUPS.has(group) ? (
                  <CollapsibleSection
                    key={group}
                    group={group}
                    cards={sectionCards}
                    selectedPath={selectedPath}
                    onSelect={onSelect}
                    expanded={collapsedSections[group] === false ? true : collapsedSections[group] === true ? false : undefined}
                    onToggle={() => toggleSection(group)}
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
          )}
        </div>

        {/* 剧本正文 */}
        {bodySections.map(({ group, cards: sectionCards }) =>
          COLLAPSIBLE_GROUPS.has(group) ? (
            <CollapsibleSection
              key={group}
              group={group}
              cards={sectionCards}
              selectedPath={selectedPath}
              onSelect={onSelect}
              expanded={collapsedSections[group] === false ? true : collapsedSections[group] === true ? false : undefined}
              onToggle={() => toggleSection(group)}
              forceCollapse={sectionCards.length > 0} // 写作期「剧本」始终套折叠壳
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
