import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Options as SanitizeOptions } from 'rehype-sanitize'

import { computeDiff, diffPartsToMarkdown } from '../utils/diff'

// ===== 安全列表：允许 DiffViewer 使用的 HTML 标签 =====

const sanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'ins',
    'del',
  ],
  attributes: {
    ...defaultSchema.attributes,
    ins: ['class'],
    del: ['class'],
  },
}

// ===== DiffViewer Props =====

interface DiffViewerProps {
  baselineText: string
  currentText: string
}

/**
 * DiffViewer — 词级差异对比 + Markdown 渲染组件
 *
 * 接收基线文本和当前文本，计算词级 diff，
 * 在文本层注入 `<ins class="diff-add">` / `<del class="diff-remove">` 标记，
 * 然后通过 react-markdown 完整渲染。
 *
 * 文本层注入策略确保 Markdown 表格结构在 diff 后仍能正确渲染。
 *
 * @see product_design/design-doc.md §4
 */
export function DiffViewer({ baselineText, currentText }: DiffViewerProps) {
  // 无变化时直接渲染当前文本
  if (baselineText === currentText || !baselineText) {
    return (
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        >
          {currentText}
        </ReactMarkdown>
      </div>
    )
  }

  // 计算 diff
  const parts = computeDiff(baselineText, currentText)

  // 转换为带 <ins>/<del> 标记的文本
  const markedText = diffPartsToMarkdown(parts)

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      >
        {markedText}
      </ReactMarkdown>
    </div>
  )
}
