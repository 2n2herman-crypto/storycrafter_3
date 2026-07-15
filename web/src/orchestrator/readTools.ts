/**
 * readTools.ts — read_file / read_reference 通用工具 schema（v7.3 新增）
 *
 * 两个工具供宽泛 subagent 在其专属多轮循环中使用：
 * - read_file：读取任意已知资产文件的完整内容
 * - read_reference：读取当前 Skill 自己 references/ 目录下的一个参考文件
 *
 * 与 agentLoop.ts 配合：schema 供 runAgentLoop 的 tools 参数使用，
 * 具体执行逻辑由 executeReadToolCall 绑定（在 orchestratorEngine.ts 里实现）。
 */

import type OpenAI from 'openai'

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

export const READ_FILE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      '读取一个已知资产文件的完整内容。path 为资产文件路径，如 sequences/S1-1.md、characters.md 等。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '资产文件路径，如 sequences/S1-1.md、worldbuilding.md',
        },
      },
      required: ['path'],
    },
  },
}

export const READ_REFERENCE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_reference',
    description:
      '读取当前 Skill 自己 references/ 目录下的一个参考文件。name 为文件名（不含路径与 .md 后缀），如 shot_split_rules、visual_description_rules。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '参考文件名（不含路径与 .md 后缀），如 shot_split_rules',
        },
      },
      required: ['name'],
    },
  },
}
