/**
 * v5.3 版上下文组装器
 *
 * 从 Skill.reads 读取文件列表，自动组装为 XML 标签格式的上下文。
 * 标签名从文件名推导（worldbuilding.md → worldbuilding）。
 *
 * v5.5：buildAgentPrompt 支持注入最近若干轮对话历史，用于解析指代性澄清。
 */

import type { ConversationTurn } from '../types'

/**
 * 组装 Skill 上下文
 *
 * @param reads - 需读取的文件路径列表（来自 SkillSpec.reads）
 * @param files - 文件内容映射 { path: content }
 * @returns XML 标签格式的上下文
 */
export function assembleContext(
  reads: string[],
  files: Record<string, string>,
): string {
  const parts: string[] = []

  for (const filePath of reads) {
    const tagName = filePath.replace(/\.md$/, '')
    const content = files[filePath]

    if (content !== undefined && content.length > 0) {
      parts.push(`<${tagName}>\n${content}\n</${tagName}>`)
    } else {
      parts.push(`<${tagName}></${tagName}>`)
    }
  }

  return parts.join('\n\n')
}

/**
 * 将对话历史渲染为 <conversation_history> 段（空则返回 ''）
 *
 * 供 analyzer 解析指代（"那个""上面说的"），非需求本身。
 */
function renderHistory(history?: ConversationTurn[]): string {
  if (!history || history.length === 0) return ''
  const lines = history.map((turn) => {
    const label = turn.role === 'user' ? '用户' : '助手'
    return `${label}：${turn.content}`
  })
  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>`
}

/**
 * 构建最终的 Tool Prompt
 *
 * @param context - 已组装的上下文
 * @param instruction - 用户修改指令
 * @param history - 可选：最近若干轮对话（v5.5，仅需求整理者等使用）
 * @returns 发送给 LLM 的 user content
 */
export function buildAgentPrompt(
  context: string,
  instruction: string,
  history?: ConversationTurn[],
): string {
  const historyBlock = renderHistory(history)
  return [
    historyBlock,
    context,
    `<user_revision_instruction>\n${instruction}\n</user_revision_instruction>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

