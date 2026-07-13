# v6.3 变更方案：场景节拍多切片对齐（Checker 修复 + 前端聚合卡）

## 一、问题与目标

v6.1 起 `scene_beats` 已从**单文件 `scene_beat_outline.md`** 物理拆成**每序列一份 `sequences/<ID>.md`**（[subagent.md:4](../src/skills/scene_beats/subagent.md#L4)）。但两处上层组件仍停留在"单文件视角"，导致：

1. **Checker 判 FAIL 实为路径失明**：[story_checker/SKILL.md:5](../src/skills/story_checker/story_checker/SKILL.md#L5) 的 `reads` 仍是死写的 `scene_beat_outline.md`，运行期该文件恒不存在，`<scene_beat_outline>` 拿到空串；rubric 里所有"检查场景节拍是否落地"的项（[:28](../src/skills/story_checker/story_checker/SKILL.md#L28)、[:49](../src/skills/story_checker/story_checker/SKILL.md#L49)、[:106](../src/skills/story_checker/story_checker/SKILL.md#L106)、[:148-149](../src/skills/story_checker/story_checker/SKILL.md#L148-L149)）自然一律 FAIL——世界观/角色维度实际是 PASS 的，日志佐证。
2. **前端左栏卡片爆炸**：`sequences/S1-1.md`…`sequences/S3-4.md` 每条都是一张独立卡（[assetStore.getAssetList:186-208](../src/store/assetStore.ts#L186-L208) 兜底分组为 `大纲切片`，但没聚合），12 序列故事就是 12 张卡塞满左栏；`chapters/*.md` 也同样问题。
3. **中文标签死引用**：[assetStore.ts:32](../src/store/assetStore.ts#L32) `FILE_LABELS` 仍挂 `'scene_beat_outline.md': '场景节拍大纲'`，是 v6.1 未清理的遗留。

**v6.3 目标**：把 checker 与前端资产列表对齐到"N 切片"世界模型，业务内核（`outputValidator` / `contextAssembler.assembleContext` / `types` / pipeline runner）**一行不改**（承继 v6.1 INV-1/INV-2/INV-3）。

## 二、Wave 划分

| Wave | 内容 | 影响面 |
|---|---|---|
| **A** Checker 路径对齐 | `story_checker/SKILL.md` reads + rubric 描述 + skillLoader glob 展开 | 1 skill.md + 1 引擎 hook |
| **B** 中文标签规则化 | `FILE_LABELS` 清死项 + 动态标签规则（`sequences/*` / `chapters/*`） | 1 store |
| **C** 前端聚合卡 | `AssetCardPanel` 大纲切片/剧本正文按 group 折叠 + 计数徽标 + 状态聚合 | 1 组件 + CSS module |

三 Wave 相互解耦，可分别独立合入；建议顺序 A → B → C（A/B 是 bugfix，C 是样式重构）。

## 三、Wave A：Checker 路径对齐

### A.1 SKILL.md 改写

[story_checker/SKILL.md](../src/skills/story_checker/story_checker/SKILL.md)：

- `reads` 中 `'scene_beat_outline.md'` → `'sequences/*.md'`（**新增 glob 语法约定**，见 A.2）。
- 正文所有出现 `scene_beat_outline.md` 处替换为 `sequences/<ID>.md`；上下文标签 `<scene_beat_outline>` 改为 `<scene_beats_slices>`（聚合视图，见 A.2 拼装约定）。
- rubric 示例路径列 `scene_beat_outline.md: S1-3 场景` → `sequences/S1-3.md: SC-...`。

### A.2 引擎侧 glob 展开（最小侵入）

**决策**：不改 `contextAssembler.assembleContext` 函数体（守 INV-2），改在 **caller（`orchestratorEngine.executeTool`）拿到 `skill.reads` 后**做一次展开：

```ts
// 伪码：executeTool 内、读文件之前
const expandedReads: string[] = []
for (const r of skill.reads) {
  if (r.endsWith('/*.md')) {
    const prefix = r.slice(0, -'*.md'.length)  // 'sequences/'
    const hits = (await fm.listAssetFiles())
      .filter(a => a.path.startsWith(prefix) && a.exists)
      .map(a => a.path)
    expandedReads.push(...hits)
  } else {
    expandedReads.push(r)
  }
}
```

然后按 `expandedReads` 逐个读文件，**再在拼装 XML 时把同前缀的多个文件合并到一个聚合标签**——这一步用 caller 手工拼装（同 v6.1 append `<prev_X>` 的做法，守 INV-2）：

```ts
const singleReads = expandedReads.filter(p => !p.startsWith('sequences/'))
const sliceReads  = expandedReads.filter(p =>  p.startsWith('sequences/'))
let ctx = assembleContext(singleReads, files)
if (sliceReads.length > 0) {
  const inner = sliceReads.map(p => {
    const id = p.replace(/^sequences\//,'').replace(/\.md$/,'')
    return `<slice id="${id}">\n${files[p] ?? ''}\n</slice>`
  }).join('\n\n')
  ctx += `\n\n<scene_beats_slices>\n${inner}\n</scene_beats_slices>`
}
```

**注意**：该展开逻辑仅在 skill.reads 出现 glob (`*.md` 后缀) 时触发；非 checker 的其他 skill 全部走原路径，零回归。

### A.3 buildFunctionSpec / listAssetFiles 前置

`listAssetFiles()` 需要 `expandedReads` 之前调用一次。当前 `executeTool` 已在做 `fm.readFile` 前的路径列表构建，插入一次 `listAssetFiles()` 调用即可（内存 fs，成本可忽略）。

### A.4 验收

- 手动跑 `scene_beats` 生成 ≥2 个 sequences 切片 → 调 `story_checker` → 报告的 `<scene_beats_slices>` 引用 XML 里能看到全部切片的 id 与正文。
- rubric 中"伏笔 F-02 在 scene_beats 中的落地"类检查项不再一律 FAIL。

## 四、Wave B：中文标签规则化

### B.1 assetStore.FILE_LABELS 清理

[assetStore.ts:32](../src/store/assetStore.ts#L32)：删除 `'scene_beat_outline.md': '场景节拍大纲'` 一行。

### B.2 动态标签规则

`getAssetList` 内联式 label 计算改为：

```ts
function computeLabel(path: string): string {
  if (FILE_LABELS[path]) return FILE_LABELS[path]
  const seqMatch = path.match(/^sequences\/(.+)\.md$/)
  if (seqMatch) return `序列 ${seqMatch[1]}`
  const chMatch = path.match(/^chapters\/(.+)\.md$/)
  if (chMatch) return `章节 ${chMatch[1]}`
  return path.replace(/\.md$/, '')
}
```

### B.3 验收

- 左栏 `sequences/S1-1.md` 卡标题渲染为「序列 S1-1」而非「sequences/S1-1」。

## 五、Wave C：前端聚合卡

### C.1 数据结构扩展

`AssetCardData` 类型无需改（只加 UI 层聚合），在 `AssetCardPanel` 内做一次 group-by-group 折叠渲染。

聚合规则：**group ∈ {'大纲切片','剧本正文'} 时进入聚合视图**，其余 group 保持原有平铺。

### C.2 组件改造

[AssetCardPanel.tsx](../src/components/Layout/AssetCardPanel.tsx)（当前实现只做 group 分块 + 卡片 map）内新增：

```
[大纲切片 (7/12) ▾]
  ├─ 序列 S1-1   ✓ generated
  ├─ 序列 S1-2   ● modified
  ├─ 序列 S1-3   ○ pending
  └─ ...
```

- 折叠头行：组名 + `(已生成/总数)` + 展开箭头 + 组级状态徽标（组内有 `modified` → 组头显示 `● N 项已更新`，全 generated → `✓ 全部就绪`，含 pending → `○ 进行中`）。
- 展开态：子项复用 `AssetCard` 组件（尺寸缩一档，纵向堆叠）。
- 折叠态默认：**首次生成前折叠、有 modified 子项时自动展开**（用 `useEffect` 监听 group 内 status 变化，只在 pending→modified 跳变时展开一次，避免抖动）。
- 子项数量 ≤2 时降级为平铺（不折叠），避免为 1-2 张卡额外套一层壳。

### C.3 状态聚合函数

`AssetCardPanel` 内私有工具：

```ts
type GroupStatus =
  | { kind: 'idle' }         // 全 pending
  | { kind: 'partial'; done: number; total: number }
  | { kind: 'ready' }        // 全 generated
  | { kind: 'modified'; count: number }

function aggregate(cards: AssetCardData[]): GroupStatus { … }
```

### C.4 CSS

`AssetCardPanel.module.css` 新增 `.groupCollapsible / .groupHeader / .groupCount / .subItem` 若干类；沿用现有色板变量（`--asset-status-*`）。

### C.5 验收

- 12 序列故事的左栏：`大纲切片` 一行聚合卡，右侧显示 `(12/12)`；展开后见 12 个子项。
- 用户对 S1-3 refine 后，组头变 `● 1 项已更新` 并自动展开；点击 S1-3 子项进入 CurrentPanel 显示 diff。
- 只生成了 1 个 chapter 时 `剧本正文` 平铺 1 张卡，不套聚合壳。

## 六、不变式（INV）与风险

- **INV-1/2/3 全部继承**：outputValidator、assembleContext 函数体、types/SkillSpec 均零改动；A.2 的 glob 展开在 caller 侧完成。
- **无新 Skill 属主键**：FORBIDDEN_SKILL_KEYS 自然遵守。
- **回归风险点**：A.2 的 glob 展开仅当路径以 `/*.md` 结尾时触发；建议加一条 skillLoader 校验：若 skill.reads 中出现除 `/*.md` 外的 glob 变体（如 `sequences/S1-*.md`），loader 抛错——避免语义模糊。
- **UI 风险**：C.2 的"pending→modified 自动展开"用 ref 记录上一次组状态即可，不引入 zustand persist。

## 七、代码触点一览

| 文件 | Wave | 改动性质 |
|---|---|---|
| [src/skills/story_checker/story_checker/SKILL.md](../src/skills/story_checker/story_checker/SKILL.md) | A | reads + 正文文案 |
| [src/orchestrator/orchestratorEngine.ts](../src/orchestrator/orchestratorEngine.ts) `executeTool` | A | glob 展开 + 切片聚合标签拼接 |
| [src/skills/skillLoader.ts](../src/skills/skillLoader.ts) | A | reads glob 语法白名单校验（可选） |
| [src/store/assetStore.ts](../src/store/assetStore.ts) `FILE_LABELS` + `getAssetList` | B | 死项清理 + 动态标签 |
| [src/components/Layout/AssetCardPanel.tsx](../src/components/Layout/AssetCardPanel.tsx) | C | 聚合折叠 + 状态聚合 |
| [src/components/Layout/AssetCardPanel.module.css](../src/components/Layout/AssetCardPanel.module.css) | C | 新类若干 |

## 八、后续（不在 v6.3 范围）

- 切片 diff 的"批量视图"：一次 refine 涉及多切片时的横向对比 UI（延到 v6.4）。
- checker 支持"仅审计部分序列"参数化调用（延到 v6.4，配合 phase gate 的粒度化）。
