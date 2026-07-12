import { Router } from 'express'
import {
  loadConfig,
  saveConfig,
  maskApiKey,
  newProfileId,
  type LLMConfig,
  type LLMProfile,
} from '../services/configStore.js'

export const configRouter = Router()

/** 返回脱敏配置（apiKey mask）给前端 */
function maskConfig(config: LLMConfig): LLMConfig {
  return {
    activeProfileId: config.activeProfileId,
    profiles: config.profiles.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })),
  }
}

configRouter.get('/', (_req, res) => {
  res.json(maskConfig(loadConfig()))
})

configRouter.put('/', (req, res) => {
  const incoming = req.body as Partial<LLMConfig> & {
    profiles?: Partial<LLMProfile>[]
  }
  const current = loadConfig()

  const profiles: LLMProfile[] = (incoming.profiles ?? []).map((p) => {
    const old = current.profiles.find((o) => o.id === p.id)
    return {
      id: p.id ?? old?.id ?? newProfileId(),
      name: p.name ?? old?.name ?? '',
      kind: p.kind ?? old?.kind ?? 'openai-compatible',
      baseURL: p.baseURL ?? old?.baseURL ?? '',
      // apiKey 传 null/undefined 表示保持原值；传字符串则覆盖
      apiKey:
        p.apiKey === null || p.apiKey === undefined
          ? (old?.apiKey ?? '')
          : p.apiKey,
      model: p.model ?? old?.model ?? '',
      extraHeaders: p.extraHeaders ?? old?.extraHeaders,
    }
  })

  const next: LLMConfig = {
    activeProfileId: incoming.activeProfileId ?? current.activeProfileId,
    profiles,
  }

  saveConfig(next)
  res.json(maskConfig(next))
})
