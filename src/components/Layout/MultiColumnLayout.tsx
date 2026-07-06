import { Fragment, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import styles from './MultiColumnLayout.module.css'
import { PanelResizer } from './PanelResizer'

interface MultiColumnLayoutProps {
  /** 各栏内容，从左到右 */
  columns: ReactNode[]
  /** 默认宽度占比（百分比），长度需与 columns 一致，和为 100 */
  defaultRatios?: number[]
  /** 每栏最小占比（百分比） */
  minRatio?: number
  /** 不可拖拽的边界索引（边界 i 位于第 i 栏与第 i+1 栏之间，该处不渲染分隔条） */
  fixedBoundaries?: number[]
}

export function MultiColumnLayout({
  columns,
  defaultRatios,
  minRatio = 15,
  fixedBoundaries = [],
}: MultiColumnLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initialRatios =
    defaultRatios && defaultRatios.length === columns.length
      ? defaultRatios
      : columns.map(() => 100 / columns.length)
  const [ratios, setRatios] = useState<number[]>(initialRatios)

  // 在第 index 栏与第 index+1 栏之间转移比例
  const handleResize = useCallback(
    (index: number, deltaX: number) => {
      if (!containerRef.current) return
      const containerWidth = containerRef.current.offsetWidth
      if (containerWidth <= 0) return

      const deltaPercent = (deltaX / containerWidth) * 100
      setRatios((prev) => {
        const left = prev[index] + deltaPercent
        const right = prev[index + 1] - deltaPercent
        // 任一侧触底则不调整，保证和恒为 100
        if (left < minRatio || right < minRatio) return prev
        const next = [...prev]
        next[index] = left
        next[index + 1] = right
        return next
      })
    },
    [minRatio],
  )

  return (
    <div className={styles.layout} ref={containerRef}>
      {columns.map((col, i) => (
        <Fragment key={i}>
          <div className={styles.panel} style={{ width: `${ratios[i]}%` }}>
            {col}
          </div>
          {i < columns.length - 1 &&
            (fixedBoundaries.includes(i) ? (
              <div className={styles.fixedDivider} />
            ) : (
              <PanelResizer onResize={(deltaX) => handleResize(i, deltaX)} />
            ))}
        </Fragment>
      ))}
    </div>
  )
}
