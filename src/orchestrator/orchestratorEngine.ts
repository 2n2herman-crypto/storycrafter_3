import type OpenAI from 'openai'
import type { ToolSpec, ToolResult, DispatchResult, SchedulerState, ExecutionEvent, ExecutionEventCallback } from '../types'
import { getTool, getAvailableTools, buildFunctionSpec } from './toolRegistry'
import { assembleContext, buildAgentPrompt } from './contextAssembler'
import { validateOutput } from './outputValidator'
import type { LLMClient } from '../llm/client'
import type { FileManager } from './fileManager'

type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam

// Vite glob import: 加载所有 prompt 文件
const promptModules = import.meta.glob<{ default: string }>(
  '../llm/prompts/*.md',
  { query: '?raw', eager: true },
)

// ===== 常量 =====

const MAX_ROUNDS = 10
const MAX_RETRIES = 3
const MAX_TOOLS_PER_ROUND = 5
const CONTEXT_LIMIT_CHARS = 22_000 // deepseek-v4-flash 32K 的 ~70%

/** 创作工具 ID 列表（用于后处理判断是否需要更新需求状态） */
const CREATIVE_TOOL_IDS = [
  'worldbuilding', 'characters', 'act_map', 'sequence_list',
  'scene_beats', 'foreshadowing_tracker', 'subplot_manager',
]


// ===== Prompt 加载 =====

/**
 * 加载 System Prompt 文件内容
 */
function loadSystemPrompt(filePath: string): string {
  const modulePath = `../llm/prompts/${filePath.replace('prompts/', '')}`
  const mod = promptModules[modulePath]
  if (!mod) {
    throw new Error(`System Prompt 文件未找到: ${filePath} (module path: ${modulePath})`)
  }
  return mod.default
}

/**
 * 加载并组装 Orchestrator System Prompt（注入可用工具列表）
 */
function loadOrchestratorPrompt(tools: object[]): string {
  const raw = loadSystemPrompt('prompts/orchestrator_v5.md')
  return raw.replace(
    '{available_tools_json}',
    JSON.stringify(tools, null, 2),
  )
}

// ===== Tool 执行 =====

/**
 * 判断是否为"清空操作"工具（如 reset_all）
 * 协议：writes:[] + outputTags:[] = 清空操作
 */
function isResetTool(tool: ToolSpec): boolean {
  return tool.writes.length === 0 && tool.outputTags.length === 0
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
   * 执行单个 Tool（含重试逻辑）
   */
  private async executeTool(
    tool: ToolSpec,
    instruction: string,
  ): Promise<ToolResult> {
    // reset_all 特殊处理：不调 LLM，直接清空
    if (isResetTool(tool)) {
      await this.fileManager.clearAll()
      return { success: true, writes: [], output: '已清空所有故事内容' }
    }

    // ① 读取上下文
    const files: Record<string, string> = {}
    for (const path of tool.reads) {
      try {
        files[path] = await this.fileManager.readFile(path)
      } catch {
        files[path] = ''
      }
    }

    // ② 组装上下文
    const context = assembleContext(tool, files)

    // ③ 加载 System Prompt
    let systemPrompt: string
    try {
      systemPrompt = loadSystemPrompt(tool.systemPromptFile)
    } catch (e) {
      return { success: false, error: `加载 System Prompt 失败: ${(e as Error).message}` }
    }

    // ④ 组装完整 Prompt
    let userContent = buildAgentPrompt(context, instruction)

    // ⑤ 调用 LLM + 校验（最多 3 次重试）
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const output = await this.llm.sendMessage(systemPrompt, userContent)
        const validation = validateOutput(output, tool)

        if (validation.valid) {
          for (const [file, content] of Object.entries(validation.extracted)) {
            await this.fileManager.writeFile(file, content)
          }
          return {
            success: true,
            writes: Object.keys(validation.extracted),
            output: output,
          }
        }

        // 校验失败：追加格式提示后重试
        if (attempt < MAX_RETRIES - 1) {
          this.emit('tool_retry', {
            toolId: tool.id,
            toolName: tool.name,
            attempt: attempt + 1,
            maxAttempts: MAX_RETRIES,
            message: `${tool.name} 格式错误，重试 ${attempt + 1}/${MAX_RETRIES}`,
          })
          userContent = `${userContent}\n\n---\n⚠️ 格式错误：输出必须包含正确的 ${tool.outputTags[0]} 和 ${tool.outputTags[1]} 包裹。请严格遵循模板格式重新输出完整内容。`
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
   * @returns DispatchResult
   */
  async processUserInput(userInput: string, onEvent?: ExecutionEventCallback): Promise<DispatchResult> {
    // ① 计算可用工具（v5：全部工具始终可见）
    this.onEvent = onEvent
    const availableTools = getAvailableTools()
    const toolSpecs = availableTools.map(buildFunctionSpec)

    // ② 加载 System Prompt（注入工具列表）
    let systemPrompt = loadOrchestratorPrompt(toolSpecs)

    // ③ 初始化消息列表
    const messages: ChatCompletionMessageParam[] = [
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

          // 后处理：如果有创作工具被执行，自动更新 user_requirements.md 的状态标记
          if (state.toolsCalled.some(id => CREATIVE_TOOL_IDS.includes(id))) {
            const reqTool = getTool('user_requirements_analyzer')
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

          // 串行执行每个 Tool
          for (const toolCall of callsToProcess) {
            const toolId = toolCall.function.name
            const toolSpec = getTool(toolId)

            if (!toolSpec) {
              // 未知工具 → 返回错误
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

            // 执行 Tool
            this.emit('tool_start', {
              toolId: toolSpec.id,
              toolName: toolSpec.name,
              round: state.currentRound + 1,
              maxRounds: state.maxRounds,
              message: `调用：${toolSpec.name}`,
            })

            const result = await this.executeTool(toolSpec, instruction)
            state.toolResults.push(result)
            state.toolsCalled.push(toolSpec.id)

            if (result.success) {
              this.emit('tool_complete', {
                toolId: toolSpec.id,
                toolName: toolSpec.name,
                message: `${toolSpec.name} 完成`,
              })
            } else {
              this.emit('tool_error', {
                toolId: toolSpec.id,
                toolName: toolSpec.name,
                message: `${toolSpec.name} 失败`,
              })
            }

            // 将 tool 结果加入消息历史
            // story_checker 注入完整报告，其余工具返回简短消息
            if (toolSpec.id === 'story_checker' && result.success) {
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
                  ? `已成功执行 ${toolSpec.name}，输出已保存。`
                  : `${toolSpec.name} 执行失败: ${result.error || '未知错误'}`,
              } as ChatCompletionMessageParam)
            }
          }

          // v5：不再重算可用工具（所有工具始终可见）

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

    // 后处理：如果有创作工具被执行，自动更新 user_requirements.md 的状态标记
    if (state.toolsCalled.some(id => CREATIVE_TOOL_IDS.includes(id))) {
      const reqTool = getTool('user_requirements_analyzer')
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
