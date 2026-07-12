import { apiFetch } from './client'

export type LLMProfileKind = 'openai-compatible'

export interface LLMProfile {
  id: string
  name: string
  kind: LLMProfileKind
  baseURL: string
  /** GET 返回脱敏；PUT 传 null/undefined 保持原值，传字符串覆盖 */
  apiKey: string
  model: string
  extraHeaders?: Record<string, string>
}

export interface LLMConfig {
  activeProfileId: string
  profiles: LLMProfile[]
}

export function getConfig(): Promise<LLMConfig> {
  return apiFetch<LLMConfig>('/api/config')
}

export function putConfig(
  config: Partial<Omit<LLMConfig, 'profiles'>> & { profiles?: Partial<LLMProfile>[] },
): Promise<LLMConfig> {
  return apiFetch<LLMConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}
