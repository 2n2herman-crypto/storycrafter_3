/** 统一后端调用封装：fetch + 错误 parse（CLAUDE.md 强制：所有后端调用经此层） */

export interface ApiError {
  kind: string
  message: string
  detail?: string
}

/** 带 kind 的请求错误，供 classifyLLMError / UI 识别 */
export class ApiRequestError extends Error {
  kind: string
  detail?: string
  constructor(err: ApiError) {
    super(err.message)
    this.name = 'ApiRequestError'
    this.kind = err.kind
    this.detail = err.detail
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let body: { error?: ApiError } = {}
    try {
      body = (await res.json()) as { error?: ApiError }
    } catch {
      // 非 JSON 错误体，回退到 HTTP 状态
    }
    const err = body.error ?? { kind: 'network', message: `HTTP ${res.status}` }
    throw new ApiRequestError(err)
  }
  return res.json() as Promise<T>
}
