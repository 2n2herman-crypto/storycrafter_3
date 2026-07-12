import { loadConfig, getActiveProfile, type LLMProfile } from './configStore.js'

export interface ChatRequestBody {
  messages: unknown[]
  tools?: unknown[]
  tool_choice?: string
  temperature?: number
  max_tokens?: number
  profileId?: string
}

/** 后端代理统一错误，携带 kind/status 供路由层格式化 */
export class ProxyError extends Error {
  kind: string
  status: number
  detail?: string
  constructor(kind: string, message: string, status: number, detail?: string) {
    super(message)
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}

function classifyUpstream(status: number): string {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  return 'upstream'
}

function resolveProfile(profileId?: string): LLMProfile {
  const config = loadConfig()
  const profile = profileId
    ? config.profiles.find((p) => p.id === profileId) ?? null
    : getActiveProfile(config)
  if (!profile) {
    throw new ProxyError('config', '未配置 LLM provider，请先在 Settings 添加并激活', 400)
  }
  if (!profile.apiKey) {
    throw new ProxyError('config', `profile "${profile.name}" 未设置 apiKey`, 400)
  }
  return profile
}

/** 透传 chat.completions 到上游厂商（OpenAI 兼容） */
export async function proxyChat(body: ChatRequestBody): Promise<unknown> {
  const profile = resolveProfile(body.profileId)

  // 无脑用 profile.model 覆盖，防 model 字段污染导致费用错乱
  const upstreamBody: Record<string, unknown> = {
    model: profile.model,
    messages: body.messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 8192,
  }
  if (body.tools && body.tools.length > 0) {
    upstreamBody.tools = body.tools
    upstreamBody.tool_choice = body.tool_choice ?? 'auto'
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${profile.apiKey}`,
  }
  if (profile.extraHeaders) {
    Object.assign(headers, profile.extraHeaders)
  }

  let res: Response
  try {
    res = await fetch(`${profile.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    })
  } catch (e) {
    throw new ProxyError(
      'network',
      '无法连接到 LLM 上游',
      502,
      e instanceof Error ? e.message : String(e),
    )
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProxyError(
      classifyUpstream(res.status),
      `上游返回 ${res.status}`,
      502,
      text.slice(0, 500),
    )
  }

  return res.json()
}

/** 探活：发一次 minimal chat 请求 */
export async function testProfile(
  profileId: string,
): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
  const config = loadConfig()
  const profile = config.profiles.find((p) => p.id === profileId)
  if (!profile) {
    throw new ProxyError('not_found', 'profile 不存在', 404)
  }
  const start = Date.now()
  try {
    const res = await fetch(`${profile.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, latencyMs, model: profile.model, error: `${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true, latencyMs, model: profile.model }
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      model: profile.model,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
