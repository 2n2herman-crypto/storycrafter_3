import type { SkillSpec, ValidationResult } from '../types'

/**
 * v5.3 版输出校验器
 *
 * 校验逻辑简化：每个 Skill 只输出一个 TAG 对，
 * 直接从 SkillSpec.outputTags 读取 [START, END] 进行校验。
 */

/**
 * 校验 Skill 输出
 *
 * @param output - Skill 返回的原始输出
 * @param skill - SkillSpec
 * @returns 校验结果
 */
export function validateOutput(output: string, skill: SkillSpec): ValidationResult {
  const [startTag, endTag] = skill.outputTags

  // 无 TAG 的 Skill（如 reset_all）跳过校验
  if (!startTag || !endTag) {
    return { valid: true, missingTags: [], extracted: {} }
  }

  const missingTags: string[] = []
  if (!output.includes(startTag)) missingTags.push(startTag)
  if (!output.includes(endTag)) missingTags.push(endTag)

  const extracted: Record<string, string> = {}
  let structuralError: string | undefined
  if (missingTags.length === 0) {
    const content = extractBetween(output, startTag, endTag)
    if (content !== null && skill.writes.length > 0) {
      // v6.2：结构化钩子（scene_designer 场景表列数/ID 格式、beat_writer 节拍类型词库
      // 与 SC-ID 跨表引用完整性等）在 tag 提取通过后再跑一遍，把"仅 tag 存在性"升级为
      // "格式 + 引用完整性"两级校验，让 retry 拿到具体错位反馈而非盲重试烧配额。
      if (skill.structuralCheck) {
        const err = skill.structuralCheck(content)
        if (err) {
          return { valid: false, missingTags: [], extracted: {}, structuralError: err }
        }
      }
      // 写入第一个 writes 文件（大多数 Skill 只写一个文件）
      extracted[skill.writes[0]] = content
    }
  }

  return {
    valid: missingTags.length === 0 && structuralError === undefined,
    missingTags,
    extracted,
    structuralError,
  }
}

/**
 * 提取两个 TAG 之间的内容
 */
function extractBetween(text: string, startTag: string, endTag: string): string | null {
  const startIdx = text.indexOf(startTag)
  if (startIdx === -1) return null
  const contentStart = startIdx + startTag.length
  const endIdx = text.indexOf(endTag, contentStart)
  if (endIdx === -1) return null
  return text.slice(contentStart, endIdx).trim()
}

/**
 * v6.6：多文件输出提取（input_normalizer 专用）。
 *
 * 归一化一次可能产多个种子资产（worldbuilding/characters/act_map/...），
 * validateOutput 只写 writes[0] 无法承载。本函数在外层 START/END TAG 内解析
 * `<<<FILE:path>>>...<<<END:path>>>` 块，返回 path→content 映射。
 *
 * 守 INV-1 边缘：独立新函数，不改 validateOutput 主体。
 */
export function extractMultiFileOutput(output: string, skill: SkillSpec): ValidationResult {
  const [startTag, endTag] = skill.outputTags
  if (!startTag || !endTag) {
    return { valid: true, missingTags: [], extracted: {} }
  }

  const missingTags: string[] = []
  if (!output.includes(startTag)) missingTags.push(startTag)
  if (!output.includes(endTag)) missingTags.push(endTag)
  if (missingTags.length > 0) {
    return { valid: false, missingTags, extracted: {} }
  }

  const region = extractBetween(output, startTag, endTag) ?? ''
  const extracted: Record<string, string> = {}
  const fileRegex = /<<<FILE:([^>]+)>>>([\s\S]*?)<<<END:\1>>>/g
  let match: RegExpExecArray | null
  while ((match = fileRegex.exec(region)) !== null) {
    const path = match[1].trim()
    const content = match[2].trim()
    if (path && content) {
      extracted[path] = content
    }
  }

  const structuralError =
    Object.keys(extracted).length === 0
      ? '归一化未产出任何 <<<FILE:path>>>...<<<END:path>>> 块'
      : undefined

  return {
    valid: structuralError === undefined,
    missingTags: [],
    extracted,
    structuralError,
  }
}
