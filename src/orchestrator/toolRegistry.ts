import type { ToolSpec } from '../types'
import type OpenAI from 'openai'

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

/**
 * ToolRegistry — 所有 Tool 的声明式注册表（v5）
 *
 * v5 变更：
 * - gen/refine 合并为单一 Tool（自身文件在 reads 中 → 空则创建，有则修改）
 * - 新增 foreshadowing_tracker / subplot_manager / story_checker
 * - 移除 plot_synopsis（职能被 act_map 吸收）
 */
export const TOOL_REGISTRY: ToolSpec[] = [
  // ===== 基础设定 =====
  {
    id: 'worldbuilding',
    name: '世界观设定',
    description: '创建或修改世界观设定。文件不存在时自动创建，存在时在已有内容上修改。根据输入内容自动判断架空模式（完整设定）或现实模式（环境概述）',
    systemPromptFile: 'prompts/worldbuilding.md',
    reads: ['user_requirements.md', 'worldbuilding.md'],
    writes: ['worldbuilding.md'],
    outputTags: ['<<<WORLDBUILDING_START>>>', '<<<WORLDBUILDING_END>>>'],
    group: '基础设定',
  },
  {
    id: 'characters',
    name: '角色设定',
    description: '创建或修改角色设定。文件不存在时从零生成角色列表，存在时在已有内容上新增或修改指定角色',
    systemPromptFile: 'prompts/characters.md',
    reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md'],
    writes: ['characters.md'],
    outputTags: ['<<<CHARACTERS_START>>>', '<<<CHARACTERS_END>>>'],
    group: '基础设定',
  },

  // ===== 大纲结构 =====
  {
    id: 'act_map',
    name: '幕结构设计',
    description: '创建或修改幕级结构（3-12 幕，10 列宽表）。吸收剧情概要职能，直接基于世界观和角色构建剧情方向',
    systemPromptFile: 'prompts/act_map.md',
    reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md'],
    writes: ['act_map.md'],
    outputTags: ['<<<ACT_MAP_START>>>', '<<<ACT_MAP_END>>>'],
    group: '大纲结构',
  },
  {
    id: 'sequence_list',
    name: '序列清单设计',
    description: '创建或修改序列清单（11 列宽表，含戏剧问题/统一语境/新鲜信息）',
    systemPromptFile: 'prompts/sequence_list.md',
    reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md'],
    writes: ['sequence_list.md'],
    outputTags: ['<<<SEQUENCE_LIST_START>>>', '<<<SEQUENCE_LIST_END>>>'],
    group: '大纲结构',
  },

  // ===== 微观精铸 =====
  {
    id: 'scene_beats',
    name: '场景节拍设计',
    description: '创建或修改场景节拍大纲（按序列分组的场景表 + 节拍表）。需参考伏笔规划来嵌入信息披露的铺设与回收',
    systemPromptFile: 'prompts/scene_beats.md',
    reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'foreshadowing.md'],
    writes: ['scene_beat_outline.md'],
    outputTags: ['<<<SCENE_BEAT_OUTLINE_START>>>', '<<<SCENE_BEAT_OUTLINE_END>>>'],
    group: '微观精铸',
  },

  // ===== 信息披露 =====
  {
    id: 'foreshadowing_tracker',
    name: '伏笔与信息披露追踪',
    description: '规划伏笔的铺设与回收位置。在序列结构确定之后，规划故事中信息的逐步展开',
    systemPromptFile: 'prompts/foreshadowing_tracker.md',
    reads: ['user_requirements.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md'],
    writes: ['foreshadowing.md'],
    outputTags: ['<<<FORESHADOWING_START>>>', '<<<FORESHADOWING_END>>>'],
    group: '信息披露',
  },

  // ===== 支线管理 =====
  {
    id: 'subplot_manager',
    name: '支线管理器',
    description: '管理支线完整生命周期：开辟（OPEN）、合并（MERGE）、修改（REFINE）。支线以标签形式嵌入序列和场景中',
    systemPromptFile: 'prompts/subplot_manager.md',
    reads: ['user_requirements.md', 'characters.md', 'foreshadowing.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'subplots.md'],
    writes: ['subplots.md'],
    outputTags: ['<<<SUBPLOTS_START>>>', '<<<SUBPLOTS_END>>>'],
    group: '支线管理',
  },

  // ===== 需求管理 =====
  {
    id: 'user_requirements_analyzer',
    name: '用户需求整理者',
    description: '分析用户的自然语言输入，提取并整理为结构化的用户需求文档。用于捕捉用户对世界观、角色、剧情方向、基调风格等方面的意图。新项目时创建，后续可追加或修改已有需求',
    systemPromptFile: 'prompts/user_requirements_analyzer.md',
    reads: ['user_requirements.md'],
    writes: ['user_requirements.md'],
    outputTags: ['<<<USER_REQUIREMENTS_START>>>', '<<<USER_REQUIREMENTS_END>>>'],
    group: '需求管理',
  },

  // ===== 检查 =====
  {
    id: 'story_checker',
    name: '故事多维度一致性检查',
    description: '对全部已生成的故事资产做多维度一致性检查（伏笔完整性/世界观一致性/角色行为逻辑/信息回收/时间线/结构完整性），输出审查报告',
    systemPromptFile: 'prompts/story_checker.md',
    reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'foreshadowing.md', 'subplots.md', '_check_report.md'],
    writes: ['_check_report.md'],
    outputTags: ['<<<CHECK_REPORT_START>>>', '<<<CHECK_REPORT_END>>>'],
    group: '检查',
  },

  // ===== 系统 Tool =====
  {
    id: 'reset_all',
    name: '重置所有内容',
    description: '清空所有已生成的故事内容，从头开始。当用户要求"推翻重来"、"重新开始"、"换一个故事"时调用此工具',
    systemPromptFile: 'prompts/reset_all.md',
    reads: [],
    writes: [],
    outputTags: [],
    group: '系统',
  },
]

// ===== 工具函数 =====

/**
 * 获取指定 Tool 的配置
 */
export function getTool(toolId: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((t) => t.id === toolId)
}

/**
 * 获取所有可用的 Tool（v5：全部工具始终可见）
 *
 * 所有工具在 FC 列表中始终可见。
 * 结构感由每个 Tool 的 prompt 定义其层级位置 + reads 空标签机制维持。
 */
export function getAvailableTools(): ToolSpec[] {
  return TOOL_REGISTRY
}

/**
 * 获取所有 Tool 的 writes 文件列表（去重）
 */
export function getAllAssetPaths(): string[] {
  const paths = new Set<string>()
  for (const tool of TOOL_REGISTRY) {
    for (const w of tool.writes) {
      paths.add(w)
    }
  }
  return Array.from(paths)
}

/**
 * 隐藏资产路径（不出现在 AssetCard 列表中）
 * 以下划线 _ 开头的文件自动隐藏，此处仅作声明
 */
export const HIDDEN_ASSET_PATHS = ['_check_report.md', 'draft_history.md']

/**
 * 从 ToolSpec 构建 OpenAI 兼容的 Function Calling 参数
 */
export function buildFunctionSpec(tool: ToolSpec): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: `传递给 ${tool.name} 的具体修改指令。从用户原始需求中提取与此工具相关的部分，去掉无关内容。`,
          },
        },
        required: ['instruction'],
      },
    },
  }
}
