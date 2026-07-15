import type { ProductProfile } from '../types/product'
import type { StoryPhase } from '../store/phaseStore'
import type { FileManager } from './fileManager'

interface ModuleStatus {
  label: string
  complete: boolean
  detail: string
}

export interface ProjectStatusSnapshot {
  modules: ModuleStatus[]
  existingFileCount: number
  promptBlock: string
  markdown: string
}

const CORE_MODULES = [
  ['需求分析', 'user_requirements.md'],
  ['世界观设定', 'worldbuilding.md'],
  ['角色设定', 'characters.md'],
  ['幕结构', 'act_map.md'],
  ['序列清单', 'sequence_list.md'],
  ['伏笔规划', 'foreshadowing.md'],
  ['支线管理', 'subplots.md'],
] as const

/** 进度查询直接走机械扫描，避免 Orchestrator 根据聊天历史猜测。 */
export function isProjectStatusQuery(input: string): boolean {
  return /当前进度|项目状态|进度一览|完成情况|做到哪|做到什么|哪些.*(?:完成|未完成)|(?:查看|汇报|显示).*创作进度|创作进度.*(?:怎么样|如何|多少|一览)/i.test(input)
}

async function readNonEmptyFiles(
  fileManager: FileManager,
  paths: string[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await fileManager.readFile(path)
        return [path, content.trim()] as const
      } catch {
        return [path, ''] as const
      }
    }),
  )
  return new Map(entries.filter(([, content]) => content.length > 0))
}

function parseSequenceIds(sequenceList: string): string[] {
  return [...new Set(Array.from(sequenceList.matchAll(/\bS\d+-\d+\b/g), (m) => m[0]))].sort()
}

/**
 * 由文件系统生成唯一权威的项目进度快照。
 * 不读取聊天历史，也不让 LLM 判断文件是否存在。
 */
export async function buildProjectStatusSnapshot(
  fileManager: FileManager,
  profile: ProductProfile | null,
  phase: StoryPhase,
): Promise<ProjectStatusSnapshot> {
  const fileInfos = await fileManager.listAssetFiles()
  const existingPaths = fileInfos.filter((f) => f.exists).map((f) => f.path)
  // 正文可能非常大；状态扫描只读核心设定与结构层文件，正文按已落盘文件数统计。
  const inspectedPaths = existingPaths.filter(
    (path) =>
      CORE_MODULES.some(([, corePath]) => corePath === path) ||
      path.startsWith('sequences/') ||
      path.startsWith('scenes/') ||
      path.startsWith('beats/'),
  )
  const contents = await readNonEmptyFiles(fileManager, inspectedPaths)
  const isReady = (path: string) => contents.has(path)

  const modules: ModuleStatus[] = [
    {
      label: '产品方向',
      complete: profile !== null,
      detail: profile ? `已选定「${profile.displayName}」` : '未选择',
    },
    ...CORE_MODULES.map(([label, path]) => ({
      label,
      complete: isReady(path),
      detail: isReady(path) ? '已完成' : '未创建',
    })),
  ]

  const sequenceIds = parseSequenceIds(contents.get('sequence_list.md') ?? '')
  const hasModernLayers = existingPaths.some(
    (path) => path.startsWith('scenes/') || path.startsWith('beats/'),
  )
  const completedSequences = sequenceIds.filter((id) => {
    if (hasModernLayers) {
      return [
        `sequences/${id}.md`,
        `scenes/${id}.md`,
        `beats/${id}.md`,
      ].every(isReady)
    }
    // 兼容 v7.2 及更早版本：当时场景与节拍合并存放在 sequences/<ID>.md。
    return isReady(`sequences/${id}.md`)
  }).length
  const sceneBeatComplete = sequenceIds.length > 0 && completedSequences === sequenceIds.length
  modules.push({
    label: '场景节拍',
    complete: sceneBeatComplete,
    detail: sequenceIds.length === 0
      ? '未创建'
      : sceneBeatComplete
        ? `已完成（${completedSequences}/${sequenceIds.length} 个序列）`
        : `进行中（${completedSequences}/${sequenceIds.length} 个序列）`,
  })

  const chapterCount = existingPaths.filter((path) => path.startsWith('chapters/')).length
  modules.push({
    label: '正文写作',
    complete: chapterCount > 0,
    detail: chapterCount > 0 ? `已开始（${chapterCount} 个正文文件）` : '未开始',
  })

  const rows = modules.map(
    (module) => `| **${module.label}** | ${module.complete ? '✅' : '❌'} ${module.detail} |`,
  )
  const markdown = [
    '## 📊 当前进度一览',
    '',
    '> 以下状态由项目资产文件实时扫描生成。',
    '',
    '| 模块 | 状态 |',
    '|---|---|',
    ...rows,
    '',
    `当前阶段：${phase === 'writing' ? '写作期' : '设计期'}。共检测到 ${existingPaths.length} 个资产文件。`,
  ].join('\n')

  const promptBlock = [
    '<project_status source="filesystem" authoritative="true">',
    `  <phase>${phase}</phase>`,
    `  <asset_file_count>${existingPaths.length}</asset_file_count>`,
    ...modules.map(
      (module) =>
        `  <module name="${module.label}" complete="${module.complete}">${module.detail}</module>`,
    ),
    '</project_status>',
    '当用户提及项目现状、已有资产或下一步时，必须以上述文件系统快照为准；不得根据聊天历史推测文件缺失。',
  ].join('\n')

  return {
    modules,
    existingFileCount: existingPaths.length,
    promptBlock,
    markdown,
  }
}
