import type OpenAI from 'openai'
import { chat } from '../api/llm'

type ChatCompletionMessage = OpenAI.Chat.Completions.ChatCompletionMessage
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

export interface LLMResponse {
  message: ChatCompletionMessage
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
}

/**
 * LLM 客户端（v7.1 起改为打自家后端 /api/llm/chat）
 *
 * - key 移至后端 config.json，浏览器不暴露（摘除 dangerouslyAllowBrowser）
 * - 对外签名与 v6.9 逐字一致（sendMessage / sendMessageWithTools），OrchestratorEngine 零改
 * - 仅保留 openai 包作类型来源（ChatCompletionMessage 等 DTO），不再 new OpenAI()
 */
export class LLMClient {
  /**
   * 基础消息发送（供 Subagent 内部使用）
   */
  async sendMessage(systemPrompt: string, userContent: string): Promise<string> {
    const result = await chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
      max_tokens: 8192,
    })

    const content = result.choices?.[0]?.message?.content
    if (content === null || content === undefined) {
      throw new Error('LLM 返回内容为空')
    }
    return content
  }

  /**
   * Function Calling 消息发送（Orchestrator 使用）
   *
   * 支持 tool_choice='auto'，返回包含 tool_calls 的完整响应。
   */
  async sendMessageWithTools(
    systemPrompt: string,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    options?: { maxTokens?: number },
  ): Promise<LLMResponse> {
    const result = await chat({
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.7,
      max_tokens: options?.maxTokens ?? 8192,
    })

    const choice = result.choices?.[0]
    const message = choice?.message
    const finish_reason = choice?.finish_reason ?? null

    if (!message) {
      throw new Error('LLM 返回消息为空')
    }

    return {
      message: message as ChatCompletionMessage,
      finish_reason: finish_reason as LLMResponse['finish_reason'],
    }
  }
}
