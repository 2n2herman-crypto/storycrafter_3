import { useMemo } from 'react'
import type { ExecutionEvent } from '../../types'
import { HIDDEN_FROM_TIMELINE, getSubagentReason, getSubagentGlyph } from './subagentGlyphs'

export interface ExecutionStep {
  key: string
  toolId: string
  title: string
  reason: string
  glyph: string
  subtitle: string
  status: 'running' | 'done' | 'error'
  warnings?: string[]
}

/** v7.2：把 executionLog 派生成时间线用的 Step 列表（跳过隐藏名单内的机制性 Subagent） */
export function useExecutionSteps(executionLog: ExecutionEvent[]): ExecutionStep[] {
  return useMemo(() => {
    const steps: ExecutionStep[] = []
    let seq = 0

    const findLastRunning = () => {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].status === 'running') return steps[i]
      }
      return null
    }

    for (const event of executionLog) {
      switch (event.type) {
        case 'tool_start': {
          if (!event.toolId || HIDDEN_FROM_TIMELINE.has(event.toolId)) break
          seq += 1
          steps.push({
            key: `${event.toolId}_${seq}`,
            toolId: event.toolId,
            title: `调用：${event.toolName ?? event.toolId}`,
            reason: getSubagentReason(event.toolId, event.toolName ?? event.toolId),
            glyph: getSubagentGlyph(event.toolId, event.toolName ?? event.toolId),
            subtitle: event.instruction || '处理中…',
            status: 'running',
          })
          break
        }
        case 'tool_retry': {
          const running = findLastRunning()
          if (running) {
            running.subtitle = `重试中（第 ${event.attempt ?? '?'}/${event.maxAttempts ?? '?'} 次）`
          }
          break
        }
        case 'tool_complete': {
          const running = findLastRunning()
          if (running) {
            running.status = 'done'
            const warnCount = event.warnings?.length ?? 0
            running.subtitle = warnCount > 0 ? `含 ${warnCount} 条提示` : '已完成'
            running.warnings = event.warnings
          }
          break
        }
        case 'tool_error': {
          const running = findLastRunning()
          if (running) {
            running.status = 'error'
            running.subtitle = event.message
          }
          break
        }
        default:
          break // orchestrator_thinking / engine_complete / engine_error 不产生行
      }
    }

    return steps
  }, [executionLog])
}
