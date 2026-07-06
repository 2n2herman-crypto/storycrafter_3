import type { SubagentSpec, SkillSpec } from '../types'
import type OpenAI from 'openai'

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

/**
 * SkillLoader — 四层框架的加载与注册中枢（v5.3）
 *
 * Orchestrator → Subagent → Skill Router → Skill
 *
 * 磁盘约定（热插拔）：
 *   src/skills/<subagentId>/subagent.md          — Subagent manifest（frontmatter + 角色前缀）
 *   src/skills/<subagentId>/<skillId>/SKILL.md    — Skill manifest（frontmatter + system prompt）
 *
 * 归属由目录路径决定：把一个 SKILL.md 文件夹放进 src/skills/<subagentId>/
 * 即"划入该 Subagent 的可用范围"。Skill 自身不声明属主 Subagent（硬约束）。
 *
 * 注意：import.meta.glob 在构建/dev-reload 期解析，非浏览器运行期文件系统。
 * "热插拔" = 新增文件夹后下次 dev 热重载/重新构建时自动注册，无需改引擎代码。
 */

// ===== Frontmatter 解析（自研零依赖，仅支持扁平标量 + 内联数组） =====

interface Frontmatter {
  data: Record<string, string | string[]>
  body: string
}

/**
 * 解析 `---\n...\n---\n<body>` 结构。
 * 支持：`key: scalar` / `key: "quoted"` / `key: [a, b]` / `key: ['q', 'q']`。
 * 不支持块标量与嵌套；数组项按不透明字符串处理（不解释 `>` 等字符）。
 */
function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^﻿/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) {
    return { data: {}, body: text.trim() }
  }

  const [, front, body] = match
  const data: Record<string, string | string[]> = {}

  for (const rawLine of front.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    const sep = line.indexOf(':')
    if (sep === -1) continue

    const key = line.slice(0, sep).trim()
    const rawValue = line.slice(sep + 1).trim()
    if (!key) continue

    data[key] = parseValue(rawValue)
  }

  return { data, body: body.trim() }
}

/** 解析单个 frontmatter 值：内联数组 → string[]，其余 → 去引号 string。 */
function parseValue(raw: string): string | string[] {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return splitArrayItems(inner).map(unquote)
  }
  return unquote(raw)
}

/** 按顶层逗号切分内联数组项，尊重引号内的逗号。 */
function splitArrayItems(inner: string): string[] {
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ',') {
      items.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) items.push(current.trim())
  return items
}

/** 去掉成对的首尾引号。 */
function unquote(value: string): string {
  const v = value.trim()
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1)
  }
  return v
}

function asString(value: string | string[] | undefined, fallback = ''): string {
  if (Array.isArray(value)) return value.join(', ')
  return value ?? fallback
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

// ===== Glob 发现 =====

// Subagent manifest：src/skills/<subagentId>/subagent.md
const subagentModules = import.meta.glob<{ default: string }>(
  './*/subagent.md',
  { query: '?raw', eager: true },
)

// Skill manifest：src/skills/<subagentId>/<skillId>/SKILL.md
const skillModules = import.meta.glob<{ default: string }>(
  './*/*/SKILL.md',
  { query: '?raw', eager: true },
)

/** 禁止 Skill frontmatter 声明属主（硬约束：Skill 不决定自己属于哪个 agent）。 */
const FORBIDDEN_SKILL_KEYS = ['subagent', 'owner', 'agent']

// ===== 构建注册表 =====

function buildRegistries(): {
  subagents: SubagentSpec[]
  skillsBySubagent: Map<string, SkillSpec[]>
} {
  const subagents: SubagentSpec[] = []
  const preambles = new Map<string, string>()

  // ① 加载 Subagent manifest（路径 ./<id>/subagent.md）
  for (const [path, mod] of Object.entries(subagentModules)) {
    const segs = path.split('/')
    const dirId = segs[segs.length - 2]
    const { data, body } = parseFrontmatter(mod.default)

    const id = asString(data.id) || dirId
    if (id !== dirId) {
      throw new Error(
        `[skillLoader] Subagent id "${id}" 与目录名 "${dirId}" 不一致（${path}）`,
      )
    }

    const spec: SubagentSpec = {
      id,
      name: asString(data.name, id),
      description: asString(data.description),
      group: asString(data.group),
      preamble: body,
    }
    subagents.push(spec)
    preambles.set(id, body)
  }

  // ② 加载 Skill manifest（路径 ./<subagentId>/<skillId>/SKILL.md）
  const skillsBySubagent = new Map<string, SkillSpec[]>()
  for (const [path, mod] of Object.entries(skillModules)) {
    const segs = path.split('/')
    const skillId = segs[segs.length - 2]
    const subagentId = segs[segs.length - 3]

    const { data, body } = parseFrontmatter(mod.default)

    for (const forbidden of FORBIDDEN_SKILL_KEYS) {
      if (forbidden in data) {
        throw new Error(
          `[skillLoader] Skill "${subagentId}/${skillId}" 不得声明属主键 "${forbidden}"` +
          `（归属由目录决定，见 ${path}）`,
        )
      }
    }

    const skill: SkillSpec = {
      subagentId,
      skillId,
      name: asString(data.name, skillId),
      description: asString(data.description),
      when: asArray(data.when),
      reads: asArray(data.reads),
      writes: asArray(data.writes),
      outputTags: asArray(data.outputTags),
      preamble: preambles.get(subagentId) ?? '',
      body,
    }

    const list = skillsBySubagent.get(subagentId) ?? []
    list.push(skill)
    skillsBySubagent.set(subagentId, list)
  }

  // ③ 校验：每个 Subagent 至少 1 个 Skill；每个 Skill 目录有对应 Subagent
  for (const sa of subagents) {
    const skills = skillsBySubagent.get(sa.id)
    if (!skills || skills.length === 0) {
      throw new Error(`[skillLoader] Subagent "${sa.id}" 没有任何 Skill（至少需 1 个）`)
    }
  }
  for (const subagentId of skillsBySubagent.keys()) {
    if (!subagents.some((s) => s.id === subagentId)) {
      throw new Error(
        `[skillLoader] Skill 目录 "${subagentId}" 缺少对应的 subagent.md manifest`,
      )
    }
  }

  return { subagents, skillsBySubagent }
}

const { subagents: SUBAGENT_REGISTRY, skillsBySubagent: SKILLS_BY_SUBAGENT } =
  buildRegistries()

export { SUBAGENT_REGISTRY, SKILLS_BY_SUBAGENT }

// ===== 查询函数 =====

/** 获取指定 Subagent 的配置 */
export function getSubagent(id: string): SubagentSpec | undefined {
  return SUBAGENT_REGISTRY.find((s) => s.id === id)
}

/**
 * 获取所有可用的 Subagent（v5：全部始终对 Orchestrator 可见）
 *
 * 结构感由每个 Subagent/Skill 的 prompt 定义其层级位置 + reads 空标签机制维持。
 */
export function getAvailableSubagents(): SubagentSpec[] {
  return SUBAGENT_REGISTRY
}

/** 获取指定 Subagent 名下的全部 Skill */
export function getSkills(subagentId: string): SkillSpec[] {
  return SKILLS_BY_SUBAGENT.get(subagentId) ?? []
}

/**
 * 从 SubagentSpec 构建 OpenAI 兼容的 Function Calling 参数
 * 仅暴露 id + description，与 v5 行为一致（保证 FC 面不变）。
 */
export function buildFunctionSpec(subagent: SubagentSpec): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: subagent.id,
      description: subagent.description,
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: `传递给 ${subagent.name} 的具体修改指令。从用户原始需求中提取与此工具相关的部分，去掉无关内容。`,
          },
        },
        required: ['instruction'],
      },
    },
  }
}
