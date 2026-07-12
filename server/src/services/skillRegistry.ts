import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Skill 运行时注册表（v7.1 M5）—— 用户源扫描。
 *
 * 双源 overlay：
 *   - 内置源：前端 `web/src/skills/` 经 `import.meta.glob` 构建期注册（永远可用，含降级）
 *   - 用户源：`server/data/skills/` 经本模块运行期扫描，前端 `loadUserSkills()` overlay 到内置 registry
 *
 * 后端只读文件返回 raw（不解析 frontmatter）—— frontmatter 解析复用前端 `skillLoader` 的自研解析器，
 * 避免重复实现与 shared/ tsconfig 复杂度。坏文件收集到 errors 不级联失败。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const USER_SKILLS_DIR = path.join(DATA_DIR, 'skills')

export interface SkillFileEntry {
  subagentId: string
  skillId: string
  raw: string
  source: 'user'
}

export interface SubagentFileEntry {
  subagentId: string
  raw: string
  source: 'user'
}

export interface SkillRegistryError {
  path: string
  message: string
}

export interface SkillRegistrySnapshot {
  subagents: SubagentFileEntry[]
  skills: SkillFileEntry[]
  errors: SkillRegistryError[]
}

/**
 * 扫描 `server/data/skills/<subagentId>/subagent.md` + `<subagentId>/<skillId>/SKILL.md`。
 * 目录不存在返回空快照；坏文件/坏目录结构收集到 errors 不抛。
 */
export function scanUserSkills(): SkillRegistrySnapshot {
  const result: SkillRegistrySnapshot = { subagents: [], skills: [], errors: [] }
  if (!fs.existsSync(USER_SKILLS_DIR)) return result

  let subagentDirs: fs.Dirent[]
  try {
    subagentDirs = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
  } catch (e) {
    result.errors.push({ path: USER_SKILLS_DIR, message: `读取 skills 目录失败: ${String(e)}` })
    return result
  }

  for (const entry of subagentDirs) {
    if (!entry.isDirectory()) continue
    const subagentId = entry.name
    const subagentDir = path.join(USER_SKILLS_DIR, subagentId)

    // subagent.md（可选——用户源可只加 Skill 到已有内置 Subagent）
    const subagentMd = path.join(subagentDir, 'subagent.md')
    if (fs.existsSync(subagentMd)) {
      try {
        result.subagents.push({
          subagentId,
          raw: fs.readFileSync(subagentMd, 'utf-8'),
          source: 'user',
        })
      } catch (e) {
        result.errors.push({ path: subagentMd, message: `读取失败: ${String(e)}` })
      }
    }

    // skill 子目录
    let skillDirs: fs.Dirent[]
    try {
      skillDirs = fs.readdirSync(subagentDir, { withFileTypes: true })
    } catch (e) {
      result.errors.push({ path: subagentDir, message: `读取子目录失败: ${String(e)}` })
      continue
    }
    for (const skillEntry of skillDirs) {
      if (!skillEntry.isDirectory()) continue
      const skillId = skillEntry.name
      const skillMd = path.join(subagentDir, skillId, 'SKILL.md')
      if (fs.existsSync(skillMd)) {
        try {
          result.skills.push({
            subagentId,
            skillId,
            raw: fs.readFileSync(skillMd, 'utf-8'),
            source: 'user',
          })
        } catch (e) {
          result.errors.push({ path: skillMd, message: `读取失败: ${String(e)}` })
        }
      }
    }
  }
  return result
}
