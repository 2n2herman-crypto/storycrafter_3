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
import { InMemoryFileManager, DEFAULT_ASSET_PATHS } from './orchestrator/fileManager'
import { LLMClient } from './llm/client'
import { OrchestratorEngine } from './orchestrator/orchestratorEngine'
import { useEffect, useState } from 'react'

function App() {
  const [isReady, setIsReady] = useState(false)

  const assets = useAssetStore((s) => s.assets)
  const initAssetStore = useAssetStore((s) => s.init)
  const initChatStore = useChatStore((s) => s.init)
  const selectedCard = useUIStore((s) => s.selectedCard)
  const setSelectedCard = useUIStore((s) => s.setSelectedCard)

  // 初始化：创建核心实例并注入 Store
  useEffect(() => {
    const fm = new InMemoryFileManager(DEFAULT_ASSET_PATHS)

    const llm = new LLMClient()
    const engine = new OrchestratorEngine(llm, fm)

    initAssetStore(fm)
    initChatStore(engine)
    setIsReady(true)
  }, [initAssetStore, initChatStore])

  // 获取当前选中卡片的内容
  const selectedCardData = selectedCard ? assets[selectedCard] : null
  const cardList = useAssetStore((s) => s.getAssetList())
  // 选中卡片的中文展示名（从卡片列表取，回退到路径）
  const selectedLabel =
    cardList.find((c) => c.path === selectedCard)?.filename ?? selectedCard ?? undefined

  return (
    <div className="app-container">
      <HeaderBar />
      <MultiColumnLayout
        defaultRatios={[27, 20, 26.5, 26.5]}
        fixedBoundaries={[0]}
        columns={[
          <BottomPanel />,
          <AssetCardPanel
            cards={cardList}
            selectedPath={selectedCard}
            onSelect={setSelectedCard}
          />,
          <CurrentPanel
            filename={selectedLabel}
            content={selectedCardData?.content ?? undefined}
            isLoading={!isReady}
          />,
          <BaselinePanel
            filename={selectedLabel}
            content={selectedCardData?.previousContent ?? undefined}
            isLoading={!isReady}
          />,
        ]}
      />
    </div>
  )
}

export default App
