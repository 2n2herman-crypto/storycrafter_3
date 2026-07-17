/**
 * 前端文件下载工具（v7.1 M3）
 *
 * MD 导出纯前端 Blob（资产已在 assetStore，非后端调用）；
 * Word 导出由 api/importExport 拿回 Blob 后复用 triggerDownload。
 */

export type ExportFormat = 'markdown' | 'word'

export interface ExportSourceItem {
  path: string
  title: string
  content: string
}

interface ZipEntryInput {
  path: string
  content: string | Blob
}

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

/**
 * v7.9.1：全量导出改为结构化资产包。
 * Markdown 每个资产独立成文件；Word 每个资产独立转 docx 后放入同构目录。
 */
export async function buildAssetExportZip(
  items: ExportSourceItem[],
  format: ExportFormat,
  options: {
    rootName?: string
    toWord?: (markdown: string, filename: string) => Promise<Blob>
  } = {},
): Promise<Blob> {
  const normalizedItems = items.filter((item) => item.content.trim())
  const rootName = sanitizeExportName(options.rootName || 'StoryCrafter_资产导出')
  const extension = format === 'word' ? 'docx' : 'md'
  const usedPaths = new Set<string>()
  const files: ZipEntryInput[] = []
  const manifestMarkdown = buildManifestMarkdown(normalizedItems, format)

  if (format === 'word') {
    if (!options.toWord) {
      throw new Error('Word 导出缺少转换函数')
    }
    files.push({
      path: `${rootName}/00_项目信息/manifest.docx`,
      content: await options.toWord(manifestMarkdown, 'manifest'),
    })
  } else {
    files.push({
      path: `${rootName}/00_项目信息/manifest.md`,
      content: manifestMarkdown,
    })
  }
  files.push({
    path: `${rootName}/00_项目信息/manifest.json`,
    content: JSON.stringify(buildManifestJson(normalizedItems, format), null, 2),
  })

  for (const item of normalizedItems) {
    const classified = classifyExportPath(item.path)
    const baseName = sanitizeExportName(stripMarkdownExtension(classified.filename || item.title || item.path))
    const exportPath = makeUniquePath(
      `${rootName}/${classified.directory}/${baseName}.${extension}`,
      usedPaths,
    )

    if (format === 'word') {
      if (!options.toWord) {
        throw new Error('Word 导出缺少转换函数')
      }
      const blob = await options.toWord(item.content.trim(), baseName)
      files.push({ path: exportPath, content: blob })
    } else {
      files.push({ path: exportPath, content: item.content.trimEnd() + '\n' })
    }
  }

  return createZipBlob(files)
}

export function buildExportArchiveName(format: ExportFormat, rootName = 'StoryCrafter_资产导出'): string {
  const safeRoot = sanitizeExportName(rootName)
  const suffix = format === 'word' ? 'word' : 'md'
  return `${safeRoot}_${suffix}.zip`
}

export function classifyExportPath(path: string): { directory: string; filename: string; category: string } {
  const filename = path.split('/').pop() || path

  if (path === 'user_requirements.md') {
    return { directory: '01_需求与设定', filename, category: '需求分析' }
  }
  if (path === 'worldbuilding.md' || path === 'characters.md') {
    return { directory: '01_需求与设定', filename, category: '设定资产' }
  }
  if (path === 'act_map.md' || path === 'sequence_list.md' || path === 'foreshadowing.md' || path === 'subplots.md') {
    return { directory: '02_结构大纲', filename, category: '结构大纲' }
  }
  if (path.startsWith('sequences/')) {
    return { directory: '03_序列细纲/sequences', filename, category: '序列层' }
  }
  if (path.startsWith('scenes/')) {
    return { directory: '03_序列细纲/scenes', filename, category: '场景层' }
  }
  if (path.startsWith('beats/')) {
    return { directory: '03_序列细纲/beats', filename, category: '节拍层' }
  }
  if (path.startsWith('sequence_outlines/')) {
    return { directory: '03_序列细纲/sequence_outlines', filename, category: '序列细纲合并稿' }
  }
  if (path.startsWith('novel_chapters/')) {
    return { directory: '04_写作资产/novel_chapters', filename, category: '小说正文' }
  }
  if (path.startsWith('short_drama_scripts/')) {
    return { directory: '04_写作资产/short_drama_scripts', filename, category: '短剧剧本' }
  }
  if (path.startsWith('long_drama_scripts/')) {
    return { directory: '04_写作资产/long_drama_scripts', filename, category: '长剧剧本' }
  }
  if (path.startsWith('film_scripts/')) {
    return { directory: '04_写作资产/film_scripts', filename, category: '电影剧本' }
  }
  if (path.startsWith('chapters/')) {
    return { directory: '04_写作资产/chapters_legacy', filename, category: '旧正文' }
  }
  const videoMatch = path.match(/^video_scripts\/([^/]+)\//)
  if (videoMatch) {
    return { directory: `05_视频脚本/${videoMatch[1]}`, filename, category: '视频脚本' }
  }

  return { directory: '99_其他资产', filename, category: '其他资产' }
}

export function sanitizeExportName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'untitled'
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '')
}

function makeUniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path)
    return path
  }
  const extIndex = path.lastIndexOf('.')
  const prefix = extIndex >= 0 ? path.slice(0, extIndex) : path
  const ext = extIndex >= 0 ? path.slice(extIndex) : ''
  let index = 2
  while (used.has(`${prefix}_${index}${ext}`)) index++
  const unique = `${prefix}_${index}${ext}`
  used.add(unique)
  return unique
}

function buildManifestMarkdown(items: ExportSourceItem[], format: ExportFormat): string {
  const lines = [
    '# StoryCrafter 资产导出清单',
    '',
    `- 导出格式：${format === 'word' ? 'Word (.docx)' : 'Markdown (.md)'}`,
    `- 资产数量：${items.length}`,
    `- 导出时间：${new Date().toISOString()}`,
    '',
    '| 分类 | 源路径 | 标题 |',
    '|---|---|---|',
  ]
  for (const item of items) {
    const classified = classifyExportPath(item.path)
    lines.push(`| ${classified.category} | ${item.path} | ${item.title} |`)
  }
  return lines.join('\n') + '\n'
}

function buildManifestJson(items: ExportSourceItem[], format: ExportFormat) {
  return {
    format,
    exportedAt: new Date().toISOString(),
    count: items.length,
    assets: items.map((item) => {
      const classified = classifyExportPath(item.path)
      return {
        sourcePath: item.path,
        title: item.title,
        category: classified.category,
        directory: classified.directory,
      }
    }),
  }
}

async function createZipBlob(entries: ZipEntryInput[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const localParts: ArrayBuffer[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const pathBytes = encoder.encode(entry.path)
    const data =
      typeof entry.content === 'string'
        ? encoder.encode(entry.content)
        : new Uint8Array(await entry.content.arrayBuffer())
    const crc = crc32(data)
    const { time, date } = getDosDateTime(new Date())

    const localHeader = new Uint8Array(30 + pathBytes.length)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, time, true)
    localView.setUint16(12, date, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.byteLength, true)
    localView.setUint32(22, data.byteLength, true)
    localView.setUint16(26, pathBytes.length, true)
    localView.setUint16(28, 0, true)
    localHeader.set(pathBytes, 30)

    localParts.push(toArrayBuffer(localHeader), toArrayBuffer(data))

    const centralHeader = new Uint8Array(46 + pathBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, time, true)
    centralView.setUint16(14, date, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, data.byteLength, true)
    centralView.setUint32(24, data.byteLength, true)
    centralView.setUint16(28, pathBytes.length, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(pathBytes, 46)
    centralParts.push(centralHeader)

    offset += localHeader.byteLength + data.byteLength
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, 0, true)

  return new Blob(
    [...localParts, ...centralParts.map(toArrayBuffer), toArrayBuffer(end)],
    { type: 'application/zip' },
  )
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

function getDosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate()
  return { time, date: dosDate }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()
