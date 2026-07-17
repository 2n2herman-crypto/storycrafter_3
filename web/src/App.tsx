import './styles/global.css'
import './styles/layout.css'
import './styles/diff.css'

import { HeaderBar } from './components/Layout/HeaderBar'
import { MultiColumnLayout } from './components/Layout/MultiColumnLayout'
import { BaselinePanel } from './components/Layout/BaselinePanel'
import { CurrentPanel } from './components/Layout/CurrentPanel'
import { AssetCardPanel } from './components/Layout/AssetCardPanel'
import { BottomPanel } from './components/BottomBar/BottomPanel'

import { useAssetStore } from './store/assetStore'
import { useChatStore } from './store/chatStore'
import { useUIStore } from './store/uiStore'
import { usePhaseStore } from './store/phaseStore'
import { InMemoryFileManager, DEFAULT_ASSET_PATHS } from './orchestrator/fileManager'
import type { FileManager } from './orchestrator/fileManager'
import { HttpFileManager } from './api/assets'
import {
  listProjects,
  createProject,
  deleteProject,
  getProject,
  updateProject,
  type ProjectMeta,
} from './api/projects'
import type { ProductKind } from './types/product'
import { LLMClient } from './llm/client'
import { OrchestratorEngine } from './orchestrator/orchestratorEngine'
import { loadUserSkills } from './skills/skillLoader'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SettingsPage } from './pages/Settings/SettingsPage'

/**
 * v7.4：旧项目 metadata 没有 productKind/phase 时的一次性迁移。
 * 优先用正文命名识别长短剧，再从核心资产中的明确产品词回退识别；
 * phase 仅在已有正文时推断为 writing，避免仅完成设计稿就被误锁。
 */
async function inferLegacyRuntimeState(
  fm: FileManager,
): Promise<{ productKind: ProductKind | null; phase: 'designing' | 'writing' }> {
  const files = await fm.listAssetFiles()
  const paths = files.filter((f) => f.exists).map((f) => f.path)
  const hasShortDramaChapters = paths.some((p) =>
    p.startsWith('short_drama_scripts/') ||
    p.startsWith('video_scripts/short_drama/') ||
    /^chapters\/E\d+-E\d+\.md$/.test(p),
  )
  const hasLongDramaChapters = paths.some((p) =>
    p.startsWith('long_drama_scripts/') ||
    p.startsWith('video_scripts/long_drama/') ||
    /^chapters\/E\d+\.md$/.test(p),
  )
  const hasFilmScripts = paths.some((p) =>
    p.startsWith('film_scripts/') ||
    p.startsWith('video_scripts/film/'),
  )
  const hasWritingAssets = paths.some((p) =>
    p.startsWith('chapters/') ||
    p.startsWith('novel_chapters/') ||
    p.startsWith('short_drama_scripts/') ||
    p.startsWith('long_drama_scripts/') ||
    p.startsWith('film_scripts/') ||
    p.startsWith('video_scripts/'),
  )

  let productKind: ProductKind | null = hasShortDramaChapters
    ? 'short_drama'
    : hasLongDramaChapters
      ? 'long_drama'
      : hasFilmScripts
        ? 'screenplay'
        : paths.some((p) => p.startsWith('novel_chapters/'))
          ? 'novel'
          : null

  if (!productKind) {
    const samples = await Promise.all(
      ['user_requirements.md', 'act_map.md', 'sequence_list.md'].map(async (path) => {
        try {
          return await fm.readFile(path)
        } catch {
          return ''
        }
      }),
    )
    const corpus = samples.join('\n').slice(0, 24_000)
    const explicitType = '(?:产品方向|创作模式|产品类型|类型)[^\\n]{0,12}'
    if (new RegExp(`${explicitType}短剧|短剧脚本`).test(corpus)) productKind = 'short_drama'
    else if (new RegExp(`${explicitType}长剧|长剧脚本`).test(corpus)) productKind = 'long_drama'
    else if (new RegExp(`${explicitType}(?:电影)?剧本|电影剧本`).test(corpus)) productKind = 'screenplay'
    else if (new RegExp(`${explicitType}小说`).test(corpus)) productKind = 'novel'
  }

  return { productKind, phase: hasWritingAssets ? 'writing' : 'designing' }
}

function App() {
  const [isReady, setIsReady] = useState(false)
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [currentProject, setCurrentProject] = useState<ProjectMeta | null>(null)
  /** v7.3：设计完整度进度条 + 合并按钮需要直接操作 FileManager，跟随当前项目切换 */
  const [fileManager, setFileManager] = useState<FileManager | null>(null)

  const assets = useAssetStore((s) => s.assets)
  const initAssetStore = useAssetStore((s) => s.init)
  const initChatStore = useChatStore((s) => s.init)
  const selectedCard = useUIStore((s) => s.selectedCard)
  const setSelectedCard = useUIStore((s) => s.setSelectedCard)
  const compareMode = useUIStore((s) => s.compareMode)
  const toggleCompareMode = useUIStore((s) => s.toggleCompareMode)
  const phase = usePhaseStore((s) => s.phase)
  const prevPhaseRef = useRef(phase)

  // v7.1 M4：切换项目——重建 fm+engine，重置 UI/Phase 状态，重新 init 两个 store（含拉历史对话）
  const switchProject = useCallback(
    async (project: ProjectMeta) => {
      setIsReady(false)
      // 项目列表可能是旧快照；切换前重新读取 metadata，保证同会话内切回来也拿到最新运行状态。
      const persistedProject = await getProject(project.id)
      const fm = new HttpFileManager(persistedProject.id)
      const llm = new LLMClient()
      const engine = new OrchestratorEngine(llm, fm)

      const legacy = await inferLegacyRuntimeState(fm)
      const productKind = persistedProject.productKind ?? legacy.productKind
      let restoredPhase = persistedProject.phase ?? legacy.phase

      if (productKind) engine.lockProfile(productKind)

      // 先清掉上一个项目的 UI/Phase 内存，再从当前项目 metadata + 资产重建。
      useUIStore.getState().reset()
      usePhaseStore.getState().reset()
      await initAssetStore(fm)
      if (restoredPhase === 'writing') {
        try {
          await usePhaseStore.getState().lock(fm)
        } catch (e) {
          console.warn('[App] 写作期恢复失败，已安全回退设计期', e)
          restoredPhase = 'designing'
        }
      }

      const hydratedProject = await updateProject(persistedProject.id, {
        productKind,
        phase: restoredPhase,
      })
      await initChatStore(engine, persistedProject.id)
      setProjects((prev) => prev.map((p) => (p.id === hydratedProject.id ? hydratedProject : p)))
      setCurrentProject(hydratedProject)
      setFileManager(fm)
      setIsReady(true)
    },
    [initAssetStore, initChatStore],
  )

  // 初始化：拉项目 → 选第一个（空则建默认项目）→ switchProject；后端不可用降级 InMemoryFileManager
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // v7.1 M5：加载用户源 Skill overlay（后端不可用仅内置源，不阻塞启动）
        await loadUserSkills()
        let list = await listProjects()
        if (list.length === 0) {
          list = [await createProject('默认项目')]
        }
        if (cancelled) return
        setProjects(list)
        await switchProject(list[0])
        if (!cancelled) setIsReady(true)
      } catch (e) {
        console.error('[App] 后端初始化失败，降级 InMemoryFileManager（无持久化）', e)
        const fm = new InMemoryFileManager(DEFAULT_ASSET_PATHS)
        const llm = new LLMClient()
        const engine = new OrchestratorEngine(llm, fm)
        if (cancelled) return
        await initAssetStore(fm)
        await initChatStore(engine, null)
        setFileManager(fm)
        setIsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initAssetStore, initChatStore, switchProject])

  // v7.1 M4：新建项目并切入
  const handleCreateProject = useCallback(
    async (name: string) => {
      const p = await createProject(name)
      setProjects((prev) => [...prev, p])
      await switchProject(p)
    },
    [switchProject],
  )

  // 删除项目：后端硬删 → 从列表移除 → 若删的是当前项目则切到剩余的第一个
  const handleDeleteProject = useCallback(
    async (project: ProjectMeta) => {
      await deleteProject(project.id)
      const remaining = projects.filter((p) => p.id !== project.id)
      setProjects(remaining)
      if (currentProject?.id === project.id && remaining.length > 0) {
        await switchProject(remaining[0])
      }
    },
    [projects, currentProject, switchProject],
  )

  // v6.4：phase 切换时联动 selectedPath
  useEffect(() => {
    if (prevPhaseRef.current === 'designing' && phase === 'writing') {
      // 进入写作期：若有已生成的章节，自动选中第一个
      const cards = useAssetStore.getState().getAssetList()
      const firstChapter = cards.find((c) =>
        c.path.startsWith('novel_chapters/') ||
        c.path.startsWith('short_drama_scripts/') ||
        c.path.startsWith('long_drama_scripts/') ||
        c.path.startsWith('film_scripts/') ||
        c.path.startsWith('chapters/'),
      )
      if (firstChapter) {
        setSelectedCard(firstChapter.path)
      }
    }
    prevPhaseRef.current = phase
  }, [phase, setSelectedCard])

  // 获取当前选中卡片的内容
  const selectedCardData = selectedCard ? assets[selectedCard] : null
  const cardList = useAssetStore((s) => s.getAssetList())
  // 选中卡片的中文展示名（从卡片列表取，回退到路径）
  const selectedLabel =
    cardList.find((c) => c.path === selectedCard)?.filename ?? selectedCard ?? undefined

  if (view === 'settings') {
    return <SettingsPage onClose={() => setView('main')} />
  }

  // 对照模式：开启时四栏（含版本对比），关闭时三栏（隐藏版本对比栏）
  const columns = [
    <BottomPanel />,
    <AssetCardPanel
      cards={cardList}
      selectedPath={selectedCard}
      onSelect={setSelectedCard}
      wordExportAvailable={currentProject !== null}
      projectName={currentProject?.name}
      fileManager={fileManager}
      projectId={currentProject?.id}
    />,
    <CurrentPanel
      filename={selectedLabel}
      content={selectedCardData?.content ?? undefined}
      isLoading={!isReady}
      selectedPath={selectedCard ?? undefined}
      compareMode={compareMode}
      onToggleCompare={toggleCompareMode}
    />,
  ]
  if (compareMode) {
    columns.push(
      <BaselinePanel
        filename={selectedLabel}
        content={selectedCardData?.previousContent ?? undefined}
        isLoading={!isReady}
      />,
    )
  }
  const ratios = compareMode ? [27, 20, 26.5, 26.5] : [30, 22, 48]

  return (
    <div className="app-container">
      <div className="sc-container">
        <HeaderBar
          onOpenSettings={() => setView('settings')}
          projects={projects}
          currentProject={currentProject}
          onSwitchProject={switchProject}
          onCreateProject={handleCreateProject}
          onDeleteProject={handleDeleteProject}
        />
        <MultiColumnLayout
          key={compareMode ? 'compare' : 'plain'}
          defaultRatios={ratios}
          fixedBoundaries={[0]}
          columns={columns}
        />
      </div>
    </div>
  )
}

export default App
