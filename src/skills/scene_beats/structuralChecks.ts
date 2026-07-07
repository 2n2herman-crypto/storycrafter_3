/**
 * v6.2 scene_beats 结构化校验钩子
 *
 * 与 SKILL.md 的自然语言约束形成双保险:
 *   - SKILL body 让 LLM 主动生成合规输出(第一道防线,提高首次通过率);
 *   - 本文件让 validator 机械拦截不合规输出(第二道防线,retry 时反馈具体错位)。
 *
 * 由 orchestratorEngine.runPipeline 在每次调度时动态挂载到 SkillSpec.structuralCheck,
 * 因为 checkBeatTable 需要 scenesMd 作 SC-ID 集合参照——跨步骤依赖不适合静态注册。
 *
 * 返回 null = 通过;返回中文字符串 = 首条违规详情,追加到 retry userContent 尾部。
 */

// ===== 常量与正则 =====

/** 场景 ID:SC-{序列 ID}-{两位数字} 如 SC-S1-1-01 */
const SCENE_ID_REGEX = /^SC-[A-Z]\d+-\d+-\d{2}$/

/** 节拍序号:B-{场景 ID}-{单位数字} 如 B-SC-S1-1-01-1 */
const BEAT_ID_REGEX = /^B-SC-[A-Z]\d+-\d+-\d{2}-\d+$/

/** 节拍类型主词五选一(允许后缀变体如 "铺垫·冷启",只判主词) */
const BEAT_TYPE_KEYWORDS = ['铺垫', '触发', '对抗', '转折', '收束'] as const

const SCENE_TABLE_COLUMNS = 7
const BEAT_TABLE_COLUMNS = 6

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

// ===== 裸竖线检测 =====

/**
 * 检测正文中是否存在"表格外的裸竖线",或表格单元格内部的可疑竖线。
 *
 * 由于 markdown 表格本身就靠 `|` 分列,单元格内部若混入额外 `|` 会破坏解析,
 * 表现为某行 split 后列数异常——由 checkColumnCount 拦截更精确。
 * 这里只做补充:非表格行不应出现 `|`(注释除外)。
 */
function findStrayPipe(md: string): string | null {
  const lines = md.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('|')) continue // 表格行合法
    if (line.startsWith('<!--')) continue // HTML 注释合法
    if (line.includes('|')) {
      return `第 "${line.slice(0, 40)}${line.length > 40 ? '...' : ''}" 出现表格外的裸竖线 \`|\`,请用顿号/逗号替换`
    }
  }
  return null
}

// ===== 场景表校验 =====

/**
 * 校验 scene_designer 产出的场景表。
 *
 * 检查项:
 *   1. 能解析为合法 markdown 表格
 *   2. 列数 = 7
 *   3. 至少 3 行数据(SKILL body 约束 N∈[3,6],此处只判下限;超上限 6 不硬拦作为宽松保底)
 *   4. 场景 ID 匹配 SCENE_ID_REGEX
 *   5. 每行列数一致(即无因单元格裸竖线导致 split 错位)
 *   6. 视角人物不为空
 *
 * @param md - extractBetween 提取的场景表正文(不含 START/END TAG)
 * @returns null=通过;string=首条违规详情
 */
export function checkSceneTable(md: string): string | null {
  const strayErr = findStrayPipe(md)
  if (strayErr) return strayErr

  const table = parseMarkdownTable(md)
  if (!table) return '未能解析出合法 Markdown 表格(检查表头 `|...|` 与分隔行 `|---|...|` 是否规范)'

  if (table.header.length !== SCENE_TABLE_COLUMNS) {
    return `场景表列数 ${table.header.length} ≠ 期望值 7,请补齐/删除表头列使其恰好为 \`场景ID|场景功能|场景目标(Objective)|冲突与障碍|场景结果(Outcome)|时空边界|视角人物\``
  }

  if (table.rows.length < 3) {
    return `场景表仅 ${table.rows.length} 行数据,少于下限 3 行,请补足场景数`
  }

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i]
    if (row.length !== SCENE_TABLE_COLUMNS) {
      return `第 ${i + 1} 行数据列数 ${row.length} ≠ 期望值 7(疑似单元格内含未转义 \`|\` 破坏分隔),请检查该行内容`
    }
    const [sceneId, , , , , , viewpoint] = row
    if (!SCENE_ID_REGEX.test(sceneId)) {
      return `第 ${i + 1} 行场景ID "${sceneId}" 不符合格式 SC-S{幕}-{序}-{nn}(如 SC-S1-1-01)`
    }
    if (!viewpoint || viewpoint === '—' || viewpoint === '-') {
      return `第 ${i + 1} 行"视角人物"为空或 \`—\`,场景必须有明确视角人物(须落在 <characters> 注册表内)`
    }
  }

  return null
}

// ===== 节拍表校验 =====

/**
 * 校验 beat_writer 产出的节拍表,含跨表 SC-ID 引用完整性校验。
 *
 * 检查项:
 *   1. 能解析为合法 markdown 表格
 *   2. 列数 = 6
 *   3. 节拍序号匹配 BEAT_ID_REGEX
 *   4. 节拍类型主词 ∈ BEAT_TYPE_KEYWORDS(允许后缀变体如 "铺垫·冷启")
 *   5. 同场景相邻两拍主词不相同
 *   6. 所属场景 ∈ scenesMd 中出现的 SC-ID 集合(若提供)
 *   7. 每行列数一致
 *
 * @param md - extractBetween 提取的节拍表正文
 * @param scenesMd - 上一步 scene_designer 的场景表(用于 SC-ID 集合参照);
 *                   缺省时跳过第 6 项(用于孤立测试或 REFINE 模式无 prev_scenes 场景)
 * @returns null=通过;string=首条违规详情
 */
export function checkBeatTable(md: string, scenesMd?: string): string | null {
  const strayErr = findStrayPipe(md)
  if (strayErr) return strayErr

  const table = parseMarkdownTable(md)
  if (!table) return '未能解析出合法 Markdown 表格(检查表头 `|...|` 与分隔行 `|---|...|` 是否规范)'

  if (table.header.length !== BEAT_TABLE_COLUMNS) {
    return `节拍表列数 ${table.header.length} ≠ 期望值 6,请补齐/删除表头列使其恰好为 \`所属场景|节拍序号|节拍类型|动作-反应描述|情绪/信息变化|关联伏笔\``
  }

  if (table.rows.length === 0) {
    return '节拍表无任何数据行'
  }

  // 预计算 scenes SC-ID 集合(若提供 scenesMd)
  const validSceneIds = scenesMd ? extractSceneIds(scenesMd) : null

  // 追踪同场景连续同类型:key=sceneId,value=上一拍的类型主词
  const lastTypePerScene = new Map<string, string>()

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i]
    if (row.length !== BEAT_TABLE_COLUMNS) {
      return `第 ${i + 1} 行数据列数 ${row.length} ≠ 期望值 6(疑似单元格内含未转义 \`|\` 破坏分隔)`
    }

    const [sceneId, beatId, beatType] = row

    if (!BEAT_ID_REGEX.test(beatId)) {
      return `第 ${i + 1} 行节拍序号 "${beatId}" 不符合格式 B-SC-S{幕}-{序}-{nn}-{n}(如 B-SC-S1-1-01-1)`
    }

    if (!SCENE_ID_REGEX.test(sceneId)) {
      return `第 ${i + 1} 行所属场景 "${sceneId}" 不符合场景ID格式 SC-S{幕}-{序}-{nn}`
    }

    // 跨表引用完整性
    if (validSceneIds && !validSceneIds.has(sceneId)) {
      return `第 ${i + 1} 行所属场景 "${sceneId}" 在 <prev_scenes> 场景表中不存在(合法 SC-ID 集合:${Array.from(validSceneIds).join(', ')})`
    }

    // 节拍序号内嵌的场景 ID 应与"所属场景"列一致
    const embeddedSceneId = beatId.replace(/^B-/, '').replace(/-\d+$/, '')
    if (embeddedSceneId !== sceneId) {
      return `第 ${i + 1} 行节拍序号 "${beatId}" 内嵌的场景ID "${embeddedSceneId}" 与"所属场景"列 "${sceneId}" 不一致`
    }

    // 类型主词命中五选一之一(允许后缀变体)
    const primaryType = BEAT_TYPE_KEYWORDS.find((k) => beatType.startsWith(k))
    if (!primaryType) {
      return `第 ${i + 1} 行节拍类型 "${beatType}" 未命中主词库 {${BEAT_TYPE_KEYWORDS.join(',')}}(允许后缀变体如"铺垫·冷启")`
    }

    // 同场景相邻同类型检测
    const lastType = lastTypePerScene.get(sceneId)
    if (lastType === primaryType) {
      return `第 ${i + 1} 行(场景 ${sceneId})与上一拍类型主词均为 "${primaryType}",违反"同场景相邻不得同类型"规则`
    }
    lastTypePerScene.set(sceneId, primaryType)
  }

  return null
}

/**
 * 从场景表 markdown 中抽取所有 SC-ID 集合(供 checkBeatTable 跨表引用校验用)。
 *
 * 直接正则扫描而非依赖 parseMarkdownTable——因为传入的 scenesMd 是刚通过 checkSceneTable
 * 的合法产物,格式已保证;且此处只需 SC-ID 集合不关心其它列。
 */
function extractSceneIds(scenesMd: string): Set<string> {
  const ids = new Set<string>()
  const regex = /SC-[A-Z]\d+-\d+-\d{2}/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(scenesMd)) !== null) {
    ids.add(match[0])
  }
  return ids
}
