import type OpenAI from 'openai'
import type { SubagentSpec, SkillSpec, ToolResult, DispatchResult, SchedulerState, ExecutionEvent, ExecutionEventCallback, ConversationTurn, AssetFileInfo, TurnStopReason } from '../types'
import type { ProductProfile, ProductKind } from '../types/product'
import { PRODUCT_PROFILES, WRITER_IDS, renderProductProfileXml } from '../types/product'
import {
  getSubagent,
  getAvailableSubagents,
  buildFunctionSpec,
  getSkills,
  getSkillById,
  getSkillIndex,
  filterSkillIndexForProduct,
  REFERENCE_CONTENTS,
} from '../skills/skillLoader'
import { assembleContext, buildAgentPrompt, wrapFileAsXml } from './contextAssembler'
import { validateOutput, extractMultiFileOutput } from './outputValidator'
import type { LLMClient } from '../llm/client'
import type { FileManager } from './fileManager'
import { usePhaseStore } from '../store/phaseStore'
import { useSelfCheckStore } from '../store/selfCheckStore'
import orchestratorPromptRaw from '../llm/prompts/orchestrator_v5.md?raw'
import { runAgentLoop, SUBAGENT_LOOP_MAX_ROUNDS } from './agentLoop'
import { READ_FILE_TOOL, READ_REFERENCE_TOOL, READ_SKILL_TOOL } from './readTools'
import { auditStructure, type StructuralIssue } from '../skills/checker/structuralAudit'
import { buildProjectStatusSnapshot, isProjectStatusQuery } from './projectStatus'
import { buildTurnSummary, renderTurnSummary, type ExecutedToolResult } from './turnSummary'

type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam

// ===== 常量 =====

const MAX_RETRIES = 3
const MAX_TOOLS_PER_ROUND = 5
const CONTEXT_LIMIT_CHARS = 22_000 // deepseek-v4-flash 32K 的 ~70%
const MAIN_LOOP_MAX_ROUNDS = 10
const TURN_TIMEOUT_MS = 5 * 60 * 1000
const MAX_NO_PROGRESS_ROUNDS = 2
const READ_ASSET_FILE_TOOL_ID = 'read_asset_file'
const READ_ASSET_FILE_MAX_CHARS = 12_000

const READ_ASSET_FILE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: READ_ASSET_FILE_TOOL_ID,
    description:
      '渐进式读取一个项目资产文件。用于主调度在需要确认真实序列 ID、序列数量、任务规模或资产内容时读取 sequence_list.md 等文件；只读，不写入。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '资产路径，如 sequence_list.md、act_map.md、sequences/S1-1.md。不得使用绝对路径或 ..。',
        },
      },
      required: ['path'],
    },
  },
}

/** v7.3：统一并发池上限（构筑/写作 subagent 批量调度共用） */
const BATCH_CONCURRENCY = 5

/** 创作 Subagent ID 列表（用于后处理判断是否需要更新需求状态，以及设计期/写作期可见性管控） */
const CREATIVE_TOOL_IDS = [
  'worldbuilding', 'characters', 'act_map', 'sequence_list',
  'sequence_builder', 'foreshadowing_tracker', 'subplot_manager',
]

/** v7.3：宽泛 subagent ID 列表（走独立隔离上下文执行路径） */
const ISOLATED_SUBAGENT_IDS = ['quality_checker', 'sequence_builder', 'prose_writer']


type WriterOutputKind =
  | 'novel_chapter'
  | 'short_drama_script'
  | 'long_drama_script'
  | 'film_script'
  | 'video_script'

function getWriterOutputKind(profile: ProductProfile | null, skillId: string): WriterOutputKind {
  if (skillId === 'video_shot_script_rules') return 'video_script'
  if (!profile || profile.kind === 'novel') return 'novel_chapter'
  if (profile.kind === 'short_drama') return 'short_drama_script'
  if (profile.kind === 'long_drama') return 'long_drama_script'
  return 'film_script'
}

function getDefaultSkill(subagentId: string): SkillSpec {
  const skills = getSkills(subagentId)
  if (skills.length === 0) {
    throw new Error(`[skillResolver] Subagent "${subagentId}" 没有可用 Skill`)
  }
  return skills[0]
}

function isVideoScriptIntent(instruction: string): boolean {
  return /视频脚本|分镜|镜头|景别|运镜|拍摄脚本|视听|时长/i.test(instruction)
}

/**
 * 前置需求合并指令（v5.5 机制 A）
 *
 * 每轮 FC 循环前调用 user_requirements_analyzer，把用户本轮明确表达的新需求
 * 结合对话上下文合并进 user_requirements.md。区别于后处理的"状态标记模式"。
 */
const MERGE_INSTRUCTION =
  '结合最近的对话上下文（<conversation_history>），将用户本轮明确表达的新需求合并进 user_requirements.md。' +
  '遵循高精度低召回：只记录用户明说的需求；解析"那个""上面说的"等指代时，以对话上文为准锚定其所指，' +
  '无法明确锚定的指代不要臆测。保留所有已有的状态标记（✅/⬜/❌）不变。' +
  '如果用户本轮没有提出任何新需求，原样返回已有的需求文档，不要新增或改写条目。'

/** v6.6：前置归一化指令——把 _input_raw.md 分类为种子资产 */
const NORMALIZE_INSTRUCTION =
  '通读 <_input_raw> 全部内容（多文件以 <<< 来源:文件名 >>> 分隔），判定输入类型并归一化为对应种子资产。' +
  '按 <product_profile> 的层语义组织；既有种子资产非空时增量合并不覆盖；只产出有信号的文件块，不凑数。'


// ===== v6.1 动态写靶协议扩展（resolveWriteTarget / resolveExtraContext）=====

/**
 * 目标标识符合法性护栏：
 * 主层级 S{幕}-{序} 如 S1-1；细粒度子级 SC-{seq}-{nn} 如 SC-S1-1-01；
 * 集级 S{幕}-{序}-{n} 如 S1-1-03（短剧一序列多集时 Orche 可能传，由 normalizeToSequenceId 归约）。
 * v6.6：后缀放宽 -\d{2} → -\d{1,2}，兼容一位集号；不收紧拒收，归约兜底规避写死风险。
 */
const TARGET_ID_REGEX = /^[A-Z]\d+-\d+(?:-\d{1,2})?$/

/**
 * 从细粒度标识符反推所属序列 ID（成文 writer 定位上游 sequence beats 文件、
 * 落盘 chapters 路径统一用序列级 ID）。
 *
 * v6.6：短剧一序列多集，Orchestrator 可能传集级 ID（如 S1-1-03）指代"第3集"。
 * 若不归约，会落成 chapters/S1-1-03.md（每集一个文件）且读错 sequences/S1-1-03.md
 * （实际场记是 sequences/S1-1.md）。此处把集级 ID 归约到序列级，保证整序列多集
 * 追加到同一 chapters/<序列ID>.md——归约兜底而非拒收，规避"格式偏差导致无法输出"。
 *
 * 例：SC-S1-1-02 → S1-1（场景号）；S1-1-03 → S1-1（集级 ID）；S2-3 → S2-3（已序列级）。
 */
function normalizeToSequenceId(target: string): string {
  // SC-S1-1-02 → S1-1（场景号反推）
  const sc = /^SC-([A-Z]\d+-\d+)/.exec(target)
  if (sc) return sc[1]
  // S1-1-03 → S1-1（集级 ID 反推序列；短剧一序列多集时 Orche 可能传集号）
  const ep = /^([A-Z]\d+-\d+)-\d+$/.exec(target)
  if (ep) return ep[1]
  return target
}

/** v6.9 两位零填充：1 → "01"（集号路径用） */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

interface ExtraLabelEntry {
  /** XML tag 名（不含尖括号），如 prev_scenes / current_target */
  label: string
  content: string | undefined
}

/** 将额外标签条目拼接到 assembledContext 尾部，零侵入 assembleContext 本体（INV-2）。空值自动过滤。 */
function appendExtraLabels(ctxStatic: string, entries: ExtraLabelEntry[]): string {
  const parts = entries
    .filter((e) => e.content !== undefined && e.content.length > 0)
    .map((e) => `<${e.label}>\n${e.content}\n</${e.label}>`)
  if (parts.length === 0) return ctxStatic
  return `${ctxStatic}\n\n${parts.join('\n\n')}`
}

/** 安全读文件不存在时回 '' 而非抛错（pipeline 注入上下文容错所需）*/
async function safeRead(fm: FileManager, path: string): Promise<string> {
  try {
    return await fm.readFile(path)
  } catch {
    return ''
  }
}


/**
 * v6.6：极简表格数据行计数——数 `|` 起始且 `|` 结尾的行，去掉表头与分隔行。
 *
 * 仅供 buildEpisodeRangeMap 做量级评估用；不替代 structuralAudit
 * 内的 parseMarkdownTable（后者承担列数/ID 等阻塞校验，逻辑更严）。
 */
function countTableDataRows(md: string): number {
  const lines = md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'))
  if (lines.length < 2) return Math.max(0, lines.length)
  // 第 2 行是分隔行（|---|---|），剔除；第 1 行是表头，剔除
  return lines.length - 2
}

// ===== v6.3 拼接聚合标签辅助函数（守 INV-2：不侵入 assembleContext 本体）=====

/**
 * 将 glob 展开后同前缀的多文件拼成一个聚合 XML 标签。
 *
 * 展开逻辑仅在 skill.reads 出现 `/*.md` 后缀时触发；非 checker 的其他 skill 全部走原路径。
 * 同前缀文件以 `<slice id="...">` 子 tag 并列，外层 tag 名由 prefix 推导：
 *   sequences/ → <sequence_slices>
 */
function expandGlobs(
	reads: string[],
	allPaths: AssetFileInfo[],
): { reads: string[]; aggregatedLabel: string } {
	const globPattern = /^(.*)\/\*\.md$/
	const expanded: string[] = []
	let aggregatedLabel = ''

	for (const r of reads) {
		const m = globPattern.exec(r)
		if (m) {
			const prefix = m[1] // e.g. 'sequences'
			const hits = allPaths
				.filter((a) => a.path.startsWith(prefix + '/') && a.path.endsWith('.md') && a.exists)
				.map((a) => a.path)
				.sort()

			// 把命中的文件逐个加入 expanded（用于后续 readFile）
			expanded.push(...hits)

			// 拼聚合标签名
			if (prefix === 'sequences') {
				aggregatedLabel = 'sequence_slices'
			}
			// 未来可扩展更多前缀 → 标签名映射
		} else {
			expanded.push(r)
		}
	}

	return { reads: expanded, aggregatedLabel }
}

/**
 * 将聚合标签前缀对应的多文件内容拼成 `<tagName>\n<slice id="...">...</slice>...</tagName>`。
 * 全局展开后调用此函数，把 files dict 中的同名文件按 ID 分组聚合，
 * 返回一段可直接 append 到上下文尾部的字符串块。
 */
function buildAggregatedXml(
	aggregatedLabel: string,
	expandedReads: string[],
	files: Record<string, string>,
): string {
	if (expandedReads.length === 0) return ''
	const inner = expandedReads
		.map((p) => {
			const id = p.replace(/^sequences\//, '').replace(/\.md$/, '')
			return `<slice id="${id}">\n${files[p] ?? ''}\n</slice>`
		})
		.join('\n\n')
	return `\n\n<${aggregatedLabel}>\n${inner}\n</${aggregatedLabel}>`
}


// ===== Prompt 加载 =====

/**
 * 加载并组装 Orchestrator System Prompt（注入可用 Subagent 列表）
 */
function loadOrchestratorPrompt(tools: object[]): string {
  return orchestratorPromptRaw.replace(
    '{available_tools_json}',
    JSON.stringify(tools, null, 2),
  )
}

// ===== Skill 执行 =====

/** 截断字符串到指定长度，超出加省略号（v7.2：执行日志时间线副标题用） */
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}

function normalizeCallText(text: string): string {
  return text.trim().toLowerCase().replace(/[\s，。！？、；：,.!?;:]+/g, ' ')
}

function buildToolCallSignature(toolId: string, target: string, instruction: string): string {
  return `${toolId}:${target.trim().toUpperCase()}:${normalizeCallText(instruction)}`
}

function isSafeAssetPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    /^[\w./-]+\.md$/.test(path)
  )
}

// ===== 上下文管理 =====

/**
 * 计算消息列表的近似 token 数（粗略估算：字符数 / 2）
 */
function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let totalChars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length
    }
  }
  return Math.round(totalChars / 2)
}

/**
 * 压缩消息列表：保留最新的 2 轮工具调用，对更早的做摘要
 */
function compressMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  if (messages.length <= 4) return messages

  // 保留最新 2 轮（最后 4 条消息：2 个 assistant + 2 个 tool）
  const keep = messages.slice(-4)

  // 在消息列表开头添加压缩标记
  return [
    { role: 'system', content: '[此前工具调用已完成，以下为最新 2 轮调用记录]' },
    ...keep,
  ]
}

// ===== OrchestratorEngine =====

/**
 * Orchestrator 调度引擎（v5）
 *
 * 核心方法：processUserInput()
 *   → 注入可用工具到 System Prompt
 *   → 进入 FC 循环（最多 10 轮）
 *     → LLM 返回 tool_calls → 串行执行 Tool（最多 5 个/轮）
 *     → 写入文件 → 继续循环
 *     → LLM 返回 stop → 输出给用户
 *   → 超限 → 强制结束
 *   → audit 循环（quality_checker 最多 3 轮）与 FC 循环独立计数
 *
 * @see product_design_v4/orchestrator调度引擎设计.md
 */
export class OrchestratorEngine {
  private llm: LLMClient
  private fileManager: FileManager
  private onEvent?: ExecutionEventCallback




  /**
   * v6.6 产品档案锁：项目级锁定不可变，由 UI 产品选择器经 lockProfile() 落定。
   * null = 当前项目尚未选择产品（Guard-0：设计区与成文区全部禁用）。
   * 选定后不可在项目内切换；如需其他产品方向，应新建项目。
   */
  private profileLock: ProductProfile | null = null

  constructor(llm: LLMClient, fileManager: FileManager) {
    this.llm = llm
    this.fileManager = fileManager
  }

  // ===== v6.6 产品档案锁 =====

  /**
   * UI 产品选择器落定产品档案（会话级锁定不可变）。
   * 必须在任何 sendMessage 之前调用——设计区/成文区的结构参数全部自此派生。
   */
  lockProfile(kind: ProductKind): void {
    this.profileLock = PRODUCT_PROFILES[kind]
  }

  /** 查询当前产品档案（UI 展示 / 注入判定用）*/
  getProfile(): ProductProfile | null {
    return this.profileLock
  }

  /**
   * v6.6：用户投喂文件落到 `_input_raw.md`（input_normalizer 的生产端）。
   *
   * 单文件直写、多文件追加合并——以 `<<< 来源:文件名 >>>` 分隔标记来源，
   * 便于归一化时区分不同投喂物。归一化产出种子资产后引擎不清空本文件，
   * 由 processUserInput 检测"未归一化"状态决定是否强制先跑 input_normalizer。
   */
  async appendInputRaw(filename: string, content: string): Promise<void> {
    const path = '_input_raw.md'
    const existing = await safeRead(this.fileManager, path)
    const block = `<<< 来源:${filename} >>>\n${content}`
    const next = existing.length > 0 ? `${existing}\n\n${block}` : block
    await this.fileManager.writeFile(path, next)
  }

  /**
   * v6.6：归一化完成后清空 `_input_raw.md`（标记已消费，避免下轮重复归一化）。
   */
  async clearInputRaw(): Promise<void> {
    await this.fileManager.writeFile('_input_raw.md', '')
  }

  /** 发射执行事件 */
  private emit(
    type: ExecutionEvent['type'],
    data: Omit<ExecutionEvent, 'type' | 'timestamp'>,
  ): void {
    this.onEvent?.({ type, timestamp: Date.now(), ...data })
  }

  /**
   * 执行单个 Subagent（v7.3 后：Subagent 直接绑定 Skill；宽泛 Subagent 走独立上下文目标解析）
   *
   * v6.1 扩展点：
   *   - 第 4 可选参 options.target 承载 FC args.target_{sequence|chapter}，由 processUserInput
   *     dispatch loop 解析 JSON arguments 后透传进来。
   *   - 按原有单 Skill 直发流程，其中成文 writer 经 resolveWriteTarget 计算 effectiveWrites
   *     替换 placeholder 并同步喂读 <current_draft>/<current_sequence_beats>/<current_target>
   *     触发 create/refine 双模自判定。validator 业务一行未改（INV-1）。
   *
   * @param history - 可选：最近若干轮对话（v5.5，供需求整理者解析指代）
   * @param options - v6.1 可选动态靶元信息 { target }
   */
  private async executeTool(
    subagent: SubagentSpec,
    instruction: string,
    history?: ConversationTurn[],
    options?: { target?: string },
  ): Promise<ToolResult> {
    // ===== v6.6 Guard 体系（FC 面 Guard-0/1 已裁剪，此处双保险兜底）=====
    //  - Guard-0：未选产品(profileLock=null)时所有创作工具均不可用
    //  - Guard-2：写作期屏蔽设计区（含构筑 subagent）；设计期屏蔽写作 subagent
    //  - v7.3：quality_checker 不受阶段限制，只受 selfCheckStore 开关约束（下方独立判断）
    const psGuard = usePhaseStore.getState()
    if (this.profileLock === null) {
      this.emit('tool_error', {
        toolId: subagent.id,
        toolName: subagent.name,
        message: `${subagent.name} 暂不可用：尚未选择产品方向`,
      })
      return {
        success: false,
        error: `${subagent.name} 暂不可用，请引导用户先在顶部选择产品方向（小说/剧本/长剧/短剧）`,
        skillName: subagent.name,
      }
    }
    if (subagent.id === 'quality_checker' && !useSelfCheckStore.getState().selfCheckEnabled) {
      this.emit('tool_error', {
        toolId: subagent.id,
        toolName: subagent.name,
        message: `${subagent.name} 当前已被自检模式开关关闭`,
      })
      return {
        success: false,
        error: `${subagent.name} 已被自检模式开关关闭，请引导用户先开启自检模式`,
        skillName: subagent.name,
      }
    }
    if (psGuard.isWriting()) {
      if (CREATIVE_TOOL_IDS.includes(subagent.id)) {
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          message: `${subagent.name} 属于设计期专用工具，当前处于写作期已被阶段闸门屏蔽`,
        })
        return {
          success: false,
          error: `${subagent.name} 受阶段闸门屏蔽，请引导用户点🔓解锁回到设计期后再调整此设定`,
          skillName: subagent.name,
        }
      }
    } else if (WRITER_IDS.includes(subagent.id)) {
      this.emit('tool_error', {
        toolId: subagent.id,
        toolName: subagent.name,
        message: `${subagent.name} 仅在写作期可用，请先点🔒锁定大纲再发起正文创作`,
      })
      return {
        success: false,
        error: `${subagent.name} 当前不在开放窗口内（须先 HeaderBar 🔒锁定大纲进入写作期）`,
        skillName: subagent.name,
      }
    }

    const target = options?.target?.trim() ?? ''

    // ===== v7.3 宽泛 subagent 分流：独立隔离上下文执行 =====
    // quality_checker 不带 target 语义（检查粒度由 instruction 自然语言指定，非按序列批量），
    // 始终走单次隔离执行；sequence_builder/prose_writer 沿用 target 协议：
    // 空 target = 批量并发全部序列，带 target = 精修单序列。
    if (ISOLATED_SUBAGENT_IDS.includes(subagent.id)) {
      if (subagent.id !== 'quality_checker' && !target) {
        const seqListMd = await safeRead(this.fileManager, 'sequence_list.md')
        const seqIds = this.parseSequenceIds(seqListMd)
        if (seqIds.length === 0) {
          return {
            success: false,
            error: '未能从 sequence_list.md 解析出任何序列 ID，请先生成序列清单',
            skillName: subagent.name,
          }
        }
        return this.runBatchWithSubagent(subagent, instruction, seqIds)
      }
      if (target && !TARGET_ID_REGEX.test(target)) { return { success: false, error: `目标序列格式非法：${target}`, skillName: subagent.name } }
      if (target) {
        const normalized = normalizeToSequenceId(target)
        const seqListMd = await safeRead(this.fileManager, 'sequence_list.md')
        const knownIds = this.parseSequenceIds(seqListMd)
        if (!knownIds.includes(normalized)) {
          this.emit('tool_error', { toolId: subagent.id, toolName: subagent.name, message: `${subagent.name} 目标序列 ${normalized} 不存在于序列清单中` })
          return { success: false, error: `目标序列 ${normalized} 不存在，请先在 sequence_list.md 中注册该序列（已有序列：${knownIds.join(', ') || '无'}）`, skillName: subagent.name }
        }
      }
      return this.runSubagentWithIsolatedContext(subagent, instruction, target ? normalizeToSequenceId(target) : undefined)
    }


    // ===== 单 Skill 直发路径 =====
    // ① v7.3 后撤销旧技能分流层：非隔离 Subagent 均按注册顺序使用默认 Skill。
    const skill = getDefaultSkill(subagent.id)

    // ② 读上下文（按 Skill.reads，支持 /*.md glob 展开 v6.3）
    const files: Record<string, string> = {}
    const allPaths = await this.fileManager.listAssetFiles()
    const { reads: expandedReads, aggregatedLabel } = expandGlobs(skill.reads, allPaths)
    for (const path of expandedReads) {
      if (!(path in files)) {
        files[path] = await safeRead(this.fileManager, path)
      }
    }

    // ③ 组装静态上下文 + v6.3 聚合标签拼接（若命中 glob 即追加 <sequence_slices>）
    let context = assembleContext(expandedReads, files)
    if (aggregatedLabel) {
      const prefix = aggregatedLabel === 'sequence_slices' ? 'sequences' : ''
      if (prefix) {
        context += buildAggregatedXml(aggregatedLabel, expandedReads, files)
      }
    }

    // ④ System Prompt：角色前缀 + Skill 正文
    const systemPrompt = skill.preamble ? `${skill.preamble}\n\n${skill.body}` : skill.body

    // ⑤ v6.1 设计区 Subagent 注入档案
    let effectiveWrites = skill.writes
    if (this.profileLock) {
      // v6.6 设计区档案化：非 writer 的设计区 Subagent（act_map/sequence_list/
      //   foreshadowing_tracker/subplot_manager 等）注入 <product_profile>，
      //   供其 SKILL body 去硬编码后按档案取幕/序/场/拍区间与节拍词库、伏笔寿命。
      //   Guard-0 已保证此处 profileLock 必非 null。
      context = appendExtraLabels(context, [
        { label: 'product_profile', content: renderProductProfileXml(this.profileLock) },
      ])
    }

    // ⑥ 完整 userContent（v5.5：可附对话历史供指代解析）
    let userContent = buildAgentPrompt(context, instruction, history)

    // specView 仅供 validateOutput 取 outputTags + effectiveWrites[0]，validator 业务零改（INV-1）
    const specView: SkillSpec = { ...skill, writes: effectiveWrites }

    // v6.6：input_normalizer 走多文件提取分支（独立于 validateOutput 主体，守 INV-1 边缘）
    const isNormalizer = subagent.id === 'input_normalizer'

    // ⑦ 调用 LLM + 校验（最多 3 次重试）。v6.9：writer 已被上方 WRITER 分流截走，
    //    此处仅服务 input_normalizer + 设计区单 Skill Subagent，落盘即直接写 content。
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const output = await this.llm.sendMessage(systemPrompt, userContent)
        const validation = isNormalizer
          ? extractMultiFileOutput(output, specView)
          : validateOutput(output, specView)

        if (validation.valid) {
          for (const [file, content] of Object.entries(validation.extracted)) {
            await this.fileManager.writeFile(file, content)
          }
          // v6.6：归一化成功后清空 _input_raw.md（标记已消费，避免下轮重复归一化）
          if (isNormalizer) {
            await this.clearInputRaw()
          }
          return {
            success: true,
            writes: Object.keys(validation.extracted),
            output,
            skillId: skill.skillId,
            skillName: skill.name,
          }
        }

        // 校验失败：追加格式提示后重试
        if (attempt < MAX_RETRIES - 1) {
          this.emit('tool_retry', {
            toolId: subagent.id,
            toolName: subagent.name,
            skillId: skill.skillId,
            skillName: skill.name,
            attempt: attempt + 1,
            maxAttempts: MAX_RETRIES,
            message: `${subagent.name} 格式错误，重试 ${attempt + 1}/${MAX_RETRIES}`,
          })
          // v6.2：优先透传结构化钩子的具体错误消息（列数/ID 引用/类型词库等），
          // 让 retry 从盲抽奖变为带反馈的定向修正；无结构化错误时回退到 tag 缺失提示。
          const feedback = validation.structuralError
            ? `⚠️ 结构错误：${validation.structuralError}`
            : `⚠️ 格式错误：输出必须包含正确的 ${specView.outputTags[0]} 和 ${specView.outputTags[1]} 包裹。请严格遵循模板格式重新输出完整内容。`
          userContent = `${userContent}\n\n---\n${feedback}`
        }
      } catch (e) {
        if (attempt === MAX_RETRIES - 1) {
          return { success: false, error: `执行失败: ${(e as Error).message}` }
        }
      }
    }

    return { success: false, error: `输出校验失败（已重试${MAX_RETRIES}次）` }
  }

  /**
   * v6.8 有界并发池：最多 limit 个 worker 同时跑，超出排队。
   * out[i] 与 items[i] 下标对齐（无论完成顺序），保证批量汇总稳定。
   */
  private async runWithConcurrency<T, R>(
    items: T[], limit: number, worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await worker(items[i])
      }
    })
    await Promise.all(runners)
    return out
  }

  /** v6.7 从 sequence_list.md 扫全部序列 ID（S{幕}-{序}），去重排序 */
  private parseSequenceIds(seqListMd: string): string[] {
    const set = new Set<string>()
    const re = /\bS\d+-\d+\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(seqListMd)) !== null) set.add(m[0])
    return [...set].sort()
  }

  /**
   * v6.9 构建序列 ID → 全局集号区间 [start, end] 映射。
   * - one_to_many(短剧)：集数取 sequences/<ID>.md 场景表数据行数（一集一场景），解析失败回退 episodesPerSequence[0]
   * - one_to_one(长剧)：固定 1
   * - none(小说/剧本)：返回空 Map（路径仍用 chapters/<seqId>.md）
   * 按 sequence_list 的 seqIds 顺序累计全局集号。
   */
  private async buildEpisodeRangeMap(
    seqIds: string[],
  ): Promise<Map<string, [number, number]>> {
    const profile = this.profileLock
    const map = new Map<string, [number, number]>()
    if (!profile || profile.sequenceToEpisode === 'none') return map

    let cursor = 1
    for (const seqId of seqIds) {
      let count = 1
      if (profile.sequenceToEpisode === 'one_to_many') {
        const beatsMd = await safeRead(this.fileManager, `sequences/${seqId}.md`)
        const rows = countTableDataRows(beatsMd)
        count = rows > 0 ? rows : (profile.episodesPerSequence?.[0] ?? 8)
      }
      map.set(seqId, [cursor, cursor + count - 1])
      cursor += count
    }
    return map
  }

  private resolveWriterAssetId(
    seqId: string,
    episodeRange: Map<string, [number, number]>,
  ): string {
    const profile = this.profileLock
    if (!profile || profile.sequenceToEpisode === 'none') return seqId
    const range = episodeRange.get(seqId)
    if (!range) return seqId
    const [start, end] = range
    if (profile.sequenceToEpisode === 'one_to_many') return `E${pad2(start)}-E${pad2(end)}`
    return `E${pad2(start)}`
  }

  private resolveVideoProductDir(): 'short_drama' | 'long_drama' | 'film' {
    if (this.profileLock?.kind === 'short_drama') return 'short_drama'
    if (this.profileLock?.kind === 'long_drama') return 'long_drama'
    return 'film'
  }

  private resolveWriterOutputPath(
    seqId: string,
    skill: SkillSpec,
    episodeRange: Map<string, [number, number]>,
  ): string {
    const outputKind = getWriterOutputKind(this.profileLock, skill.skillId)
    const assetId = this.resolveWriterAssetId(seqId, episodeRange)

    switch (outputKind) {
      case 'novel_chapter':
        return `novel_chapters/${seqId}.md`
      case 'short_drama_script':
        return `short_drama_scripts/${assetId}.md`
      case 'long_drama_script':
        return `long_drama_scripts/${assetId}.md`
      case 'film_script':
        return `film_scripts/${seqId}.md`
      case 'video_script':
        return `video_scripts/${this.resolveVideoProductDir()}/${assetId}.md`
    }
  }

  private async buildProjectEpisodeRangeMap(): Promise<Map<string, [number, number]>> {
    const seqListMd = await safeRead(this.fileManager, 'sequence_list.md')
    return this.buildEpisodeRangeMap(this.parseSequenceIds(seqListMd))
  }

  private resolvePrimaryScriptSkill(): SkillSpec | undefined {
    const skills = getSkills('prose_writer')
    const skillId =
      this.profileLock?.kind === 'short_drama'
        ? 'short_drama_script_rules'
        : this.profileLock?.kind === 'long_drama'
          ? 'long_drama_script_rules'
          : this.profileLock?.kind === 'novel'
            ? 'novel_prose_rules'
            : 'film_script_rules'
    return skills.find((skill) => skill.skillId === skillId)
  }

  private async buildWriterPathHint(seqId: string): Promise<string> {
    const skills = getSkills('prose_writer')
    const episodeRange = await this.buildProjectEpisodeRangeMap()
    const primarySkill = this.resolvePrimaryScriptSkill()
    const videoSkill = skills.find((skill) => skill.skillId === 'video_shot_script_rules')
    const primaryPath = primarySkill
      ? this.resolveWriterOutputPath(seqId, primarySkill, episodeRange)
      : ''
    const videoPath = videoSkill && this.profileLock?.kind !== 'novel'
      ? this.resolveWriterOutputPath(seqId, videoSkill, episodeRange)
      : ''

    return [
      '<writer_asset_paths>',
      `  <target_sequence>${seqId}</target_sequence>`,
      primaryPath ? `  <primary_output>${primaryPath}</primary_output>` : '',
      videoPath ? `  <video_output>${videoPath}</video_output>` : '',
      '  <note>读取或写入写作资产时必须使用这里给出的真实路径；不要自行把序列号拼成旧 chapters 路径。</note>',
      '</writer_asset_paths>',
    ].filter(Boolean).join('\n')
  }

  // ===== v7.3 宽泛 subagent 独立上下文执行 =====

  private resolveAllowedReadPatterns(
    skill: SkillSpec,
    target?: string,
    extraPaths: string[] = [],
  ): string[] {
    const normalizedReads = skill.reads.map((path) => {
      if (!target) return path
      return path.replace(/<ID>/g, target).replace(/<target>/g, target)
    })
    return [...normalizedReads, ...extraPaths].filter(Boolean)
  }

  private isAllowedReadPath(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
      if (pattern === path) return true
      if (pattern.endsWith('/*.md')) {
        const prefix = pattern.slice(0, -'/*.md'.length)
        return path.startsWith(`${prefix}/`) && path.endsWith('.md')
      }
      return false
    })
  }

  private async buildExtraAllowedReadPaths(
    subagentId: string,
    target?: string,
  ): Promise<string[]> {
    if (subagentId !== 'prose_writer' || !target) return []
    const episodeRange = await this.buildProjectEpisodeRangeMap()
    return getSkills('prose_writer').map((skill) =>
      this.resolveWriterOutputPath(target, skill, episodeRange),
    )
  }

  /**
   * v7.3：质检 subagent 结构合法性维度的第一段——机械扫描（不调 LLM）。
   *
   * 读取全部已落盘的 act_map/sequence_list/sequences/scenes/beats，跑 structuralAudit.auditStructure，
   * 把结果格式化为一段项目符号列表，供第二段 LLM 语义判断在 <structural_scan_result> 标签下参考。
   * 只有 instruction 涉及结构合法性维度时才跑这一段（避免其余 4 个维度被迫多读一堆文件）。
   */
  private async runStructuralScanIfNeeded(instruction: string): Promise<string> {
    const structureKeywords = ['结构', '幕', '序列满足', '场景满足', '节拍满足', 'structure']
    const text = instruction.toLowerCase()
    const isStructureCheck = structureKeywords.some(kw => text.includes(kw.toLowerCase()))
    if (!isStructureCheck) return ''

    const allPaths = await this.fileManager.listAssetFiles()
    const actMap = await safeRead(this.fileManager, 'act_map.md')
    const sequenceList = await safeRead(this.fileManager, 'sequence_list.md')

    const sequenceFiles = new Map<string, string>()
    const sceneFiles = new Map<string, string>()
    const beatFiles = new Map<string, string>()
    for (const a of allPaths) {
      if (!a.exists) continue
      const seqMatch = /^sequences\/(.+)\.md$/.exec(a.path)
      const sceneMatch = /^scenes\/(.+)\.md$/.exec(a.path)
      const beatMatch = /^beats\/(.+)\.md$/.exec(a.path)
      if (seqMatch) sequenceFiles.set(seqMatch[1], await safeRead(this.fileManager, a.path))
      if (sceneMatch) sceneFiles.set(sceneMatch[1], await safeRead(this.fileManager, a.path))
      if (beatMatch) beatFiles.set(beatMatch[1], await safeRead(this.fileManager, a.path))
    }

    const issues = auditStructure({ actMap, sequenceList, sequenceFiles, sceneFiles, beatFiles })
    if (issues.length === 0) {
      return '<structural_scan_result>\n机械扫描未发现结构性缺失/悬空引用/格式错误。\n</structural_scan_result>'
    }
    const lines = issues.map((i: StructuralIssue) => `- [${i.level}] ${i.sequenceId}：${i.detail}（${i.issueType}）`)
    return `<structural_scan_result>\n以下是机械扫描发现的结构性问题：\n${lines.join('\n')}\n</structural_scan_result>`
  }

  /**
   * v7.3：宽泛 subagent 独立隔离上下文执行。
   *
   * 1. 只披露 Skill Index，完整 Skill 正文由 read_skill 按需读取
   * 2. 新建专属 messages 数组（与主 Orchestrator 隔离）
   * 3. 走 runAgentLoop 多轮循环，工具集为 read_skill / read_file / read_reference
   * 4. 循环结束后取 finalText，校验并落盘
   *
   * 质检 subagent 的"只读隔离"由工具集层面保证——它只能拿到 read_file/read_reference，
   * 不提供任何写入工具，引擎侧统一落盘。
   */
  private async runSubagentWithIsolatedContext(
    subagent: SubagentSpec,
    instruction: string,
    target?: string,
    skipVideoPrerequisite = false,
  ): Promise<ToolResult> {
    const prerequisiteWrites: string[] = []
    if (
      subagent.id === 'prose_writer' &&
      target &&
      !skipVideoPrerequisite &&
      this.profileLock?.kind !== 'novel' &&
      isVideoScriptIntent(instruction)
    ) {
      const primarySkill = this.resolvePrimaryScriptSkill()
      if (primarySkill) {
        const episodeRange = await this.buildProjectEpisodeRangeMap()
        const primaryPath = this.resolveWriterOutputPath(target, primarySkill, episodeRange)
        const existingScript = await safeRead(this.fileManager, primaryPath)
        if (!existingScript.trim()) {
          this.emit('tool_start', {
            toolId: subagent.id,
            toolName: subagent.name,
            skillId: primarySkill.skillId,
            skillName: primarySkill.name,
            message: `[${target}] 缺少产品剧本，先自动生成剧本`,
          })
          const scriptResult = await this.runSubagentWithIsolatedContext(
            subagent,
            '根据叙事结构生成当前产品的专业剧本；只输出产品主剧本，不输出二级拍摄稿。',
            target,
            true,
          )
          if (!scriptResult.success) return scriptResult
          prerequisiteWrites.push(...(scriptResult.writes ?? []))
        }
      }
    }

    const rawSkillIndex = getSkillIndex(subagent.id)
    const skillIndex = filterSkillIndexForProduct(
      subagent.id,
      rawSkillIndex,
      this.profileLock?.kind ?? null,
      instruction,
    )
    if (skillIndex.length === 0) {
      return {
        success: false,
        error: `${subagent.name} 当前没有可用 Skill，请检查产品方向、阶段或用户意图`,
        skillName: subagent.name,
      }
    }

    let selectedSkill: SkillSpec | null = null
    const readFiles = new Set<string>()
    const readReferences = new Set<string>()
    const extraAllowedReadPaths = await this.buildExtraAllowedReadPaths(subagent.id, target)

    const systemPrompt = [
      subagent.preamble || '',
      '',
      '## 渐进式披露协议',
      '你现在只能看到当前 Subagent 的 Skill Index。',
      '执行任务前必须先调用 read_skill，读取最合适的完整 Skill 规范。',
      '读取 Skill 后，只能调用 read_file 读取该 Skill 的 reads 声明范围内的资产。',
      '读取 Skill 后，只能调用 read_reference 读取该 Skill 声明的 references。',
      '最终输出必须遵循已读取 Skill 的 outputTags 与写入边界。',
      '如果已读取 Skill 的 outputTags 包含 START/END 两个标签，你的最终回复必须只包含一个完整 TAG 块：第一行是 START 标签，最后一行是 END 标签。',
      '不要在最终 TAG 块外写解释、总结、Markdown 代码围栏或额外寒暄；需要写入资产的正文全部放在 TAG 块内部。',
      '如果 outputTags 为空，才可以直接输出检查报告正文。',
      '',
      '<skill_index>',
      JSON.stringify(skillIndex, null, 2),
      '</skill_index>',
      this.profileLock ? `\n<product_profile>\n${renderProductProfileXml(this.profileLock)}\n</product_profile>` : '',
    ].filter(Boolean).join('\n')

    // v7.3：质检 subagent 的结构合法性维度先跑机械扫描，注入 <structural_scan_result>
    const structuralScan = subagent.id === 'quality_checker'
      ? await this.runStructuralScanIfNeeded(instruction)
      : ''
    const writerPathHint = subagent.id === 'prose_writer' && target
      ? await this.buildWriterPathHint(target)
      : ''

    // 目标序列注入 instruction
    const userContent = [
      target ? `${instruction}\n\n目标序列：${target}` : instruction,
      writerPathHint,
      structuralScan,
    ].filter(Boolean).join('\n\n')

    const initialMessages: ChatCompletionMessageParam[] = [
      { role: 'user', content: userContent },
    ]

    this.emit('subagent_loop_start', {
      toolId: subagent.id,
      toolName: subagent.name,
      message: `${subagent.name} 进入独立上下文执行（披露 ${skillIndex.length} 条 Skill 索引）`,
    })

    const result = await runAgentLoop(this.llm, {
      systemPrompt,
      initialMessages,
      tools: [READ_SKILL_TOOL, READ_FILE_TOOL, READ_REFERENCE_TOOL],
      executeToolCall: async (tc) => {
        const args = JSON.parse(tc.function.arguments || '{}')
        if (tc.function.name === 'read_skill') {
          const skillId = String(args.skillId ?? '').trim()
          if (!skillIndex.some((item) => item.skillId === skillId)) {
            return JSON.stringify({
              success: false,
              error: `Skill ${skillId || '(empty)'} 不在当前可用索引中`,
            })
          }
          const skill = getSkillById(subagent.id, skillId)
          if (!skill) {
            return JSON.stringify({ success: false, error: `未知 Skill: ${skillId}` })
          }
          selectedSkill = skill
          this.emit('subagent_loop_step', {
            toolId: subagent.id,
            toolName: subagent.name,
            skillId: skill.skillId,
            skillName: skill.name,
            message: `已选择规范：${skill.name}`,
          })
          return JSON.stringify({
            success: true,
            skill: {
              skillId: skill.skillId,
              name: skill.name,
              description: skill.description,
              when: skill.when,
              reads: skill.reads,
              writes: skill.writes,
              outputTags: skill.outputTags,
              references: skill.references ?? [],
              body: skill.body,
              finalOutputContract: skill.outputTags.length >= 2
                ? `最终回复必须以 ${skill.outputTags[0]} 开始，并以 ${skill.outputTags[1]} 结束；TAG 外不得有任何内容。`
                : '最终回复直接输出报告正文；无需 TAG。',
            },
          })
        }

        if (tc.function.name === 'read_file') {
          if (!selectedSkill) {
            return JSON.stringify({ success: false, error: '请先调用 read_skill 选择执行规范' })
          }
          const path = String(args.path ?? '').trim()
          const allowed = this.resolveAllowedReadPatterns(selectedSkill, target, extraAllowedReadPaths)
          if (!this.isAllowedReadPath(path, allowed)) {
            return JSON.stringify({
              success: false,
              error: `该文件不在当前 Skill reads 中: ${path}`,
              allowed,
            })
          }
          readFiles.add(path)
          const content = await safeRead(this.fileManager, path)
          return wrapFileAsXml(path, content)
        }

        if (tc.function.name === 'read_reference') {
          if (!selectedSkill) {
            return JSON.stringify({ success: false, error: '请先调用 read_skill 选择执行规范' })
          }
          const name = String(args.name ?? '').trim()
          if (!selectedSkill.references?.includes(name)) {
            return JSON.stringify({
              success: false,
              error: `该 reference 未被当前 Skill 声明: ${name}`,
              allowed: selectedSkill.references ?? [],
            })
          }
          const key = `${subagent.id}/${selectedSkill.skillId}/${name}`
          const content = REFERENCE_CONTENTS.get(key)
          if (!content) {
            return JSON.stringify({ success: false, error: `未找到参考文件: ${name}` })
          }
          readReferences.add(name)
          return content
        }

        throw new Error(`未知工具: ${tc.function.name}`)
      },
      maxRounds: SUBAGENT_LOOP_MAX_ROUNDS,
      onRound: (round) => {
        this.emit('subagent_loop_step', {
          toolId: subagent.id,
          toolName: subagent.name,
          round,
          message: `${subagent.name} 第 ${round + 1} 轮`,
        })
      },
    })

    this.emit('subagent_loop_complete', {
      toolId: subagent.id,
      toolName: subagent.name,
      message: result.finalText !== null
        ? `${subagent.name} 执行完成（${result.roundsUsed} 轮）`
        : `${subagent.name} 超轮次上限（${result.roundsUsed} 轮）`,
    })

    if (result.finalText === null) {
      return { success: false, error: '达到内部循环轮次上限仍未产出结果', skillName: subagent.name }
    }

    const finalSelectedSkill = selectedSkill as SkillSpec | null
    if (!finalSelectedSkill) {
      return {
        success: false,
        error: `${subagent.name} 未调用 read_skill 选择执行规范，无法继续写入`,
        skillName: subagent.name,
      }
    }

    // 质检 subagent：产出直接作为报告文本，不经过 outputValidator（它不打 TAG、不落盘）
    if (subagent.id === 'quality_checker') {
      return {
        success: true,
        output: result.finalText,
        skillId: finalSelectedSkill.skillId,
        skillName: finalSelectedSkill.name,
      }
    }

    // 构筑/写作 subagent：走 outputValidator 校验 + 落盘
    const persisted = await this.validateAndPersist(subagent, instruction, result.finalText, target, finalSelectedSkill)
    return {
      ...persisted,
      writes: [...prerequisiteWrites, ...(persisted.writes ?? [])],
    }
  }

  /**
   * v7.3 兼容回退：独立上下文完成后解析本次输出目标——优先按候选 skill 的 `when` 关键词命中，
   * 再回退到 outputTags 是否已出现在 finalText 里做兜底判断
   * （LLM 产出的 TAG 通常与它实际选用的规则一致，即使 instruction 没给出明确关键词）；
   * 仍无法判定则回退到候选列表第一项，保证行为始终可预测。
   */
  private resolveTargetSkill(
    subagent: SubagentSpec,
    instruction: string,
    finalText: string,
  ): SkillSpec | undefined {
    const subagentSkills = getSkills(subagent.id)
    const preloadedIds = subagent.skills ?? []
    let candidates = preloadedIds.length > 0
      ? preloadedIds.map(id => subagentSkills.find(s => s.skillId === id)).filter((s): s is SkillSpec => s !== undefined)
      : subagentSkills

    if (subagent.id === 'prose_writer') {
      candidates = this.filterWriterSkillsByProfile(candidates)
    }

    if (candidates.length === 0) return undefined
    if (candidates.length === 1) return candidates[0]

    const text = instruction.toLowerCase()
    let best = candidates[0]
    let bestScore = -1
    let tie = false
    for (const skill of candidates) {
      const score = skill.when.reduce((n, kw) => n + (kw && text.includes(kw.toLowerCase()) ? 1 : 0), 0)
      if (score > bestScore) { bestScore = score; best = skill; tie = false }
      else if (score === bestScore) { tie = true }
    }
    if (bestScore > 0 && !tie) return best

    // instruction 关键词零命中或平局 → 用 finalText 里实际出现的 outputTags 反查
    const byTag = candidates.find(s => s.outputTags[0] && finalText.includes(s.outputTags[0]))
    if (byTag) return byTag

    return best
  }

  private filterWriterSkillsByProfile(skills: SkillSpec[]): SkillSpec[] {
    const allowed =
      this.profileLock?.kind === 'novel'
        ? ['novel_prose_rules']
        : this.profileLock?.kind === 'short_drama'
          ? ['short_drama_script_rules', 'video_shot_script_rules']
          : this.profileLock?.kind === 'long_drama'
            ? ['long_drama_script_rules', 'video_shot_script_rules']
            : ['film_script_rules', 'video_shot_script_rules']

    return skills.filter((skill) => allowed.includes(skill.skillId))
  }

  private normalizeUntaggedFallbackContent(output: string): string {
    let content = output.trim()
    const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(content)
    if (fenced) content = fenced[1].trim()
    return content
  }

  /**
   * v7.3：构筑/写作 subagent 产出校验与落盘。
   *
   * 根据 read_skill 实际选择的 Skill 做 outputTags 提取校验；
   * 若走兼容回退，则由 resolveTargetSkill 判定目标层。
   * 然后写入对应路径。
   *
   * 当前采用单层模式——一次调用只处理一层；多层需求由 Orchestrator 拆成多次调用。
   */
  private async validateAndPersist(
    subagent: SubagentSpec,
    instruction: string,
    finalText: string,
    target?: string,
    selectedSkill?: SkillSpec,
  ): Promise<ToolResult> {
    const targetSkill = selectedSkill ?? this.resolveTargetSkill(subagent, instruction, finalText)

    if (!targetSkill) {
      return { success: false, error: `未找到 ${subagent.id} 的可用 Skill`, skillName: subagent.name }
    }

    // 写入路径由目标 skill 与当前产品共同决定；writer 使用 v7.8 新目录，其他 subagent 保持旧占位替换。
    const writePath = target
      ? subagent.id === 'prose_writer'
        ? this.resolveWriterOutputPath(target, targetSkill, await this.buildProjectEpisodeRangeMap())
        : targetSkill.writes[0].replace(/<ID>/g, target).replace(/<target>/g, target)
      : targetSkill.writes[0]

    const specView: SkillSpec = { ...targetSkill, writes: [writePath] }
    const validation = validateOutput(finalText, specView)
    const warnings: string[] = []
    let extracted = validation.extracted[writePath]

    if (!validation.valid) {
      if (validation.structuralError) {
        return {
          success: false,
          error: validation.structuralError,
          skillId: targetSkill.skillId,
          skillName: targetSkill.name,
        }
      }

      const canFallbackToWholeOutput =
        validation.missingTags.length > 0 &&
        specView.writes.length === 1 &&
        Boolean(writePath)

      if (canFallbackToWholeOutput) {
        extracted = this.normalizeUntaggedFallbackContent(finalText)
        if (targetSkill.structuralCheck) {
          const structuralError = targetSkill.structuralCheck(extracted)
          if (structuralError) {
            return {
              success: false,
              error: structuralError,
              skillId: targetSkill.skillId,
              skillName: targetSkill.name,
            }
          }
        }
        warnings.push(
          `产出缺少 TAG（${validation.missingTags.join(', ')}），已按单文件目标 ${writePath} 兜底写入。`,
        )
      } else {
      const missing = validation.missingTags.join(', ')
      return {
        success: false,
        error: `产出缺少 TAG: ${missing}`,
        skillId: targetSkill.skillId,
        skillName: targetSkill.name,
      }
      }
    }

    if (!extracted) {
      return {
        success: false,
        error: `TAG 校验通过但未提取到 ${writePath} 内容`,
        skillId: targetSkill.skillId,
        skillName: targetSkill.name,
      }
    }

    // v7.5：目标序列内容校验——确保提取出的内容属于目标序列，而非 LLM 输出的其他序列的内容。
    // 当 LLM 在 agent loop 中读到多个序列文件时，可能误将所有序列的第一段 TAG 块排在前面，
    // 导致 extractBetween 取到的第一个 START/END 块是错误序列的。
    if (target && targetSkill.outputTags[0] && targetSkill.outputTags[1]) {
      const [startTag, endTag] = targetSkill.outputTags
      const seqIdInContent = extracted.match(/#\s*(S\d+-\d+)/)
      if (seqIdInContent && seqIdInContent[1] !== target) {
        // 内容中出现的序列 ID 与目标不一致→尝试根据目标序列 ID 在 finalText 中重定位正确段
        const targetStart = `# ${target}`
        const searchFrom = finalText.indexOf(startTag)
        if (searchFrom >= 0) {
          // 从 startTag 往后找目标序列标题
          const titleIdx = finalText.indexOf(targetStart, searchFrom)
          if (titleIdx >= 0) {
            // 从标题位置往回找到最近的 startTag，从此处开始提取
            const sectionStart = finalText.lastIndexOf(startTag, titleIdx)
            if (sectionStart >= 0) {
              const contentStart = sectionStart + startTag.length
              const endIdx = finalText.indexOf(endTag, contentStart)
              if (endIdx > sectionStart) {
                extracted = finalText.slice(contentStart, endIdx).trim()
              }
            }
          }
        }
        // 重定位后再次验证
        const reCheck = extracted.match(/#\s*(S\d+-\d+)/)
        if (!reCheck || reCheck[1] !== target) {
          return {
            success: false,
            error: `产出内容与目标序列 ${target} 不匹配（内容中序列 ID 为 ${seqIdInContent[1]}，目标为 ${target}），已重试仍无法纠正`,
            skillId: targetSkill.skillId,
            skillName: targetSkill.name,
          }
        }
      }
    }

    await this.fileManager.writeFile(writePath, extracted)
    return {
      success: true,
      writes: [writePath],
      output: finalText,
      warnings: warnings.length > 0 ? warnings : undefined,
      skillId: targetSkill.skillId,
      skillName: targetSkill.name,
    }
  }

  /**
   * v7.3：批量并发调度（构筑/写作 subagent 共用）。
   *
   * 按序列 ID 列表拆分并发池，对每个序列并发起一次 runSubagentWithIsolatedContext 调用。
   * 复用现有 runWithConcurrency 原语（不改一行）。
   */
  private async runBatchWithSubagent(
    subagent: SubagentSpec,
    instruction: string,
    seqIds: string[],
  ): Promise<ToolResult> {
    this.emit('tool_start', {
      toolId: subagent.id,
      toolName: subagent.name,
      message: `并发批量 ${subagent.name} × ${seqIds.length} 序列（并发 ${BATCH_CONCURRENCY}）`,
    })

    const results = await this.runWithConcurrency(seqIds, BATCH_CONCURRENCY,
      (seqId) => this.runSubagentWithIsolatedContext(subagent, instruction, seqId))

    // 汇总（下标对齐）
    const writes: string[] = []
    const warnings: string[] = []
    let okCount = 0
    results.forEach((r, i) => {
      if (r.success) {
        okCount++
        if (r.writes) writes.push(...r.writes)
        if (r.warnings) warnings.push(...r.warnings)
      } else {
        warnings.push(`序列 ${seqIds[i]} 失败：${r.error ?? '未知错误'}`)
      }
    })

    return {
      success: okCount > 0,
      writes,
      output: '',
      skillName: subagent.name,
      error: okCount === 0 ? '全部序列执行失败' : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  /** v7.4：非关键收尾。失败只进入最终总结 warning，不再阻塞或吞掉用户结果。 */
  private async syncRequirementStatuses(state: SchedulerState): Promise<string[]> {
    if (!state.toolsCalled.some((id) => CREATIVE_TOOL_IDS.includes(id))) return []

    const reqTool = getSubagent('user_requirements_analyzer')
    if (!reqTool) return []

    const successWrites = state.toolResults
      .filter((result) => result.success && result.writes && result.writes.length > 0)
      .flatMap((result) => result.writes ?? [])
    if (successWrites.length === 0) return []

    const statusInstruction =
      `根据本轮执行结果更新 user_requirements.md 的状态标记。已成功写入：${successWrites.join('、')}。` +
      '请将其中已实现的需求标记为 ✅，仍未实现的需求保持 ⬜。仅更新状态标记，不修改需求内容。'

    try {
      const result = await this.executeTool(reqTool, statusInstruction)
      return result.success ? [] : [`需求状态同步失败：${result.error ?? '未知错误'}`]
    } catch (error) {
      return [`需求状态同步失败：${error instanceof Error ? error.message : String(error)}`]
    }
  }

  private async executeOrchestratorReadAssetFile(path: string): Promise<string> {
    const normalizedPath = path.trim()
    if (!isSafeAssetPath(normalizedPath)) {
      return JSON.stringify({
        success: false,
        error: `非法资产路径：${path}`,
      })
    }

    const allFiles = await this.fileManager.listAssetFiles()
    const known = allFiles.find((file) => file.path === normalizedPath)
    const content = await safeRead(this.fileManager, normalizedPath)
    const truncated = content.length > READ_ASSET_FILE_MAX_CHARS
    return JSON.stringify({
      success: true,
      path: normalizedPath,
      exists: known?.exists ?? content.length > 0,
      length: content.length,
      truncated,
      content: truncated ? content.slice(0, READ_ASSET_FILE_MAX_CHARS) : content,
      note: truncated
        ? `内容超过 ${READ_ASSET_FILE_MAX_CHARS} 字符，已截断；如需更细粒度信息，请读取更具体的资产文件。`
        : undefined,
    })
  }

  /**
   * 处理用户输入
   *
   * @param userInput - 用户原始输入
   * @param history - 最近若干轮对话（v5.5，用于跨轮需求记忆）
   * @param onEvent - 执行事件回调
   * @returns DispatchResult
   */
  async processUserInput(
    userInput: string,
    history: ConversationTurn[] = [],
    onEvent?: ExecutionEventCallback,
  ): Promise<DispatchResult> {
    this.onEvent = onEvent

    // v7.4：每轮先从 FileManager 机械扫描项目状态。
    // 纯进度查询直接返回确定性表格，不再让 LLM 根据历史消息猜测；
    // 其余请求则把同一快照注入 Orchestrator system prompt。
    const projectStatus = await buildProjectStatusSnapshot(
      this.fileManager,
      this.profileLock,
      usePhaseStore.getState().phase,
    )
    if (isProjectStatusQuery(userInput)) {
      this.emit('engine_complete', { message: '已从项目资产实时读取当前进度' })
      return {
        success: true,
        results: [],
        response: projectStatus.markdown,
      }
    }

    // ① 计算可用 Subagent（v5：全部始终可见）
    const availableSubagents = getAvailableSubagents()

    // ===== v6.6 Guard-0/1：产品锁 + Phase Gate 双重可见性过滤（FC 面）=====
    //  - profileLock=null：未选产品 → 不暴露任何创作工具
    //  - 设计期：剔除 prose_writer（须先🔒锁定大纲进写作期才可写正文）
    //  - 写作期：剔除设计区 + sequence_builder（构筑）
    //  - v7.3：quality_checker 受 selfCheckStore 开关控制，与阶段无关，独立判定
    const phaseState0 = usePhaseStore.getState()
    const selfCheckEnabled = useSelfCheckStore.getState().selfCheckEnabled
    // v6.6：input_normalizer 仅在"无设计资产"时进 FC 面（早期可用），有资产后隐藏
    const allAssetFiles0 = await this.fileManager.listAssetFiles()
    const hasDesignAssets = allAssetFiles0.some(
      (a) =>
        a.exists &&
        ['worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md'].includes(a.path),
    )
    let visibleSubagents: SubagentSpec[]
    if (this.profileLock === null) {
      visibleSubagents = []
    } else if (phaseState0.isWriting()) {
      visibleSubagents = availableSubagents.filter(
        (sa) =>
          !CREATIVE_TOOL_IDS.includes(sa.id) &&
          sa.id !== 'input_normalizer' &&
          !(sa.id === 'quality_checker' && !selfCheckEnabled),
      )
    } else {
      visibleSubagents = availableSubagents.filter(
        (sa) =>
          !WRITER_IDS.includes(sa.id) &&
          (sa.id !== 'input_normalizer' || !hasDesignAssets) &&
          !(sa.id === 'quality_checker' && !selfCheckEnabled),
      )
    }
    const toolSpecs = [...visibleSubagents.map(buildFunctionSpec), READ_ASSET_FILE_TOOL]

    // ② 加载 System Prompt（注入工具列表）
    const systemPrompt = `${loadOrchestratorPrompt(toolSpecs)}\n\n## 当前项目权威状态\n\n${projectStatus.promptBlock}`

    // ②.4 v6.6 前置归一化：检测到未归一化的 _input_raw.md 时，强制先跑 input_normalizer，
    //      再允许需求合并——否则整篇原文会被 user_requirements_analyzer 当"需求"吞掉。
    //      （补 checker 第 7 条；归一化成功后 executeTool 内部已 clearInputRaw 标记已消费）
    const rawInput = await safeRead(this.fileManager, '_input_raw.md')
    if (rawInput.length > 0) {
      const normalizer = getSubagent('input_normalizer')
      if (normalizer) {
        this.emit('tool_start', {
          toolId: normalizer.id,
          toolName: normalizer.name,
          message: `归一化投喂：${normalizer.name}`,
        })
        const normResult = await this.executeTool(normalizer, NORMALIZE_INSTRUCTION, history)
        if (normResult.success) {
          this.emit('tool_complete', {
            toolId: normalizer.id,
            toolName: normalizer.name,
            skillId: normResult.skillId,
            skillName: normResult.skillName,
            writes: normResult.writes,
            message: `${normalizer.name} 完成（产出 ${normResult.writes?.length ?? 0} 个种子资产）`,
          })
        } else {
          this.emit('tool_error', {
            toolId: normalizer.id,
            toolName: normalizer.name,
            message: `${normalizer.name} 失败：${normResult.error ?? '未知错误'}`,
          })
        }
      }
    }

    // ②.5 前置需求合并（v5.5 机制 A）：每轮确定性地把新需求结合对话上下文
    //      合并进 user_requirements.md，不依赖 Orchestrator 是否主动选择需求整理者。
    const analyzer = getSubagent('user_requirements_analyzer')
    if (analyzer) {
      this.emit('tool_start', {
        toolId: analyzer.id,
        toolName: analyzer.name,
        message: `整理需求：${analyzer.name}`,
      })
      const mergeResult = await this.executeTool(analyzer, MERGE_INSTRUCTION, history)
      if (mergeResult.success) {
        this.emit('tool_complete', {
          toolId: analyzer.id,
          toolName: analyzer.name,
          skillId: mergeResult.skillId,
          skillName: mergeResult.skillName,
          writes: mergeResult.writes,
          message: `${analyzer.name} 完成`,
        })
      } else {
        this.emit('tool_error', {
          toolId: analyzer.id,
          toolName: analyzer.name,
          message: `${analyzer.name} 失败`,
        })
      }
    }

    // ③ 初始化消息列表（v5.5 机制 B：前置最近若干轮对话历史，供 Orchestrator 理解指代）
    const messages: ChatCompletionMessageParam[] = [
      ...history.map(
        (turn) =>
          ({ role: turn.role, content: turn.content }) as ChatCompletionMessageParam,
      ),
      { role: 'user', content: userInput },
    ]

    // ④ 调度状态
    const state: SchedulerState = {
      currentRound: 0,
      maxRounds: MAIN_LOOP_MAX_ROUNDS,
      toolsCalled: [],
      toolResults: [],
    }

    const turnStartedAt = Date.now()
    const executions: ExecutedToolResult[] = []
    const successfulSignatures = new Set<string>()
    const failureCounts = new Map<string, number>()
    let noProgressRounds = 0

    /** v7.4：所有退出分支都走同一个确定性收口，保证日志后必有一条结果消息。 */
    const finalizeTurn = async (
      stopReason: TurnStopReason,
      assistantNote?: string,
    ): Promise<DispatchResult> => {
      this.emit('engine_finalizing', { message: '正在整理本轮结果…' })

      const extraWarnings = await this.syncRequirementStatuses(state)
      const summary = buildTurnSummary({
        executions,
        stopReason,
        assistantNote,
        extraWarnings,
        startedAt: turnStartedAt,
        finishedAt: Date.now(),
      })

      this.emit('engine_complete', {
        message: summary.status === 'completed'
          ? `本轮已完成（${summary.completedTools.length} 个工具）`
          : summary.status === 'partial'
            ? `本轮部分完成（${summary.completedTools.length} 个成功，${summary.failedTools.length} 个失败）`
            : summary.status === 'interrupted'
              ? '本轮已自动中止，已保留成功写入'
              : '本轮未完成',
      })

      return {
        success: summary.status === 'completed' || summary.status === 'partial',
        results: state.toolResults,
        response: renderTurnSummary(summary),
        summary,
      }
    }

    // ⑤ FC 调度循环（v7.4：有界轮次 + 时间/重复/无进展三重保护）
    while (state.currentRound < state.maxRounds) {
      if (Date.now() - turnStartedAt >= TURN_TIMEOUT_MS) {
        return finalizeTurn('timeout')
      }

      // 上下文管理：检查 token 是否超限
      if (estimateTokens(messages) > CONTEXT_LIMIT_CHARS) {
        const compressed = compressMessages(messages)
        messages.length = 0
        messages.push(...compressed)
      }

      this.emit('orchestrator_thinking', {
        round: state.currentRound + 1,
        maxRounds: state.maxRounds,
        message: `第 ${state.currentRound + 1} 轮：正在分析你的需求...`,
      })

      let response
      try {
        response = await this.llm.sendMessageWithTools(systemPrompt, messages, toolSpecs)
      } catch (e) {
        this.emit('engine_error', {
          message: `处理异常: ${(e as Error).message}`,
        })
        return finalizeTurn('error', `系统响应异常：${(e as Error).message}`)
      }

      const { message, finish_reason } = response

      // 处理 finish_reason
      switch (finish_reason) {
        case 'stop':
          return finalizeTurn('normal', message.content ?? undefined)

        case 'tool_calls': {
          const toolCalls = message.tool_calls
          if (!toolCalls || toolCalls.length === 0) {
            state.currentRound++
            noProgressRounds++
            if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
              return finalizeTurn('no_progress')
            }
            continue
          }

          // 限制单次调用的工具数量
          const callsToProcess = toolCalls.slice(0, MAX_TOOLS_PER_ROUND)

          // 先将 assistant 消息加入历史（含 tool_calls）
          messages.push({
            role: 'assistant' as const,
            content: message.content,
            tool_calls: callsToProcess,
          } as ChatCompletionMessageParam)

          let roundHadProgress = false
          let roundSawDuplicate = false

          // 串行执行每个 Subagent
          for (const toolCall of callsToProcess) {
            const toolId = toolCall.function.name
            const isAssetReadTool = toolId === READ_ASSET_FILE_TOOL_ID
            const subagentSpec = isAssetReadTool ? undefined : getSubagent(toolId)

            // 解析 instruction + v6.1 动态靶参数（target_sequence / target_chapter 由 buildFunctionSpec
            // 条件附加给 NEEDS_TARGET_PARAM 白名单成员；其它 subagent 不携带此字段，空串无影响）
            let instruction = ''
            let argTarget = ''
            let readAssetPath = ''
            try {
              const args = JSON.parse(toolCall.function.arguments)
              instruction = args.instruction || ''
              argTarget = String(args.target_sequence ?? args.target_chapter ?? '').trim()
              readAssetPath = String(args.path ?? '').trim()
            } catch {
              instruction = toolCall.function.arguments || ''
            }

            const signature = buildToolCallSignature(
              toolId,
              argTarget,
              isAssetReadTool ? readAssetPath : instruction,
            )
            const repeatedFailure = (failureCounts.get(signature) ?? 0) >= 2
            if (successfulSignatures.has(signature) || repeatedFailure) {
              roundSawDuplicate = true
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({
                  success: false,
                  skipped: true,
                  error: repeatedFailure ? '同一调用已连续失败两次' : '同一调用已成功执行',
                }),
              } as ChatCompletionMessageParam)
              continue
            }

            if (isAssetReadTool) {
              this.emit('tool_start', {
                toolId,
                toolName: '读取资产',
                round: state.currentRound + 1,
                maxRounds: state.maxRounds,
                message: `读取资产：${readAssetPath || '(empty)'}`,
              })
              const readResult = await this.executeOrchestratorReadAssetFile(readAssetPath)
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: readResult,
              } as ChatCompletionMessageParam)
              successfulSignatures.add(signature)
              roundHadProgress = true
              this.emit('tool_complete', {
                toolId,
                toolName: '读取资产',
                message: `读取资产完成：${readAssetPath || '(empty)'}`,
              })
              continue
            }

            if (!subagentSpec) {
              // 未知 Subagent → 返回错误
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ success: false, error: `未知工具: ${toolId}` }),
              } as ChatCompletionMessageParam)
              continue
            }

            // 执行 Subagent（history 仅 analyzer 前置预跑需要；第 4 可选项承载动态靶供
            // executeTool 内 resolveWriteTarget 消费）
            this.emit('tool_start', {
              toolId: subagentSpec.id,
              toolName: subagentSpec.name,
              round: state.currentRound + 1,
              maxRounds: state.maxRounds,
              message: `调用：${subagentSpec.name}`,
              instruction: instruction ? truncate(instruction, 40) : undefined,
            })

            let result: ToolResult
            try {
              result = await this.executeTool(subagentSpec, instruction, undefined, {
                target: argTarget,
              })
            } catch (error) {
              result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
            state.toolResults.push(result)
            state.toolsCalled.push(subagentSpec.id)
            executions.push({
              toolId: subagentSpec.id,
              toolName: subagentSpec.name,
              result,
            })

            if (result.success) {
              successfulSignatures.add(signature)
              roundHadProgress = true
              const warnCount = result.warnings?.length ?? 0
              this.emit('tool_complete', {
                toolId: subagentSpec.id,
                toolName: subagentSpec.name,
                skillId: result.skillId,
                skillName: result.skillName,
                writes: result.writes,
                message:
                  warnCount > 0
                    ? `${subagentSpec.name} 完成（含 ${warnCount} 条提示）`
                    : `${subagentSpec.name} 完成`,
                warnings: result.warnings,
              })
            } else {
              failureCounts.set(signature, (failureCounts.get(signature) ?? 0) + 1)
              this.emit('tool_error', {
                toolId: subagentSpec.id,
                toolName: subagentSpec.name,
                skillId: result.skillId,
                skillName: result.skillName,
                message: `${subagentSpec.name} 失败`,
              })
            }

            // 将 tool 结果加入消息历史
            // quality_checker：注入完整报告文本（result.output），其余 Subagent 返回简短消息
            if (subagentSpec.id === 'quality_checker' && result.success && result.output) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result.output,
              } as ChatCompletionMessageParam)
            } else {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result.success
                  ? `已成功执行 ${subagentSpec.name}，输出已保存。`
                  : `${subagentSpec.name} 执行失败: ${result.error || '未知错误'}`,
              } as ChatCompletionMessageParam)
            }
          }

          // v5：不再重算可用 Subagent（全部始终可见）

          state.currentRound++

          if (Date.now() - turnStartedAt >= TURN_TIMEOUT_MS) {
            return finalizeTurn('timeout')
          }

          if (roundHadProgress) {
            noProgressRounds = 0
          } else {
            noProgressRounds++
          }

          if (roundSawDuplicate && !roundHadProgress) {
            return finalizeTurn('duplicate_call')
          }
          if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
            return finalizeTurn('no_progress')
          }
          break
        }

        case 'length':
          return finalizeTurn('length')

        case 'content_filter':
          return finalizeTurn('content_filter')

        default:
          state.currentRound++
          noProgressRounds++
          if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
            return finalizeTurn('no_progress')
          }
          continue
      }
    }

    return finalizeTurn('round_limit')
  }
}
