import { useCallback } from 'react'
import { useChatStore } from '../../store/chatStore'
import { usePhaseStore, LOCKED_STATIC_PATHS } from '../../store/phaseStore'
import { useAssetStore } from '../../store/assetStore'
import type { ChatMessage } from '../../types'
import styles from './StageCard.module.css'

/**
 * StageCard（v7.1 改动3：阶段选择下放到对话流，配色对齐设计稿 v8 sc-stage-card）
 *
 * 由引擎探测"全部场记完成且仍处设计期"后，chatStore 追加一条 kind='stage_proposal' 消息渲染。
 * 交互完全复用 phaseStore：选「写作阶段」→ lock(fm)；选「设计阶段」→ writing 期 unlock、否则 NOP。
 * 写作阶段选项仅在满足 lock 前置（六项核心设定齐全 + ≥1 场记）时可点，否则 disabled + 提示缺失项。
 */
export function StageCard({ msg }: { msg: ChatMessage }) {
  const resolveStage = useChatStore((s) => s.resolveStage)
  const phase = usePhaseStore((s) => s.phase)
  const assets = useAssetStore((s) => s.assets)

  const resolved = msg.stageState === 'resolved'
  // 当前选中态：已 resolved 取落定值，否则跟随实时 phase
  const selected = resolved ? msg.resolvedStage : phase

  // 写作阶段可用性：六项核心设定非空 + 至少一个场记切片
  const missing = LOCKED_STATIC_PATHS.filter((p) => !assets[p]?.content?.trim())
  const hasSequence = Object.entries(assets).some(
    ([p, a]) => p.startsWith('sequences/') && a.content?.trim(),
  )
  const writingReady = missing.length === 0 && hasSequence
  const writingHint = !writingReady
    ? missing.length > 0
      ? `尚缺核心设定：${missing.map((p) => p.replace(/\.md$/, '')).join('、')}`
      : '至少需要一个已完成的场记切片'
    : ''

  const handleSelect = useCallback(
    (stage: 'designing' | 'writing') => {
      if (resolved) return
      if (stage === 'writing' && !writingReady) return
      void resolveStage(msg.id, stage)
    },
    [resolved, writingReady, resolveStage, msg.id],
  )

  return (
    <div className={styles.card}>
      <div className={styles.title}>请选择创作阶段</div>
      <div className={styles.desc}>
        {resolved
          ? `已进入${selected === 'writing' ? '写作' : '设计'}阶段。`
          : '设计阶段构建骨架，写作阶段填充血肉。可随时切换。'}
      </div>
      <div className={styles.options} role="radiogroup" aria-label="创作阶段">
        <button
          type="button"
          role="radio"
          aria-checked={selected === 'designing'}
          className={`${styles.option} ${selected === 'designing' ? styles.active : ''}`}
          disabled={resolved}
          onClick={() => handleSelect('designing')}
        >
          <span className={styles.icon}>设</span>
          <span>
            <span className={styles.name}>设计阶段</span>
            <span className={styles.copy}>世界观、角色、幕结构、序列规划、伏笔设计</span>
          </span>
          <span className={styles.check} />
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={selected === 'writing'}
          className={`${styles.option} ${selected === 'writing' ? styles.active : ''}`}
          disabled={resolved || !writingReady}
          onClick={() => handleSelect('writing')}
          title={writingHint}
        >
          <span className={styles.icon}>写</span>
          <span>
            <span className={styles.name}>写作阶段</span>
            <span className={styles.copy}>
              {writingReady ? '场景生成、对白润色、节拍展开、成稿输出' : writingHint}
            </span>
          </span>
          <span className={styles.check} />
        </button>
      </div>
    </div>
  )
}
