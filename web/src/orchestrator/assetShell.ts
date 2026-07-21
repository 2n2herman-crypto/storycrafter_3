import type { FileManager } from './fileManager'

const MAX_OUTPUT_CHARS = 8_000
const MAX_GREP_MATCHES = 20
const GREP_CONTEXT_LINES = 2
const MAX_SED_LINES = 120
const MAX_FIND_RESULTS = 200
const MAX_CAT_CHARS = 8_000

type AssetShellResult = {
  output: string
  truncated?: boolean
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) throw new Error('命令引号未闭合')
  if (current) tokens.push(current)
  return tokens
}

function rejectUnsafeCommand(command: string): void {
  if (/[;&|<>`$]/.test(command) || command.includes('&&') || command.includes('||')) {
    throw new Error('不允许命令拼接、管道、重定向、变量或子命令')
  }
}

function normalizeAssetPath(input = '.'): string {
  let path = input.trim()
  if (!path || path === '.') return ''
  if (path.startsWith('./')) path = path.slice(2)
  if (path.startsWith('/') || path.includes('..')) {
    throw new Error(`非法资产路径: ${input}`)
  }
  return path.replace(/\/+$/, '')
}

function limitOutput(text: string): AssetShellResult {
  if (text.length <= MAX_OUTPUT_CHARS) return { output: text }
  return {
    output: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n...[输出已截断，请缩小关键词、指定文件路径或使用 sed -n 读取更小范围]`,
    truncated: true,
  }
}

function globToRegex(glob: string): RegExp {
  const normalized = normalizeAssetPath(glob)
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

async function listExistingAssets(fm: FileManager): Promise<string[]> {
  const files = await fm.listAssetFiles()
  return files
    .filter((file) => file.exists && file.path.endsWith('.md'))
    .map((file) => file.path)
    .sort()
}

async function readAsset(fm: FileManager, path: string): Promise<string> {
  const normalized = normalizeAssetPath(path)
  if (!normalized.endsWith('.md')) throw new Error(`仅允许读取 .md 资产: ${path}`)
  return fm.readFile(normalized)
}

async function expandPaths(fm: FileManager, patterns: string[]): Promise<string[]> {
  const all = await listExistingAssets(fm)
  if (patterns.length === 0) return all
  const result = new Set<string>()
  for (const pattern of patterns) {
    const normalized = normalizeAssetPath(pattern)
    if (!normalized) continue
    if (normalized.includes('*')) {
      const re = globToRegex(normalized)
      for (const path of all) {
        if (re.test(path)) result.add(path)
      }
    } else {
      if (!normalized.endsWith('.md')) throw new Error(`仅允许读取 .md 资产: ${pattern}`)
      result.add(normalized)
    }
  }
  return [...result].sort()
}

function formatLines(path: string, lines: string[], startIndex: number): string {
  return [
    `<<< ${path}:${startIndex + 1}-${startIndex + lines.length} >>>`,
    ...lines.map((line, idx) => `${startIndex + idx + 1}: ${line}`),
  ].join('\n')
}

async function runLs(fm: FileManager, args: string[]): Promise<string> {
  const prefix = normalizeAssetPath(args[0] ?? '')
  const files = await listExistingAssets(fm)
  const hits = files.filter((path) => !prefix || path === prefix || path.startsWith(`${prefix}/`))
  return hits.length > 0 ? hits.join('\n') : '未找到资产'
}

async function runFind(fm: FileManager, args: string[]): Promise<string> {
  const root = normalizeAssetPath(args[0] && !args[0].startsWith('-') ? args[0] : '.')
  const nameIdx = args.indexOf('-name')
  const pattern = nameIdx >= 0 ? args[nameIdx + 1] : '*.md'
  if (!pattern) throw new Error('find 缺少 -name 参数值')
  const files = await listExistingAssets(fm)
  const nameRe = globToRegex(pattern)
  const hits = files
    .filter((path) => !root || path === root || path.startsWith(`${root}/`))
    .filter((path) => nameRe.test(path.split('/').pop() ?? path))
    .slice(0, MAX_FIND_RESULTS)
  const suffix = hits.length === MAX_FIND_RESULTS ? '\n...[结果过多，已截断]' : ''
  return hits.length > 0 ? `${hits.join('\n')}${suffix}` : '未找到资产'
}

async function runGrep(fm: FileManager, args: string[]): Promise<string> {
  const positional = args.filter((arg) => arg !== '-n')
  const pattern = positional[0]
  if (!pattern) throw new Error('grep 缺少搜索关键词')
  const paths = await expandPaths(fm, positional.slice(1))
  const re = new RegExp(pattern, 'i')
  const blocks: string[] = []
  let matches = 0

  for (const path of paths) {
    const content = await readAsset(fm, path).catch(() => '')
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!re.test(lines[i])) continue
      const start = Math.max(0, i - GREP_CONTEXT_LINES)
      const end = Math.min(lines.length, i + GREP_CONTEXT_LINES + 1)
      blocks.push(formatLines(path, lines.slice(start, end), start))
      matches += 1
      if (matches >= MAX_GREP_MATCHES) {
        blocks.push('...[命中过多，已截断，请缩小关键词或指定更具体文件]')
        return blocks.join('\n\n')
      }
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : '未找到匹配项'
}

async function runSed(fm: FileManager, args: string[]): Promise<string> {
  if (args[0] !== '-n') throw new Error("仅支持 sed -n 'start,endp' file.md")
  const range = args[1]
  const path = args[2]
  const match = /^(\d+),(\d+)p$/.exec(range ?? '')
  if (!match || !path) throw new Error("仅支持 sed -n 'start,endp' file.md")
  const start = Number(match[1])
  const end = Number(match[2])
  if (start < 1 || end < start) throw new Error('sed 行号范围非法')
  const limitedEnd = Math.min(end, start + MAX_SED_LINES - 1)
  const content = await readAsset(fm, path)
  const lines = content.split(/\r?\n/).slice(start - 1, limitedEnd)
  const suffix = end > limitedEnd ? '\n...[行数过多，已截断]' : ''
  return `${formatLines(normalizeAssetPath(path), lines, start - 1)}${suffix}`
}

async function runHeadTail(fm: FileManager, cmd: 'head' | 'tail', args: string[]): Promise<string> {
  let count = 80
  let path = args[0]
  if (args[0] === '-n') {
    count = Math.min(Number(args[1] ?? 80), MAX_SED_LINES)
    path = args[2]
  }
  if (!path || Number.isNaN(count) || count < 1) throw new Error(`${cmd} 参数非法`)
  const normalized = normalizeAssetPath(path)
  const lines = (await readAsset(fm, normalized)).split(/\r?\n/)
  const start = cmd === 'head' ? 0 : Math.max(0, lines.length - count)
  const slice = cmd === 'head' ? lines.slice(0, count) : lines.slice(start)
  return formatLines(normalized, slice, start)
}

async function runWc(fm: FileManager, args: string[]): Promise<string> {
  const paths = await expandPaths(fm, args.filter((arg) => arg !== '-l'))
  const rows = await Promise.all(paths.map(async (path) => {
    const content = await readAsset(fm, path)
    return `${content.split(/\r?\n/).length} ${path}`
  }))
  return rows.join('\n')
}

async function runCat(fm: FileManager, args: string[]): Promise<string> {
  const path = args[0]
  if (!path) throw new Error('cat 缺少文件路径')
  const normalized = normalizeAssetPath(path)
  const content = await readAsset(fm, normalized)
  if (content.length > MAX_CAT_CHARS) {
    return `${content.slice(0, MAX_CAT_CHARS)}\n\n...[文件过大，cat 输出已截断；请改用 grep / sed -n / head / tail 读取片段]`
  }
  return content
}

export async function runAssetShell(fm: FileManager, command: string): Promise<string> {
  rejectUnsafeCommand(command)
  const tokens = tokenize(command)
  const cmd = tokens[0]
  const args = tokens.slice(1)

  let result: string
  switch (cmd) {
    case 'ls':
      result = await runLs(fm, args)
      break
    case 'find':
      result = await runFind(fm, args)
      break
    case 'grep':
      result = await runGrep(fm, args)
      break
    case 'sed':
      result = await runSed(fm, args)
      break
    case 'head':
      result = await runHeadTail(fm, 'head', args)
      break
    case 'tail':
      result = await runHeadTail(fm, 'tail', args)
      break
    case 'wc':
      result = await runWc(fm, args)
      break
    case 'cat':
      result = await runCat(fm, args)
      break
    default:
      throw new Error('不支持该命令。支持：ls/find/grep/cat/head/tail/sed -n/wc')
  }

  const limited = limitOutput(result)
  return `$ ${command}\n${limited.output}`
}
