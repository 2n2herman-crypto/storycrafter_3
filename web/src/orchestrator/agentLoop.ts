/**
 * agentLoop.ts — 通用 FC 循环函数（v7.3 新增）
 *
 * 抽出 processUserInput 主循环和 3 个宽泛 subagent 都需要的能力：
 * "反复调 sendMessageWithTools 直到无 tool_call"。
 *
 * 主 Orchestrator 循环和宽泛 subagent 专属循环共用同一份骨架，
 * 差异部分（工具执行细节、压缩策略）通过回调参数传入。
 */

import type OpenAI from 'openai'
import type { LLMClient } from '../llm/client'

type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

/** OpenAI tool_call 结构（类型来源同 LLMClient） */
interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// ===== 接口定义 =====

export interface AgentLoopOptions {
  /** system prompt（在首条消息前注入） */
  systemPrompt: string
  /** 初始 messages 数组（宽泛 subagent 传新建空数组+首条 user；主循环传已有历史） */
  initialMessages: ChatCompletionMessageParam[]
  /** 本轮可用的工具列表 */
  tools: ChatCompletionTool[]
  /**
   * 工具调用执行回调。
   * 调用方负责解析 toolCall、执行具体操作（读文件/调 Subagent/读 reference），
   * 返回 tool result 内容的字符串。
   */
  executeToolCall: (toolCall: ToolCall) => Promise<string>
  /** 最大轮次（安全阀，防死循环） */
  maxRounds: number
  /**
   * 可选：每轮开始前的钩子。
   * 调用方可在回调内对 messages 做压缩/裁剪等操作（主循环用它做 compressMessages）。
   */
  beforeRound?: (messages: ChatCompletionMessageParam[], round: number) => void
  /**
   * 可选：每轮结束后的回调（供事件 emit / 日志记录）。
   */
  onRound?: (round: number, messages: ChatCompletionMessageParam[]) => void
  /** 可选：一次 LLM 调用的 max_tokens 上限 */
  maxTokens?: number
}

export interface AgentLoopResult {
  /** 最终无 tool_call 时的文本；达到 maxRounds 仍在 tool_calls 则为 null */
  finalText: string | null
  /** 完整循环历史（供持久化存档或调试） */
  messages: ChatCompletionMessageParam[]
  /** 实际消耗的轮次 */
  roundsUsed: number
}

// ===== 主函数 =====

export async function runAgentLoop(
  llm: LLMClient,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    initialMessages,
    tools,
    executeToolCall,
    maxRounds,
    beforeRound,
    onRound,
    maxTokens,
  } = options

  // 使用传入的 messages 数组的副本，避免调用方的数组被意外修改
  const messages = [...initialMessages]

  for (let round = 0; round < maxRounds; round++) {
    // 每轮开始前的钩子（如压缩检查）
    beforeRound?.(messages, round)

    const response = await llm.sendMessageWithTools(systemPrompt, messages, tools, {
      maxTokens,
    })

    const { message, finish_reason } = response

    switch (finish_reason) {
      case 'stop': {
        // LLM 不再调工具 → 返回最终文本
        const content = message.content ?? null
        messages.push(message as unknown as ChatCompletionMessageParam)
        onRound?.(round, messages)
        return {
          finalText: content,
          messages,
          roundsUsed: round + 1,
        }
      }

      case 'tool_calls': {
        const toolCalls = message.tool_calls
        if (!toolCalls || toolCalls.length === 0) {
          // 没有 tool_calls 但 finish_reason 是 tool_calls → 异常，继续下一轮
          messages.push(message as unknown as ChatCompletionMessageParam)
          onRound?.(round, messages)
          continue
        }

        // 将 assistant 消息（含 tool_calls）加入历史
        messages.push(message as unknown as ChatCompletionMessageParam)

        // 串行执行每个 tool call
        for (const tc of toolCalls) {
          const toolCall = tc as unknown as ToolCall
          let toolResult: string
          try {
            toolResult = await executeToolCall(toolCall)
          } catch (e) {
            toolResult = JSON.stringify({
              success: false,
              error: `工具 ${toolCall.function.name} 执行失败: ${(e as Error).message}`,
            })
          }

          // 将 tool 结果加入消息历史
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          } as ChatCompletionMessageParam)
        }

        onRound?.(round, messages)
        // 继续下一轮（LLM 可能会继续调工具，或 stop 产出最终文本）
        continue
      }

      case 'length':
        // 响应过长截断 → 返回已有消息历史，finalText 为 null
        onRound?.(round, messages)
        return {
          finalText: null,
          messages,
          roundsUsed: round + 1,
        }

      case 'content_filter':
        // 被安全过滤 → 同上
        onRound?.(round, messages)
        return {
          finalText: null,
          messages,
          roundsUsed: round + 1,
        }

      default:
        // 未知 finish_reason → 继续下一轮
        onRound?.(round, messages)
        continue
    }
  }

  // 达到 maxRounds 仍未产出最终文本
  return {
    finalText: null,
    messages,
    roundsUsed: maxRounds,
  }
}

/** 宽泛 subagent 内部循环轮次上限（v7.3 经验值，开发方案第2.4节） */
export const SUBAGENT_LOOP_MAX_ROUNDS = 8

