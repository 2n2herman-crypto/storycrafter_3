/**
 * v5.3 版上下文组装器
 *
 * 从 Skill.reads 读取文件列表，自动组装为 XML 标签格式的上下文。
 * 标签名从文件名推导（worldbuilding.md → worldbuilding）。
 *
 * v5.5：buildAgentPrompt 支持注入最近若干轮对话历史，用于解析指代性澄清。
 */

import type { ConversationTurn, AssetFileInfo } from '../types'

/**
 * v7.3：单文件 XML 包装辅助函数。
 *
 * 从 assembleContext 体内抽出的单文件包装逻辑，供 read_file tool call 的返回值格式化复用。
 * 标签名从路径推导：去掉 .md 后缀，将 / 替换为 _（因为 XML 标签名不能含斜杠）。
 *
 * 例如：sequences/S1-1.md → <sequences_S1-1>...</sequences_S1-1>
 *       worldbuilding.md    → <worldbuilding>...</worldbuilding>
 */
export function wrapFileAsXml(path: string, content: string): string {
  const tagName = path.replace(/\.md$/, '').replace(/\//g, '_')
  if (content && content.length > 0) {
    return `<${tagName}>\n${content}\n</${tagName}>`
  }
  return `<${tagName}></${tagName}>`
}

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

/**
 * 列举指定 prefix 下已生成存在的资产路径(v6.1 dynamic asset listing primitive)
 *
 * 用于旁系审计 subagent coverage_auditor(Wave E 启用时挂载)对照 act_map 解析覆盖率缺口。
 * 本波次(B)先行预埋占位降低未来返工面积；暂无任何 Skill 默认 reads 触达本能力。
 *
 * @param assets 由 fileManager.listAssetFiles() 返回的全量元信息快照
 * @param prefix 路径前缀过滤器 如 'sequences/' 或 'chapters/'
 * @returns 匹配且确实存在的资产 path 升列（保持 listAssetFiles 原 Set 插入序）
 */
export function listGeneratedAssets(
  assets: AssetFileInfo[],
  prefix: string,
): string[] {
  return assets
    .filter((a) => a.path.startsWith(prefix) && a.exists)
    .map((a) => a.path)
}
