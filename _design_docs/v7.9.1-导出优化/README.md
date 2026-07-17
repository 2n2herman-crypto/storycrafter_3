# StoryCrafter v7.9.1 · 导出优化

## 1. 背景

当前资产面板提供两个全量导出按钮：

- `全量 MD`
- `全量 Word`

现有实现会把所有资产按上下拼接方式合并成一个大 Markdown，再直接下载或转成一个 Word 文件。这种方式在资产数量变多后会出现几个问题：

1. 资产类型混在一个长文档里，不利于二次整理。
2. 小说正文、短剧剧本、视频脚本、设计资产被强行串接，语义边界丢失。
3. Word 导出只是单一文档，不适合后续按模块归档。
4. 两个按钮占用资产栏顶部空间，功能重复感较强。

v7.9.1 目标是把全量导出收缩成一个简约入口，并把导出结果改成**文件夹化资产包**。

## 2. 用户需求

用户希望：

1. 将“全量导出 MD”和“全量导出 Word”压缩为一个简约的“导出”按钮。
2. 点击“导出”后弹出格式选择。
3. 格式选择包含：
   - Markdown
   - Word
4. 用户选择格式后触发下载。
5. 下载结果不再是所有资产上下拼接的单文件。
6. 下载结果应是一个大文件夹，内部按资产类型分成不同文件夹。

## 3. 产品交互方案

### 3.1 入口收缩

资产面板顶部从：

```text
[全量 MD] [全量 Word]
```

改为：

```text
[导出]
```

按钮文案：

```text
导出
```

导出中：

```text
导出中...
```

禁用态：

```text
暂无可导出内容
```

### 3.2 格式选择弹层

点击“导出”后弹出轻量选择层：

```text
选择格式后下载
[x] Markdown 资产包
[ ] Word 资产包
```

说明：

- UI 上使用复选框样式，但行为是**单选**：Markdown 与 Word 二选一。
- 用户点击某个格式选项后立即触发下载，不再额外要求点击“下载”确认。
- 若未来需要一次导出两种格式，可允许复选框多选，并输出两个 zip 包或一个 zip 包内含 `markdown/` 与 `word/` 两套目录。
- 当前需求是“选择 md 格式还是 word 格式”，所以第一版按二选一实现最清晰。

### 3.3 下载产物

无论选择 Markdown 还是 Word，下载物都应该是一个压缩包：

```text
<项目名>_资产导出_<YYYYMMDD-HHmm>.zip
```

压缩包内部是一个根目录：

```text
<项目名>_资产导出/
```

根目录下按类型分文件夹保存资产。

## 4. 导出包结构

### 4.1 Markdown 导出包

示例：

```text
我的短剧项目_资产导出/
  00_项目信息/
    项目说明.md
    导出清单.md
  01_需求与设定/
    user_requirements.md
    worldbuilding.md
    characters.md
  02_结构大纲/
    act_map.md
    sequence_list.md
    foreshadowing.md
    subplots.md
  03_序列细纲/
    sequences/
      S1-1.md
    scenes/
      S1-1.md
    beats/
      S1-1.md
    sequence_outlines/
      S1-1.md
  04_写作资产/
    novel_chapters/
    short_drama_scripts/
      E01-E12.md
    long_drama_scripts/
    film_scripts/
    chapters_legacy/
      E01-E12.md
  05_视频脚本/
    short_drama/
      E01-E12.md
    long_drama/
    film/
  99_其他资产/
    <未归类资产>.md
```

### 4.2 Word 导出包

Word 导出不再生成一个总 Word，而是按同样目录结构把每个 Markdown 资产转换成独立 `.docx`：

```text
我的短剧项目_资产导出/
  01_需求与设定/
    user_requirements.docx
    worldbuilding.docx
    characters.docx
  02_结构大纲/
    act_map.docx
    sequence_list.docx
  04_写作资产/
    short_drama_scripts/
      E01-E12.docx
  05_视频脚本/
    short_drama/
      E01-E12.docx
```

`导出清单` 也应转换为：

```text
00_项目信息/导出清单.docx
```

## 5. 分类规则

导出时按资产路径归类：

| 源路径 | 导出目录 |
|---|---|
| `user_requirements.md` | `01_需求与设定/` |
| `worldbuilding.md` | `01_需求与设定/` |
| `characters.md` | `01_需求与设定/` |
| `act_map.md` | `02_结构大纲/` |
| `sequence_list.md` | `02_结构大纲/` |
| `foreshadowing.md` | `02_结构大纲/` |
| `subplots.md` | `02_结构大纲/` |
| `sequences/*.md` | `03_序列细纲/sequences/` |
| `scenes/*.md` | `03_序列细纲/scenes/` |
| `beats/*.md` | `03_序列细纲/beats/` |
| `sequence_outlines/*.md` | `03_序列细纲/sequence_outlines/` |
| `novel_chapters/*.md` | `04_写作资产/novel_chapters/` |
| `short_drama_scripts/*.md` | `04_写作资产/short_drama_scripts/` |
| `long_drama_scripts/*.md` | `04_写作资产/long_drama_scripts/` |
| `film_scripts/*.md` | `04_写作资产/film_scripts/` |
| `chapters/*.md` | `04_写作资产/chapters_legacy/` |
| `video_scripts/short_drama/*.md` | `05_视频脚本/short_drama/` |
| `video_scripts/long_drama/*.md` | `05_视频脚本/long_drama/` |
| `video_scripts/film/*.md` | `05_视频脚本/film/` |
| 其他 `.md` | `99_其他资产/` |

## 6. 导出清单

每次导出自动生成一个清单文件：

```text
00_项目信息/导出清单.md
```

内容示例：

```md
# 导出清单

- 项目名称：xxx
- 导出时间：2026-07-17 19:30
- 导出格式：Markdown
- 资产数量：32

## 文件列表

| 分类 | 文件 | 源路径 |
|---|---|---|
| 需求与设定 | worldbuilding.md | worldbuilding.md |
| 写作资产 | E01-E12.md | short_drama_scripts/E01-E12.md |
```

Word 导出时，清单也转换为 `.docx`。

## 7. 技术实现方案

### 7.1 前端导出工具调整

当前文件：

```text
web/src/utils/exportMd.ts
```

当前核心函数：

```ts
buildAllMarkdown(items)
```

v7.9.1 后不再使用它做全量导出主路径，改为新增：

```ts
export type ExportFormat = 'markdown' | 'word'

export interface ExportAssetItem {
  path: string
  title: string
  content: string
}

export interface ExportFileEntry {
  outputPath: string
  content: string | Blob
}

export function classifyExportPath(sourcePath: string): string
export function buildExportManifest(items: ExportAssetItem[], format: ExportFormat): string
export async function buildExportZip(items: ExportAssetItem[], format: ExportFormat): Promise<Blob>
```

### 7.2 Zip 生成方式

优先方案：前端引入 `jszip`。

```bash
npm install jszip
```

前端打包：

```ts
import JSZip from 'jszip'

const zip = new JSZip()
const root = zip.folder(rootFolderName)
root.file('01_需求与设定/worldbuilding.md', content)
const blob = await zip.generateAsync({ type: 'blob' })
triggerDownload(blob, `${rootFolderName}.zip`)
```

备选方案：后端新增 `/api/export/package`，由后端生成 zip。  
第一阶段建议优先前端实现 Markdown zip；Word zip 若需要逐文件调用后端 docx 转换，仍可以由前端拿 Blob 后塞入 zip。

当前实现说明：

- 由于当前开发环境不允许 npm 在系统缓存目录写入，本轮没有新增 `jszip` 依赖。
- 前端在 `web/src/utils/exportMd.ts` 内实现轻量标准 ZIP 打包器。
- ZIP 使用 store/no compression 格式，浏览器与系统解压工具可直接识别。
- 后续若依赖安装环境恢复，可再替换为 `jszip`，但不影响当前功能验收。

### 7.3 Word 转换策略

当前 API：

```text
POST /api/export/docx
```

当前只支持：

```ts
exportDocx(markdown: string, filename: string): Promise<Blob>
```

第一阶段可以复用它：

1. 前端遍历每个资产。
2. 对每个资产调用 `exportDocx(content, filename)`。
3. 将返回的 Blob 写入 zip 对应目录。
4. 最后下载 zip。

注意：

- Word 导出会产生多次接口请求。
- 需要设置并发上限，例如 4。
- 单个文件转换失败时，不应让整个导出失败。建议：
  - 成功文件继续写入 zip。
  - 失败文件在 `00_项目信息/导出清单` 中标注失败。

后续增强可新增后端批量接口：

```text
POST /api/export/package
```

由后端一次性接收文件列表并返回 zip。

### 7.4 AssetCardPanel 交互调整

当前文件：

```text
web/src/components/Layout/AssetCardPanel.tsx
```

当前组件：

```ts
function ExportHeader(...)
```

当前按钮：

```text
全量 MD
全量 Word
```

改为：

```text
导出
```

新增状态：

```ts
const [isExportMenuOpen, setIsExportMenuOpen] = useState(false)
const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('markdown')
const [exporting, setExporting] = useState(false)
```

交互：

```ts
function handleExportClick() {
  setIsExportMenuOpen(true)
}

async function handleExport(format: ExportFormat) {
  setExporting(true)
  try {
    const blob = await buildExportZip(items, format)
    triggerDownload(blob, `${projectName}_资产导出_${timestamp}.zip`)
  } finally {
    setExporting(false)
    setIsExportMenuOpen(false)
  }
}
```

格式选项点击即下载：

- 点击 `Markdown 资产包`：前端直接生成 `.md` 文件结构化 zip。
- 点击 `Word 资产包`：逐资产复用 `/api/export/docx` 转换为 `.docx` 后写入同构 zip。
- 降级模式下 Word 选项禁用，Markdown 保持可用。

### 7.5 CurrentPanel 保持不变

当前单资产导出：

- `导出当前 MD`
- `导出当前 Word`

本专项只收缩“全量导出”。单资产导出可以暂时保持不变。

## 8. 文件命名规则

### 8.1 文件名安全化

导出 zip 内部文件名需要安全化：

```ts
function sanitizeExportName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}
```

### 8.2 保留原资产名

同一目录内优先保留原始资产文件名：

```text
short_drama_scripts/E01-E12.md
→ 04_写作资产/short_drama_scripts/E01-E12.md
```

对于根目录资产：

```text
worldbuilding.md
→ 01_需求与设定/worldbuilding.md
```

## 9. 验收标准

### 9.1 UI 验收

- 资产面板顶部只保留一个“导出”按钮。
- 点击“导出”后出现格式选择。
- 选择 Markdown 后立即下载 `.zip`。
- 选择 Word 后立即下载 `.zip`。
- 无可导出资产时按钮禁用或提示“暂无可导出内容”。
- 降级模式下：
  - Markdown zip 可用。
  - Word zip 若依赖后端，应明确禁用并提示。

### 9.2 内容验收

- 导出结果不是单一拼接文档。
- zip 内存在项目根目录。
- 根目录内按类型生成文件夹。
- 原资产内容不被改写。
- 旧 `chapters/` 资产进入 `04_写作资产/chapters_legacy/`。
- `video_scripts/` 资产进入 `05_视频脚本/`。
- 自动生成导出清单。

### 9.3 Word 验收

- Word 导出 zip 内每个资产是独立 `.docx`。
- 文件夹结构与 Markdown 导出一致。
- 单个 Word 转换失败不会阻断其他文件导出。
- 失败项写入导出清单。

## 10. 开发步骤

### Step 1：实现 zip 能力

优先使用 `jszip`；若环境不允许新增依赖，则在前端实现轻量 ZIP 打包器。当前代码采用无依赖实现。

### Step 2：改造导出工具

文件：

```text
web/src/utils/exportMd.ts
```

新增：

- `ExportFormat`
- `classifyExportPath`
- `buildExportManifest`
- `buildExportZip`
- `sanitizeExportName`

保留：

- `triggerDownload`
- `downloadText`
- `buildAllMarkdown`（供旧逻辑或单文件拼接兼容）

### Step 3：改造资产面板 ExportHeader

文件：

```text
web/src/components/Layout/AssetCardPanel.tsx
```

删除两个全量按钮：

- `全量 MD`
- `全量 Word`

新增：

- `导出` 按钮
- 格式选择弹层
- `handleConfirmExport`

### Step 4：Word zip 并发转换

新增并发工具：

```ts
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]>
```

Word 导出每次最多并发 4 个转换请求。

### Step 5：回归验证

运行：

```bash
npm run typecheck
npm run build
```

## 11. v7.9.1 UI 位置调整补充

本轮同时处理两个位置问题：

1. `自检：开/关` 不再放在资产卡片栏工具行，迁移到对话栏标题右侧。
2. `设计进度` 不再放在资产卡片栏顶部，迁移到资产卡片栏底部。

调整原因：

- 自检属于对话执行策略，应靠近 Dialogue 标题，而不是资产列表。
- 设计进度属于资产完成度和阶段推进，应仍然留在资产栏，符合“看资产完成度→进入写作模式”的用户心理。
- 资产卡片栏顶部只保留资产列表的主操作，即 `导出`；进度条沉到底部，减少对资产卡片浏览的干扰。

目标布局：

```text
对话 DIALOGUE                                      [自检：开]

<对话记录>

<创作模式>

<文件导入>
<输入框>

资产卡片                                      [导出]

<资产列表>

设计进度                                      5/9
[progress]                         [进入写作模式]
```

手测：

1. 只有设计资产时导出 Markdown。
2. 有小说正文时导出 Markdown。
3. 有短剧剧本 + 视频脚本时导出 Markdown。
4. 有旧 `chapters/` 时确认进入 `chapters_legacy/`。
5. Word 导出 zip 内结构正确。
6. 降级模式下 Word 按钮/选项禁用。

## 12. 最小实现范围

第一版必须完成：

1. 单一“导出”按钮。
2. 格式选择。
3. Markdown zip 分文件夹导出。
4. Word zip 分文件夹导出。
5. 导出清单。

可以后续再做：

1. 后端批量 zip 接口。
2. 多格式同时勾选一次导出。
3. 导出进度条。
4. 用户自定义导出范围。
5. 用户自定义目录命名。

## 13. 一句话结论

v7.9.1 把“全量导出”从两个按钮和一个拼接文档，升级为一个简约入口和一个结构化资产包：

```text
导出按钮
→ 选择 Markdown / Word
→ 下载 <项目名>_资产导出.zip
→ zip 内按资产类型分文件夹保存
```

这样导出的结果更接近真实项目归档，而不是一份难以维护的长文档。
