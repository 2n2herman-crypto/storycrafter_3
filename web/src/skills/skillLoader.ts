import type { SubagentSpec, SkillSpec } from '../types'
import { WRITER_IDS } from '../types/product'
import type OpenAI from 'openai'
import { fetchSkills } from '../api/skills'

type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool

/**
 * SkillLoader — 四层框架的加载与注册中枢（v5.3）
 *
 * Orchestrator → Subagent → Skill
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

// v7.3：references 目录扫描（供 read_reference 工具查找）
const referenceModules = import.meta.glob<{ default: string }>(
  './*/*/references/*.md',
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
      skills: asArray(data.skills),
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
      references: [], // 先占位，step③会填充
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

  // ④ v7.3：解析 references 文件，按 subagentId+skillId 归类，填充 SkillSpec.references
  for (const [path] of Object.entries(referenceModules)) {
    const segs = path.split('/')
    // 路径：./<subagentId>/<skillId>/references/<name>.md
    const name = segs[segs.length - 1].replace(/\.md$/, '')
    const skillId = segs[segs.length - 3]
    const subagentId = segs[segs.length - 4]

    const skills = skillsBySubagent.get(subagentId)
    if (!skills) continue
    const skill = skills.find((s) => s.skillId === skillId)
    if (!skill) continue
    skill.references = [...(skill.references ?? []), name]
  }

  return { subagents, skillsBySubagent }
}

const builtIn = buildRegistries()

// ===== v7.3 References 内容查表（供独立 subagent 的 read_reference 查找） =====

function buildReferenceContents(
  refModules: Record<string, { default: string }>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const [path, mod] of Object.entries(refModules)) {
    const segs = path.split('/')
    // 路径：./<subagentId>/<skillId>/references/<name>.md
    const name = segs[segs.length - 1].replace(/\.md$/, '')
    const skillId = segs[segs.length - 3]
    const subagentId = segs[segs.length - 4]
    const key = `${subagentId}/${skillId}/${name}`
    map.set(key, mod.default)
  }
  return map
}

/** v7.3：references 文件内容查表，key = `${subagentId}/${skillId}/${name}`，value = 文件正文 */
export const REFERENCE_CONTENTS: Map<string, string> = buildReferenceContents(referenceModules)

// v7.1 M5：可变 registry——boot 时 loadUserSkills() 把 server/data/skills/ 用户源 overlay 到内置源。
// export let 提供 live binding：重新赋值后引用方（assetStore/skillResolver/orchestratorEngine）拿到新值。
export let SUBAGENT_REGISTRY: SubagentSpec[] = builtIn.subagents
export let SKILLS_BY_SUBAGENT: Map<string, SkillSpec[]> = builtIn.skillsBySubagent

/**
 * v7.1 M5：拉取后端用户源 Skill（server/data/skills/），用现有 parseFrontmatter 解析后 overlay 到 registry。
 * - 用户源 subagent.md 覆盖内置同 id（或新增）
 * - 用户源 SKILL.md 覆盖内置同 subagentId/skillId（或新增）
 * - 坏文件/属主键违规 skip + console.warn，不级联失败
 * - 后端不可用（降级模式）仅保留内置源
 */
export async function loadUserSkills(): Promise<void> {
  let data
  try {
    data = await fetchSkills()
  } catch (e) {
    console.warn('[skillLoader] 拉取用户 Skill 失败，仅使用内置源', e)
    return
  }

  // ① 解析用户源 Subagent
  const userSubagents = new Map<string, SubagentSpec>()
  for (const f of data.subagents) {
    try {
      const { data: fm, body } = parseFrontmatter(f.raw)
      const id = asString(fm.id) || f.subagentId
      if (id !== f.subagentId) {
        console.warn(`[skillLoader] 用户 Subagent id "${id}" 与目录名 "${f.subagentId}" 不一致，跳过`)
        continue
      }
      userSubagents.set(id, {
        id,
        name: asString(fm.name, id),
        description: asString(fm.description),
        group: asString(fm.group),
        preamble: body,
        source: 'user',
      })
    } catch (e) {
      console.warn(`[skillLoader] 用户 Subagent ${f.subagentId} 解析失败`, e)
    }
  }

  // ② 解析用户源 Skill
  const userSkillsBySubagent = new Map<string, SkillSpec[]>()
  for (const f of data.skills) {
    try {
      const { data: fm, body } = parseFrontmatter(f.raw)
      let skip = false
      for (const forbidden of FORBIDDEN_SKILL_KEYS) {
        if (forbidden in fm) {
          console.warn(`[skillLoader] 用户 Skill ${f.subagentId}/${f.skillId} 声明属主键 "${forbidden}"，跳过`)
          skip = true
          break
        }
      }
      if (skip) continue

      // preamble：优先用户源 subagent，回退内置 subagent，再回退空
      const preamble =
        userSubagents.get(f.subagentId)?.preamble ??
        builtIn.subagents.find((s) => s.id === f.subagentId)?.preamble ??
        ''

      const skill: SkillSpec = {
        subagentId: f.subagentId,
        skillId: f.skillId,
        name: asString(fm.name, f.skillId),
        description: asString(fm.description),
        when: asArray(fm.when),
        reads: asArray(fm.reads),
        writes: asArray(fm.writes),
        outputTags: asArray(fm.outputTags),
        preamble,
        body,
        source: 'user',
      }
      const list = userSkillsBySubagent.get(f.subagentId) ?? []
      list.push(skill)
      userSkillsBySubagent.set(f.subagentId, list)
    } catch (e) {
      console.warn(`[skillLoader] 用户 Skill ${f.subagentId}/${f.skillId} 解析失败`, e)
    }
  }

  // ③ overlay：merge 用户源到内置（同 id 覆盖，否则新增）
  const mergedSubagents = [...builtIn.subagents]
  for (const [id, spec] of userSubagents) {
    const idx = mergedSubagents.findIndex((s) => s.id === id)
    if (idx >= 0) mergedSubagents[idx] = spec
    else mergedSubagents.push(spec)
  }
  const mergedSkills = new Map(builtIn.skillsBySubagent)
  for (const [subId, skills] of userSkillsBySubagent) {
    const existing = mergedSkills.get(subId) ?? []
    const merged = [...existing]
    for (const skill of skills) {
      const idx = merged.findIndex((s) => s.skillId === skill.skillId)
      if (idx >= 0) merged[idx] = skill
      else merged.push(skill)
    }
    mergedSkills.set(subId, merged)
  }

  SUBAGENT_REGISTRY = mergedSubagents
  SKILLS_BY_SUBAGENT = mergedSkills
}

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

// v6.6：sequence_builder 用 target_sequence；统一写作 agent 用 target_chapter（白名单由 WRITER_IDS 派生）
const NEEDS_TARGET_PARAM = new Set<string>(['sequence_builder', ...WRITER_IDS])

function resolveTargetParamName(
  subagentId: string,
): 'target_sequence' | 'target_chapter' | null {
  if (!NEEDS_TARGET_PARAM.has(subagentId)) return null
  return WRITER_IDS.includes(subagentId) ? 'target_chapter' : 'target_sequence'
}

/**
 * 从 SubagentSpec 构建 OpenAI 兼容的 Function Calling 参数
 * 仅暴露 id + description，与 v5 行为一致保证 FC 面 stable。
 *
 * sequence_builder / 统一写作 agent 额外附非必填 target_sequence / target_chapter 参数，
 * 引擎 executeTool.resolveWriteTarget 据此构造 effectiveWrites 替换 frontmatter writes placeholder。
 * 格式合法性由 engine dispatch 时硬校验早退拒绝；此处仅在 description 给示例提示引导模型填合规值。
 */
export function buildFunctionSpec(subagent: SubagentSpec): ChatCompletionTool {
  const paramName = resolveTargetParamName(subagent.id)
  const properties: Record<string, { type: string; description: string }> = {
    instruction: {
      type: 'string',
      description: `传递给 ${subagent.name} 的具体修改指令。从用户原始需求中提取与此工具相关的部分，去掉无关内容。`,
    },
  }

  if (paramName !== null) {
    const isChapter = paramName === 'target_chapter'
    if (isChapter) {
      // v6.9：target_chapter 改可选——留空=全量并发批量，填=精修单序列。
      properties[paramName] = {
        type: 'string',
        description:
          '**可选**。留空=引擎读序列清单并发批量写作**全部序列**(一次 tool_call 内并发池)；' +
          '填写合法序列号(如 `S1-1`)=只**精修该单序列**、覆写其正文文件、其余不动；' +
          '短剧一序列=多集弧(8-15集)、长剧一序列=一集(含多场景)，整序列由引擎内部逐集/逐场景调用 writer 累积到同一文件；' +
          '集级 ID(如 `S1-1-03`)会被引擎归约到序列号兜底，但建议直接填序列号。' +
          '有值但格式非法会被 Guard 早退拒绝，故要么留空、要么填合规序列号。',
      }
    } else {
      // v7.3 sequence_builder：target_sequence 可选——留空=并发批量，填=精修单序列
      properties[paramName] = {
        type: 'string',
        description:
          '**可选**。留空=引擎读序列清单并发批量铺设**全部序列**(一次 tool_call 内并发池)；' +
          '填写合法序列号(如 `S1-1`)=只**精修该单序列**、覆写 sequences/<target>.md、其余不动。' +
          '有值但格式非法会被 Guard 早退拒绝，故要么留空、要么填合规序列号。',
      }
    }
  }

  return {
    type: 'function',
    function: {
      name: subagent.id,
      description: subagent.description,
      parameters: {
        type: 'object',
        properties,
        required: ['instruction'],
      },
    },
  }
}
