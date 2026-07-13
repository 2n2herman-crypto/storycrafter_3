import { useCallback } from 'react'
import { useChatStore } from '../../store/chatStore'
import { PRODUCT_PROFILES, type ProductKind } from '../../types/product'
import styles from './ModeBar.module.css'

/**
 * 创作模式选择器（v7.1 改动2：从 HeaderBar 下放到对话底部 sc-mode-bar）
 *
 * 交互规则：
 *   - 未选产品：四按钮可点 → setProduct（内部 engine.lockProfile）
 *   - 已选产品：立即折叠为单个已选按钮并锁定，不可撤销（仅 reset_all 可解）
 *
 * 数据源完全复用 chatStore，不新增 state。
 */
export function ModeBar() {
  const product = useChatStore((s) => s.product)
  const setProduct = useChatStore((s) => s.setProduct)
  const isProcessing = useChatStore((s) => s.isProcessing)

  // 一经选定即锁定折叠（不可撤销）
  const locked = product !== null

  const handleClick = useCallback(
    (kind: ProductKind) => {
      if (isProcessing || locked) return
      setProduct(kind)
    },
    [locked, isProcessing, setProduct],
  )

  const profiles = Object.values(PRODUCT_PROFILES)

  return (
    <div className={`${styles.modeBar} ${locked ? styles.locked : ''}`}>
      <span className={styles.label}>{locked ? '模式已锁定' : '创作模式'}</span>
      <div className={styles.switcher} role="radiogroup" aria-label="创作模式">
        {profiles.map((p) => {
          const active = product === p.kind
          // 锁定态只保留 active 按钮可见（CSS 收起其余），此处仅控制 disabled
          return (
            <button
              key={p.kind}
              type="button"
              role="radio"
              aria-checked={active}
              className={`${styles.btn} ${active ? styles.active : ''}`}
              disabled={locked || isProcessing}
              onClick={() => handleClick(p.kind)}
              title={
                locked
                  ? active
                    ? '已锁定该创作模式（重置后可重选）'
                    : ''
                  : `选择 ${p.displayName} 方向`
              }
            >
              {p.displayName}
            </button>
          )
        })}
      </div>
    </div>
  )
}
