import type OpenAI from 'openai'
import type { SubagentSpec, SkillSpec, ToolResult, DispatchResult, SchedulerState, ExecutionEvent, ExecutionEventCallback, ConversationTurn, AssetFileInfo } from '../types'
import { getSubagent, getAvailableSubagents, buildFunctionSpec, getSkills } from '../skills/skillLoader'
import { selectSkill } from './skillRouter'
import { assembleContext, buildAgentPrompt } from './contextAssembler'
import { validateOutput } from './outputValidator'
import { checkSceneTable, checkBeatTable } from '../skills/scene_beats/structuralChecks'
import type { LLMClient } from '../llm/client'
import type { FileManager } from './fileManager'
import { usePhaseStore } from '../store/phaseStore'
import orchestratorPromptRaw from '../llm/prompts/orchestrator_v5.md?raw'

type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam

// ===== 常量 =====

const MAX_ROUNDS = 10
const MAX_RETRIES = 3
const MAX_TOOLS_PER_ROUND = 5
const CONTEXT_LIMIT_CHARS = 22_000 // deepseek-v4-flash 32K 的 ~70%

/** 创作 Subagent ID 列表（用于后处理判断是否需要更新需求状态） */
const CREATIVE_TOOL_IDS = [
  'worldbuilding', 'characters', 'act_map', 'sequence_list',
  'scene_beats', 'foreshadowing_tracker', 'subplot_manager',
]

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


// ===== v6.1 动态写靶协议扩展（resolveWriteTarget / resolveExtraContext）=====

/**
 * 目标标识符合法性护栏：
 * 主层级 S{幕}-{序} 如 S1-1；细粒度子级 SC-{seq}-{nn} 如 SC-S1-1-01。
 */
const TARGET_ID_REGEX = /^[A-Z]\d+-\d+(?:-\d{2})?$/

/**
 * 从细粒度场景号反推所属序列 ID（script_writer 定位上游 sequence beats 文件用）
 *
 * 例：SC-S1-1-02 → S1-1 ；S2-3 → S2-3（已为主层级原样返回）。
 */
function normalizeToSequenceId(target: string): string {
  const m = /^SC-([A-Z]\d+-\d+)/.exec(target)
  return m ? m[1] : target
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

// ===== v6.2 Scene Beats 两步流水线注册表（PIPELINE_REGISTRY）=====
//
// 当某 Subagent 出现在此注册表中，executeTool 会绕开 Skill Router 多选机制，
// 按 steps 固定序强制选定各 step.skillId 各自跑一次 LLM call，
// 最后由引擎代码 assembleSequenceOutline() 拼装成品落盘 sequences/<ID>.md。
// 中间产物**不落盘**，通过 runPipeline 内的内存变量在两步之间传递，天然幂等无临件残留。
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
  steps: PipeStepDef[]
}

const PIPELINE_REGISTRY: Record<string, PipeRegistryValue> = {
  scene_beats: {
    steps: [
      { skillId: 'scene_designer', label: 'prev_scenes' },
      { skillId: 'beat_writer',    label: 'prev_beats' },
      // S3 assemble 不在 steps 里——由 runPipeline 收尾时直接调 assembleSequenceOutline() 引擎函数
    ],
  },
}

/**
 * v6.2 为 pipeline step 动态构造 structuralCheck 钩子。
 *
 * checkBeatTable 需要跨步依赖 scenesMd 作 SC-ID 集合参照,故必须在 runPipeline 内
 * 按 skillId + 前置产出 快照 构造 closure,无法在 skillLoader 静态注册。
 *
 * @param skillId 当前 pipeline step 的 skill id
 * @param scenesMd 上一步 scene_designer 的场景表内存字符串(供 beat_writer 校验用)
 * @returns 挂载到 SkillSpec.structuralCheck 的钩子;非 scene_beats pipeline step 返回 undefined
 */
function buildStructuralCheckForStep(
  skillId: string,
  scenesMd: string | undefined,
): SkillSpec['structuralCheck'] {
  if (skillId === 'scene_designer') {
    return (extracted: string) => checkSceneTable(extracted)
  }
  if (skillId === 'beat_writer') {
    return (extracted: string) => checkBeatTable(extracted, scenesMd)
  }
  return undefined
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

// ===== v6.2 Scene Beats 引擎代码收口(S3)=====

/** 提取 markdown 表格首行到尾行的连续块(去除表头前的空行与表尾后的说明段)。 */
function extractTableBlock(md: string): string {
  const lines = md.split(/\r?\n/)
  const table: string[] = []
  let inTable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('|') && line.endsWith('|')) {
      table.push(line)
      inTable = true
    } else if (inTable) {
      break
    }
  }
  return table.join('\n')
}

/**
 * v6.2 S3:两步 LLM 完成后由引擎代码拼装 sequences/<target>.md 最终成品(零 LLM 调用)。
 *
 * 职责三项:
 *   1. 从 scenesMd / beatsMd(已经过 validator 结构化校验)中抽出表格块(丢弃可能的前置说明段);
 *   2. 按固定模板拼装 # 标题 + 场景表 + 节拍表,外层包上 SCENE_BEAT_OUTLINE 复合 tag
 *      复用下游 script_writer 的 <current_sequence_beats> 契约(v6.1 已确立);
 *   3. 由于 LLM 输出已经过 checkSceneTable/checkBeatTable 双重结构校验,拼装期不再做
 *      额外一致性心算——真正的引用完整性/词库合规性已在 validator 阶段拦下。
 *
 * @param target 目标序列 ID 如 'S1-1'
 * @param scenesMd scene_designer 输出的场景表(不含 START/END TAG)
 * @param beatsMd beat_writer 输出的节拍表(不含 START/END TAG)
 * @returns 最终 sequences/<target>.md 的完整内容(含外层 SCENE_BEAT_OUTLINE TAG)
 */
function assembleSequenceOutline(target: string, scenesMd: string, beatsMd: string): string {
  const scenesTable = extractTableBlock(scenesMd) || scenesMd.trim()
  const beatsTable = extractTableBlock(beatsMd) || beatsMd.trim()

  return [
    '<<<SCENE_BEAT_OUTLINE_START>>>',
    `# ${target}`,
    '',
    '### 场景表',
    '',
    scenesTable,
    '',
    '### 节拍表',
    '',
    beatsTable,
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

  constructor(llm: LLMClient, fileManager: FileManager) {
    this.llm = llm
    this.fileManager = fileManager
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
   *   - 若 subagent 注册于 PIPELINE_REGISTRY 则走纵切多步管道（runPipeline）对 Orche 原子化为一次 tool_call；
   *     否则按原有单 Skill 直发流程，其中 script_writer 经 resolveWriteTarget 计算 effectiveWrites
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
    // ===== v6.1 Guard-2: Phase Gate dispatch 兜底拦截（Guard-1 已做 FC 面裁剪此处双保险防线）=====
    // 即便未来某段逻辑漏过可见性筛选仍在此处硬拦下违规跨阶段调用并 push 友好错误反馈供 Orche 自纠转向。
    const psGuard = usePhaseStore.getState()
    if (psGuard.isWriting()) {
      if (
        CREATIVE_TOOL_IDS.includes(subagent.id) ||
        subagent.id === 'story_checker'
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
    } else if (subagent.id === 'script_writer') {
      this.emit('tool_error', {
        toolId: subagent.id,
        toolName: subagent.name,
        message: `${subagent.name} 仅在写作期可用，请先点🔒锁定大纲再发起章节创作`,
      })
      return {
        success: false,
        error: `${subagent.name} 当前不在开放窗口内（须先 HeaderBar 🔒锁定大纲进入写作期）`,
        skillName: subagent.name,
      }
    }

    const target = options?.target?.trim() ?? ''

    // ===== v6.1 Pipeline Registry 分流（scene_beats 四步纵切主路）=====
    const pipeReg = PIPELINE_REGISTRY[subagent.id]
    if (pipeReg !== undefined) {
      if (!target || !TARGET_ID_REGEX.test(target)) {
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          message: `${subagent.name} 必须提供合法格式的 target_sequence（形如 S1-1）；缺值或非法将拒绝下沉给模型`,
        })
        return {
          success: false,
          error: `必须提供合法格式的 target_sequence 以驱动 ${subagent.name} 流水线`,
          skillName: subagent.name,
        }
      }
      return this.runPipeline(subagent, pipeReg, target, instruction, history)
    }

    // ===== 单 Skill 直发路径（含 script_writer 的 resolveWriteTarget 协议扩展）=====
    // ① Skill Router：在该 Subagent 名下选出最合适的 Skill
    //    单 Skill 时零成本直选、不调 LLM；≥2 candidate 时按 when/description 打分择优
    const skill = selectSkill(subagent.id, instruction)

    // reset_all 特殊处理：空 writes + 空 outputTags = 不调 LLM，直接清空
    if (isResetSkill(skill)) {
      await this.fileManager.clearAll()
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

    // ⑤ v6.1 resolveWriteTarget：scene_beats 已被上方管道截走，此处仅需处理 script_writer 章节 靶
    let effectiveWrites = skill.writes
    if (subagent.id === 'script_writer') {
      if (!target || !TARGET_ID_REGEX.test(target)) {
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          message: `${subagent.name} 必须提供合法格式的 target_chapter（形如 S1-1）才能落盘正文`,
        })
        return {
          success: false,
          error: `必须提供合法格式的 target_chapter 以定位 ${subagent.name} 输出文件`,
          skillName: subagent.name,
        }
      }
      const resolvedPath = `chapters/${target}.md`
      effectiveWrites = [resolvedPath, ...skill.writes.slice(1)]

      // resolveExtraContext：注入既存草稿与上游场记切片触发 create/refine 双模自判定
      const currentDraft = await safeRead(this.fileManager, resolvedPath)
      const seqBeatsDoc = await safeRead(
        this.fileManager,
        `sequences/${normalizeToSequenceId(target)}.md`,
      )
      context = appendExtraLabels(context, [
        { label: 'current_draft', content: currentDraft },
        { label: 'current_target', content: currentDraft },
        { label: 'current_sequence_beats', content: seqBeatsDoc },
      ])
    }

    // ⑥ 完整 userContent（v5.5：可附对话历史供指代解析）
    let userContent = buildAgentPrompt(context, instruction, history)

    // specView 仅供 validateOutput 取 outputTags + effectiveWrites[0]，validator 业务零改（INV-1）
    const specView: SkillSpec = { ...skill, writes: effectiveWrites }

    // ⑦ 调用 LLM + 校验（最多 3 次重试）
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const output = await this.llm.sendMessage(systemPrompt, userContent)
        const validation = validateOutput(output, specView)

        if (validation.valid) {
          for (const [file, content] of Object.entries(validation.extracted)) {
            await this.fileManager.writeFile(file, content)
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
   * v6.2 两步流水线 Runner（PIPELINE_REGISTRY 注册者专享私有方法）
   *
   * 按 pipe.steps 固定序依次强制选定各 step.skillId（绕开 Router 打分），每 step 各跑
   * ≤MAX_RETRIES 次 LLM + validateOutput，中间产物**不落盘**通过内存字符串传递到下一步的
   * `<prev_*>` XML 标签；全部 LLM 步骤成功后由引擎代码 assembleSequenceOutline() 拼装
   * 最终成品并 writeFile 到 sequences/<ID>.md 一次落盘完成整体交付。
   *
   * 任一 LLM 步失败即整体 abort 返回 ToolResult.success=false.error 含中断位点指示，
   * Orchestrator 收到错误反馈自行决定下一步转向。
   *
   * 数据传递：<prev_scenes> 将 S1 场景表内存字符串注入 S2 上下文；若终品 sequences/<ID>.md
   * 已存在则同时向 S1/S2 都附加 <current_target>=旧版作 baseline 微修参照。
   *
   * v6.2 结构化 validator 挂载：runPipeline 在此为每 step 动态绑定 structuralCheck 钩子
   * （scene_designer→checkSceneTable、beat_writer→checkBeatTable(scenesMd)），
   * 因为 checkBeatTable 需跨步依赖 scenesMd 集合，故无法在 skillLoader 静态注册。
   */
  private async runPipeline(
    subagent: SubagentSpec,
    pipe: PipeRegistryValue,
    target: string,
    instruction: string,
    history?: ConversationTurn[],
  ): Promise<ToolResult> {
    const subSkills = getSkills(subagent.id)
    const finalResolvedPath = `sequences/${target}.md`
    const priorFinalDraft = await safeRead(this.fileManager, finalResolvedPath)

    // 步间内存字符串传递：key=step.label（如 'prev_scenes'），value=上一步 extracted 内容
    const stepOutputs = new Map<string, string>()

    for (let i = 0; i < pipe.steps.length; i++) {
      const step = pipe.steps[i]
      const stepSkill = subSkills.find((s) => s.skillId === step.skillId)
      if (!stepSkill) {
        return {
          success: false,
          error: `[${subagent.id}] 流水线配置异常：未找到已注册的第 ${i + 1} 步 skill "${step.skillId}"`,
          skillName: subagent.name,
        }
      }

      // ① 结构化 validator 钩子按 skillId 动态挂载（v6.2）
      const structuralCheck = buildStructuralCheckForStep(
        step.skillId,
        stepOutputs.get('prev_scenes'),
      )
      // specView 承载临时 structuralCheck；writes[0] 沿用 placeholder 供 validator 记账,
      // 实际不会 writeFile（中间产物纯内存传递）
      const specView: SkillSpec = { ...stepSkill, structuralCheck }

      // ② 读 static reads
      const files: Record<string, string> = {}
      for (const p of stepSkill.reads) {
        files[p] = await safeRead(this.fileManager, p)
      }

      // ③ 拼 static ctx 再 append 前续步骤产出的 prev_<X> 标签与 current_target baseline
      let ctxFull = assembleContext(stepSkill.reads, files)
      const extras: ExtraLabelEntry[] = []
      for (const [label, content] of stepOutputs) {
        extras.push({ label, content })
      }
      if (priorFinalDraft.length > 0) {
        // v6.2 REFINE 信号：终品已存在时向每一步都附加 <current_target>=旧版，
        // 让 scene_designer 与 beat_writer 各自 SKILL body 的双模判定能一致命中 REFINE。
        extras.push({ label: 'current_target', content: priorFinalDraft })
      }
      ctxFull = appendExtraLabels(ctxFull, extras)

      // ④ sysPrompt=preamble+body
      const systemPrompt = stepSkill.preamble
        ? `${stepSkill.preamble}\n\n${stepSkill.body}`
        : stepSkill.body

      // ⑤ derivedInstruction：首步沿用 Orc 原 instruction；后续步骤注入固定推进语引导模型据上文继续
      const refsHint = Array.from(stepOutputs.keys()).map((k) => `<${k}>`).join('、')
      const derivedInstruction =
        i === 0
          ? instruction
          : `承接前一阶段产物(${refsHint}均已注入上下文)，按本技能规范完成「${stepSkill.name}」职责范围的输出。\n原始指令参考：${instruction}`

      let userContent = buildAgentPrompt(ctxFull, derivedInstruction, history)

      // ⑥ sendMessage ×≤MAX_RETRIES + validateOutput(specView)
      let lastErr = ''
      let stepContent = ''
      let ok = false
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const out = await this.llm.sendMessage(systemPrompt, userContent)
          const vr = validateOutput(out, specView)
          if (vr.valid) {
            stepContent = vr.extracted[stepSkill.writes[0]] ?? ''
            ok = true
            break
          }
          if (attempt < MAX_RETRIES - 1) {
            this.emit('tool_retry', {
              toolId: subagent.id,
              toolName: subagent.name,
              skillId: stepSkill.skillId,
              skillName: stepSkill.name,
              attempt: attempt + 1,
              maxAttempts: MAX_RETRIES,
              message: `${subagent.name}[S${i + 1}/${stepSkill.skillId}] 格式错误重试 ${attempt + 1}/${MAX_RETRIES}`,
            })
            const feedback = vr.structuralError
              ? `⚠️ 结构错误：${vr.structuralError}`
              : `⚠️ 格式错误：输出须包含 ${specView.outputTags[0]} 与 ${specView.outputTags[1]} 包裹，请严格遵循模板再次生成。`
            userContent = `${userContent}\n\n---\n${feedback}`
          }
        } catch (e) {
          lastErr = (e as Error).message
          if (attempt === MAX_RETRIES - 1) break
        }
      }

      if (!ok) {
        this.emit('tool_error', {
          toolId: subagent.id,
          toolName: subagent.name,
          skillId: stepSkill.skillId,
          skillName: stepSkill.name,
          message: `${subagent.name}[S${i + 1}/${stepSkill.skillId}] 连续 ${MAX_RETRIES} 次未合规，流水线中止`,
        })
        return {
          success: false,
          error: `序列切片流水线在第 ${i + 1} 步 (${stepSkill.skillId}) 中止：${
            lastErr || 'validateOutput 反复失败'
          }`,
          skillName: subagent.name,
        }
      }

      // ⑦ 中间产物存内存供下一步注入（不 writeFile）
      stepOutputs.set(step.label, stepContent)
    }

    // ⑧ S3 引擎代码收口：拼装两表 + 结构复核 → 落盘 sequences/<ID>.md
    const scenesMd = stepOutputs.get('prev_scenes') ?? ''
    const beatsMd = stepOutputs.get('prev_beats') ?? ''
    const finalMd = assembleSequenceOutline(target, scenesMd, beatsMd)
    await this.fileManager.writeFile(finalResolvedPath, finalMd)

    // 归属最后一步 LLM 的 skillId 供事件流展示（S3 是引擎代码不占 skill 身份）
    const lastLlmStep = pipe.steps[pipe.steps.length - 1]
    const lastStepSkill = subSkills.find((s) => s.skillId === lastLlmStep.skillId)!
    return {
      success: true,
      writes: [finalResolvedPath],
      output: '',
      skillId: lastStepSkill.skillId,
      skillName: lastStepSkill.name,
    }
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
    const availableSubagents = getAvailableSubagents()

    // ===== v6.1 Guard-1: Phase Gate 可见性过滤（FC 面）=====
    // 设计期剔除 script_writer 让其不可达避免未成熟即开写；写作期剔除全部 CREATIVE_TOOL_IDS
    // 及 story_checker 彻底断绝上游回流污染与质检回路消耗，保住 requirements_analyzer 自动化链路畅通。
    const phaseState0 = usePhaseStore.getState()
    const visibleSubagents =
      phaseState0.isWriting()
        ? availableSubagents.filter(
            (sa) => !CREATIVE_TOOL_IDS.includes(sa.id) && sa.id !== 'story_checker',
          )
        : availableSubagents.filter((sa) => sa.id !== 'script_writer')
    const toolSpecs = visibleSubagents.map(buildFunctionSpec)

    // ② 加载 System Prompt（注入工具列表）
    let systemPrompt = loadOrchestratorPrompt(toolSpecs)

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
            // executeTool 内 resolveWriteTarget / runPipeline 消费）
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
              this.emit('tool_complete', {
                toolId: subagentSpec.id,
                toolName: subagentSpec.name,
                skillId: result.skillId,
                skillName: result.skillName,
                writes: result.writes,
                message: `${subagentSpec.name} 完成`,
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
