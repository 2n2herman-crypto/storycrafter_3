import { useState } from 'react'
import type { FileManager } from '../../orchestrator/fileManager'
import { mergeAllSequenceOutlines, mergeSingleSequenceOutline, type MergeResult } from '../../orchestrator/outlineMerger'
import { updateProject } from '../../api/projects'
import { useAssetStore } from '../../store/assetStore'
import { usePhaseStore } from '../../store/phaseStore'
import { useSelfCheckStore } from '../../store/selfCheckStore'
import styles from './BottomPanel.module.css'

interface SelfCheckToggleProps {
  className?: string
}

export function SelfCheckToggle({ className }: SelfCheckToggleProps) {
  const selfCheckEnabled = useSelfCheckStore((s) => s.selfCheckEnabled)
  const toggle = useSelfCheckStore((s) => s.toggle)
  return (
    <button
      className={`${styles.selfCheckBtn}${className ? ` ${className}` : ''}`}
      onClick={toggle}
      title={selfCheckEnabled ? '点击关闭自检模式（质检 subagent 将不再参与调度）' : '点击开启自检模式'}
    >
      自检：{selfCheckEnabled ? '开' : '关'}
    </button>
  )
}

interface DesignProgressBarProps {
  fileManager: FileManager | null | undefined
  projectId?: string
  placement?: 'dialogue' | 'asset'
}

/**
 * v7.3/v7.9.1：设计完整度进度条。
 * 位置从资产栏迁移到对话栏底部，作为“进入写作模式”的显式行动区。
 */
export function DesignProgressBar({ fileManager, projectId, placement = 'dialogue' }: DesignProgressBarProps) {
  const { numerator, denominator, seqIds } = useAssetStore((s) => s.getDesignCompleteness())
  const [merging, setMerging] = useState(false)
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null)

  const canEnter = denominator > 0 && numerator === denominator && !merging

  const handleEnterWritingMode = async () => {
    if (!fileManager) return
    const confirmed = window.confirm(
      `即将合并并锁定以下 ${seqIds.length} 个序列的序列层/场景层/节拍层：\n${seqIds.join('、')}\n\n合并后这些文件将不可编辑，确认继续？`,
    )
    if (!confirmed) return

    setMerging(true)
    try {
      const result = await mergeAllSequenceOutlines(fileManager)
      setMergeResult(result)
      for (const seqId of result.succeeded) {
        usePhaseStore.getState().lockSequenceFiles(seqId)
      }
      if (result.succeeded.length > 0) {
        await usePhaseStore.getState().lock(fileManager)
        if (projectId) await updateProject(projectId, { phase: 'writing' })
        await useAssetStore.getState().refreshAllFiles()
      }
    } catch (e) {
      alert(`进入写作模式失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMerging(false)
    }
  }

  const handleRetrySingle = async (seqId: string) => {
    if (!fileManager) return
    const result = await mergeSingleSequenceOutline(fileManager, seqId)
    if (result.ok) {
      usePhaseStore.getState().lockSequenceFiles(seqId)
      await useAssetStore.getState().refreshAllFiles()
      setMergeResult((prev) =>
        prev ? { succeeded: [...prev.succeeded, seqId], failed: prev.failed.filter((f) => f.seqId !== seqId) } : prev,
      )
    } else {
      alert(`序列 ${seqId} 仍未通过：${result.reason}`)
    }
  }

  if (denominator === 0) return null

  return (
    <div className={`${styles.designProgress}${placement === 'asset' ? ` ${styles.designProgressAsset}` : ''}`}>
      <div className={styles.designProgressMeta}>
        <span>设计进度</span>
        <span>{numerator}/{denominator}</span>
      </div>
      <div className={styles.designProgressRow}>
        <progress className={styles.designProgressBar} value={numerator} max={denominator} />
        <button
          className={styles.designProgressBtn}
          disabled={!canEnter}
          onClick={handleEnterWritingMode}
          title={canEnter ? '合并全部序列细纲并进入写作模式' : '需要全部序列的序列层/场景层/节拍层生成完毕'}
        >
          {merging ? '合并中…' : '进入写作模式'}
        </button>
      </div>
      {mergeResult && mergeResult.failed.length > 0 && (
        <div className={styles.designProgressFails}>
          {mergeResult.failed.map(({ seqId, reason }) => (
            <div key={seqId} className={styles.designProgressFailItem}>
              <span>序列 {seqId} 未通过：{reason}</span>
              <button className={styles.designProgressRetryBtn} onClick={() => handleRetrySingle(seqId)}>重试</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
