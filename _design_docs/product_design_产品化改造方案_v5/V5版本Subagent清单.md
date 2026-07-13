# V5 版本 Subagent 清单

> 基于 v4 的 14 个 Subagent，按 `product_design_产品化改造方案_v5/Subagent清单.md` 的需求分析和 `Philosophy_story_structure.md` 的层次定义，重新设计 v5 Subagent 体系。

---

## 一、设计原则

1. **不扩引擎**：v4 的 Tool 注册表声明式架构（reads/writes/dependsOn/FC 映射）不变，新增 Subagent 只需注册
2. **题材感知**：Orchestrator 自动推断故事题材，决定哪些 Subagent 可用/收敛
3. **一个 Tool 可多模式**：伏笔追踪器一个 Tool 两个调用模式（规划/审计），由 Orchestrator 按阶段传不同 instruction
4. **支线本质是序列或场景**：支线开辟后在 sequence_list / scene_beat_outline 中以标签形式嵌入，生命周期由 SubplotManager 管理
5. **框架深度增强**：幕-序列-场景-节拍四层按 `Philosophy_story_structure.md` 扩展信息维度，以新增列/章节的方式融入现有资产文件

---

## 二、资产文件全景

### 核心资产（6 → 10 个）

| 文件 | 说明 | 生成 Tool | 精炼/操作 Tool |
|------|------|-----------|---------------|
| `worldbuilding.md` | 世界观设定 / 环境描述 | generate_worldbuilding | refine_worldbuilding |
| `characters.md` | 角色设定 | generate_characters | refine_characters |
| `plot_synopsis.md` | 剧情大纲 | generate_plot_synopsis | refine_plot_synopsis |
| `act_map.md` | 幕结构（★ 增强） | generate_act_map | refine_act_map |
| `sequence_list.md` | 序列清单（★ 增强） | generate_sequence_list | refine_sequence_list |
| `scene_beat_outline.md` | 场景节拍（★ 增强） | generate_scene_beats | refine_scene_beats |
| `foreshadowing.md` | 伏笔/信息披露追踪 | — | foreshadowing_tracker（规划/审计） |
| `subplots.md` | 支线管理 | — | subplot_manager（开辟/合并） |
| `draft_history.md` | 审计修改记录（自动维护） | — | — |

> `draft_history.md` 由 foreshadowing_tracker 审计未通过时自动写入，记录哪些文件在审计轮次中被修改，用于控制修改边界。

### 收敛机制说明

世界观的输出形态取决于题材推断：
- **奇幻/科幻/架空题材**：世界观 Subagent 正常调用，输出完整的 6 章节设定集
- **现代/都市/历史现实题材**：世界观 Subagent 降级为"环境描述"模式——输出简短的时空背景段落（1-3 段），而不是架空设定集
- **判断依据**：Orchestrator 从用户输入中自动推断，不依赖用户手动选择

---

## 三、Subagent 完整清单

### 3.1 基础设定组（与 v4 一致，收敛调用）

#### ① generate_worldbuilding — 世界观设定师

| 字段 | 定义 |
|------|------|
| **读取** | 无 |
| **写入** | `worldbuilding.md` |
| **TAG** | `<<<WORLDBUILDING_START/END>>>` |
| **用途** | 按题材生成完整世界观或环境描述 |
| **收敛** | 非幻想题材 → 环境描述模式（1-3 段时空背景） |
| **dependsOn** | 无 |

#### ② refine_worldbuilding — 世界观精炼师

| 字段 | 定义 |
|------|------|
| **读取** | `worldbuilding.md` |
| **写入** | `worldbuilding.md` |
| **TAG** | 同上 |
| **用途** | 修改已有世界观/环境描述 |

#### ③ generate_characters — 角色设定师

| 字段 | 定义 |
|------|------|
| **读取** | `worldbuilding.md` |
| **写入** | `characters.md` |
| **TAG** | `<<<CHARACTERS_START/END>>>` |
| **用途** | 生成角色（主角 + 配角） |
| **收敛** | 按题材控制角色数量上限 |

#### ④ refine_characters — 角色精炼师

| 字段 | 定义 |
|------|------|
| **读取** | `characters.md`, `worldbuilding.md` |
| **写入** | `characters.md` |

#### ⑤ generate_plot_synopsis — 剧情架构师

| 字段 | 定义 |
|------|------|
| **读取** | `worldbuilding.md`, `characters.md` |
| **写入** | `plot_synopsis.md` |
| **TAG** | `<<<PLOT_SYNOPSIS_START/END>>>` |
| **用途** | 生成核心冲突 + 三幕主线 + 主题 |

#### ⑥ refine_plot_synopsis — 剧情精炼师

| 字段 | 定义 |
|------|------|
| **读取** | `plot_synopsis.md`, `worldbuilding.md`, `characters.md` |
| **写入** | `plot_synopsis.md` |

---

### 3.2 宏观结构组（★ 深度增强）

#### ⑦ generate_act_map — 幕结构生成器

**核心变化**：按 `Philosophy_story_structure.md` 扩展信息维度，支持 3-12 幕。

| 字段 | 定义 |
|------|------|
| **读取** | `worldbuilding.md`, `characters.md`, `plot_synopsis.md` |
| **写入** | `act_map.md` |
| **TAG** | `<<<ACT_MAP_START/END>>>` |
| **幕数** | 3-12 幕（v4 仅 3-4） |
| **输出结构** | 单张宽表，列扩展为： |

| 列 | 说明 | 来源 |
|----|------|------|
| 幕编号 | 第1幕、第2幕…第N幕 | v4 原有 |
| 幕定位 | 宏观阶段划分（建置/对抗/解决…） | v4 原有 |
| 篇幅占比 | 百分比 | v4 原有 |
| 核心任务 | 该幕的核心叙事任务 | v4 原有 |
| **转折点（情节点）** | 幕与幕之间的关键转折 | **新增** |
| **情感弧线** | 该幕的情感动向（共鸣→打破→挣扎→释放…） | **新增** |
| **主角状态** | 主角在该幕中的状态迁移 | **新增** |
| **世界状态** | 世界在该幕中的状态变迁 | **新增** |
| 核心冲突升级 | 该幕主要冲突 | v4 原有 |
| 必须解决的叙事项 | 该幕必须完成的事项列表 | v4 原有 |

**结构类型适配**：Orchestrator 在调用前，根据用户需求判断结构类型（三幕剧/英雄之旅/救猫咪等），生成不同的幕数量和定位模板。模板数据可参考 `story_structure.md` 的 17 种结构。

#### ⑧ refine_act_map — 幕结构精炼师

| 字段 | 定义 |
|------|------|
| **读取** | `act_map.md`, `worldbuilding.md`, `plot_synopsis.md` |
| **写入** | `act_map.md` |

---

#### ⑨ generate_sequence_list — 序列清单生成器

**核心变化**：按 `Philosophy_story_structure.md` 扩展信息维度，每幕 2-N 序列。

| 字段 | 定义 |
|------|------|
| **读取** | `worldbuilding.md`, `characters.md`, `plot_synopsis.md`, `act_map.md` |
| **写入** | `sequence_list.md` |
| **TAG** | `<<<SEQUENCE_LIST_START/END>>>` |
| **输出结构** | 单张宽表，列扩展为： |

| 列 | 说明 | 来源 |
|----|------|------|
| 序列ID | S{幕号}-{序号} | v4 原有 |
| 所属幕 | 幕编号 | v4 原有 |
| 序列定位/命名 | 如"绑架序列"、"监狱适应序列" | v4 原有 |
| **核心任务（短期目标）** | 该序列要完成的短期目标 | **新增** |
| **统一语境（Context）** | 该序列只讲"一件事"——目标、时间、地点、事件 | **新增** |
| **戏剧问题** | 是/非问句："主角能否达成X？" | **新增** |
| **三幕微结构位置** | 建置/上升/高潮/回落 | **新增** |
| **新鲜信息（Fresh News）** | 序列结束时必须提供的信息 | **新增** |
| 必须完成的事件 | 列表 | v4 原有 |
| 可选钩子 | 可选 | v4 原有 |
| **关联支线** | 若属于某支线，标记 subplot_id | **新增** |

#### ⑩ refine_sequence_list — 序列清单精炼师

| 字段 | 定义 |
|------|------|
| **读取** | `sequence_list.md`, `act_map.md` |
| **写入** | `sequence_list.md` |

---

### 3.3 信息披露组（★ 新增）

#### ⑪ foreshadowing_tracker — 伏笔/信息披露追踪器

**说明**：一个 Tool 两个调用模式，由 Orchestrator 在不同阶段传入不同 instruction 来区分。

##### 模式A：规划（在 sequence_list 生成后调用）

| 字段 | 定义 |
|------|------|
| **读取** | `act_map.md`, `sequence_list.md` |
| **写入** | `foreshadowing.md` |
| **TAG** | `<<<FORESHADOWING_START/END>>>` |
| **目的** | 分析幕-序列结构，规划哪些信息需要铺设、在哪个序列铺设、预期在哪个序列回收 |
| **输出结构** | 表格： |

| 列 | 说明 |
|----|------|
| 伏笔ID | F-{序号} |
| 信息名称 | 一段自然语言描述该信息 |
| 信息类型 | 情感性 / 功能性 / 主题性 |
| 铺设序列 | 序列ID → 首次出现该信息的序列 |
| 预期回收序列 | 序列ID → 信息完整揭示的序列 |
| 当前状态 | pending（未铺设）/ active（铺设中）/ resolved（已回收） |
| 关联角色 | 该信息涉及的角色 |
| **关联支线** | 若需开辟支线展开此信息，标记 subplot_id（初始为空） |

##### 模式B：审计（在 scene_beat_outline 生成后调用）

| 字段 | 定义 |
|------|------|
| **读取** | `act_map.md`, `sequence_list.md`, `scene_beat_outline.md`, `foreshadowing.md` |
| **写入** | `foreshadowing.md`（更新状态）, `draft_history.md`（写入审计结果） |
| **TAG** | 同上 |
| **目的** | 检查伏笔/信息披露的铺设和回收是否在场景节拍中正确落地 |
| **输出结构** | 审计报告 + 状态更新 |

**审计逻辑**：
1. 对比 foreshadowing.md 中的预期 vs scene_beat_outline.md 中的实际
2. 标记每个伏笔的实际状态：
   - ✅ 已铺设 — 在预期序列的场景中找到了对应内容
   - ❌ 未铺设 — 预期序列中缺失该信息
   - ✅ 已回收 — 在预期回收序列的场景中找到了对应内容
   - ❌ 未回收 — 到了回收序列但场景中未揭示
3. 写入 `draft_history.md` 记录审计结果

**Orchestrator 对审计未通过的处理**：
- 审计不通过的伏笔 → Orchestrator 判断问题出在哪个层级：
  - **序列层问题**（铺设点/回收点规划不合理）→ 调 refine_sequence_list 修改序列规划
  - **场景节拍层问题**（内容未落地）→ 调 refine_scene_beats 修改场景节拍
- **修改轮次边界**：`draft_history.md` 记录每轮修改，累计超出上限（建议 3 轮）后强制退出，告知用户

---

### 3.4 微观精铸组（★ 深度增强）

#### ⑫ generate_scene_beats — 场景节拍精铸师

**核心变化**：按 `Philosophy_story_structure.md` 扩展，场景层增加"目标-冲突-结果"结构 + 时空边界。

| 字段 | 定义 |
|------|------|
| **读取** | 全部上游文件 + `foreshadowing.md`（可读模式A的结果做信息铺设参考） |
| **写入** | `scene_beat_outline.md` |
| **TAG** | `<<<SCENE_BEAT_OUTLINE_START/END>>>` |
| **输出结构** | 宽表，列扩展为： |

| 列 | 说明 | 来源 |
|----|------|------|
| 场景ID | SC-{序列ID}-{2位序号} | v4 原有 |
| 所属序列 | 序列ID | v4 原有 |
| 场景功能 | 推动叙事的微观动作 | v4 原有 |
| **场景目标（Objective）** | 角色进入场景时想要什么 | **新增** |
| **冲突与障碍** | 什么阻碍了角色达成目标 | **新增** |
| **场景结果（Outcome）** | 目标达成/被拒绝/改变 | **新增** |
| **时空边界** | 地点 + 时间（换地点/跳时间 = 新场景） | **新增** |
| 视角人物 | 谁的视角 | v4 原有 |
| 节拍序号 | B-{场景ID}-{序号} | v4 原有 |
| **节拍类型** | 铺垫/触发/对抗/转折/收束（扩展中允许更多类型） | v4 原有（扩展） |
| **动作-反应描述** | 动作→反应机制，标记情感/权力位移 | **新增** |
| 情绪/信息变化 | 该节拍带来的变化 | v4 原有 |
| 承接钩子 | 上下衔接 | v4 原有 |
| **关联伏笔** | 该场景铺设或回收的伏笔ID | **新增** |
| **关联支线** | 若属于某支线，标记 subplot_id | **新增** |

**节拍类型说明**：v4 固定 5 种类型。v5 保留 铺垫/触发/对抗/转折/收束 作为基础类型，可根据题材类型的需要扩展（如悬疑可增加"线索发现"类型），由生成时的 instruction 控制。

#### ⑬ refine_scene_beats — 场景节拍精炼师

| 字段 | 定义 |
|------|------|
| **读取** | `scene_beat_outline.md`, `act_map.md`, `sequence_list.md`, `foreshadowing.md` |
| **写入** | `scene_beat_outline.md` |

**新增职责**：精炼时需参考 foreshadowing.md 中的审计结果，补充缺失的伏笔铺设/回收。

---

### 3.5 支线管理组（★ 新增）

#### ⑭ subplot_manager — 支线管理器

**说明**：负责支线的开辟、执行、合并回收。一个 Tool 覆盖全生命周期。

| 字段 | 定义 |
|------|------|
| **读取** | `characters.md`, `foreshadowing.md`, `act_map.md`, `sequence_list.md`, `scene_beat_outline.md`（取决于阶段） |
| **写入** | `subplots.md`（生命周期记录）+ 修改对应 scene_beat_outline.md 或 sequence_list.md（插入支线内容） |
| **TAG** | `<<<SUBPLOTS_START/END>>>` |

**生命周期流程**：

```
┌──────────────────────────────┐
│ 阶段1：开辟                   │
│ Orchestrator 判断：           │
│ 某信息是否需要支线展开？      │
│ → 确定支线的叙事功能          │
│ → 确定驱动角色（依赖角色）    │
│ → 确定规模（场景级/序列级）   │
│ → 写入 subplots.md            │
│ → 在 sequence_list.md 标记    │
│   "关联支线：subplot_id"      │
└──────────┬───────────────────┘
           ▼
┌──────────────────────────────┐
│ 阶段2：执行                   │
│ 支线内容嵌入常规生成流程：     │
│ • 序列级支线 → 在              │
│   generate_sequence_list 时   │
│   将支线序列加入对应幕        │
│ • 场景级支线 → 在              │
│   generate_scene_beats 时     │
│   将支线场景加入对应序列      │
│ 支线场景/序列在表中           │
│ "关联支线"列标记 subplot_id   │
└──────────┬───────────────────┘
           ▼
┌──────────────────────────────┐
│ 阶段3：合并/回收              │
│ 支线内容写入主线后：          │
│ → subplots.md 标记已完成     │
│ → 关联伏笔更新为 resolved    │
│ → 状态标记 "已合并"           │
│ 后续不再独立维护              │
└──────────────────────────────┘
```

**subplots.md 输出结构**：

| 列 | 说明 |
|----|------|
| 支线ID | SP-{序号} |
| 叙事功能 | 为什么需要这个支线 |
| 驱动角色 | 谁驱动这条支线（characters.md 中的角色） |
| 关联伏笔 | 这条支线服务的伏笔ID |
| 规模 | scene / sequence |
| 开始位置 | 序列ID 或 场景ID（从哪里开始） |
| 结束位置 | 序列ID 或 场景ID（在哪里结束汇入主线） |
| 交叉点 | 与主线交汇的位置列表 |
| 当前状态 | active / merged |

---

### 3.6 系统组

#### ⑮ reset_all — 系统重置工具

保持不变。清空所有资产文件（含新增的 foreshadowing.md、subplots.md、draft_history.md）。

#### ⑯ orchestrator — 总监理与工具决策者

**核心变化**：

| 能力 | v4 | v5 |
|------|----|----|
| 题材感知 | 无 | 自动推断题材，裁剪可用 Tool |
| 世界观收敛 | 总是全量生成 | 按题材决定世界观模式 |
| 结构类型适配 | 固定 3-4 幕 | 按结构类型适配幕数量和定位 |
| 伏笔规划 | 无 | 序列生成后 → 调 foreshadowing_tracker 模式A |
| 伏笔审计 | 无 | 场景生成后 → 调 foreshadowing_tracker 模式B |
| 审计不通过处理 | 无 | 判断问题层级 → 调度对应 refine → 控轮次 |
| 支线管理 | 无 | 开辟/合并调度 |
| 修改轮次边界 | 5 轮 FC 上限 | 同上 + 审计修改轮次上限（建议 3 轮） |

---

## 四、Subagent 依赖图

```
题材感知 (Orchestrator 层)
        │
        ▼
世界观 ([收敛逻辑] 按题材决定模式)
  │
  ▼
角色
  │
  ▼
剧情大纲
  │
  ▼
幕结构 (★ 增强: 3-12幕 + 情感弧线 + 状态迁移)  ◄── 结构类型适配 (Orchestrator 层)
  │
  ▼
────── 分岔 ──────
│                │
▼                ▼
序列 (★ 增强)     伏笔规划
│  (planned)      │ (模式A)
│                │
├────────────────┤
│                │
▼                ▼
场景节拍 (★ 增强)  伏笔审计
│  (actual)       │ (模式B) ── ❌ 未通过 ──→ Orchestrator 判断层级 ──→ refine_序列/场景
│                │                   │                               │
│                │                   ├── 3 轮边界                     │
│                │                   ▼                               │
│                │               draft_history.md                    │
├────────────────┤                                                   │
│                                                                     │
▼                             ◄── 若需开辟
支线管理器 (开辟 → 执行 → 合并)
     │
     └── 依赖: characters.md, foreshadowing.md
```

---

## 五、与 v4 的对比一览

| 维度 | v4 | v5 |
|------|----|----|
| 资产文件数 | 6 | 10（+foreshadowing + subplots + draft_history + 已有的 6 个增强） |
| Subagent 数 | 14（6 gen + 6 ref + 1 reset + 1 orch） | 16（6 gen + 6 ref + 1 foreshadowing_tracker + 1 subplot_manager + 1 reset + 1 orch） |
| 世界观 | 总是全量 | 按题材收敛，2 种模式 |
| 幕 | 3-4 幕，6 列 | 3-12 幕，10 列 |
| 序列 | 5 列，功能简单 | 11 列，含戏剧问题/统一语境/新鲜信息/微结构 |
| 场景节拍 | 10 列，节奏驱动 | 15+ 列，含目标-冲突-结果+时空+关联伏笔+关联支线 |
| 伏笔管理 | 无 | 规划+审计两阶段，闭环修复 |
| 支线管理 | 无（纯单线） | 全生命周期（开辟→执行→合并） |
| 结构类型 | 固定三幕 | 可适配多种结构模板 |
| 修改闭环 | 单轮 refine | 审计→修改→再审计，多轮闭环 |

---

## 六、新增/变更的 ToolSpec 注册汇总

```typescript
// v5 新增或变更的 ToolSpec（相对于 v4）

// ★ 新增：伏笔追踪器（一个 Tool 两个模式）
{
  id: 'foreshadowing_tracker',
  name: '伏笔与信息披露追踪器',
  description: '规划伏笔的铺设与回收位置，或审计场景节拍的伏笔落地情况',
  systemPromptFile: 'prompts/foreshadowing_tracker.md',
  reads: ['act_map.md', 'sequence_list.md'],          // 模式A
  // reads: ['act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'foreshadowing.md'],  // 模式B（由 orchestrator 传入不同 instruction 控制）
  writes: ['foreshadowing.md', 'draft_history.md'],
  outputTags: ['<<<FORESHADOWING_START>>>', '<<<FORESHADOWING_END>>>'],
  group: '信息披露',
  dependsOn: ['sequence_list.md'],                    // 至少序列生成后才能规划
}

// ★ 新增：支线管理器
{
  id: 'subplot_manager',
  name: '支线管理器',
  description: '开辟、执行、合并回收支线剧情',
  systemPromptFile: 'prompts/subplot_manager.md',
  reads: ['characters.md', 'foreshadowing.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md'],
  writes: ['subplots.md'],
  outputTags: ['<<<SUBPLOTS_START>>>', '<<<SUBPLOTS_END>>>'],
  group: '支线管理',
  dependsOn: ['characters.md', 'foreshadowing.md'],
}

// ★ 增强：generate_scene_beats — 依赖链增加 foreshadowing.md
{
  id: 'generate_scene_beats',
  reads: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md'],
  // ↑ 新增 foreshadowing.md 以便在生成场景时主动铺设/回收伏笔
}

// ★ 增强：refine_scene_beats — 依赖链增加 foreshadowing.md
{
  id: 'refine_scene_beats',
  reads: ['scene_beat_outline.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md'],
  // ↑ 新增 foreshadowing.md 以便根据审计结果修复场景节拍
}
```

---

## 七、Orchestrator 调度逻辑变更

### 题材感知逻辑（orchestrator 层新增）

```typescript
// 伪代码——在 processUserInput 开始前执行
function inferGenre(userInput: string): GenreProfile {
  // 检测关键词判断题材
  // 返回: { genre: 'fantasy'|'sci-fi'|'modern'|'historical'|..., 
  //          worldbuildingMode: 'full'|'minimal',
  //          structureTemplate: 'three-act'|'hero-journey'|'save-the-cat'|etc }
}

// 根据题材裁剪工具可用性
function getToolsByGenre(genre: GenreProfile): ToolSpec[] {
  if (genre.worldbuildingMode === 'minimal') {
    // worldbuilding tool 仍然可用，但 orchestrator 在其 instruction 中注明"只需环境描述"
  }
}
```

### 审计闭环逻辑（新增）

```typescript
// 伪代码——在 scene_beats 生成后
async function auditAndFix(sceneBeats: ToolResult) {
  const MAX_AUDIT_ROUNDS = 3
  let auditRound = 0

  while (auditRound < MAX_AUDIT_ROUNDS) {
    const result = await executeTool(foreshadowingTracker, 'AUDIT', ...)
    if (result.auditPassed) break

    // 判断问题层级
    const layer = classifyIssue(result.issues)
    if (layer === 'sequence') {
      await executeTool(refineSequenceList, result.fixInstruction, ...)
    } else if (layer === 'scene_beat') {
      await executeTool(refineSceneBeats, result.fixInstruction, ...)
    }
    auditRound++
  }
}
```

### 支线生命周期调度（新增）

```
1. 序列生成后 → orchestrator 判断伏笔中是否有需要支线展开的
    → 若有 → 调 subplot_manager（开辟模式）
    → 将支线 ID 标记到 sequence_list 的"关联支线"列

2. 场景节拍生成时 → 关联支线的场景纳入对应序列

3. 支线完成后 → orchestrator 调 subplot_manager（合并模式）
    → subplots.md 标记 "merged"
```

---

## 八、新的 prompt 文件清单

| 文件 | 说明 |
|------|------|
| `prompts/foreshadowing_tracker.md` | 伏笔追踪器（规划+审计双模式 instruction） |
| `prompts/subplot_manager.md` | 支线管理器（开辟/执行/合并） |

需要修改的已有 prompt（按 **★ 增强**标注的内容扩展）：

| 文件 | 修改内容 |
|------|---------|
| `prompts/generate_act_map.md` | 扩展到 10 列，支持 3-12 幕，结构模板注入 |
| `prompts/refine_act_map.md` | 对应扩展 |
| `prompts/generate_sequence_list.md` | 扩展到 11 列，含戏剧问题/统一语境/新鲜信息 |
| `prompts/refine_sequence_list.md` | 对应扩展 |
| `prompts/generate_scene_beats.md` | 扩展到 15+ 列，含目标-冲突-结果/时空/关联伏笔/关联支线 |
| `prompts/refine_scene_beats.md` | 对应扩展 + 审计修复职责 |
| `prompts/orchestrator_v4.md` | 题材感知 + 审计闭环 + 支线生命周期调度逻辑 |
