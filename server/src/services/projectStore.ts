import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolveAssetPath } from '../util/pathGuard.js'
import { enqueue } from '../util/fsQueue.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../../data')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')

export interface ProjectMeta {
  id: string
  name: string
  description?: string
  /** v7.4：项目级产品方向，跨服务重启恢复 Orchestrator profileLock */
  productKind?: 'novel' | 'screenplay' | 'long_drama' | 'short_drama'
  /** v7.4：项目当前阶段，跨服务重启恢复 Phase Gate */
  phase?: 'designing' | 'writing'
  createdAt: string
  updatedAt: string
  /** v7.1 M6 预留：资产间关系（projectStore 透传不解释，文件关系系统未实现） */
  relations?: unknown[]
}

export interface AssetEntry {
  path: string
  size: number
  updatedAt: string
}

export class ProjectNotFound extends Error {
  constructor(public projectId: string) {
    super(`项目不存在: ${projectId}`)
    this.name = 'ProjectNotFound'
  }
}

export class AssetNotFound extends Error {
  constructor(public assetPath: string) {
    super(`资产不存在: ${assetPath}`)
    this.name = 'AssetNotFound'
  }
}

function projectDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId)
}

function assetsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'assets')
}

function metaPath(projectId: string): string {
  return path.join(projectDir(projectId), 'metadata.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 原子写：临时文件 + rename（崩溃安全，metadata 用） */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

// ===== 项目 CRUD =====

export function listProjects(): ProjectMeta[] {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  const projects: ProjectMeta[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const mp = metaPath(e.name)
    if (!fs.existsSync(mp)) continue
    try {
      projects.push(JSON.parse(fs.readFileSync(mp, 'utf-8')) as ProjectMeta)
    } catch {
      // 坏 metadata 跳过，不级联失败
    }
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getProject(projectId: string): ProjectMeta | null {
  const mp = metaPath(projectId)
  if (!fs.existsSync(mp)) return null
  try {
    return JSON.parse(fs.readFileSync(mp, 'utf-8')) as ProjectMeta
  } catch {
    return null
  }
}

export function createProject(name: string): ProjectMeta {
  const id = crypto.randomUUID()
  const meta: ProjectMeta = {
    id,
    name: name || '未命名项目',
    phase: 'designing',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  fs.mkdirSync(assetsDir(id), { recursive: true })
  atomicWrite(metaPath(id), JSON.stringify(meta, null, 2))
  return meta
}

export function updateProject(
  projectId: string,
  patch: {
    name?: string
    description?: string
    productKind?: ProjectMeta['productKind'] | null
    phase?: ProjectMeta['phase']
  },
): ProjectMeta {
  const meta = getProject(projectId)
  if (!meta) throw new ProjectNotFound(projectId)
  if (patch.name !== undefined) meta.name = patch.name
  if (patch.description !== undefined) meta.description = patch.description
  if (patch.productKind !== undefined) {
    if (patch.productKind === null) delete meta.productKind
    else meta.productKind = patch.productKind
  }
  if (patch.phase !== undefined) meta.phase = patch.phase
  meta.updatedAt = nowIso()
  atomicWrite(metaPath(projectId), JSON.stringify(meta, null, 2))
  return meta
}

export function deleteProject(projectId: string): void {
  const dir = projectDir(projectId)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

// ===== 资产（对应 FileManager 六方法） =====

/** 列出项目所有资产（递归子目录），对应 FileManager.listAssetFiles */
export function listAssets(projectId: string): AssetEntry[] {
  const root = assetsDir(projectId)
  if (!fs.existsSync(root)) return []
  const result: AssetEntry[] = []
  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = path.relative(root, full).split(path.sep).join('/')
        const stat = fs.statSync(full)
        result.push({ path: rel, size: stat.size, updatedAt: stat.mtime.toISOString() })
      }
    }
  }
  walk(root)
  return result
}

/** 读单文件，对应 FileManager.readFile */
export function readAsset(
  projectId: string,
  relPath: string,
): { content: string; updatedAt: string } {
  const abs = resolveAssetPath(assetsDir(projectId), relPath)
  if (!fs.existsSync(abs)) throw new AssetNotFound(relPath)
  const content = fs.readFileSync(abs, 'utf-8')
  return { content, updatedAt: fs.statSync(abs).mtime.toISOString() }
}

/** 覆盖写，对应 FileManager.writeFile（过队列串行） */
export function writeAsset(
  projectId: string,
  relPath: string,
  content: string,
): Promise<{ updatedAt: string }> {
  if (!getProject(projectId)) throw new ProjectNotFound(projectId)
  return enqueue(projectId, () => {
    const abs = resolveAssetPath(assetsDir(projectId), relPath)
    atomicWrite(abs, content)
    return { updatedAt: fs.statSync(abs).mtime.toISOString() }
  })
}

/** 删单文件，对应 FileManager.clearFile */
export function deleteAsset(projectId: string, relPath: string): void {
  const abs = resolveAssetPath(assetsDir(projectId), relPath)
  if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
}

/** 清空全部资产（保留项目本身），对应 FileManager.clearAll（reset_all 用） */
export function clearAssets(projectId: string): Promise<void> {
  return enqueue(projectId, () => {
    const root = assetsDir(projectId)
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true })
      fs.mkdirSync(root, { recursive: true })
    }
  })
}
