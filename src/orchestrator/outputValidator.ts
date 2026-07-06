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
  if (missingTags.length === 0) {
    const content = extractBetween(output, startTag, endTag)
    if (content !== null && skill.writes.length > 0) {
      // 写入第一个 writes 文件（大多数 Skill 只写一个文件）
      extracted[skill.writes[0]] = content
    }
  }

  return {
    valid: missingTags.length === 0,
    missingTags,
    extracted,
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
