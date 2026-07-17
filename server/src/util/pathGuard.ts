import path from 'node:path'

/**
 * 校验资产相对路径并解析为绝对路径。
 *
 * v6 契约原规定 `[A-Za-z0-9_.-]+\.md` 不含子目录，但 v6.1 起实际产物含
 * `sequences/<ID>.md`、`novel_chapters/<ID>.md`、`video_scripts/<product>/<ID>.md` 等子目录，
 * 故放宽为「允许单层/多层子目录 + 禁绝对路径与 `..` + resolve/startsWith 兜底」。
 */
export function resolveAssetPath(assetsRoot: string, relPath: string): string {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('资产路径为空')
  }
  // 禁绝对路径
  if (path.isAbsolute(relPath)) {
    throw new Error(`非法绝对路径: ${relPath}`)
  }
  // 禁 .. 越界（编码变体由 resolve+startsWith 兜底）
  if (relPath.includes('..')) {
    throw new Error(`非法路径含 ..: ${relPath}`)
  }
  // 仅允许 .md（资产约定）
  if (!relPath.endsWith('.md')) {
    throw new Error(`仅允许 .md 资产: ${relPath}`)
  }
  const root = path.resolve(assetsRoot)
  const abs = path.resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界: ${relPath}`)
  }
  return abs
}
