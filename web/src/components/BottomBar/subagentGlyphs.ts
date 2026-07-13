/**
 * v7.2：执行日志时间线卡片用的前端静态映射表。
 * 与 subagent.md 的 description（喂给 Orchestrator FC 决策）语义目的不同，独立维护。
 */

/** 引擎内部机制性 Subagent：每轮自动前置调用，非 Orchestrator FC 主动选择，不作为用户可感知的创作步骤展示 */
export const HIDDEN_FROM_TIMELINE = new Set(['user_requirements_analyzer', 'input_normalizer'])

/** subagentId → 调用原因（可读性优先，非 FC description 的技术性文案） */
export const SUBAGENT_REASON: Record<string, string> = {
  worldbuilding: '构建故事的世界观与背景设定',
  characters: '设计角色与人物关系',
  act_map: '规划幕级结构与剧情走向',
  sequence_list: '拆解序列清单与戏剧节奏',
  scene_beats: '铺设场景与节拍细节',
  foreshadowing_tracker: '规划伏笔的铺设与回收',
  subplot_manager: '管理支线的开辟与合并',
  story_checker: '审查故事一致性与结构完整性',
  novel_writer: '展开小说正文',
  screenplay_writer: '展开剧本正文',
  long_drama_writer: '展开长剧正文',
  short_drama_writer: '展开短剧正文',
  reset_all: '重置全部故事资产',
}

/** subagentId → 单字图形图标（非 emoji，对齐 StageCard 单字图标风格） */
export const SUBAGENT_GLYPH: Record<string, string> = {
  worldbuilding: '世',
  characters: '角',
  act_map: '幕',
  sequence_list: '序',
  scene_beats: '场',
  foreshadowing_tracker: '伏',
  subplot_manager: '支',
  story_checker: '查',
  novel_writer: '写',
  screenplay_writer: '写',
  long_drama_writer: '写',
  short_drama_writer: '写',
  reset_all: '重',
}

/** 查表 + 兜底：未登记的 subagentId 回退为 toolName 本身 */
export function getSubagentReason(toolId: string, toolName: string): string {
  return SUBAGENT_REASON[toolId] ?? toolName
}

/** 查表 + 兜底：未登记的 subagentId 回退取 toolName 首字 */
export function getSubagentGlyph(toolId: string, toolName: string): string {
  return SUBAGENT_GLYPH[toolId] ?? toolName.charAt(0)
}
