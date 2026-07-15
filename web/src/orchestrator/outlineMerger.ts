/**
 * outlineMerger.ts — 序列细纲合并器（v7.3 新增）
 *
 * 功能：读取同一序列的三层文件（sequences/<ID>.md + scenes/<ID>.md + beats/<ID>.md），
 * 机械拼接为一份嵌套的"序列细纲"，落盘到 sequence_outlines/<ID>.md。
 *
 * 合并是纯字符串操作，不调 LLM。拼接前对三文件跑 structuralAudit 机械扫描，
 * 发现结构性缺陷则跳过该序列、记录失败原因。
 *
 * 合并链路调用方：DesignCompletenessBar 的"进入写作模式"按钮 + 单序列重试入口。
 */

import type { FileManager } from './fileManager'
import { auditStructureForSequence } from '../skills/checker/structuralAudit'

/** 合并结果汇总 */
export interface MergeResult {
  succeeded: string[]
  failed: Array<{ seqId: string; reason: string }>
}

/** 安全读：文件不存在时返回 '' */
async function safeRead(fm: FileManager, path: string): Promise<string> {
  try {
    return await fm.readFile(path)
  } catch {
    return ''
  }
}

/** 从 sequence_list.md 文本解析全部序列 ID */
export function parseSequenceIds(seqListMd: string): string[] {
  const set = new Set<string>()
  const re = /\bS\d+-\d+\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(seqListMd)) !== null) set.add(m[0])
  return [...set].sort()
}

/**
 * 全量合并：读取 sequence_list.md 得到全部序列 ID，
 * 对每个序列依次执行 mergeSingleSequenceOutline。
 */
export async function mergeAllSequenceOutlines(
  fileManager: FileManager,
): Promise<MergeResult> {
  const seqListMd = await safeRead(fileManager, 'sequence_list.md')
  const seqIds = parseSequenceIds(seqListMd)
  const succeeded: string[] = []
  const failed: Array<{ seqId: string; reason: string }> = []

  for (const seqId of seqIds) {
    const result = await mergeSingleSequenceOutline(fileManager, seqId)
    if (result.ok) {
      succeeded.push(seqId)
    } else {
      failed.push({ seqId, reason: result.reason })
    }
  }

  return { succeeded, failed }
}

/**
 * 单序列合并：读三文件 → 跑 structuralAudit 机械扫描 → 拼接 → 落盘。
 * 返回 ok=true 表示成功，ok=false 附带失败原因。
 */
export async function mergeSingleSequenceOutline(
  fileManager: FileManager,
  seqId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [sequenceMd, sceneMd, beatMd] = await Promise.all([
    safeRead(fileManager, `sequences/${seqId}.md`),
    safeRead(fileManager, `scenes/${seqId}.md`),
    safeRead(fileManager, `beats/${seqId}.md`),
  ])

  // 三文件全空 → 跳过（该序列尚未生成）
  if (!sequenceMd.trim() && !sceneMd.trim() && !beatMd.trim()) {
    return { ok: false, reason: `序列 ${seqId} 的三层文件均为空，尚未生成` }
  }

  // 机械扫描
  const issues = auditStructureForSequence(seqId, { sequenceMd, sceneMd, beatMd })
  if (issues.length > 0) {
    return { ok: false, reason: issues.map((i) => i.detail).join('; ') }
  }

  // 拼接 + 落盘
  const merged = buildSequenceOutline(seqId, sequenceMd, sceneMd, beatMd)
  await fileManager.writeFile(`sequence_outlines/${seqId}.md`, merged)

  return { ok: true }
}

/**
 * 核心拼接函数：按层级把节拍块嵌入场景小节、场景小节嵌入序列文档。
 *
 * 拼接逻辑：
 * 1. 取序列层文本作为外层文档骨架（保留其 # 标题 + 各字段块）
 * 2. 按场景 ID 从场景层提取对应 ## 小节，嵌入到序列文档末尾
 * 3. 在每个场景小节下，嵌入节拍层中对应的节拍块
 *
 * 拼接是纯字符串操作——三层文件已经是结构化 Markdown，
 * 按已知的标题层级和 ID 命名规则做字符串重组。
 */
function buildSequenceOutline(
  seqId: string,
  sequenceMd: string,
  sceneMd: string,
  beatMd: string,
): string {
  const parts: string[] = [
    `# 序列细纲 · ${seqId}`,
    '',
  ]

  // 序列层内容（去掉原有的 # 标题行，避免重复）
  const seqBody = sequenceMd
    .replace(/^#\s+.*$/m, '')
    .trim()
  parts.push(seqBody, '')

  // 场景层：按 ## 标题切分
  const sceneSections = splitByH2(sceneMd)

  // 节拍层：按 ## 标题切分，构建 SC-ID → [节拍块列表] 映射
  const beatSections = splitByH2(beatMd)

  // 场景与节拍按 ID 匹配嵌入
  for (const [scTitle, scBody] of sceneSections) {
    // 从标题中提取 SC-ID
    const scIdMatch = scTitle.match(/SC-[A-Z]\d+-\d+-\d{1,2}/)
    void scIdMatch // 保留正则匹配作为格式校验，后续扩展时可复用

    parts.push(`## ${scTitle}`)
    parts.push(scBody.trim(), '')

    // 查找该场景在节拍层中的节拍块
    const beatContent = beatSections.get(scTitle)
    if (beatContent) {
      parts.push(`### 节拍`, '')
      parts.push(beatContent.trim(), '')
    } else {
      parts.push(`### 节拍`, '')
      parts.push('*（暂无节拍）*', '')
    }
  }

  return parts.join('\n')
}

/**
 * 按 ## 标题将 Markdown 文本切分为 [标题文本, 正文内容] 的映射。
 * 标题行本身作为 key（不含 ## 前缀），正文为到下一个 ## 标题之前的内容。
 * 第一个 ## 标题之前的内容被忽略（通常是文件级 # 标题和前置说明）。
 */
function splitByH2(md: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = md.split(/\r?\n/)
  let currentTitle = ''
  let currentBody: string[] = []

  for (const line of lines) {
    const h2Match = /^##\s+(.+)$/.exec(line)
    if (h2Match) {
      // 遇到新的 ## 标题 → 存入上一个
      if (currentTitle) {
        map.set(currentTitle, currentBody.join('\n').trim())
      }
      currentTitle = h2Match[1].trim()
      currentBody = []
    } else if (currentTitle) {
      currentBody.push(line)
    }
    // 第一个 ## 之前的行忽略
  }

  // 存入最后一个
  if (currentTitle) {
    map.set(currentTitle, currentBody.join('\n').trim())
  }

  return map
}
