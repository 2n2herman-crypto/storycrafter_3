import type OpenAI from 'openai'
import type { SubagentSpec, SkillSpec, ToolResult, DispatchResult, SchedulerState, ExecutionEvent, ExecutionEventCallback, ConversationTurn, AssetFileInfo } from '../types'
import type { ProductProfile, ProductKind } from '../types/product'
import { PRODUCT_PROFILES, WRITER_IDS, renderProductProfileXml } from '../types/product'
import { getSubagent, getAvailableSubagents, buildFunctionSpec, getSkills } from '../skills/skillLoader'
import { selectSkill } from './skillRouter'
import { assembleContext, buildAgentPrompt } from './contextAssembler'
import { validateOutput, extractMultiFileOutput } from './outputValidator'
import { checkSceneTable, checkBeatBlocks, extractSceneIds, countBeatBlocks } from '../skills/scene_beats/structuralChecks'
import type { LLMClient } from '../llm/client'
import type { FileManager } from './fileManager'
import { usePhaseStore } from '../store/phaseStore'
import { classifyLLMError } from '../utils/llmError'
import orchestratorPromptRaw from '../llm/prompts/orchestrator_v5.md?raw'

type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam

// ===== 常量 =====

const MAX_ROUNDS = 10
const MAX_RETRIES = 3
const MAX_TOOLS_PER_ROUND = 5
const CONTEXT_LIMIT_CHARS = 22_000 // deepseek-v4-flash 32K 的 ~70%

/** v6.8 全序列并行并发池上限。DeepSeek API 并发上限 500，取 50（10 倍余量防突发）。 */
const PIPELINE_CONCURRENCY = 50

/** v6.9 全序列写作并发池上限（同 PIPELINE_CONCURRENCY 依据） */
const WRITER_CONCURRENCY = 50

/** 创作 Subagent ID 列表（用于后处理判断是否需要更新需求状态） */
const CREATIVE_TOOL_IDS = [
  'worldbuilding', 'characters', 'act_map', 'sequence_list',
  'scene_beats', 'foreshadowing_tracker', 'subplot_manager',
]

/** v6.8 审计修复轮受保护的上游设定 Subagent ID（Guard-3a 拦截目标，不含 scene_beats） */
const UPSTREAM_DESIGN_IDS = [
  'worldbuilding', 'characters', 'act_map', 'sequence_list',
  'foreshadowing_tracker', 'subplot_manager',
]

/**
 * v6.6 短剧镜头分解规范（仅 short_drama writer 注入为 <shot_breakdown_spec>）。
 * 短剧 outputAnnotations 含 shot_breakdown，每集末尾输出 SHOT_BREAKDOWN 注释。
 */
const SHORT_DRAMA_SHOT_SPEC = [
  '短剧镜头分解规范（每集产出后于 END TAG 后输出 SHOT_BREAKDOWN 注释）：',
  '- 注释格式：<!-- SHOT_BREAKDOWN: 景别·主体·情绪功能 | 景别·主体·情绪功能 | ... -->',
  '- 景别词库：特写 / 近景 / 中景 / 全景 / 远景 / 俯拍 / 仰拍 / 跟拍 / 手持',
  '- 每集 4-8 个镜头节点，按时间顺序排列，标注景别+主体+情绪功能',
  '- 镜头节奏服务于脉冲式叙事：钩子集用快切（短镜头多），沉淀集可放慢',
].join('\n')

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

/**
 * v6.6：将序列 ID 折算为线性序号，供伏笔寿命裁剪做距离比较。
 *
 * S{幕}-{序} → 幕×100 + 序（如 S1-1→101、S2-3→203）；非匹配格式返回 0。
 * 粗粒度仅用于"是否超寿命"的远近距离判断，不要求精确可序。
 */
function seqOrdinal(seqId: string): number {
  const m = /^S?([A-Z])\d*?-?(\d+)-(\d+)/.exec(seqId)
  if (!m) return 0
  const act = Math.max(1, m[1].charCodeAt(0) - 64) // A→1, B→2 ...
  const seq = parseInt(m[2], 10)
  const sub = parseInt(m[3], 10)
  return act * 10000 + seq * 100 + sub
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

// ===== v6.7 Scene Beats 三段式流水线注册表（PIPELINE_REGISTRY）=====
//
// 当某 Subagent 出现在此注册表中，executeTool 会绕开 Skill Router 多选机制，
// 走三段式流水线：① 建档（引擎零 LLM）② 场景表（sceneStep）③ 逐场景节拍（beatStep 循环）。
// 空靶 = runBatchPipeline 读 sequence_list 并发铺全部序列（PIPELINE_CONCURRENCY=3 并发池）；合法靶 = runSequencePipeline 精修单序列。
// 中间产物（场景表）**不落盘**，通过内存变量在段间传递；最终 assembleSequenceDoc 拼装落盘。
// 对 Orche 表现为单个 round 配额消耗的一次 tool_call。
//
// 所有 pipeline 元信息均集中在引擎侧此常量内嵌声明：types/index.ts 与 frontmatter parser 维持不变。

interface PipeStepDef {
  /** 该步对应的 skillId（须经目录约定热插拔注册于同名 subagent 名下）*/
  skillId: string
  /** 注入下游上下文的短别名（与各 SKILL.md 正文引用约定保持一致）*/
  label: string
}

interface PipeRegistryValue {
  /** 段②：写场景表 */
  sceneStep: PipeStepDef
  /** 段③：逐场景循环写节拍块 */
  beatStep: PipeStepDef
}

const PIPELINE_REGISTRY: Record<string, PipeRegistryValue> = {
  scene_beats: {
    sceneStep: { skillId: 'scene_designer', label: 'prev_scenes' },
    beatStep: { skillId: 'beat_writer', label: 'target_scene' },
  },
}
// 建档段①是纯引擎代码，无 skill，不进注册表。
// v6.8 偏差③闭合：runBatchPipeline 走 runWithConcurrency 并发池（PIPELINE_CONCURRENCY=3），不再串行 for。

/**
 * v6.6：极简表格数据行计数——数 `|` 起始且 `|` 结尾的行，去掉表头与分隔行。
 *
 * 仅供 runPipelineSoftValidation 做"量级越界"非阻塞软校验用；不替代 structuralChecks
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
 *   sequences/ → <scene_beats_slices>
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
				aggregatedLabel = 'scene_beats_slices'
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

// ===== v6.7 Scene Beats 引擎代码收口 =====

/**
 * v6.7 收口：三段式完成后由引擎代码拼装 sequences/<seqId>.md 最终成品（零 LLM 调用）。
 *
 * 场景表仍是表格直接 trim；节拍段按场景用 `#### <SC-ID>` 分组，每组内是 beat_writer 产出的
 * `[BEAT ...]` 字段块。外层 `<<<SCENE_BEAT_OUTLINE_START/END>>>` + `# <seqId>` 标题保留不变
 * → 下游四 writer 的 `<current_sequence_beats>` 纯文本注入契约不破。
 *
 * @param seqId 目标序列 ID 如 'S1-1'
 * @param scenesMd scene_designer 输出的场景表（不含 START/END TAG）
 * @param sceneIds 场景表解析出的有序 SC-ID 列表
 * @param beatBySc Map<SC-ID, 节拍块 md>（失败场景为占位注释）
 * @returns 最终 sequences/<seqId>.md 的完整内容（含外层 TAG）
 */
function assembleSequenceDoc(
  seqId: string,
  scenesMd: string,
  sceneIds: string[],
  beatBySc: Map<string, string>,
): string {
  const scenesTable = scenesMd.trim() // 场景仍是表格，直接 trim
  const beatSections = sceneIds
    .map((sc) => `#### ${sc}\n\n${(beatBySc.get(sc) ?? '').trim()}`)
    .join('\n\n')
  return [
    '<<<SCENE_BEAT_OUTLINE_START>>>',
    `# ${seqId}`,
    '',
    '### 场景表',
    '',
    scenesTable,
    '',
    '### 节拍',
    '',
    beatSections,
    '<<<SCENE_BEAT_OUTLINE_END>>>',
  ].join('\n')
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

/**
 * 判断是否为"清空操作"Skill（如 reset_all）
 * 协议：writes:[] + outputTags:[] = 清空操作，不调 LLM
 */
function isResetSkill(skill: SkillSpec): boolean {
  return skill.writes.length === 0 && skill.outputTags.length === 0
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
 *   → audit 循环（story_checker 最多 3 轮）与 FC 循环独立计数
 *
 * @see product_design_v4/orchestrator调度引擎设计.md
 */
export class OrchestratorEngine {
  private llm: LLMClient
  private fileManager: FileManager
  private onEvent?: ExecutionEventCallback

  /** v6.4 角色行为追踪：key=target_chapter，值=该章中提取的 BEHAVIOR_TRACK 注释列表 */
  private behaviorTrack: Map<string, string[]> = new Map()

  /**
   * v6.6 伏笔运行时状态：key=F-id，值={planted, paidoff, atChapter}。
   * 从四 writer 输出的 `<!-- FORESHADOW: F-id=plant|payoff@章节id -->` 注释提取，
   * 注入 `<foreshadowing_state>` 供下游 writer 防重复 plant / 提前 payoff。
   * 按 foreshadowingMaxLifespan 裁剪过期项。
   */
  private foreshadowingState: Map<string, { planted: boolean; paidoff: boolean; atChapter: string }> = new Map()

  /**
   * v6.6 批次断点：key=sequenceId，值={lastUnit, done}。
   * 短剧/长剧按分段续写时记录已完成单元数，支持跨对话轮断点续写。
   */
  private batchProgress: Map<string, { lastUnit: number; done: boolean }> = new Map()

  /**
   * v6.6 产品档案锁：会话级锁定不可变，由 UI 产品选择器经 lockProfile() 落定。
   * null = 未选产品（Guard-0：设计区+成文区全禁，仅 reset_all 可用）。
   * 解锁仅 reset_all（清资产同时释放 profileLock）。
   */
  private profileLock: ProductProfile | null = null

  /** v6.8 审计修复状态：story_checker 报 FAIL 时置 true，PASS/WARNING 或漏标置 false */
  private auditFixMode = false
  /** v6.8 审计范围：checker 标 sequence_only 时设，否则 null（漏标默认放行上游） */
  private auditScope: 'sequence_only' | null = null

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

  /**
   * 释放产品锁，回到未选产品态。仅 reset_all 调用（清资产同时清锁，可重选产品）。
   */
  clearProfileLock(): void {
    this.profileLock = null
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
   * 执行单个 Subagent（v5.3 四层框架：Subagent → Skill Router → Skill，含重试逻辑）
   *
   * v6.1 扩展点：
   *   - 第 4 可选参 options.target 承载 FC args.target_{sequence|chapter}，由 processUserInput
   *     dispatch loop 解析 JSON arguments 后透传进来。
   *   - 若 subagent 注册于 PIPELINE_REGISTRY 则走三段式管道（空靶 runBatchPipeline 全量串行批量 /
   *     带靶 runSequencePipeline 精修单序列）对 Orche 原子化为一次 tool_call；
   *     否则按原有单 Skill 直发流程，其中成文 writer 经 resolveWriteTarget 计算 effectiveWrites
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
    //  - Guard-0：未选产品(profileLock=null)时除 reset_all 外全拦
    //  - Guard-2：写作期屏蔽设计区 + story_checker + 非本产品 writer；设计期屏蔽全部 writer
    const psGuard = usePhaseStore.getState()
    if (this.profileLock === null && subagent.id !== 'reset_all') {
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
    if (psGuard.isWriting()) {
      const isOtherWriter =
        this.profileLock != null &&
        WRITER_IDS.includes(subagent.id) &&
        subagent.id !== this.profileLock.writerSubagentId
      if (
        CREATIVE_TOOL_IDS.includes(subagent.id) ||
        subagent.id === 'story_checker' ||
        isOtherWriter
      ) {
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

    // ===== v6.8 Guard-3a：审计修复轮仅序列级问题时，拦截上游设定工具（dispatch 兜底）=====
    if (this.auditFixMode && this.auditScope === 'sequence_only' && UPSTREAM_DESIGN_IDS.includes(subagent.id)) {
      this.emit('tool_error', {
        toolId: subagent.id,
        toolName: subagent.name,
        message: `${subagent.name} 受审计修复约束：本轮仅序列级问题，不得修改上游设定文件`,
      })
      return {
        success: false,
        skillName: subagent.name,
        error: '审计修复轮仅序列级问题，不得修改上游指导文件（worldbuilding/characters/act_map/sequence_list/foreshadowing/subplots）',
      }
    }

    // ===== v6.7 Pipeline Registry 分流（scene_beats 三段式：空靶批量 / 带靶精修）=====
    const pipeReg = PIPELINE_REGISTRY[subagent.id]
    if (pipeReg !== undefined) {
      // ===== v6.8 Guard-3b：审计修复轮 scene_beats 必须带靶，禁止空靶全量覆写 =====
      if (this.auditFixMode && subagent.id === 'scene_beats' && !target) {
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          message: '审计修复轮禁止空靶全量覆写，必须带 target_sequence 精修出错序列',
        })
        return {
          success: false,
          skillName: subagent.name,
          error: '审计修复轮必须带 target_sequence 精修单序列，禁止空靶全量覆写',
        }
      }
      if (!target) {
        // 空靶 = 全量批量（v6.8 并发池）
        return this.runBatchPipeline(subagent, pipeReg, instruction, history)
      }
      if (!TARGET_ID_REGEX.test(target)) {
        // 有值但非法 → 仍早退（避免误写）
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          message: `${subagent.name} 的 target_sequence 格式非法（形如 S1-1）；留空=全量批量，填写=精修单序列`,
        })
        return {
          success: false,
          error: `target_sequence 格式非法：${target}`,
          skillName: subagent.name,
        }
      }
      // 合法靶（归约后）= 精修单序列
      return this.runSequencePipeline(
        subagent,
        pipeReg,
        normalizeToSequenceId(target),
        instruction,
        history,
      )
    }

    // ===== v6.9 WRITER 分流：空靶=全量并发批量 / 带靶=单序列精修（对齐 scene_beats 范式）=====
    if (WRITER_IDS.includes(subagent.id)) {
      if (!target) {
        return this.runWriterBatchPipeline(subagent, instruction, history)
      }
      if (!TARGET_ID_REGEX.test(target)) {
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          message: `${subagent.name} 的 target_chapter 格式非法（形如 S1-1）；留空=全量并发批量，填写=精修单序列`,
        })
        return {
          success: false,
          error: `target_chapter 格式非法：${target}`,
          skillName: subagent.name,
        }
      }
      const seqId = normalizeToSequenceId(target)
      const episodeRange = await this.buildEpisodeRangeMap([seqId])
      return this.runWriterSequencePipeline(subagent, seqId, instruction, history, episodeRange)
    }

    // ===== 单 Skill 直发路径 =====
    // ① Skill Router：在该 Subagent 名下选出最合适的 Skill
    //    单 Skill 时零成本直选、不调 LLM；≥2 candidate 时按 when/description 打分择优
    const skill = selectSkill(subagent.id, instruction)

    // reset_all 特殊处理：空 writes + 空 outputTags = 不调 LLM，直接清空
    if (isResetSkill(skill)) {
      await this.fileManager.clearAll()
      // v6.4：清空行为追踪
      this.behaviorTrack.clear()
      // v6.6：清空运行时记忆
      this.foreshadowingState.clear()
      this.batchProgress.clear()
      // v6.6：释放产品档案锁，回到未选产品态（可重选产品）
      this.clearProfileLock()
      // v6.1 F.4：reset_all 触发时同步把 phase 打回 designing、清空 baselines，
      // 保证状态机一致归零（clearAll 已删光 chapters/_seq 等全部内容故无需额外清理这些产物路径）。
      usePhaseStore.getState().reset()
      return {
        success: true,
        writes: [],
        output: '已清空所有故事内容',
        skillId: skill.skillId,
        skillName: skill.name,
      }
    }

    // ② 读上下文（按 Skill.reads，支持 /*.md glob 展开 v6.3）
    const files: Record<string, string> = {}
    const allPaths = await this.fileManager.listAssetFiles()
    const { reads: expandedReads, aggregatedLabel } = expandGlobs(skill.reads, allPaths)
    for (const path of expandedReads) {
      if (!(path in files)) {
        files[path] = await safeRead(this.fileManager, path)
      }
    }

    // ③ 组装静态上下文 + v6.3 聚合标签拼接（若命中 glob 即追加 <scene_beats_slices>）
    let context = assembleContext(expandedReads, files)
    if (aggregatedLabel) {
      const prefix = aggregatedLabel === 'scene_beats_slices' ? 'sequences' : ''
      if (prefix) {
        context += buildAggregatedXml(aggregatedLabel, expandedReads, files)
      }
    }

    // ④ System Prompt：角色前缀 + Skill 正文
    const systemPrompt = skill.preamble ? `${skill.preamble}\n\n${skill.body}` : skill.body

    // ⑤ v6.1 resolveWriteTarget：scene_beats/writer 已被上方管道截走，此处仅设计区 Subagent 注入档案
    let effectiveWrites = skill.writes
    if (this.profileLock) {
      // v6.6 设计区档案化：非 writer 的设计区 Subagent（act_map/sequence_list/
      //   foreshadowing_tracker/subplot_manager 等）注入 <product_profile>，
      //   供其 SKILL body 去硬编码后按档案取幕/序/场/拍区间与节拍词库、伏笔寿命。
      //   Guard-0 已保证此处 profileLock 必非 null（reset_all 早已 return）。
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
   * v6.4：从 writer 输出中提取角色行为追踪注释。
   * v6.6：LRU 上限从硬编码 5 改为 profileLock.behaviorTrackWindow（小说 8/剧本 8/长剧 12/短剧 20）。
   */
  private extractBehaviorTrack(target: string, output: string): void {
    const regex = /<!--\s*BEHAVIOR_TRACK:\s*(.+?)\s*-->/g
    const tracks: string[] = []
    let match: RegExpExecArray | null
    while ((match = regex.exec(output)) !== null) {
      tracks.push(match[1].trim())
    }
    if (tracks.length > 0) {
      // 先删再插，保证 LRU 语义正确（Map.set 不改变已有 key 的插入位置）
      this.behaviorTrack.delete(target)
      this.behaviorTrack.set(target, tracks)
      // 上限取产品档案窗口（不复用 foreshadowingMaxLifespan——语义不同）
      const window = this.profileLock?.behaviorTrackWindow ?? 8
      while (this.behaviorTrack.size > window) {
        const oldest = this.behaviorTrack.keys().next().value
        if (oldest) this.behaviorTrack.delete(oldest)
      }
    }
  }

  /**
   * v6.6：从 writer 输出提取伏笔运行时状态。
   *
   * 解析 `<!-- FORESHADOW: F-id=plant@章节id -->` / `payoff@章节id`，更新 foreshadowingState：
   *   - plant → 标记 planted=true，记录 atChapter
   *   - payoff → 标记 paidoff=true
   * 随后按 foreshadowingMaxLifespan 裁剪：与最新章节序距超过寿命的已 resolved 项剔除。
   */
  private extractForeshadowingState(target: string, output: string): void {
    const regex = /<!--\s*FORESHADOW:\s*(F-[\w-]+)\s*=\s*(plant|payoff)\s*@\s*([\w-]+)\s*-->/g
    let match: RegExpExecArray | null
    const latestOrd = seqOrdinal(normalizeToSequenceId(target))
    while ((match = regex.exec(output)) !== null) {
      const [, fId, action, atChapter] = match
      const entry = this.foreshadowingState.get(fId) ?? { planted: false, paidoff: false, atChapter }
      if (action === 'plant') {
        entry.planted = true
        entry.atChapter = atChapter
      } else {
        entry.paidoff = true
      }
      this.foreshadowingState.set(fId, entry)
    }
    // 按 lifespan 裁剪：已回收且距最新章节超寿命的伏笔移除（不再有用）
    const lifespan = this.profileLock?.foreshadowingMaxLifespan ?? 20
    for (const [fId, entry] of this.foreshadowingState) {
      if (entry.paidoff && Math.abs(seqOrdinal(normalizeToSequenceId(entry.atChapter)) - latestOrd) > lifespan) {
        this.foreshadowingState.delete(fId)
      }
    }
  }

  /**
   * v6.6：更新批次断点进度。
   *
   * 短剧/长剧（proseSplitUnit != 'none'）按分段续写：从累积后草稿中数 `## 第N集`
   * 单元数记录 lastUnit；非分段产品落 done=true。
   * v6.9 fix: 改基于累积后内容(accumulatedDraft)算 lastUnit，而非 writer 本次 output——
   *   writer 现只输出本单元，output 仅 1 集，旧逻辑会恒记 lastUnit=1。
   */
  private updateBatchProgress(target: string, accumulatedDraft: string): void {
    const seqId = normalizeToSequenceId(target)
    const splitUnit = this.profileLock?.proseSplitUnit ?? 'none'
    if (splitUnit === 'none') {
      this.batchProgress.set(seqId, { lastUnit: 0, done: true })
      return
    }
    // 短剧/长剧数累积后草稿的 `## 第N集` 单元数
    const unitMatches = accumulatedDraft.match(/##\s*第\s*\d+\s*集/g)
    const lastUnit = unitMatches ? unitMatches.length : 0
    this.batchProgress.set(seqId, { lastUnit, done: false })
  }

  /**
   * v6.6：将 foreshadowingState 渲染为 `<foreshadowing_state>` XML 注入 writer 上下文。
   * 空状态返回空串（appendExtraLabels 自动过滤）。
   */
  private renderForeshadowingStateXml(): string {
    if (this.foreshadowingState.size === 0) return ''
    const lines = [...this.foreshadowingState.entries()].map(
      ([fId, st]) =>
        `  <foreshadow id="${fId}" planted="${st.planted}" paidoff="${st.paidoff}" at="${st.atChapter}"/>`,
    )
    return `<foreshadowing_state>\n${lines.join('\n')}\n</foreshadowing_state>`
  }

  /**
   * v6.6：将 batchProgress 渲染为 `<batch_progress>` XML 注入 writer 上下文。
   * 空状态返回空串。供分段续写时感知本序列已产单元数。
   */
  private renderBatchProgressXml(): string {
    if (this.batchProgress.size === 0) return ''
    const lines = [...this.batchProgress.entries()].map(
      ([seqId, st]) =>
        `  <sequence id="${seqId}" lastUnit="${st.lastUnit}" done="${st.done}"/>`,
    )
    return `<batch_progress>\n${lines.join('\n')}\n</batch_progress>`
  }

  /**
   * v6.4：视听转化软校验，非阻塞——仅在 execution log 中产生 warning。
   */
  private runSoftValidation(output: string): string[] {
    const warnings: string[] = []

    // 1. 全知叙述句式检测
    if (/他不知道[，,\s]*这是[他她].*?[最后终]/.test(output)) {
      warnings.push('检测到疑似全知叙述句式（如"他不知道，这是他最后一次..."）')
    }

    // 2. 直白情感标签检测
    const emotionMatches = output.match(/她?很(?:伤心|难过|生气|愤怒|害怕|紧张|开心|高兴|失望|焦虑|恐惧)/g)
    if (emotionMatches && emotionMatches.length > 0) {
      warnings.push(`检测到 ${emotionMatches.length} 处直白情感标签：${emotionMatches.slice(0, 3).join('、')}。建议用行为替代`)
    }

    // 3. 过长无对话描写检测
    const paragraphs = output.split(/\n\n+/)
    for (let i = 0; i < paragraphs.length; i++) {
      const lines = paragraphs[i].split('\n').filter(l => l.trim())
      if (lines.length > 5 && !/[「「"」"」：]/.test(paragraphs[i])) {
        warnings.push(`检测到第 ${i + 1} 段超过 5 行的无对话描写段落`)
        break
      }
    }

    return warnings
  }

  /**
   * v6.7：scene_beats Pipeline 数量软校验——场景数 / 平均每场景节拍数越出档案区间时
   * 产出非阻塞 warning。与 runSoftValidation 同为非阻塞提示，不触发 retry。
   *
   * 结构红线（B-ID/内嵌 SC-ID）已由 checkBeatBlocks 阻塞校验兜底；字段齐全/词库/相邻规则
   * 交 SKILL body 引导（v6.8 放宽，不再机械校验）；此处仅校验"量级"
   * 是否贴合 <product_profile> 声明（如小说每章 2-6 场景、短剧每序列 8-15 集）。
   * v6.7：场景数仍数表格行；节拍数改块计数（节拍已从整表改为逐场景字段块）。
   */
  private runPipelineSoftValidation(scenesMd: string, beatBySc: Map<string, string>): string[] {
    const warnings: string[] = []
    const profile = this.profileLock
    if (!profile) return warnings

    const sceneRows = countTableDataRows(scenesMd)
    const [sMin, sMax] = profile.scene.countRange
    if (sceneRows > 0 && (sceneRows < sMin || sceneRows > sMax)) {
      warnings.push(
        `场景数 ${sceneRows} 越出 <product_profile> 区间 [${sMin}, ${sMax}]（${profile.scene.semantic}）`,
      )
    }

    // 节拍已改逐场景字段块，改块计数：校验"平均每场景节拍数"是否贴合 beat.countRange
    const beatCount = [...beatBySc.values()].reduce((n, md) => n + countBeatBlocks(md), 0)
    const avgBeats = sceneRows > 0 ? Math.round(beatCount / sceneRows) : 0
    const [bMin, bMax] = profile.beat.countRange
    if (avgBeats > 0 && (avgBeats < bMin || avgBeats > bMax)) {
      warnings.push(
        `平均每场景节拍数 ${avgBeats} 越出档案区间 [${bMin}, ${bMax}]（总 ${beatCount} 拍 / ${sceneRows} 场景）`,
      )
    }

    return warnings
  }

  /**
   * v6.7 单步 LLM 执行（供 runSequencePipeline 段②③复用，抽自原 runPipeline 重试块）。
   *
   * 读 skill.reads → assembleContext → appendExtraLabels(opts.extras) → sendMessage ×≤MAX_RETRIES
   * → validateOutput（挂 opts.structuralCheck，INV-1 validator 主体不改）。
   * 成功返回 extracted[skill.writes[0]]；连续失败返回 null（调用方决定 abort 或降级占位）。
   */
  private async runSingleStep(
    subagent: SubagentSpec,
    skill: SkillSpec,
    seqId: string,
    instruction: string,
    history: ConversationTurn[] | undefined,
    opts: { structuralCheck: SkillSpec['structuralCheck']; extras: ExtraLabelEntry[] },
  ): Promise<string | null> {
    // ① 读 static reads
    const files: Record<string, string> = {}
    for (const p of skill.reads) {
      files[p] = await safeRead(this.fileManager, p)
    }

    // ② 拼 static ctx + append extras（prev_scenes/target_scene/current_target/product_profile 等）
    const ctxFull = appendExtraLabels(assembleContext(skill.reads, files), opts.extras)

    // ③ sysPrompt = 角色前缀 + Skill 正文；specView 承载临时 structuralCheck
    const systemPrompt = skill.preamble ? `${skill.preamble}\n\n${skill.body}` : skill.body
    const specView: SkillSpec = { ...skill, structuralCheck: opts.structuralCheck }

    let userContent = buildAgentPrompt(ctxFull, instruction, history)

    // ④ sendMessage ×≤MAX_RETRIES + validateOutput(specView)
    let ok = false
    let stepContent = ''
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const out = await this.sendWithRateLimit(
          { toolId: subagent.id, toolName: subagent.name, skillId: skill.skillId, skillName: skill.name },
          systemPrompt, userContent,
        )
        const vr = validateOutput(out, specView)
        if (vr.valid) {
          stepContent = vr.extracted[skill.writes[0]] ?? ''
          ok = true
          break
        }
        if (attempt < MAX_RETRIES - 1) {
          this.emit('tool_retry', {
            toolId: subagent.id,
            toolName: subagent.name,
            skillId: skill.skillId,
            skillName: skill.name,
            attempt: attempt + 1,
            maxAttempts: MAX_RETRIES,
            message: `${subagent.name}[${seqId}/${skill.skillId}] 格式错误重试 ${attempt + 1}/${MAX_RETRIES}`,
          })
          const feedback = vr.structuralError
            ? `⚠️ 结构错误：${vr.structuralError}`
            : `⚠️ 格式错误：输出须包含 ${specView.outputTags[0]} 与 ${specView.outputTags[1]} 包裹，请严格遵循模板再次生成。`
          userContent = `${userContent}\n\n---\n${feedback}`
        }
      } catch {
        if (attempt === MAX_RETRIES - 1) break
      }
    }

    return ok ? stepContent : null
  }

  /**
   * v6.7 统一附加标签：<current_target>(priorDraft baseline) + <product_profile>。
   * 供段②场景表与段③逐场景节拍复用，两段的 REFINE 判定据 <current_target> 一致命中。
   */
  private designExtras(priorDraft: string): ExtraLabelEntry[] {
    const extras: ExtraLabelEntry[] = []
    if (priorDraft.length > 0) {
      extras.push({ label: 'current_target', content: priorDraft })
    }
    if (this.profileLock) {
      extras.push({ label: 'product_profile', content: renderProductProfileXml(this.profileLock) })
    }
    return extras
  }

  /**
   * v6.7 单序列三段式流水线（精修入口 / 批量循环体）。
   *
   * ① 建档（0 LLM）：先落骨架占位，UI 立即出现卡片；
   * ② 场景表（1 LLM，checkSceneTable）：沿用 7 列表格，失败即 abort；
   * ③ 逐场景节拍（每场景 1 LLM，checkBeatBlocks）：引擎按场景 ID 遍历，单场景失败降级占位不阻断。
   * 收口 assembleSequenceDoc 覆写落盘 + 数量软校验。
   */
  private async runSequencePipeline(
    subagent: SubagentSpec,
    pipe: PipeRegistryValue,
    seqId: string,
    instruction: string,
    history?: ConversationTurn[],
  ): Promise<ToolResult> {
    const subSkills = getSkills(subagent.id)
    const sceneSkill = subSkills.find((s) => s.skillId === pipe.sceneStep.skillId)
    const beatSkill = subSkills.find((s) => s.skillId === pipe.beatStep.skillId)
    if (!sceneSkill || !beatSkill) {
      return {
        success: false,
        error: `[${subagent.id}] 流水线配置异常：未找到 scene/beat skill`,
        skillName: subagent.name,
      }
    }
    const finalPath = `sequences/${seqId}.md`
    const priorDraft = await safeRead(this.fileManager, finalPath) // REFINE baseline

    // ① 建档：先落骨架占位，让 UI 立刻出现卡片
    await this.fileManager.writeFile(finalPath, this.buildSequenceSkeleton(seqId))

    // ② 场景表（1 次 LLM，checkSceneTable）
    const scenesMd = await this.runSingleStep(subagent, sceneSkill, seqId, instruction, history, {
      structuralCheck: (x) => checkSceneTable(x),
      extras: this.designExtras(priorDraft),
    })
    if (scenesMd == null) return this.pipelineFail(subagent, seqId, '场景表', finalPath)

    // ③ 逐场景节拍（每场景 1 次 LLM，checkBeatBlocks）
    const sceneIds = [...extractSceneIds(scenesMd)]
    const beatBySc = new Map<string, string>()
    for (const sc of sceneIds) {
      const blockMd = await this.runSingleStep(subagent, beatSkill, seqId, instruction, history, {
        structuralCheck: (x) => checkBeatBlocks(x, sc),
        extras: [
          { label: 'prev_scenes', content: scenesMd },
          { label: 'target_scene', content: this.sliceSceneRow(scenesMd, sc) },
          ...this.designExtras(priorDraft),
        ],
      })
      beatBySc.set(sc, blockMd ?? `<!-- 待补节拍 ${sc}（生成失败） -->`) // 降级不阻断
    }

    // 收口：拼装覆写落盘
    const finalMd = assembleSequenceDoc(seqId, scenesMd, sceneIds, beatBySc)
    await this.fileManager.writeFile(finalPath, finalMd)

    const softWarnings = this.runPipelineSoftValidation(scenesMd, beatBySc)
    return {
      success: true,
      writes: [finalPath],
      output: '',
      skillId: beatSkill.skillId,
      skillName: beatSkill.name,
      warnings: softWarnings.length > 0 ? softWarnings : undefined,
    }
  }

  /**
   * v6.7 全序列串行批量：读 sequence_list.md 解析全部序列 ID，for...await 串行跑
   * runSequencePipeline（偏差③并行本次不做），汇总为单 ToolResult 对 Orche 原子化。
   */
  private async runBatchPipeline(
    subagent: SubagentSpec,
    pipe: PipeRegistryValue,
    instruction: string,
    history?: ConversationTurn[],
  ): Promise<ToolResult> {
    const seqListMd = await safeRead(this.fileManager, 'sequence_list.md')
    const seqIds = this.parseSequenceIds(seqListMd)
    if (seqIds.length === 0) {
      return {
        success: false,
        error: '未能从 sequence_list.md 解析出任何序列 ID，请先生成序列清单',
        skillName: subagent.name,
      }
    }

    this.emit('tool_start', {
      toolId: subagent.id,
      toolName: subagent.name,
      message: `并发批量铺设 ${seqIds.length} 个序列（并发 ${PIPELINE_CONCURRENCY}）`,
    })

    // v6.8 并发池（偏差③闭合：串行 for → runWithConcurrency），汇总逻辑按下标对齐不变
    const results = await this.runWithConcurrency(seqIds, PIPELINE_CONCURRENCY,
      (seqId) => this.runSequencePipeline(subagent, pipe, seqId, instruction, history))

    // 汇总
    const writes: string[] = []
    const warnings: string[] = []
    let okCount = 0
    results.forEach((r, i) => {
      if (r.success) {
        okCount++
        if (r.writes) writes.push(...r.writes)
        if (r.warnings) warnings.push(...r.warnings)
      } else {
        warnings.push(`序列 ${seqIds[i]} 失败：${r.error}`)
      }
    })

    return {
      success: okCount > 0,
      writes,
      output: '',
      skillId: pipe.beatStep.skillId,
      skillName: subagent.name,
      error: okCount === 0 ? '全部序列生成失败' : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  /**
   * v6.8 有界并发池：最多 limit 个 worker 同时跑，超出排队。
   * out[i] 与 items[i] 下标对齐（无论完成顺序），保证 runBatchPipeline 汇总 seqIds[i] 正确。
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

  /**
   * v6.8 429 指数退避重试（复用 classifyLLMError 识别 rate_limit）。
   * 非 429 直接抛交原流程；429 退避重试不消耗 MAX_RETRIES 格式重试预算。
   */
  private async sendWithRateLimit(
    ctx: { toolId: string; toolName: string; skillId: string; skillName: string },
    systemPrompt: string, userContent: string,
  ): Promise<string> {
    const MAX_429_RETRIES = 3
    for (let i = 0; i < MAX_429_RETRIES; i++) {
      try {
        return await this.llm.sendMessage(systemPrompt, userContent)
      } catch (e) {
        if (classifyLLMError(e).type !== 'rate_limit' || i === MAX_429_RETRIES - 1) throw e
        const backoff = 1000 * Math.pow(2, i) // 1s → 2s → 4s
        this.emit('tool_retry', {
          toolId: ctx.toolId, toolName: ctx.toolName, skillId: ctx.skillId, skillName: ctx.skillName,
          attempt: i + 1, maxAttempts: MAX_429_RETRIES,
          message: `429 限流，${backoff}ms 后重试 (${i + 1}/${MAX_429_RETRIES})`,
        })
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
    throw new Error('unreachable')
  }

  /** v6.7 段②/③失败收口：返回中断位点指示的失败 ToolResult（骨架已落盘，UI 卡片保留） */
  private pipelineFail(
    subagent: SubagentSpec,
    seqId: string,
    stage: string,
    finalPath: string,
  ): ToolResult {
    this.emit('tool_error', {
      toolId: subagent.id,
      toolName: subagent.name,
      message: `${subagent.name}[${seqId}] 在「${stage}」阶段连续失败，流水线中止`,
    })
    return {
      success: false,
      error: `序列 ${seqId} 在「${stage}」阶段生成失败`,
      writes: [finalPath],
      skillName: subagent.name,
    }
  }

  /** v6.7 从 sequence_list.md 扫全部序列 ID（S{幕}-{序}），去重排序 */
  private parseSequenceIds(seqListMd: string): string[] {
    const set = new Set<string>()
    const re = /\bS\d+-\d+\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(seqListMd)) !== null) set.add(m[0])
    return [...set].sort()
  }

  /** v6.7 建档骨架：带标题占位，让 UI 立即出现卡片 */
  private buildSequenceSkeleton(seqId: string): string {
    return `<<<SCENE_BEAT_OUTLINE_START>>>\n# ${seqId}\n\n### 场景表\n\n*（生成中…）*\n\n### 节拍\n\n*（生成中…）*\n<<<SCENE_BEAT_OUTLINE_END>>>`
  }

  /** v6.9 成文建档骨架：用 writer 自身 outputTags 包裹（四 writer tag 各异，动态取），UI 立即出现卡片 */
  private buildChapterSkeleton(skill: SkillSpec, seqId: string): string {
    const [start, end] = skill.outputTags
    return `${start}\n# ${seqId}\n\n*（正文生成中…）*\n${end}`
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

  /**
   * v6.9 按产品解析序列正文落盘路径。
   * - one_to_many(短剧)：chapters/E01-E12.md（全局集号区间）
   * - one_to_one(长剧)：chapters/E05.md（单集）
   * - none(小说/剧本)：chapters/<seqId>.md（不变）
   * 守 INV-3：用 profile.sequenceToEpisode 分支，不加 ProductProfile 字段。
   */
  private resolveChapterPath(
    seqId: string,
    episodeRange: Map<string, [number, number]>,
  ): string {
    const profile = this.profileLock
    if (!profile || profile.sequenceToEpisode === 'none') {
      return `chapters/${seqId}.md`
    }
    const range = episodeRange.get(seqId)
    if (!range) return `chapters/${seqId}.md` // 兜底
    const [start, end] = range
    if (profile.sequenceToEpisode === 'one_to_many') {
      return `chapters/E${pad2(start)}-E${pad2(end)}.md`
    }
    return `chapters/E${pad2(start)}.md` // one_to_one（长剧）
  }

  /**
   * v6.9 单步 writer LLM 调用（短剧逐集 / 长剧逐场景 / 单序列整产共用）。
   *
   * 从原 executeTool WRITER 分支抽出上下文组装 + LLM 调用 + 校验逻辑，去掉落盘
   * （累积改由 runWriterSequencePipeline 的 finalDraft 做，避免逐单元覆写丢历史）。
   * 组装 reads 静态上下文 + current_draft/同幕/前章/行为追踪/档案/伏笔状态/批次进度，
   * 调 sendWithRateLimit（429 退避不耗格式重试预算）×≤MAX_RETRIES，validateOutput 通过返回 extracted[chapterPath]。
   *
   * 守 INV-1：仍调 validateOutput 校验 START/END tags；INV-2：经 appendExtraLabels 注入标签。
   */
  private async runWriterStep(
    subagent: SubagentSpec,
    skill: SkillSpec,
    seqId: string,
    chapterPath: string,
    seqBeatsDoc: string,
    currentDraft: string,
    instruction: string,
    history: ConversationTurn[] | undefined,
  ): Promise<string | null> {
    // ② 读上下文（按 Skill.reads，支持 /*.md glob 展开 v6.3）
    const files: Record<string, string> = {}
    const allPaths = await this.fileManager.listAssetFiles()
    const { reads: expandedReads, aggregatedLabel } = expandGlobs(skill.reads, allPaths)
    for (const path of expandedReads) {
      if (!(path in files)) {
        files[path] = await safeRead(this.fileManager, path)
      }
    }

    // ③ 组装静态上下文 + v6.3 聚合标签拼接
    let context = assembleContext(expandedReads, files)
    if (aggregatedLabel) {
      const prefix = aggregatedLabel === 'scene_beats_slices' ? 'sequences' : ''
      if (prefix) {
        context += buildAggregatedXml(aggregatedLabel, expandedReads, files)
      }
    }

    // v6.4：同幕全部序列（按幕号聚合，替代旧 ±1 相邻序列）
    const actPrefix = seqId.replace(/-\d+$/, '')
    const seqPaths = allPaths
      .filter(a => a.path.startsWith('sequences/') && a.path.endsWith('.md') && a.exists)
      .map(a => a.path)
      .sort()
    const sameActPaths = seqPaths.filter(p => {
      const sId = p.replace(/^sequences\//, '').replace(/\.md$/, '')
      return sId.startsWith(actPrefix + '-')
    })
    const sameActDocs = await Promise.all(sameActPaths.map(p => safeRead(this.fileManager, p)))
    const sameActXml = sameActPaths
      .map((p, i) => {
        const sId = p.replace(/^sequences\//, '').replace(/\.md$/, '')
        return `<slice id="${sId}">\n${sameActDocs[i]}\n</slice>`
      })
      .join('\n')

    // v6.4：紧前章节正文，供 Writer 感知实际文风（仅 CREATE 模式注入）
    const chapterPaths = allPaths
      .filter(a => a.path.startsWith('chapters/') && a.path.endsWith('.md') && a.exists)
      .map(a => a.path)
      .sort()
    const chapterIdx = chapterPaths.findIndex(p => p === chapterPath)
    const prevChapterDoc = (!currentDraft && chapterIdx > 0)
      ? await safeRead(this.fileManager, chapterPaths[chapterIdx - 1])
      : ''

    // v6.4：角色行为追踪摘要
    const behaviorTrackingSummary = [...this.behaviorTrack.entries()]
      .map(([ch, items]) => `<chapter id="${ch}">\n${items.map(i => `  - ${i}`).join('\n')}\n</chapter>`)
      .join('\n\n')

    // v6.6：注入产品档案 + 短剧镜头分解规范
    const profileXml = this.profileLock ? renderProductProfileXml(this.profileLock) : ''
    const shotSpec = this.profileLock?.kind === 'short_drama' ? SHORT_DRAMA_SHOT_SPEC : ''

    // v6.6：伏笔运行时状态 + 批次断点（防重复 plant / 提前 payoff，支持分段续写）
    const foreshadowStateXml = this.renderForeshadowingStateXml()
    const batchProgressXml = this.renderBatchProgressXml()

    context = appendExtraLabels(context, [
      { label: 'current_draft', content: currentDraft },
      { label: 'current_target', content: currentDraft },
      { label: 'current_sequence_beats', content: seqBeatsDoc },
      { label: 'same_act_sequences', content: sameActXml },
      { label: 'previous_chapter_draft', content: prevChapterDoc },
      { label: 'character_behavior_tracking', content: behaviorTrackingSummary },
      { label: 'product_profile', content: profileXml },
      { label: 'shot_breakdown_spec', content: shotSpec },
      { label: 'foreshadowing_state', content: foreshadowStateXml },
      { label: 'batch_progress', content: batchProgressXml },
    ])

    // ④ System Prompt + specView（effectiveWrites 替换 placeholder）
    const systemPrompt = skill.preamble ? `${skill.preamble}\n\n${skill.body}` : skill.body
    const specView: SkillSpec = { ...skill, writes: [chapterPath] }
    let userContent = buildAgentPrompt(context, instruction, history)
    const ctx = { toolId: subagent.id, toolName: subagent.name, skillId: skill.skillId, skillName: skill.name }

    // ⑦ 调用 LLM + 校验（最多 MAX_RETRIES 次，429 由 sendWithRateLimit 退避不耗预算）
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const output = await this.sendWithRateLimit(ctx, systemPrompt, userContent)
        const validation = validateOutput(output, specView)
        if (validation.valid) {
          return validation.extracted[chapterPath] ?? ''
        }
        if (attempt < MAX_RETRIES - 1) {
          this.emit('tool_retry', {
            toolId: ctx.toolId, toolName: ctx.toolName, skillId: ctx.skillId, skillName: ctx.skillName,
            attempt: attempt + 1, maxAttempts: MAX_RETRIES,
            message: `${subagent.name}[${seqId}] 格式错误，重试 ${attempt + 1}/${MAX_RETRIES}`,
          })
          const feedback = validation.structuralError
            ? `⚠️ 结构错误：${validation.structuralError}`
            : `⚠️ 格式错误：输出必须包含正确的 ${specView.outputTags[0]} 和 ${specView.outputTags[1]} 包裹。请严格遵循模板格式重新输出完整内容。`
          userContent = `${userContent}\n\n---\n${feedback}`
        }
      } catch (e) {
        if (attempt === MAX_RETRIES - 1) {
          this.emit('tool_error', {
            toolId: ctx.toolId, toolName: ctx.toolName,
            message: `${subagent.name}[${seqId}] 单步调用失败：${(e as Error).message}`,
          })
          return null
        }
      }
    }
    return null
  }

  /**
   * v6.9 单序列写作 pipeline（精修入口 / 批量并发循环体）。
   *
   * ① 建档（0 LLM）：按 resolveChapterPath 落骨架占位，UI 立即出卡片
   * ② 分段产出（三分支，泛化 02 文档二分支——长剧 scene 亦需分段否则超 LLM 输出上限）：
   *    - episode(短剧)：逐集循环调 runWriterStep，finalDraft 引擎累积（不依赖 writer 回填历史）
   *    - scene(长剧)：逐场景循环，unitCount = sequences 场景表数据行数
   *    - none(小说/剧本)：单次调 runWriterStep 产整序列
   * ③ 收口：覆写落盘 + extractBehaviorTrack/extractForeshadowingState/updateBatchProgress + 软校验
   *
   * 守 INV-5：自包含，只读 profileLock/fileManager，只写本序列 chapter 文件，不读不写他序列产物（并行硬前提）。
   */
  private async runWriterSequencePipeline(
    subagent: SubagentSpec,
    seqId: string,
    instruction: string,
    history: ConversationTurn[] | undefined,
    episodeRange: Map<string, [number, number]>,
  ): Promise<ToolResult> {
    const skill = selectSkill(subagent.id, instruction)
    const chapterPath = this.resolveChapterPath(seqId, episodeRange)
    const splitUnit = this.profileLock?.proseSplitUnit ?? 'none'
    const seqBeatsDoc = await safeRead(this.fileManager, `sequences/${seqId}.md`)

    // ① 建档骨架（0 LLM）—— UI 立即出卡片
    await this.fileManager.writeFile(chapterPath, this.buildChapterSkeleton(skill, seqId))
    this.emit('tool_complete', {
      toolId: subagent.id, toolName: subagent.name,
      skillId: skill.skillId, skillName: skill.name,
      writes: [chapterPath],
      message: `[${seqId}] 建档骨架已落盘，开始正文生成`,
    })

    // ② 分段产出
    let finalDraft = ''
    if (splitUnit === 'episode') {
      // 短剧逐集循环：集数 = episodeRange 区间长度（一集一场景）
      const [start, end] = episodeRange.get(seqId) ?? [1, 8]
      const episodeCount = end - start + 1
      for (let i = 0; i < episodeCount; i++) {
        const epDraft = await this.runWriterStep(
          subagent, skill, seqId, chapterPath, seqBeatsDoc, finalDraft, instruction, history,
        )
        const placeholder = `<!-- 待补第${start + i}集（生成失败） -->`
        finalDraft = epDraft == null
          ? (finalDraft ? `${finalDraft}\n\n${placeholder}` : placeholder)
          : (finalDraft ? `${finalDraft}\n\n${epDraft}` : epDraft)
      }
    } else if (splitUnit === 'scene') {
      // 长剧逐场景循环：场景数 = sequences 场景表数据行数（解析失败回退 1）
      const sceneCount = countTableDataRows(seqBeatsDoc) || 1
      for (let i = 0; i < sceneCount; i++) {
        const sceneDraft = await this.runWriterStep(
          subagent, skill, seqId, chapterPath, seqBeatsDoc, finalDraft, instruction, history,
        )
        const placeholder = `<!-- 待补场景${i + 1}（生成失败） -->`
        finalDraft = sceneDraft == null
          ? (finalDraft ? `${finalDraft}\n\n${placeholder}` : placeholder)
          : (finalDraft ? `${finalDraft}\n\n${sceneDraft}` : sceneDraft)
      }
    } else {
      // 小说/剧本：单次产整序列
      const draft = await this.runWriterStep(
        subagent, skill, seqId, chapterPath, seqBeatsDoc, '', instruction, history,
      )
      finalDraft = draft ?? `<!-- 待补正文 ${seqId}（生成失败） -->`
    }

    // ③ 收口落盘 + 运行时记忆
    await this.fileManager.writeFile(chapterPath, finalDraft)
    this.extractBehaviorTrack(seqId, finalDraft)
    this.extractForeshadowingState(seqId, finalDraft)
    this.updateBatchProgress(seqId, finalDraft)
    const softWarnings = this.runSoftValidation(finalDraft)

    return {
      success: true,
      writes: [chapterPath],
      output: '',
      skillId: skill.skillId,
      skillName: skill.name,
      warnings: softWarnings.length > 0 ? softWarnings : undefined,
    }
  }

  /**
   * v6.9 全序列并发批量写作：读 sequence_list 解析全部 seqIds + buildEpisodeRangeMap
   * → runWithConcurrency(WRITER_CONCURRENCY) 并发跑 runWriterSequencePipeline → 汇总单 ToolResult。
   *
   * 守 INV-5：每个 runWriterSequencePipeline 自包含，无跨序列共享可变状态，可安全并行。
   * 竞态说明：extractBehaviorTrack/extractForeshadowingState/updateBatchProgress 写实例 Map，
   *   JS 单线程事件循环下 await 期间虽交错，但 key 按 seqId/F-id 隔离无覆写；foreshadowingState
   *   裁剪偶发不一致属软辅助不阻塞功能。
   */
  private async runWriterBatchPipeline(
    subagent: SubagentSpec,
    instruction: string,
    history: ConversationTurn[] | undefined,
  ): Promise<ToolResult> {
    const seqListMd = await safeRead(this.fileManager, 'sequence_list.md')
    const seqIds = this.parseSequenceIds(seqListMd)
    if (seqIds.length === 0) {
      return { success: false, error: '未能从 sequence_list.md 解析出任何序列 ID', skillName: subagent.name }
    }
    const episodeRange = await this.buildEpisodeRangeMap(seqIds)

    this.emit('tool_start', {
      toolId: subagent.id, toolName: subagent.name,
      message: `并发批量写作 ${seqIds.length} 个序列（并发 ${WRITER_CONCURRENCY}）`,
    })

    const results = await this.runWithConcurrency(seqIds, WRITER_CONCURRENCY,
      (seqId) => this.runWriterSequencePipeline(subagent, seqId, instruction, history, episodeRange))

    // 汇总（下标对齐，不依赖完成顺序）
    const writes: string[] = []
    const warnings: string[] = []
    let okCount = 0
    results.forEach((r, i) => {
      if (r.success) {
        okCount++
        if (r.writes) writes.push(...r.writes)
        if (r.warnings) warnings.push(...r.warnings)
      } else {
        warnings.push(`序列 ${seqIds[i]} 失败：${r.error}`)
      }
    })
    return {
      success: okCount > 0,
      writes,
      output: '',
      skillName: subagent.name,
      error: okCount === 0 ? '全部序列写作失败' : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  /** v6.7 从场景表抽 sc 那一行原样（供 <target_scene> 精准注入，模型只看这一个场景） */
  private sliceSceneRow(scenesMd: string, sc: string): string {
    const line = scenesMd.split(/\r?\n/).find((l) => l.includes(sc))
    return line ? line.trim() : sc
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
    // ① 计算可用 Subagent（v5：全部始终可见）
    this.onEvent = onEvent
    // v6.8 审计修复状态每轮用户输入重置（不跨用户输入残留，避免"检查后用户改做别的"误拦上游）
    this.auditFixMode = false
    this.auditScope = null
    const availableSubagents = getAvailableSubagents()

    // ===== v6.6 Guard-0/1：产品锁 + Phase Gate 双重可见性过滤（FC 面）=====
    //  - profileLock=null：未选产品 → 仅 reset_all 可见（设计区+成文区全隐藏）
    //  - 设计期：剔除全部四 writer（须先🔒锁定大纲进写作期才可写正文）
    //  - 写作期：剔除设计区 + story_checker + 非本产品 writer（仅留 profileLock.writerSubagentId）
    const phaseState0 = usePhaseStore.getState()
    // v6.6：input_normalizer 仅在"无设计资产"时进 FC 面（早期可用），有资产后隐藏
    const allAssetFiles0 = await this.fileManager.listAssetFiles()
    const hasDesignAssets = allAssetFiles0.some(
      (a) =>
        a.exists &&
        ['worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md'].includes(a.path),
    )
    let visibleSubagents: SubagentSpec[]
    if (this.profileLock === null) {
      visibleSubagents = availableSubagents.filter((sa) => sa.id === 'reset_all')
    } else if (phaseState0.isWriting()) {
      const activeWriter = this.profileLock.writerSubagentId
      visibleSubagents = availableSubagents.filter(
        (sa) =>
          !CREATIVE_TOOL_IDS.includes(sa.id) &&
          sa.id !== 'story_checker' &&
          sa.id !== 'input_normalizer' &&
          !(WRITER_IDS.includes(sa.id) && sa.id !== activeWriter),
      )
    } else {
      visibleSubagents = availableSubagents.filter(
        (sa) => !WRITER_IDS.includes(sa.id) && (sa.id !== 'input_normalizer' || !hasDesignAssets),
      )
    }
    const toolSpecs = visibleSubagents.map(buildFunctionSpec)

    // ② 加载 System Prompt（注入工具列表）
    let systemPrompt = loadOrchestratorPrompt(toolSpecs)

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
      maxRounds: MAX_ROUNDS,
      toolsCalled: [],
      toolResults: [],
      auditRound: 0,
      maxAuditRounds: 3,
    }

    // ⑤ FC 调度循环 + 审计循环（独立计数）
    while (state.currentRound < MAX_ROUNDS && state.auditRound < state.maxAuditRounds) {

      // 上下文管理：检查 token 是否超限
      if (estimateTokens(messages) > CONTEXT_LIMIT_CHARS) {
        const compressed = compressMessages(messages)
        messages.length = 0
        messages.push(...compressed)
      }

      this.emit('orchestrator_thinking', {
        round: state.currentRound + 1,
        maxRounds: state.maxRounds,
        message: `第 ${state.currentRound + 1}/${MAX_ROUNDS} 轮：正在分析你的需求...`,
      })

      let response
      try {
        response = await this.llm.sendMessageWithTools(systemPrompt, messages, toolSpecs)
      } catch (e) {
        this.emit('engine_error', {
          message: `处理异常: ${(e as Error).message}`,
        })
        return {
          success: false,
          results: state.toolResults,
          response: `系统响应异常: ${(e as Error).message}`,
        }
      }

      const { message, finish_reason } = response

      // 处理 finish_reason
      switch (finish_reason) {
        case 'stop':
          // LLM 决定不再调工具 → 返回文本给用户
          this.emit('engine_complete', {
            message: state.toolsCalled.length > 0
              ? `已完成 ${state.toolsCalled.length} 个工具调用`
              : '处理完成',
          })

          // 后处理：如果有创作 Subagent 被执行，自动更新 user_requirements.md 的状态标记
          if (state.toolsCalled.some(id => CREATIVE_TOOL_IDS.includes(id))) {
            const reqTool = getSubagent('user_requirements_analyzer')
            if (reqTool) {
              const successTools = state.toolResults
                .filter(r => r.success && r.writes && r.writes.length > 0)
                .map(r => r.writes!.join(', '))
                .filter(Boolean)

              if (successTools.length > 0) {
                const statusInstruction = `根据本轮执行结果更新 user_requirements.md 的状态标记。已成功写入：${successTools.join('；')}。请将其中已实现的需求标记为 ✅，仍未实现的需求保持 ⬜。仅更新状态标记，不修改需求内容。`
                await this.executeTool(reqTool, statusInstruction)
              }
            }
          }

          return {
            success: true,
            results: state.toolResults,
            response: message.content || '处理完成',
          }

        case 'tool_calls': {
          const toolCalls = message.tool_calls
          if (!toolCalls || toolCalls.length === 0) {
            // 没有 tool_calls 但 finish_reason 是 tool_calls → 异常
            state.currentRound++
            continue
          }

          // 限制单次调用的工具数量
          const callsToProcess = toolCalls.slice(0, MAX_TOOLS_PER_ROUND)

          // 先将 assistant 消息加入历史（含 tool_calls）
          messages.push({
            role: 'assistant' as const,
            content: message.content,
            tool_calls: toolCalls,
          } as ChatCompletionMessageParam)

          // 串行执行每个 Subagent
          for (const toolCall of callsToProcess) {
            const toolId = toolCall.function.name
            const subagentSpec = getSubagent(toolId)

            if (!subagentSpec) {
              // 未知 Subagent → 返回错误
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ success: false, error: `未知工具: ${toolId}` }),
              } as ChatCompletionMessageParam)
              continue
            }

            // 解析 instruction + v6.1 动态靶参数（target_sequence / target_chapter 由 buildFunctionSpec
            // 条件附加给 NEEDS_TARGET_PARAM 白名单成员；其它 subagent 不携带此字段，空串无影响）
            let instruction = ''
            let argTarget = ''
            try {
              const args = JSON.parse(toolCall.function.arguments)
              instruction = args.instruction || ''
              argTarget = String(args.target_sequence ?? args.target_chapter ?? '').trim()
            } catch {
              instruction = toolCall.function.arguments || ''
            }

            // 执行 Subagent（history 仅 analyzer 前置预跑需要；第 4 可选项承载动态靶供
            // executeTool 内 resolveWriteTarget / runSequencePipeline 消费）
            this.emit('tool_start', {
              toolId: subagentSpec.id,
              toolName: subagentSpec.name,
              round: state.currentRound + 1,
              maxRounds: state.maxRounds,
              message: `调用：${subagentSpec.name}`,
            })

            const result = await this.executeTool(subagentSpec, instruction, undefined, {
              target: argTarget,
            })
            state.toolResults.push(result)
            state.toolsCalled.push(subagentSpec.id)

            if (result.success) {
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
              this.emit('tool_error', {
                toolId: subagentSpec.id,
                toolName: subagentSpec.name,
                skillId: result.skillId,
                skillName: result.skillName,
                message: `${subagentSpec.name} 失败`,
              })
            }

            // 将 tool 结果加入消息历史
            // story_checker 注入完整报告，其余 Subagent 返回简短消息
            if (subagentSpec.id === 'story_checker' && result.success) {
              const report = await this.fileManager.readFile('_check_report.md')
              // v6.8 Guard-3 状态：由 AUDIT_SCOPE 标记判定（避免总体结论正则跨段误匹配）
              const scopeMatch = report.match(/<!-- AUDIT_SCOPE: (\w+) -->/)
              const scope = scopeMatch?.[1] ?? null
              this.auditFixMode = scope === 'sequence_only' || scope === 'has_upstream'
              this.auditScope = scope === 'sequence_only' ? 'sequence_only' : null
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: report,
              } as ChatCompletionMessageParam)
              state.auditRound++
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
          break
        }

        case 'length':
          return {
            success: false,
            results: state.toolResults,
            response: state.toolResults.length > 0
              ? '响应过长已截断，已执行的部分已完成'
              : '请求过长，请简化后重试',
          }

        case 'content_filter':
          return {
            success: false,
            results: state.toolResults,
            response: '内容被安全过滤，请调整表达方式后重试',
          }

        default:
          // 未知 finish_reason
          state.currentRound++
          continue
      }
    }

    // 超过轮次上限 → 强制结束
    const auditMsg = state.auditRound >= state.maxAuditRounds
      ? '检查和修复已达 3 轮上限，部分问题可能需要你的进一步指导。'
      : `已执行 ${state.toolsCalled.length} 个工具（达 ${MAX_ROUNDS} 轮上限），请继续补充剩余需求。`

    this.emit('engine_complete', {
      message: auditMsg,
    })

    // 后处理：如果有创作 Subagent 被执行，自动更新 user_requirements.md 的状态标记
    if (state.toolsCalled.some(id => CREATIVE_TOOL_IDS.includes(id))) {
      const reqTool = getSubagent('user_requirements_analyzer')
      if (reqTool) {
        const successTools = state.toolResults
          .filter(r => r.success && r.writes && r.writes.length > 0)
          .map(r => r.writes!.join(', '))
          .filter(Boolean)

        if (successTools.length > 0) {
          const statusInstruction = `根据本轮执行结果更新 user_requirements.md 的状态标记。已成功写入：${successTools.join('；')}。请将其中已实现的需求标记为 ✅，仍未实现的需求保持 ⬜。仅更新状态标记，不修改需求内容。`
          await this.executeTool(reqTool, statusInstruction)
        }
      }
    }

    return {
      success: true,
      results: state.toolResults,
      response: auditMsg,
    }
  }
}
