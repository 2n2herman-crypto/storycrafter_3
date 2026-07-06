import OpenAI from 'openai'

type ChatCompletionMessage = OpenAI.Chat.Completions.ChatCompletionMessage
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

export interface LLMResponse {
  message: ChatCompletionMessage
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
}

/**
 * DeepSeek API 封装（OpenAI 兼容接口）
 *
 * - baseURL: https://api.deepseek.com
 * - 模型: deepseek-v4-flash
 * - API Key 从环境变量 VITE_DEEPSEEK_API_KEY 读取
 *
 * v4 新增：sendMessageWithTools — Function Calling 支持
 */
export class LLMClient {
  private client: OpenAI

  constructor() {
    const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY
    if (!apiKey) {
      console.warn(
        '[LLMClient] VITE_DEEPSEEK_API_KEY 未设置。' +
        '请创建 .env.local 文件并添加：VITE_DEEPSEEK_API_KEY=your_key_here'
      )
    }

    this.client = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: apiKey || 'sk-placeholder',
      dangerouslyAllowBrowser: true,
      maxRetries: 3,
    })
  }

  /**
   * 基础消息发送（供 Subagent 内部使用）
   */
  async sendMessage(systemPrompt: string, userContent: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
      max_tokens: 8192,
    })

    const content = response.choices[0]?.message?.content
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
    const response = await this.client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.7,
      max_tokens: options?.maxTokens ?? 8192,
    })

    const choice = response.choices[0]
    const message = choice?.message
    const finish_reason = choice?.finish_reason ?? null

    if (!message) {
      throw new Error('LLM 返回消息为空')
    }

    return {
      message,
      finish_reason: finish_reason as LLMResponse['finish_reason'],
    }
  }
}
