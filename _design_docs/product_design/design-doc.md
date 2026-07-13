# StoryCraft v3 前端设计文档

> 版本：1.0
> 日期：2026-06-24
> 状态：定稿

---

## 1. UI 架构总览

### 1.1 整体布局

```
┌──────────────────────────────────────────────────────────────────┐
│  Header Bar: StoryCraft v3                          [⚙ 设置]    │
├────────────────┬──────────────────┬──────────────────────────────┤
│                │                  │                              │
│  Baseline Panel│  Current Panel   │  Asset Card Panel           │
│  (左侧栏)       │  (中间栏)         │  (右侧栏)                    │
│                │                  │                              │
│  用户最近一次   │  当前最新内容     │  □ worldbuilding.md  ✓     │
│  确认的版本     │  + diff 高亮     │  □ characters.md     ✓     │
│                │                  │  □ plot_synopsis.md  ✓     │
│  只读模式      │  绿色=新增       │  ──────────────────        │
│                │  红色=删除       │  □ act_map.md        ⚡     │
│                │                  │  □ sequence_list.md  ⚡     │
│                │                  │  ──────────────────        │
│                │                  │  □ scene_beat_outline.md 🔒│
│                │                  │                              │
│                │                  │  ▸ 卡片列表从 AgentRegistry  │
│                │                  │   动态生成，以上为 MVP 示例  │
├────────────────┴──────────────────┴──────────────────────────────┤
│  Bottom Panel                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ [STATE_1_CONCEPT ▼]  [对话输入 >_____________________]   │   │
│  │  (Phase 切换)          (Chat 输入)        [确认设定]     │   │
│  │                                         (ConfirmButton)  │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ 📎 拖拽文件到这里，或点击导入  [导入 Word/Excel/MD]      │   │
│  │ ▸ chat_history_line_1...                                │   │
│  │ ▸ chat_history_line_2...                                │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 布局尺寸策略

| 区域 | 占比 | 最小宽度 | 说明 |
|------|------|---------|------|
| 左侧栏 | 35% | 320px | 基线内容，可拖拽缩放 |
| 中间栏 | 40% | 360px | 当前内容 + diff 高亮，可拖拽缩放 |
| 右侧栏 | 25% | 220px | 卡片选择器，固定宽度 |
| 底栏 | 固定 180px | 180px | Phase 1a 固定高度（不可拖拽）；Phase 1b 可上下拖拽缩放 |

---

## 2. 组件树与职责

```
App
├── HeaderBar
│   ├── Logo (StoryCraft v3 标题)
│   └── SettingsButton (未来扩展)
│
├── DiffLayout (三栏主体)
│   ├── BaselinePanel (左侧栏)
│   │   ├── PanelHeader: 标题 + 时间戳/版本标签
│   │   ├── TabBar: "上次确认" / "编辑前版本" (Tab切换，后者显示本次 Agent 调用前的快照，用于对比修改效果)
│   │   └── MarkdownRender: 只读渲染
│   │
│   ├── CurrentPanel (中间栏)
│   │   ├── PanelHeader: 标题 + 状态指示器 (已修改/未修改)
│   │   └── DiffedMarkdownRender
│   │       └── ReactMarkdown + RemarkGFM
│   │           └── 自定义渲染器注入 <ins>/<del>
│   │
│   └── AssetCardPanel (右侧栏)
│       ├── SectionLabel: 从 AgentRegistry.group 动态生成
│       │   （MVP 分类: "基础设定" / "大纲结构" / "微观精铸"）
│       └── AssetCard × N
│           ├── FileIcon (文件类型图标)
│           ├── FileName (从 AgentSpec.writes 读取)
│           ├── StatusBadge (未生成/已生成/已修改/锁定)
│           └── StageIndicator (阶段归属标记，从 AgentSpec.phase 读取)
│
├── PanelResizer (三栏/上下 分隔条)
│
└── BottomPanel
    ├── ControlsRow
    │   ├── PhaseSelector (下拉: STATE_1~STATE_3 + COMPLETED)
    │   │   └── 切换时触发: 文件加载 / 卡片可见性更新
    │   └── ChatInput (文本输入框 + 发送按钮)
    │       └── 回车或点击发送 → IPC → Orchestrator
    ├── FileImporter
    │   ├── DragDropZone (拖拽区域)
    │   ├── FileButton (按钮选择文件)
    │   └── ImportPreview (导入内容的预览/确认弹窗)
    │       └── "作为参考素材" / "导入到资产卡片" 选项
    └── ChatHistory
        └── ChatMessage × N (用户消息 / 系统响应 / 导入提示)
```

---

## 3. 数据流模型

### 3.1 三层架构

```
┌───────────────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js 环境)                             │
│                                                                   │
│  File System Layer:                                               │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ chokidar.watch('story_craft_v3/*.md') → 变更事件          │   │
│  │ fs.readFile / fs.writeFile → MD 直接读写                   │   │
│  │ mammoth.convertToHtml → .docx 解析                        │   │
│  │ XLSX.readFile → .xlsx 解析                                 │   │
│  │ {filename}.approved.md → 快照管理                          │   │
│  └────────────────────────────────────────────────────────────┘   │
│                           │ IPC (ipcMain.handle)                  │
├───────────────────────────┼───────────────────────────────────────┤
│  Preload (contextBridge) │                                        │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │ 暴露 API: window.storyAPI = {                               │  │
│  │   readFile(path), writeFile(path, content),                 │  │
│  │   listAssetFiles(), importFile(filePath, type),             │  │
│  │   saveApprovedSnapshot(path),                               │  │
│  │   onFileChange(callback)                                    │  │
│  │ }                                                           │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                           │ window.storyAPI.*                      │
├───────────────────────────┼───────────────────────────────────────┤
│  Renderer Process (React) │                                        │
│  ┌────────────────────────┴────────────────────────────────────┐  │
│  │ Zustand Store                                               │  │
│  │ ┌──────────────────────────────────────────────────────────┐ │  │
│  │ │ assets: { [path]: { content, approvedContent, status } } │ │  │
│  │ │ ui: { selectedCard, baselineTab }                       │ │  │
│  │ │ phase: STATE_1_CONCEPT                                  │ │  │
│  │ │ chat: { messages[] }                                     │ │  │
│  │ │ import: { previewContent, pendingAction }                │ │  │
│  │ └──────────────────────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

**Web 模式（Phase 1a）说明**：
Phase 1a（纯 Vite + React，无 Electron）的数据流与上图区别如下：
- **无主进程**：文件操作由 `InMemoryFileManager` 直接完成（内存 Map），不走 IPC
- **无 Preload**：不存在 `window.storyAPI`，Store 直接调用 FileManager 方法
- **无 chokidar**：文件变更由 Store action 手动触发，无需监听
- **文件导入**：仅支持 `.md` 通过浏览器 `FileReader API` 读取（不支持 `.docx` / `.xlsx`）
- **LLM 调用**：前端直接调用 DeepSeek API（OpenAI 兼容，天然支持浏览器 CORS）
- **Electron 迁移**：Phase 1b 时，将 `InMemoryFileManager` 替换为 `ElectronFileManager`（通过 IPC 调用主进程），其余 React 代码完全复用

### 3.2 核心数据流场景

#### 场景 1：选择资产卡片

```
用户点击右侧栏卡片
  → AssetCard.onClick(assetPath)
  → store.setSelectedCard(assetPath)
  → useEffect 触发:
      Phase 1a (Web): fileManager.readFile(assetPath)           // 直接调用 InMemoryFileManager
      Phase 1b (Electron): window.storyAPI.readFile(assetPath)  // 通过 IPC
      Phase 1a (Web): fileManager.getApprovedSnapshot(assetPath.approved)  // 基线内容
      Phase 1b (Electron): window.storyAPI.getApprovedSnapshot(assetPath.approved)
  → store.setCurrentContent(content)
  → store.setBaselineContent(approvedContent)
  → BaselinePanel + CurrentPanel 重新渲染
  → DiffedMarkdownRender 计算 diff
```

> **Phase 1a 差异**：不走 IPC，Store 通过 `useIPC.ts` 注入的 FileManager 实例直接调用。`isElectron()` 检测返回 false 时自动使用 InMemoryFileManager。

#### 场景 2：文件变更推送

```
Phase 1b (Electron):
  chokidar 检测到 *.md 文件变更
    → ipcMain 通过 webContents.send('file-changed', {path, content})
    → preload: onFileChange callback
    → store updateFileContent(path, content)
    → 如果该文件正是当前选中的卡片:
        CurrentPanel 更新 + diff 重新计算

Phase 1a (Web):
  无 chokidar 监听。Store action 在 writeFile 调用后手动触发 refreshFile:
    → fileManager.writeFile(path, content)
    → store.refreshFile(path)  // 手动同步
    → UI 自动更新
```

> **Phase 1a 差异**：无文件系统监听，文件变更由 Store action 在写入后手动触发。

#### 场景 3：确认操作（快照保存）

```
用户点击「确认设定」/「确认大纲」等按钮
  → store.setPhase(nextPhase)            // 推进阶段
  → Phase 1a (Web): fileManager.saveApprovedSnapshot(assetPath) // 直接调 FileManager
  → Phase 1b (Electron): window.storyAPI.saveApprovedSnapshot(assetPath) // 通过 IPC
      // 将当前内容写入 {filename}.approved.md
  → store.setBaselineToCurrent()
  → 左侧栏更新为新的基线
  → 右侧栏卡片状态更新为「已确认」
```

> **Phase 1a 差异**：快照保存在 InMemoryFileManager 的内存 Map 中，刷新页面后丢失（Phase 1a 并非持久化版本）。

#### 场景 4：文件导入

```
Phase 1b (Electron):
  用户拖入 .docx 文件到 FileImporter
    → main process: mammoth.convertToHtml(filePath)
    → 返回 HTML/Markdown 文本
    → store.showImportPreview(parsedContent)

Phase 1a (Web):
  用户选择 .md 文件（浏览器 FileReader API）
    → 浏览器 FileReader 读取为 UTF-8 文本
    → 仅支持 .md 格式（.docx / .xlsx 延至 Phase 1b）
    → store.showImportPreview(content)

后续（两阶段共用）:
  用户选择操作:
    "作为参考素材" → 追加到 ChatHistory
    "导入到资产卡片" → 打开选择卡片弹窗 → writeFile
```

---

## 4. Diff 引擎设计

### 4.1 技术选型

使用 `diff` (npm) 库的 `diffWords` 方法进行词级对比。

### 4.2 工作流程

```
输入: baselineText (基线文本), currentText (当前文本)
输出: React.ReactNode[] (可安全传递给 react-markdown 的文本节点)

步骤:
1. diff.diffWords(baselineText, currentText)
   → [{ value: "text", added: true/false, removed: true/false }, ...]

2. 将 diff 结果转换为带标记的文本:
   - 普通文本 → 直接保留
   - added → 包裹 <ins class="diff-add">{value}</ins>
   - removed → 包裹 <del class="diff-remove">{value}</del>

3. 将标记后的完整文本传递给 react-markdown 渲染
```

### 4.3 Markdown 渲染策略

由于 Agent 输出全部是 Markdown 表格，必须保证表格在 diff 后仍能正确渲染。

**策略**：在文本层做标记，而非在 AST 层。

```
原始文本: "| 幕编号 | 功能定位 |"
修改后:   "| 幕编号 | 功能定位 | 新增列 |"

diff 结果文本:
"| 幕编号 | 功能定位 |<ins class="diff-add"> 新增列 |</ins>"

→ react-markdown 识别为合法表格表头
→ 渲染后新增列带有绿色高亮
```

**边界情况处理**：

| 情况 | 处理方式 |
|------|---------|
| 表格整行新增 | `<ins>` 包裹整行，表格结构仍然完整 |
| 表格整行删除 | `<del>` 包裹整行，保留占位确保表格不崩溃 |
| 跨多行修改 | 逐词 diff，保留换行符 |
| 空行 diff | 跳过空白部分，只标注有变化的行 |

### 4.4 CSS 样式

```css
.diff-add {
  background-color: rgba(0, 200, 83, 0.15);
  text-decoration: none;
  border-radius: 2px;
}

.diff-remove {
  background-color: rgba(255, 23, 68, 0.15);
  text-decoration: line-through;
  border-radius: 2px;
}
```

---

## 5. 文件导入协议

### 5.1 支持格式

| 格式 | 解析库 | 输出格式 | 备注 |
|------|--------|---------|------|
| .docx | mammoth | HTML/Markdown | 自动转换格式 |
| .xlsx | xlsx (SheetJS) | JSON → Markdown 表格 | 每个 sheet 转为一个表格 |
| .md | 原生 | 原文本 | 直接读取 UTF-8 文本 |

### 5.2 导入流程

```
文件拖入/选择
  → main process 读取文件（Phase 1a: 浏览器 FileReader API 读取）
  → 根据扩展名选择解析器（Phase 1a: 仅支持 .md，.docx / .xlsx 延至 Phase 1b）
  → 返回解析后的文本内容
  → 前端展示 preview 弹窗:
      ├── 文件原始内容预览 (只读)
      └── 操作选择:
          ├── "作为参考素材"
          │   └── 追加到 ChatHistory, 格式:
          │       [📎 导入参考: 文件名.docx]
          │       (解析后的内容缩略显示)
          │
          └── "导入到资产卡片"
              └── 弹出卡片选择器:
                  卡片列表从 AgentRegistry 动态读取
                  （当前 MVP: worldbuilding.md, characters.md, ...）
                  └── [确认导入] → IPC writeFile
```

---

## 6. 状态联动逻辑

### 6.1 Phase → 卡片可见性

卡片列表从 AgentRegistry 动态读取，**不硬编码文件列表**。规则：

```
可见卡片 = AgentRegistry 中 AgentSpec.phase <= PHASE_ORDER[当前 Phase] 的所有 writes 文件
可操作卡片 = AgentRegistry 中 AgentSpec.phase == PHASE_ORDER[当前 Phase] 的所有 writes 文件
锁定卡片（只读）= AgentRegistry 中 AgentSpec.phase < PHASE_ORDER[当前 Phase] 的所有 writes 文件

> 注：PHASE_ORDER 映射表在 `stateMachine.ts` 中定义，将 Phase 字符串转为数字（STATE_1_CONCEPT=1 … STATE_COMPLETED=4）。
```

当前 MVP 的实际映射效果：

| Phase | 可见卡片 | 可操作卡片 |
|-------|---------|-----------|
| STATE_1_CONCEPT | worldbuilding.md, characters.md, plot_synopsis.md | 全部可编辑 |
| STATE_2_MACRO | 上 + act_map.md, sequence_list.md | 阶段一卡片已锁 (只读) |
| STATE_3_MICRO | 全部 6 个 | 阶段一、二卡片已锁 (只读) |
| STATE_COMPLETED | 全部 6 个 | 全部锁定 (只读 + 导出可用) |

> 远期加 Agent 后此表自动扩展。

### 6.2 卡片状态枚举

| 状态 | 含义 | 显示 |
|------|------|------|
| `pending` | 尚未生成 | 🔄 待生成 |
| `generated` | 已生成未确认 | ✓ 已生成 |
| `approved` | 用户已确认 | ✓✓ 已确认 |
| `modified` | 确认后有修改 | ⚡ 已修改 |
| `locked` | 当前阶段不允许修改 | 🔒 已锁定 |

### 6.3 Phase 切换触发的动作

Phase 切换有**查看模式**和**推进模式**两种方式：

**查看模式（PhaseSelector 下拉切换）**：
```
用户通过 PhaseSelector 下拉选择 Phase:
  1. store.setViewingPhase(phase)     // 仅改变查看范围，不推进
  2. 更新卡片可见性列表（显示目标 Phase 的可见卡片）
  3. 如果当前选中的卡片在新查看范围不可见: 取消选中，显示提示
  4. 向 ChatHistory 追加系统消息: "系统: 已切换到 {phase} 阶段（查看模式）"
  ※ 不创建快照，不锁定文件
  ※ 如果在此模式下尝试发送修改指令 → 系统自动切回 currentPhase
```

**推进模式（ConfirmButton 点击确认）**：
```
用户点击确认按钮:
  1. store.saveSnapshots()            // 创建当前阶段所有文件的 *.approved.md
  2. store.setPhase(nextPhase)        // 推进到下一阶段
  3. 更新卡片可见性列表（新阶段下锁定前一阶段卡片）
  4. 前一阶段的所有卡片标记为 locked
  5. 向 ChatHistory 追加系统消息: "系统: 已确认 {oldPhase}，进入 {newPhase}"
  ※ 推进不可逆（除非触发 rollback）
```

---

## 7. 技术选型与理由

| 层 | 选型 | 版本 | 阶段 | 理由 |
|---|---|---|---|---|
| 桌面框架 | Electron | 28+ | Phase 1b | 原生文件系统，不需要独立后端 |
| 渲染框架 | React | 18+ | Phase 1a+1b | 组件化，生态成熟 |
| 语言 | TypeScript | 5+ | Phase 1a+1b | 接口类型安全 |
| 状态管理 | Zustand | 4+ | Phase 1a+1b | 轻量 (1KB)，无 Provider |
| Diff 引擎 | `diff` | 5+ | Phase 1a+1b | 词级 diff，零依赖 |
| Markdown 渲染 | `react-markdown` | 9+ | Phase 1a+1b | XSS 防护，自定义渲染器 |
| GFM 扩展 | `remark-gfm` | 4+ | Phase 1a+1b | 表格、删除线支持 |
| Word 解析 | `mammoth` | 1.6+ | Phase 1b | .docx → HTML/Markdown |
| Excel 解析 | `xlsx` (SheetJS) | 0.20+ | Phase 1b | .xlsx → Markdown 表格 |
| 文件监听 | `chokidar` | 3+ | Phase 1b | 跨平台 FS 事件 |
| 打包 | `electron-builder` | 24+ | Phase 1b | 跨平台安装包生成 |
| 样式 | CSS Modules | - | Phase 1a+1b | 避免类名冲突 |
| 构建工具 | Vite | 5+ | Phase 1a+1b | 快速 HMR，ESM 原生 |
| LLM 接口 | DeepSeek API (OpenAI 兼容) | - | Phase 1a+1b | 原生浏览器 CORS 支持 |

### 7.1 为什么不选择...

| 替代方案 | 放弃理由 |
|---------|---------|
| Tauri | Rust 后端，开发成本高，文件系统操作不如 Electron 直接 |
| Next.js/纯 Web（带后端） | 不需要独立后端服务，DeepSeek API 直接在浏览器端调用 |
| Monaco Editor | 太重，本项目只需要展示 + diff，不需要完整代码编辑器 |
| Redux | 对于本应用规模过于笨重，Zustand 足够 |
| Anthropic SDK | 浏览器端可能有 CORS 限制，DeepSeek 原生支持浏览器调用，切换成本更低 |

---

## 8. 快照文件规范

### 8.1 文件命名

```
{original_filename}.approved.md
```

示例：
```
worldbuilding.md → worldbuilding.approved.md
act_map.md → act_map.approved.md
```

### 8.2 存储位置

与原始 MD 文件同目录 (`story_craft_v3/` 根目录)，便于相对路径引用。

### 8.3 YAML Frontmatter

每个快照文件在头部记录元信息：

```markdown
---
snapshot_of: worldbuilding.md
approved_at: 2026-06-24T10:30:00+08:00
phase: STATE_1_CONCEPT
version: 1
---
```

### 8.4 生命周期

- 创建：用户点击确认按钮时自动创建/覆盖
- 读取：前端加载基线内容时读取
- 删除：不回退到更早阶段时不自动删除（保留历史）
- 回退：当 Orchestrator 触发状态回退时，删除对应快照

---

## 9. IPC 接口定义

### 9.1 Preload 暴露 API

```typescript
interface StoryAPI {
  // 文件操作
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listAssetFiles(): Promise<AssetFileInfo[]>;

  // 快照管理
  saveApprovedSnapshot(path: string): Promise<void>;
  getApprovedSnapshot(path: string): Promise<string | null>;

  // 文件导入
  importFile(filePath: string): Promise<ImportResult>;

  // 文件监听
  onFileChange(callback: (info: FileChangeInfo) => void): void;
  removeFileChangeListener(): void;
}

interface AssetFileInfo {
  path: string;
  filename: string;
  stage: number;              // 阶段编号，从 AgentSpec.phase 读取
  agentId: string;            // 生产此文件的 Agent ID，对应 AgentRegistry
  group: string;              // 分组标签，从 AgentSpec.group 读取
  exists: boolean;
  hasApproved: boolean;
}
// status 字段归入 UI 层的 AssetCardData（见 §10），不在 IPC 层暴露

interface ImportResult {
  format: 'docx' | 'xlsx' | 'md';
  content: string;
  filename: string;
  size: number;
}

interface FileChangeInfo {
  path: string;
  content: string;
  event: 'change' | 'add' | 'unlink';
}
```

---

## 10. 组件 Props 接口定义

### 10.1 核心组件 Props

```typescript
// ---------- Diff 相关 ----------
interface BaselinePanelProps {
  content: string;
  filename: string;
  lastApprovedAt?: string;
  isLoading: boolean;
}

interface CurrentPanelProps {
  content: string;
  baselineContent: string;
  filename: string;
  isModified: boolean;
  isLoading: boolean;
}

interface DiffedMarkdownRenderProps {
  baselineText: string;
  currentText: string;
}

// ---------- 资产卡片 ----------
interface AssetCardPanelProps {
  cards: AssetCardData[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface AssetCardProps {
  data: AssetCardData;
  isSelected: boolean;
  onSelect: () => void;
}

interface AssetCardData {
  path: string;
  filename: string;
  agentId: string;            // 对应 AgentRegistry 中的 Agent ID
  stage: number;              // 阶段编号，从 AgentSpec.phase 读取
  group: string;              // 分组标签，从 AgentSpec.group 读取
  status: 'pending' | 'generated' | 'approved' | 'modified' | 'locked';
  summary?: string;
}

// ---------- 底栏 ----------
interface PhaseSelectorProps {
  currentPhase: Phase;
  onPhaseChange: (phase: Phase) => void;
  // 始终显示所有 Phase 选项；选择限制在 onPhaseChange 中处理
  // 未解锁的 Phase 被选中时弹出提示"请先完成当前阶段的确认"
}

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
  placeholder?: string;
}

interface FileImporterProps {
  onImport: (file: File) => void;
  onImportToAsset: (content: string, targetPath: string) => void;
}

interface ImportPreviewProps {
  content: string;
  filename: string;
  onConfirmAsReference: () => void;
  onConfirmToAsset: (targetPath: string) => void;
  onDismiss: () => void;
  isImporting: boolean;
}

interface ChatHistoryProps {
  messages: ChatMessage[];
}

interface ChatMessage {
  id: string;
  type: 'user' | 'system' | 'import';
  content: string;
  timestamp: string;
  metadata?: {
    filename?: string;
    importAction?: 'reference' | 'asset';
    targetPath?: string;
  };
}

// ---------- 布局 ----------
interface DiffLayoutProps {
  baselineContent: string;
  currentContent: string;
  selectedFilename: string | null;
  isLoading: boolean;
  cards: AssetCardData[];
  selectedCardPath: string | null;
  onSelectCard: (path: string) => void;
}

interface BottomPanelProps {
  currentPhase: Phase;
  onPhaseChange: (phase: Phase) => void;
  onSendMessage: (message: string) => void;
  onFileImport: (file: File) => void;
  onImportToAsset: (content: string, targetPath: string) => void;
  chatMessages: ChatMessage[];
}
```

---

## 11. 开发与构建命令

```bash
# 开发模式（Phase 1a: Web 模式）
npm run dev          # Vite HMR，浏览器中运行

# 开发模式（Phase 1b: Electron 模式）
npm run dev:electron # Vite HMR + Electron 窗口

# 构建（Web）
npm run build        # 构建生产版本

# 构建（Electron）
npm run pack         # 打包为可分发安装包

# 代码质量
npm run lint         # ESLint
npm run typecheck    # TypeScript 类型检查
```

---

## 12. 未来扩展点

- **版本历史**：保存多次确认的快照，左侧栏可下拉选择历史版本进行 diff
- **实时协作**：基于 WebSocket 的多用户同时编辑
- **导出 PDF**：将最终大纲导出为 PDF 格式
- **暗色模式**：CSS 变量切换明暗主题
- **国际化**：i18n 支持中英文界面
