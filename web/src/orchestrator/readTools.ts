/**
 * readTools.ts — asset_shell / read_reference 通用工具 schema
 *
 * 两个工具供宽泛 subagent 在其专属多轮循环中使用：
 * - asset_shell：在项目资产内执行受控只读查询命令
 * - read_reference：读取当前 Skill 自己 references/ 目录下的一个参考文件
 */

import type OpenAI from 'openai'

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

export const ASSET_SHELL_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'asset_shell',
    description:
      '在当前项目资产目录内执行只读查询命令。支持 ls、find、grep、cat、head、tail、sed -n、wc。禁止写入、删除、网络访问、绝对路径、父级路径和命令拼接。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            '只读资产查询命令，如 `ls`、`grep -n "女主" characters.md`、`sed -n "20,80p" sequence_list.md`、`tail -n 80 novel_chapters/S1-1.md`。',
        },
      },
      required: ['command'],
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
