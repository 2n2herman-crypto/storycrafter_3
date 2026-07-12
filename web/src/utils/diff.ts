import { diffWords } from 'diff'
import type { DiffPart } from '../types'

/**
 * 词级 diff 计算
 *
 * 封装 diff.diffWords，返回结构化的 diff 片段数组。
 * 每个片段标记为 added / removed / 普通文本。
 *
 * 后续渲染策略（在 DiffViewer 中实现）：
 * - added → 包裹 <ins class="diff-add">
 * - removed → 包裹 <del class="diff-remove">
 * - 普通文本 → 直接保留
 * - 合并后的文本传给 react-markdown 渲染
 */
export function computeDiff(baseline: string, current: string): DiffPart[] {
  const changes = diffWords(baseline, current)
  return changes.map((part) => ({
    value: part.value,
    added: part.added,
    removed: part.removed,
  }))
}

/**
 * 将 DiffPart[] 转换为带 <ins>/<del> 标记的 HTML 文本
 *
 * 用于 react-markdown 的文本节点注入。
 * 标记在文本层完成，保持 Markdown 表格结构完整。
 */
export function diffPartsToMarkdown(parts: DiffPart[]): string {
  return parts
    .map((part) => {
      if (part.added) {
        return `<ins class="diff-add">${escapeHtml(part.value)}</ins>`
      }
      if (part.removed) {
        return `<del class="diff-remove">${escapeHtml(part.value)}</del>`
      }
      return escapeHtml(part.value)
    })
    .join('')
}

/** 简单的 HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
