import { apiFetch } from './client'

export interface ChatRequestBody {
  messages: unknown[]
  tools?: unknown[]
  tool_choice?: string
  temperature?: number
  max_tokens?: number
  profileId?: string
}

/** 上游 OpenAI 兼容 chat.completions 响应（仅声明用到的字段） */
export interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role: string
      content: string | null
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }
    finish_reason?: string | null
  }>
}

export function chat(req: ChatRequestBody): Promise<ChatCompletionResponse> {
  return apiFetch<ChatCompletionResponse>('/api/llm/chat', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export interface TestResult {
  ok: boolean
  latencyMs: number
  model: string
  error?: string
}

export function testProfile(profileId: string): Promise<TestResult> {
  return apiFetch<TestResult>('/api/llm/test', {
    method: 'POST',
    body: JSON.stringify({ profileId }),
  })
}
