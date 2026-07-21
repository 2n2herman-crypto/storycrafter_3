import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

export type LLMProfileKind = 'openai-compatible'

export interface LLMProfile {
  id: string
  name: string
  kind: LLMProfileKind
  baseURL: string
  apiKey: string
  model: string
  extraHeaders?: Record<string, string>
}

export interface LLMConfig {
  activeProfileId: string
  profiles: LLMProfile[]
}

/** 生成新 profile id */
export function newProfileId(): string {
  return crypto.randomUUID()
}

/** 首启动兼容：从 env VITE_DEEPSEEK_API_KEY 种入默认 profile */
function defaultConfigFromEnv(): LLMConfig | null {
  const envKey = process.env.VITE_DEEPSEEK_API_KEY
  if (!envKey) return null
  return {
    activeProfileId: 'deepseek-default',
    profiles: [
      {
        id: 'deepseek-default',
        name: 'DeepSeek',
        kind: 'openai-compatible',
        baseURL: 'https://api.deepseek.com',
        apiKey: envKey,
        model: 'deepseek-chat',
      },
    ],
  }
}

export function loadConfig(): LLMConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    const def = defaultConfigFromEnv()
    if (def) {
      saveConfig(def)
      return def
    }
    return { activeProfileId: '', profiles: [] }
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
  try {
    return JSON.parse(raw) as LLMConfig
  } catch {
    return { activeProfileId: '', profiles: [] }
  }
}

export function saveConfig(config: LLMConfig): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  try {
    fs.chmodSync(CONFIG_PATH, 0o600)
  } catch {
    // chmod 失败不阻断（Windows 无效）
  }
}

export function getActiveProfile(config: LLMConfig): LLMProfile | null {
  return config.profiles.find((p) => p.id === config.activeProfileId) ?? null
}

/** apiKey 脱敏：前4 + **** + 后4 */
export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length < 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}
