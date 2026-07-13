# StoryCrafter v6.1 设计方案 · 从节拍到剧本

> 本文件既是实施规划，也是产品设计的正式交付物。承接 [`product_design_产品化改造方案_v6.0`](../product_design_产品化改造方案_v6.0/README.md) 第 2 条「故事结构方案锁死化」与第 3 条「后链路写作 agent 和状态设计」。

---

## Context（为什么做这件事）

当前四层框架止步于 [`scene_beats`](../src/skills/scene_beats/subagent.md)：其输出 [`scene_beat_outline.md`](../src/orchestrator/fileManager.ts#L88) 是一张张表格化的「场景表 + 节拍表」，[SKILL 明确规定](../src/skills/scene_beats/scene_beats/SKILL.md#L22)「不是完整剧本」「不写完整对白」。也就是说，链路末端缺最后一跳：把这些提纲级的动作–反应单元铺展成带对白、带情绪密度、带描写的真正【剧本】正文。

但这最后一步有个根本性的安全顾虑：一旦放开下游自由创作，LLM 很可能在写正文时顺手回头改世界观、换角色动机、调整剧情走向，导致已经精心打磨好的设定层被悄悄污染；同时 [`story_checker`](../src/skills/story_checker/story_checker/) 又会把这种漂移当成 bug 反复审计修复，形成无意义的闭环消耗。

因此 v6.1 要建立一道**阶段闸门**：当用户认定大纲细度足够后，先冻结整条剧情设定的资产基线、屏蔽质检、封死上游回写的可能，然后才解锁专门的「写作 subagent」进入 Function Calling 面。这样就把「设计期」（开放探索、随时返工）和「落地期」（受保护的增量生产）物理隔开。

经澄清确定的三个核心取向：

| # | 议题 | 选型 |
|---|------|------|
| ① | 写作推进节奏 | **渐进·按场景/章节交互**——每次对话由用户点名一段发起写作 |
| ② | 片段磁盘累积 | **按章节拆分成独立的 `.md` 文档**（不走单文件追加） |
| ③ | 锁定可逆性 | **双向**——可在 HeaderBar 解锁退回设计期 |

---

## 现状制约（必须绕开的三颗钉子）

读完相关源码后的硬事实，决定了方案的形态不能天马行空：

1. **Validator 只认一对 tag、只写第一个文件**
   [`validateOutput()`](../src/orchestrator/outputValidator.ts#L17-L43) 固定取 `[startTag,endTag]=outputTags`，提取二者间内容塞入 [`extracted[skill.writes[0]]`](../src/orchestrator/outputValidator.ts#L33)。多 tag pair、动态文件名一律不支持。

2. **调度轮数上限太低，撑不住一次性长篇**
   [orchestratorEngine](../src/orchestrator/orchestratorEngine.ts#L15-L18) `MAX_ROUNDS=10` × `MAX_TOOLS_PER_ROUND=5`，加上 `CONTEXT_LIMIT_CHARS=22_000` 截断阈值。一部剧几十上百场景若想一口气全写完必然崩盘——这正是选型①「渐进交互」的根本理由：每次 `sendMessage` 重置 round 计数器，规避突破循环边界的诱惑。

3. **FileManager 无快照能力、AssetStatus 无 locked 态**
   [InMemoryFileManager](../src/orchestrator/fileManager.ts#L9) 注释白纸黑字：「v4 移除了快照方法 saveApprovedSnapshot/getApprovedSnapshot/clearSnapshot」；[`AssetStatus`](../src/types/index.ts#L77) 也只剩 `'pending'|'generated'|'modified'`，「approved/locked 被 v4 取消」。锁定能力要从零搭起。

4. （有利锚点）[`isResetSkill()`](../src/orchestrator/orchestratorEngine.ts#L57-L59) 已经树立了一个范式：用 `writes.length===0 && outputTags.length===0` 作为协议信号识别特例分支、不调 LLM 直接执行副作用。Phase Gate 会沿用同样的「协议约定 + 引擎分支」手法，保持框架一致性。

5. （有利锚点）[`uiStore.baselineTab`](../src/store/uiStore.ts#L9) 早预留 `'approved'|'pre-edit'` 两 tab，正好承载锁定前后对照视图；[`DEFAULT_ASSET_PATHS`](../src/orchestrator/fileManager.ts#L83-L94) 已预占 `draft_history.md`（虽本次改为按章拆分，不一定用到）；[`InMemoryFileManager.writeFile`](../src/orchestrator/fileManager.ts#L44-L47) 写任意 path 都会自动并入 `knownAssetPaths`，意味着运行时新生成的 `chapters/*.md` 天然能被 `listAssetFiles()` 发现、无需额外登记。

---

## 总体架构：两阶段状态机

```
        ┌─────────────── lock() ───────────────┐
        ▼                                       │
  ┌──────────┐                            ┌───────────┐
  │designing │ ─────────────────────────▶│  writing  │
  │ (现状即此)│ ◀─────────────────────────│           │
  └──────────┘         unlock()          └───────────┘
       │                                       │
       │      reset_all()                      │ reset_all()
       └────────────► 清空所有 ←───────────────┘
            （含 snapshots 与 chapters/）
```

- **state 安放处**：新增独立 store `phaseStore.ts`（职责单一，避免污染 uiStore）。导出 `{phase, lockedPaths:Set<string>, baselineSnapshot:Map<path,content>, lock(), unlock(), isLocked(), isLockedPath(p), getBaseline(p)}`。
- 选择放独立 store 而非复刻 FileManager interface 的原因：snapshot 服务对象仅限 UI 对照视图与门控判定，不应渗入 Electron 主进程 IPC 语义，故留在前端内存层即可；这也免去将来 Phase 1b 实现 ElectronFileManager 时被迫照搬一套无意义的快照接口。

---

## 分模块设计

### A. Phase Store（新增 `src/store/phaseStore.ts`）

```ts
type StoryPhase = 'designing' | 'writing'

interface PhaseState {
  phase: StoryPhase
  /** 被冻结的资产集合，固定为七项创作产物 */
  readonly LOCKED_PATHS: string[]
  /** key=path value=锁定时刻的内容快照 */
  baselines: Record<string, string>
}
```

- `LOCKED_PATHS` 常量 = `['worldbuilding.md','characters.md','act_map.md','sequence_list.md','scene_beat_outline.md','foreshadowing.md','subplots.md']`（恰好就是 [orchestratorEngine CREATIVE_TOOL_IDS](../src/orchestrator/orchestratorEngine.ts#L21-L24) 七项对应的 writes 目标）。注意不含 `user_requirements.md`——它是元数据始终可更新；也不含 `_check_report.md`/`draft_history.md`/各 `chapters/*.md`。
- `async lock(fm)`：校验七个文件均已 generated（缺任一直接抛错并附缺失列表），随后逐个读出当前内容存入 `baselines`，置 `phase='writing'`。
- `unlock()`：仅置 `phase='designing'` 并清空 `baselines`；**不清** `chapters/` 目录下的正文成果——解锁是为了回去微调设定后再回来接着写，不该丢掉已写好的稿子。
- `getBaseline(path)` 返回快照供 BaselinePanel 左视窗渲染；返回 undefined 表示处于 designing 期或该文件未被纳入快照。

### B. Engine 硬闸门控（改 [`orchestratorEngine.ts`](../src/orchestrator/orchestratorEngine.ts)）

在 `processUserInput` 入口拿到 toolSpecs 之后、以及在每个 tool_call 准备 dispatch 进 `executeTool` 之前插入两层 guard。位置参照现有 [`story_checker 特例分支`](../src/orchestrator/orchestratorEngine.ts#L423)，同源风格：

#### Guard-1：可见性过滤（FC 面）
- designing 期：剔除 `script_writer` 出 spec 列表（Orchestrator 根本看不到这个 function，无从误调）；
- writing 期：剔除全部 `CREATIVE_TOOL_IDS` 与 `story_checker`（彻底断绝上游回流与质检回路），同时保证 `user_requirements_analyzer` 与 `script_writer` 可见。
- 这是确定性硬保障，**不依赖** Orchestrator prompt 自觉遵守——prompt 只起辅助说明作用。即使模型犯浑也不会越雷池半步。

#### Guard-2：dispatch 兜底拒绝
即便 Guard-1 因未来某段逻辑漏过滤，仍在 `executeTool` 开头检查：若 `phase==='writing'` 且 `subagent.id ∈ CREATIVE_TOOL_IDS ∪ {'story_checker'}` 则 emit `tool_error` 并向 messages push `"设计期资产已锁定，无法在此阶段修改"` 后 continue。双重保险。

#### 影响 auditRound 计数器
writing 期内 `story_checker` 既不出现在 spec 里也就不会被选中，audit 循环自然静默——无需改计数逻辑。

### C. 「动态写靶」协议扩展（解 §② 章节多文件的钥匙）

用户选定「按章节拆成不同 md」。难点在于 [`SkillSpec.writes`](../src/types/index.ts#L62) 是构建期静态数组，没法在 frontmatter 里写 `writes:['chapters/S1-1.md']` 同时又支持下次写别的章节。解决方案如下，最小侵入：

#### C-1. FC 参数增容（改 [`buildFunctionSpec`](../src/skills/skillLoader.ts#L250-L268)）
目前参数只有一个 `instruction:string`。给函数定义增加**可选第二参** `target_chapter:{ type:string }`，schema 设为 non-required。description 说明：「仅在 script_writer 使用；填入目标章节标识符（建议形如 `S1-1` 序列号或 `SC-S1-1-01` 场景号），引擎据此拼装实际写入路径。」其余九个 subagent 忽略此参不受影响。

#### C-2. Engine 解析注入（改 `executeTool`）
收到 tool_call 后除原有 `instruction` 外再读 `args.target_chapter`。若该 subagent 是 `script_writer` 且提供了值，计算真实写靶：

```
const resolvedPath = `chapters/${targetChapter}.md`
// 例 targetChapter='S1-1' → chapters/S1-1.md
```

将临时副本传给 validator：构造 `effectiveWrites=[resolvedPath,...skill.writes.slice(1)]` 替代原始 `skill.writes`。validator 其余流程不变，依旧提取 START/END 内容写入 `extracted[effectiveWrites[0]]`——零侵入复用既有校验路径。

#### C-3. 为什么不引 `outputMode:'append'`
最初考虑过这条路适配单 history 文件追加，但你的选择是多文件拆分而非追加重叠，故弃用。validator 保持纯 replace 语义反而干净，省下 types/index.ts 与 outputValidator.ts 两处的连带改动。

#### C-4. 安全护栏
- 校验 `targetChapter` 格式严格匹配 `/^[A-Z]\d+-\d+(?:-\d{2})?$/`（命中 `S1-1` 或 `SC-S1-1-01` 任一层级），否则拒发并向 user 报错，杜绝路径穿越风险。
- 同一章节重复请求视为 refine 模式：reads 读到的旧文非空，Writer 自动转入精炼策略（详见 D）。

### D. Script Writer Subagent 定义（热插拔目录）

遵循四层框架归属约定，建文件夹即接入：

```
src/skills/script_writer/
├── subagent.md              # manifest
└── script_writer/
    └── SKILL.md             # system prompt
```

#### D-1. `subagent.md`

```yaml
---
id: script_writer
name: 剧本写作
description: >-
  将场景节拍大纲展开为带对白、描写、情绪密度的真正剧本正文，
  以章节为单位产出独立的 Markdown 文档。仅在『写作阶段』可用。
  每次调用须配合 target_chapter 参数指明本轮撰写哪个章节。
group: 正文章节
---
你是「剧本写作」子智能体……负责把提纲级节拍落实成可直接阅读的剧本文本……
严格遵守上游已锁定资产的设定边界，绝不擅自新增角色或篡改世界规则……
```

`description` 是喂给 Orchestrator FC 的关键字段，措辞要让它在 writing 期能正确挑中。preamble 正文压住两条红线：(a) 只读不改设定；(b) 必须收尾在本章叙事弧内不留悬念悬挂跨章。

#### D-2. `SKILL.md` 结构

```yaml
name: 剧本写作
when: [剧本, 写正文, 章节, 展开, 台词]
reads:
  - worldbuilding.md
  - characters.md
  - act_map.md
  - sequence_list.md
  - scene_beat_outline.md
  - foreshadowing.md
  - subplots.md
  - user_requirements.md
  - _check_report.md
writes:
  - chapters/.placeholder     # 见下方说明
outputTags: ['<<<SCRIPT_START>>>', '<<<SCRIPT_END>>>']
```

说明：
- 因为 frontmatter 无法表达「随 target_chapter 变化」，这里 `writes` 填的是合法 placeholder 让 loader 校验过关；真实路径由 C-2 在 engine 层覆盖。loader 的 [`asArray(data.reads)`](../src/skills/skillLoader.ts#L191) 等解析逻辑完全不必动。
- 注意 loader 有 [`FORBIDDEN_SKILL_KEYS=['subagent','owner','agent']`](../src/skills/skillLoader.ts#L131) 约束，我们不会触碰这几个键，安全。
- body 正文应包含：输入上下文 XML 标签清单、create/refine 双模判定（读 `<chapters_xxxx>` 是否为空）、本章出场人物限定（只能引用 `<characters>` 中存在的）、伏笔落地核对（参考 `<foreshadowing>` 该序列 planned 项必须在正文体现）、长度指引（单章约 2000~4000 字以防超 CONTEXT_LIMIT_CHARS）、START/END 包裹规范、严禁 JSON/YAML/code block 等——整体模仿 [`scene_beats SKILL.md`](../src/skills/scene_beats/scene_beats/SKILL.md) 的体例与口吻以保证一致感。
- 由于 reader 读取的是上一章已完成内容用于连贯性，C-2 resolve 写靶的同时也要 resolve read 额外补充该章节历史文本：assembleContext 时若检测到 `chapters/${prev}.md` 存在则一并包成 `<previous_chapter>` 注入。这部分可作为后续增强，初版可不带。

### E. AssetStore / UI 接入

#### E-1. cards 显示新章节文件
[`getAssetList()`](../src/store/assetStore.ts#L186-L200) 目前过滤 `_` 前缀与 `draft_history.md`。`chapters/S1-1.md` 类文件会被 InMemoryFileManager 自动列入已知路径从而能进入 assets map，但 [`ASSET_META`](../src/store/assetStore.ts#L23) 是从 SUBAGENT_REGISTRY×skills 构建的查不到、中文 FILE_LABELS 也没有。需在该函数兜底：

```
group: meta?.group ?? (path.startsWith('chapters/') ? '正文章节' : '')
filename: FILE_LABELS[path] ?? basename without ext
status // generated/modified/pending 三态沿用
```

并把 `selectCard` 当前的逻辑稍延展支持 `chapters/` 子路径展示。

#### E-2. HeaderBar 锁定入口（改 [`HeaderBar.tsx`](../src/components/Layout/HeaderBar.tsx)）
现版本极简，挂载位充足。增设右区两个互斥控件：
- designing 期：CTA 按钮「🔒 锁定大纲 → 进入写作」。点击前同步 await `useAssetStore.refreshAllFiles()` 再调 `phaseStore.lock(fm)`，失败弹 toast 列出缺口；成功后 version badge 从 v5→v6 或单独标 `(写作中)`。
- writing 期：换成「🔓 解锁回设计期」次要 ghost button + 一个进度文案「已写 X 章 / 共 Y 序列」。

Y 数量来自 `act_map.md` 解析的序列总数（简单 regex 计 `^##\s+S\d+-\d+:`），X 数量来自 FileManager.listAssetFiles 过滤 `chapters/*.md`。这两项放组件本地 useState 异步算即可，不入全局 store。

#### E-3. BaselinePanel 锁定快照视图
[`uiStore.baselineTab`](../src/store/uiStore.ts#L9) 已有 `'approved'|'pre-edit'`。赋予实义：
- writing 期 tab=`'approved'` → BaselinePanel 拉 `phaseStore.getBaseline(selectedCard)` 作左视窗内容；tab=`'pre-edit'` → 拿 `assetStore.previousContent`（实时编辑前一刻快照）维持旧行为不变。
- designing 期 `'approved'` 含义暂等同 pre-edit，等价降级以免破坏现状。

DiffViewer/DiffViewer.tsx 与 utils/diff.ts 无需改，只要左视窗数据源切换到位。

### F. Orchestrator Prompt 补丁（改 [`orchestrator_v5.md`](../src/llm/prompts/orchestrator_v5.md))

软引导为主，强约束交给 Guard。增量段落：

- 在「绝对禁令」末尾加第 5 条：**只在 writing 阶段才使用 `script_writer`，且每次调用务必填写 `target_chapter` 参数指明本章序号**。
- 新增「§写作阶段编排」短节：进入 writing 期后任务变成「按用户指示依次展开某章节」，无须也无权再做幕/序列/节拍的修订；遇到用户说「我想改 XX 设定」时应回复提醒他先解锁回到设计期。
- 在「批量调度策略」注明：`script_writer` 不要与其他工具并行（它的产出体积大易截断 context）。

由于 Guard-1 已确保 designing 期看不到 writer、writing 期看不到 creative tools，这段 prompt 主要服务于体验顺畅与错误友好提示，并非安全保障线。

### G. Reset_all 联动

[`isResetSkill`](../src/orchestrator/orchestratorEngine.ts#L57-L59) 现已在调 `clearAll()` 后回归初始。需叠加一步：调完之后通知 `phaseStore.reset()` 把 phase 打回 `'designing'`、清空 `baselines`。`clearAll()` 本身就会删光包括 `chapters/*.md` 在内的全部 Map entry，故正文章节顺带消失符合预期心智。

---

## H. Scene Beats 子代理重构 · 以序列为单位物理切片（二轮细化）

> 第二轮澄清后的高优演动：把单体输出的 [`scene_beats`](../src/skills/scene_beats/subagent.md) 子代理彻底重构成 per-sequence 多文件生产器，使整套系统名副其实地成为「低密度输入 ↔ 高密度输出」二元隔离体系。**本节优先级最高，凡与前述 A–G 节口径相左之处一律以本节为准。**

### H.0 为什么必须物理切片

现行 [`scene_beats SKILL`](../src/skills/scene_beats/scene_beats/SKILL.md#L65-L96) 把全部序列压扁进单张 `scene_beat_outline.md`，Wiki 式长表轻易冲破数千 token。下游 writer 就算被 Phase Gate 保护住不受上游回流污染，它在 *读取* 这张巨表时仍逃不开经典 attention 衰减——位居表中段的场景细节最先丢失，剧本于是悄悄偏离提纲。

把每个序列抽离成独立 `.md` 之后，writer 单次只需消化一个序列（几百 token）外加少量设定锚点，注意力分布趋于均匀，「lost in middle」风险大幅下降。这正是 B/F 节门控之外的第二道防线：不只是禁止 writer 回写上游，更是主动降低它每一次的有效阅读密度。

### H.1 新数据契约

| 维度 | 旧 | 新 |
|------|----|----|
| 产物 | `scene_beat_outline.md` 单体 | `sequences/S{幕}-{序}.md` × N |
| `writes[0]` | `['scene_beat_outline.md']` | `['sequences/.placeholder']`（dynamic-resolved）|
| 调度粒度 | 一次铺满全书 | 一次铺一个序列（FC 带 `target_sequence`）|
| create/refine 判据 | 读自身旧全文是否非空 | 目标 `sequences/{id}.md` 是否已存在 |
| ID 体系 | `S1-1 → SC-* → B-*` | **不变**（保兼容）|

### H.2 零成本复用动态写靶协议（C-2 同构）

C 节为 script_writer 发明的钥匙在此原样复制：

- [`buildFunctionSpec`](../src/skills/skillLoader.ts#L250-L268) 据 `subagent.id === 'scene_beats'` 附加可选参 `target_sequence: { type:'string' }`，schema non-required，description 示明「格式 `^S\\d+-\\d+$`，指明本轮铺哪一个序列」。其余八个 subagent 无感。
- `executeTool` 收到 `args.target_sequence` 且属合法格式后，构造 `effectiveWrites=[`sequences/${id}.md`, …slice(1)]` 覆盖原 `skill.writes`，[`validateOutput`](../src/orchestrator/outputValidator.ts#L17-L43) 行为零变依旧 single-tag extract → 写入 resolvedPath。
- 安全护栏同 C-4：非法格式拒发回报，杜绝穿越。

由此 scene_beats 与 script_writer 两路切片共享同一套基建（条件挂参 + resolveWriteTarget），代码收敛、心智一致——这也是当初把动态写靶做成通用机制的回报兑现。

### H.3 reads 收窄 & 全局防穿帮参照

新 `scene_beats/SKILL.md` frontmatter `reads` 建议：

```yaml
reads:
  - worldbuilding.md        # 世界规则锚点
  - characters.md           # 人物动机连续性
  - act_map.md              # 幕归属与时序
  - sequence_list.md        # 相邻序列衔接关系
  - foreshadowing.md        # 本序列 planned 伏笔必须落地
  - subplots.md             # 支线穿插不打架
  - user_requirements.md    # 风格基调
```

要点：

- **删除**原先的自读 `scene_beat_outline.md`（单体已不存在）；refine 所需的本序列历史内容由 H.4 的进度感知通路另途供给。
- **保留**全套上层架构作「穿帮防护」参照——即便镜头聚焦单序列，角色弧线、世界规则、支线交错都必须与邻接序列咬合，避免局部精致却全局断裂。
- 注意此处 reads 反而是七项偏多的，但因都是设定层薄文件总量远低于旧版那张巨表，密度安全。

### H.4 已完成序列的感知（create vs refine 自动判定）

难点：静态 `reads` 无法列举运行时已生成的 `sequences/*.md`。三套候选：

| # | 方案 | 评价 |
|---|------|------|
| ① | **指令透传**：Orchestrator 在 `instruction` 中明示「尚未建立的序列：S3-1、S3-2」 | MVP 首选，零侵入；弱点是依赖 Orc 准确记忆，长链路易漏 |
| ② | **asset 清单注入**：[`assembleContext`](../src/orchestrator/contextAssembler.ts#L19-L37) 增可选 meta-block，自动列 `fm.listAssetFiles()` 结果包成 `<existing_assets>` 注入 | 理想做态，一处小扩惠及所有 subagent；中等工程量 |
| ③ | **进度索引文件** `_beats_progress.md` | 引入持久副作用文件，违反最小存储面原则，弃用 |

推荐 MVP 阶段先用 ① 快速验通流程，稳定后升 ②。二者对外部接口透明，可平滑过渡。

### H.5 SKILL body 骨架要点

沿袭现版口吻裁为单序列视角：

- **角色**：「你是『序列场记师』……专注打磨单个序列内部的场景表与节拍表……」
- **双模判定**：依 `<existing_assets>` 或 instruction 提示的目标序列是否已成稿决定 create / refine；refine 模式强守原有 SC-/B-ID 不乱序。
- **场景数上限**：单序列 5–8（旧规 2–5）。理由是单文件承载更多细节也无截断之虞，反压释放。
- **TAG 包裹**：保留 `<<<SCENE_BEAT_OUTLINE_START>>>` / `<<<SCENE_BEAT_OUTLINE_END>>>` 名称复用存量校验逻辑（loader 自然兼容），亦可择日统一切换更具语义的名。
- **强约束**：本序列内必须落地 `<foreshadowing>` 中标记归属于此的 planted/payoff；严禁越界书写其他序列的任何场景。
- **格式稳定性硬规则**照搬现版的 7 列场景表 / 6 列节拍表规范与禁竖线规则。

### H.6 连锁波及一览（实施时务必一并落实）

下列既有条款须随 H 同步修订，避免文档自我矛盾：

| 出处 | 修订动作 |
|------|----------|
| A.`LOCKED_PATHS` 第五项 | 由字符串 `'scene_beat_outline.md'` 概念化为“All generated `sequences/*.md`”；`phaseStore.lock()` 改为遍历 `fm.listAssetFiles()` 过滤此 glob 逐个入 `baselines`，`unlock()` 同法清理对照视图缓存 |
| D.`script_writer` SKILL `reads` | 把指向 `scene_beat_outline.md` 的那条换成 `sequences/${target_chapter}.md`（借同一 resolveWriteTarget 通路喂数据），body 内 `<previous_chapter>` 衔接同理从 `sequences/<prev>.md` 取材 |
| D.preamble 第一红线表述 | 由「只读设定」精确为「只读本章节拍 + 设定」，强化低密度姿态 |
| E-1 `getAssetList` 兜底 | group 兜底区分两类前缀：`path.startsWith('sequences/') ? '大纲结构' : path.startsWith('chapters/') ? '正文章节' : ''` |
| F.Orchestrator Prompt 推荐顺序第 4 步 | 改为「针对每个序列依次（或单轮批 ≤5）调 `scene_beats(target_sequence=…)` 直至 `act_map` 解析出的序列总数全覆盖」 |
| F.绝对禁令增补 | writing 期内严禁回头调 `scene_beats`（已被 Guard-1 拦截，prompt 仅作友好提醒）|
| Verification step 2/5/8 | 改为先验收 `sequences/S1-1.md … Sn-m.md` 逐一落盘、diff 对照各自前一版本 |

### H.7 待二次拍板的一枚追加 question

- **首批铺设体验取舍**：strict one-per-call 模式意味着初次构造一部十几序列的中型作品可能需多轮 `sendMessage` 推进（Orc 每轮 ≤5 tools、共 ≤10 轮，单次会话顶天 50 个序列调用，足够但分段明显）。你是否接受这种「刻意减速」？替代方案是在 engine 开一条 limited-batch 特例允许 `target_sequence` 取数组值触发内部 loop，代价是 `executeTool` 结构变形、并发控制复杂化。个人倾向维持 strict-one 以守住框架对称美感，请你点头定案。

---

## 典型数据流（三种情境的文字时序图）

### Flow-1：完成 scene_beats 后首次锁定
```
User 点 HeaderBar「🔒锁定」
 ├ refreshAllFiles() 确保 seven paths 最新
 ├ phaseStore.lock() 持久快照 + phase→writing
 ├ HeaderBar 重渲：CTA变ghost unlock + 进度0/N
 └ User 发消息「开始写第一章」
    ├ sendMessage → processUserInput
    ├ Guard-1: toolSpecs 仅留 requirements_analyzer + script_writer
    ├ Orc FC 选 script_writer(target_chapter=S1-1,instruction="...")
    ├ Guard-2 pass;executeTool resolveWriteTarget('chapters/S1-1.md')
    ├ assembleContext(reads...) + preamble/body 拼 sysPrompt
    ├ llm.sendMessage → validateOutput(extracted[chapters/S1-1.md])
    ├ fm.writeFile('chapters/S1-1.md', content) ← auto 加入 knownAssetPaths
    └ onEvent(tool_complete,writes=['chapters/S1-1.md']) → assetStore.refreshFile → card 出现 modified 高亮
```

### Flow-2：解锁微调再回来续写
```
User 点「🔓解锁」
 ├ phaseStore.unlock(): phase→designing,baseline 清空,chapters/ 保留✓
 ├ Guard-1 切回 creative visible, writer hidden
 User:「把主角性格里的犹豫去掉」
 ├ characters 工具刷新 → previousContent 更新(diff 可见)
 User 再次「🔒锁定」
 ├ 重新拍照(new baseline 反映最新 characters)
 User:「继续写第二章」→ chapters/S1-2.md 落盘
```

### Flow-3：试图在 writing 期间违规操作
```
Orc 因某种幻觉想在 writing 期调 worldbuilding
 ├ Guard-1 已剔之 → 不在 spec → LLM 根本拿不到该 function name
 即使万一漏过 → Guard-2 catch → emit tool_error,push 拒绝消息,Orc 自纠转向 script_writer
```

---

## 边界情况处理一览

| 场景 | 行为 |
|---|---|
| 未集齐七大资产就点锁定 | `lock()` 抛错并列出缺失文件名，toast 显示，按钮不变红 |
| writing 期反复对同一 `target_chapter` 调用 | 第二次起 reads 命中已存在文件 → refine 模式，diff 左侧为上次该章内容 |
| `MAX_ROUNDS=10` 一轮内写不完用户期望的多章 | 正常现象——引导用户分多次对话推进，每次 round 重置；不在 v6.1 引入 long-run 特例 |
| `CONTEXT_LIMIT_CHARS=22000` 单章逼近上限 | SKILL body 给字数上界 ~4000 字预警；超出由 compressMessages 兜底但不影响单次 writeFile 成功性 |
| reset_all 在 writing 期触发 | 先 clearAll() 再 phaseStore.reset()，一切归零 |
| target_chapter 格式非法或路径穿越意图 | Guard 抛错并回报，不下沉到 LLM |
| Frontmatter parser 不认识的新键 | 我们只用既有支持的扁平 scalar/array，避开 `js-yaml` 间接依赖痛点（见 CLAUDE.md 关于自研解析器的限制记录）|

---

## 影响面汇总（待实施的文件级清单）

| 类型 | 文件 | 性质 |
|---|---|---|
| 新增 | `src/store/phaseStore.ts` | 整文件 |
| 新增 | `src/skills/script_writer/subagent.md` | 整文件 |
| 新增 | `src/skills/script_writer/script_writer/SKILL.md` | 整文件 |
| 改 | [`src/orchestrator/orchestratorEngine.ts`](../src/orchestrator/orchestratorEngine.ts) | Guard-1/2、resolveWriteTarget、reset_all 联动 |
| 改 | [`src/skills/skillLoader.ts`](../src/skills/skillLoader.ts) | `buildFunctionSpec` 增可选 `target_chapter` 参数 |
| 改 | [`src/components/Layout/HeaderBar.tsx`](../src/components/Layout/HeaderBar.tsx) | 锁定/解锁 CTA + 进度 |
| 改 | [`src/store/uiStore.ts`](../src/store/uiStore.ts) | `baselineTab='approved'` 绑定 phaseStore.getBaseline |
| 改 | [`src/store/assetStore.ts`](../src/store/assetStore.ts) | `getAssetList` 对 `chapters/*` 兜底分组命名 |
| 改 | [`src/App.tsx`](../src/App.tsx) | init 时实例化 phaseStore 并接入 HeaderBar props |
| 改 | [`src/llm/prompts/orchestrator_v5.md`](../src/llm/prompts/orchestrator_v5.md) | 增写作阶段编排段与禁令第 5 条 |
| 改 | `.claude/CLAUDE.md` | v6.1 章节 + 修正 Layout 路径笔误 + Subagent 清单加 script_writer |

类型层不动：types/index.ts 现有的 ToolResult/SkillSpec 字段够用；contextAssembler、outputValidator 业务逻辑也不动，仅靠 effectiveWrites 透传达成目的。

---

## Verification（端到端手测步骤）

仓库无自动化测试框架，验收靠人工 e2e：

1. `npm install && npm run dev` 起 Vite HMR，浏览器打开应用。
2. 跑通一遍既有 design 链路直到 `scene_beat_outline.md` 生成有效双表内容（验存量功能未坏）。
3. 此时 HeaderBar 应见 🔒 按钮 enabled；故意删除某个资产文件模拟缺失，点锁定应见报错 toast 且 phase 不变。
4. 恢复齐全后点锁定：观察(a)version/badge 变 writing；(b)左侧资产卡七项应有锁定角标视觉；(c)BaselinePanel 切 'approved' tab 能看到与 Current 相同内容（首拍快照≈当前）。
5. 对话框输「先把第一序列 S1-1 写成正片剧本」。预期 executionLog 出现 `tool_start(script_writer)` → `tool_complete(writes=['chapters/S1-1.md'])`，右侧资产卡新增一项 `S1-1` 于「正文章节」组,status=generated。
6. 在对话框追问「再来 SC-S1-1-02 这个场景所在的下一章」,验证 `target_chapter='S1-2'` 能落到 `chapters/S1-2.md`,与前章共存而不互相覆盖。
7. 故意发消息「帮我顺便把世界观加点东西」——Guard 应回错或 Orchestrator 礼貌劝阻,**worldbuilding.md 内容字节级别不变**(git status/diff 验证)。
8. 点🔓解锁,改一行 characters.md,看 diff 出现;再次🔒锁定;问「继续第三章」落 `chapters/S1-3.md`;确认前面两章文件完好无损。
9. 最后触发 reset_all,验证 `assets` 全空、phase 回 designing、HeaderBar CTA 复位为🔒。
10. 全程 `npx tsc -b` 应绿；DevTools Network 观察 deepseek 调用次数与轮次分布符合预期(writer 单 call ≈ 1 次 LLM 请求)。

辅助 smoke：`VITE_DEEPSEEK_API_KEY=… node test_api.mjs` 验证 FC 带 new param 的兼容性。

---

## 待二次拍板的两枚 open question（non-blocking）

1. **章节 ↔ 序列 还是 ↔ 场景？** 默认建议把「章」等同于「序列 S1-1」（一行戏剧问答自成一章，颗粒适中、token 安全）。但你也可以让一章容纳一个 Act 下的多条 Sequence（更长更沉浸但要担心 CONTEXT_LIMIT_CHARS）。倾向前者，等你点头定案。
2. **是否在锁定/解锁上加 confirm dialog 防误触？** 个人倾向轻量化不加 modal，靠 toast 即时反馈足够；如果你重视防呆再加。
