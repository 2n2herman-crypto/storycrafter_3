/**
 * v6.2 scene_beats 结构化校验钩子
 *
 * 与 SKILL.md 的自然语言约束形成双保险:
 *   - SKILL body 让 LLM 主动生成合规输出(第一道防线,提高首次通过率);
 *   - 本文件让 validator 机械拦截不合规输出(第二道防线,retry 时反馈具体错位)。
 *
 * 由 orchestratorEngine.runSequencePipeline 在每次调度时动态挂载到 SkillSpec.structuralCheck,
 * 因为 checkBeatBlocks 需要当前 <target_scene> 作 SC-ID 参照——跨步骤依赖不适合静态注册。
 *
 * 返回 null = 通过;返回中文字符串 = 首条违规详情,追加到 retry userContent 尾部。
 */

// ===== 常量与正则 =====

/** 场景 ID:SC-{序列 ID}-{两位数字} 如 SC-S1-1-01 */
const SCENE_ID_REGEX = /^SC-[A-Z]\d+-\d+-\d{2}$/

// ===== 通用表格解析 =====

interface ParsedTable {
  header: string[]
  rows: string[][]
}

/**
 * 极简 Markdown 表格解析:只认 `|` 起始行,split by `|` 并去首尾空 cell。
 *
 * 容忍:表头前的空行、表格后的说明段(遇到非 `|` 行即视为表结束)。
 * 拒绝:全角 `｜` 字符(SKILL body 已禁,交由 checkNoRawPipe 单独拦)。
 */
function parseMarkdownTable(md: string): ParsedTable | null {
  const lines = md.split(/\r?\n/).map((l) => l.trim())
  const tableLines: string[] = []
  let inTable = false
  for (const line of lines) {
    if (line.startsWith('|') && line.endsWith('|')) {
      tableLines.push(line)
      inTable = true
    } else if (inTable) {
      break
    }
  }
  if (tableLines.length < 3) return null // 至少 header + 分隔行 + 1 行数据

  const [headerLine, separatorLine, ...dataLines] = tableLines
  const header = splitRow(headerLine)
  const separator = splitRow(separatorLine)
  // 分隔行每格必须是 `---` 类连字符
  if (!separator.every((c) => /^:?-+:?$/.test(c.trim()))) return null

  const rows = dataLines.map(splitRow)
  return { header, rows }
}

function splitRow(line: string): string[] {
  // `| a | b | c |` → ['a','b','c']
  const inner = line.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((c) => c.trim())
}

// ===== 场景表校验 =====

/**
 * 校验 scene_designer 产出的场景表。
 *
 * v6.8 放宽后阻塞校验仅 2 项(保护下游流转底线):
 *   1. 能解析为合法 markdown 表格(段②→段③ SC-ID 提取的结构前提)
 *   2. 每行场景 ID 匹配 SCENE_ID_REGEX(extractSceneIds/sliceSceneRow/checkBeatBlocks B-ID 全靠此格式)
 * 列数=7/行列一致/裸竖线 3 项交软校验 warning + SKILL body 引导。
 *
 * @param md - extractBetween 提取的场景表正文(不含 START/END TAG)
 * @returns null=通过;string=首条违规详情
 */
export function checkSceneTable(md: string): string | null {
  const table = parseMarkdownTable(md)
  if (!table) return '未能解析出合法 Markdown 表格(检查表头 `|...|` 与分隔行 `|---|...|` 是否规范)'

  for (let i = 0; i < table.rows.length; i++) {
    const [sceneId] = table.rows[i]
    if (!SCENE_ID_REGEX.test(sceneId)) {
      return `第 ${i + 1} 行场景ID "${sceneId}" 不符合格式 SC-S{幕}-{序}-{nn}(如 SC-S1-1-01)`
    }
  }

  return null
}

// ===== 节拍块校验（v6.7：节拍改非表格字段块，逐场景 scope） =====

interface BeatBlock {
  id: string
  fields: Record<string, string>
}

/**
 * 解析节拍块序列。块头 `[BEAT B-...]` 整行锚定,字段行 `字段: 值` 非贪婪首冒号。
 * 块间空行/`<!-- -->` 注释容忍;块内无法识别的非空行计入 strayLines 供报错。
 */
export function parseBeatBlocks(md: string): { blocks: BeatBlock[]; strayLines: string[] } {
  const lines = md.split(/\r?\n/)
  const blocks: BeatBlock[] = []
  const strayLines: string[] = []
  let cur: BeatBlock | null = null
  const headRe = /^\[BEAT\s+(B-SC-[A-Z]\d+-\d+-\d{2}-\d+)\]\s*$/
  const fieldRe = /^(\S+?):\s*(.*)$/
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('<!--')) continue
    const h = headRe.exec(line)
    if (h) {
      cur = { id: h[1], fields: {} }
      blocks.push(cur)
      continue
    }
    const f = fieldRe.exec(line)
    if (f && cur) {
      cur.fields[f[1].trim()] = f[2].trim()
      continue
    }
    strayLines.push(line) // 块外/无法识别行
  }
  return { blocks, strayLines }
}

/**
 * 单场景节拍块校验。sceneId = 本次 <target_scene>,用于反查块头内嵌 SC-ID 一致性。
 *
 * v6.8 放宽后阻塞校验仅 2 项:
 *   1. 至少 1 个 [BEAT] 块(防空输出落盘成空壳)
 *   2. 块头内嵌 SC-ID = 当前场景(防写错场景;块头 B-ID 格式已由 parseBeatBlocks.headRe 保证,无需重复校验)
 * 字段齐全/类型词库/相邻规则/strayLines 交 SKILL body 引导 + 软校验 warning。
 *
 * @param md - extractBetween 提取的节拍块正文(不含 START/END TAG)
 * @param sceneId - 本次目标场景 ID(引擎循环时的 <target_scene>)
 * @returns null=通过;string=首条违规详情
 */
export function checkBeatBlocks(md: string, sceneId: string): string | null {
  const { blocks } = parseBeatBlocks(md)
  if (blocks.length === 0) return '未解析出任何 [BEAT ...] 节拍块'

  for (let i = 0; i < blocks.length; i++) {
    const { id } = blocks[i]
    // 内嵌 SC-ID 必须 = 当前场景(块头格式已由 parseBeatBlocks.headRe 保证)
    const embedded = id.replace(/^B-/, '').replace(/-\d+$/, '')
    if (embedded !== sceneId) return `第 ${i + 1} 块 "${id}" 内嵌场景 "${embedded}" ≠ 目标场景 "${sceneId}"`
  }
  return null
}

/** 数块头(供软校验计数) */
export function countBeatBlocks(md: string): number {
  return (md.match(/^\[BEAT\s+B-SC-[A-Z]\d+-\d+-\d{2}-\d+\]\s*$/gm) ?? []).length
}

/**
 * 从场景表 markdown 中抽取所有 SC-ID 集合。
 *
 * v6.7：由引擎 runSequencePipeline 消费(逐场景循环发起 beat_writer),故导出。
 * 直接正则扫描而非依赖 parseMarkdownTable——因为传入的 scenesMd 是刚通过 checkSceneTable
 * 的合法产物,格式已保证;且此处只需 SC-ID 集合不关心其它列。
 */
export function extractSceneIds(scenesMd: string): Set<string> {
  const ids = new Set<string>()
  const regex = /SC-[A-Z]\d+-\d+-\d{2}/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(scenesMd)) !== null) {
    ids.add(match[0])
  }
  return ids
}
