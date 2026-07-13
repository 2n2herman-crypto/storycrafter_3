/**
 * 前端文件下载工具（v7.1 M3）
 *
 * MD 导出纯前端 Blob（资产已在 assetStore，非后端调用）；
 * Word 导出由 api/importExport 拿回 Blob 后复用 triggerDownload。
 */

/** 触发浏览器下载 Blob */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 触发浏览器下载文本（默认 markdown） */
export function downloadText(filename: string, content: string, mime = 'text/markdown'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  triggerDownload(blob, filename)
}

/**
 * 全量导出：把多个资产合并为单一 Markdown。
 * 每段以 `# <标题>` 作分节标题，段间用分隔线，供 MD 直下或转 Word。
 */
export function buildAllMarkdown(items: { title: string; content: string }[]): string {
  return items
    .filter((it) => it.content.trim())
    .map((it) => `# ${it.title}\n\n${it.content.trim()}`)
    .join('\n\n---\n\n')
}
