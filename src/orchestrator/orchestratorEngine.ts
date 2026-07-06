import type OpenAI from 'openai'
import type { SubagentSpec, SkillSpec, ToolResult, DispatchResult, SchedulerState, ExecutionEvent, ExecutionEventCallback, ConversationTurn } from '../types'
import { getSubagent, getAvailableSubagents, buildFunctionSpec } from '../skills/skillLoader'
import { selectSkill } from './skillRouter'
import { assembleContext, buildAgentPrompt } from './contextAssembler'
import { validateOutput } from './outputValidator'
import type { LLMClient } from '../llm/client'
import type { FileManager } from './fileManager'
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
   * 执行单个 Subagent（四层框架：Subagent → Skill Router → Skill，含重试逻辑）
   *
   * @param history - 可选：最近若干轮对话（v5.5，供需求整理者解析指代）
   */
  private async executeTool(
    subagent: SubagentSpec,
    instruction: string,
    history?: ConversationTurn[],
  ): Promise<ToolResult> {
    // ① Skill Router：在该 Subagent 名下选出最合适的 Skill
    //    单 Skill 时零成本直选、不调 LLM（本轮所有 Subagent 都是单 Skill）
    const skill = selectSkill(subagent.id, instruction)

    // reset_all 特殊处理：空 writes + 空 outputTags = 不调 LLM，直接清空
    if (isResetSkill(skill)) {
      await this.fileManager.clearAll()
      return {
        success: true,
        writes: [],
        output: '已清空所有故事内容',
        skillId: skill.skillId,
        skillName: skill.name,
      }
    }

    // ② 读取上下文（按 Skill.reads）
    const files: Record<string, string> = {}
    for (const path of skill.reads) {
      try {
        files[path] = await this.fileManager.readFile(path)
      } catch {
        files[path] = ''
      }
    }

    // ③ 组装上下文
    const context = assembleContext(skill.reads, files)

    // ④ 组装 System Prompt：Subagent 角色前缀 + Skill 正文
    const systemPrompt = skill.preamble
      ? `${skill.preamble}\n\n${skill.body}`
      : skill.body

    // ⑤ 组装完整 Prompt（v5.5：注入对话历史，供解析指代）
    let userContent = buildAgentPrompt(context, instruction, history)

    // ⑥ 调用 LLM + 校验（最多 3 次重试）
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const output = await this.llm.sendMessage(systemPrompt, userContent)
        const validation = validateOutput(output, skill)

        if (validation.valid) {
          for (const [file, content] of Object.entries(validation.extracted)) {
            await this.fileManager.writeFile(file, content)
          }
          return {
            success: true,
            writes: Object.keys(validation.extracted),
            output: output,
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
          userContent = `${userContent}\n\n---\n⚠️ 格式错误：输出必须包含正确的 ${skill.outputTags[0]} 和 ${skill.outputTags[1]} 包裹。请严格遵循模板格式重新输出完整内容。`
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
    const toolSpecs = availableSubagents.map(buildFunctionSpec)

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

            // 解析 instruction 参数
            let instruction = ''
            try {
              const args = JSON.parse(toolCall.function.arguments)
              instruction = args.instruction || ''
            } catch {
              instruction = toolCall.function.arguments || ''
            }

            // 执行 Subagent
            this.emit('tool_start', {
              toolId: subagentSpec.id,
              toolName: subagentSpec.name,
              round: state.currentRound + 1,
              maxRounds: state.maxRounds,
              message: `调用：${subagentSpec.name}`,
            })

            const result = await this.executeTool(subagentSpec, instruction)
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
