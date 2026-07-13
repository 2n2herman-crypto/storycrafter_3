# V5 Subagent 总览

> 聚合参考文档。定义全部 9 个 Subagent、资产文件、依赖关系与运行时流程。
>
> **关键变更**：gen/refine 合并为单一 Tool（模式由文件存在与否自动推断）、所有检查项归入 story_checker。
>
> **架构决策**：所有 Tool 始终在 FC 列表中可见。dependsOn 仅为推荐顺序的元信息，不做代码拦截。结构感由每个 Tool 的 prompt 定义其层级位置来维持。

---

## 一、Subagent 一览表

| # | Tool ID | 名称 | 组 | 写入 | TAG | 说明 |
|---|---------|------|----|------|-----|------|
| 1 | `worldbuilding` | 世界观设定 | 基础设定 | `worldbuilding.md` | WORLDBUILDING | 完整模式输出，收敛由用户手动调整 prompt |
| 2 | `characters` | 角色设定 | 基础设定 | `characters.md` | CHARACTERS | 上游依赖世界观 |
| 3 | `act_map` | 幕结构 | 大纲结构 | `act_map.md` | ACT_MAP | **★增强** 3-12 幕，10 列宽表，吸收 plot_synopsis 职能 |
| 4 | `sequence_list` | 序列清单 | 大纲结构 | `sequence_list.md` | SEQUENCE_LIST | **★增强** 11 列，含戏剧问题/统一语境 |
| 5 | `scene_beats` | 场景节拍 | 微观精铸 | `scene_beat_outline.md` | SCENE_BEAT_OUTLINE | **★增强** 15 列，含目标-冲突-结果 |
| 6 | `foreshadowing_tracker` | 伏笔规划 | 信息披露 | `foreshadowing.md` | FORESHADOWING | 只做规划，审计由 story_checker 执行 |
| 7 | `subplot_manager` | 支线管理 | 支线 | `subplots.md` | SUBPLOTS | 开辟→执行→合并全生命周期 |
| 8 | `story_checker` | 故事审查 | 检查 | `_check_report.md` | CHECK_REPORT | 全维度统一检查器，不阻塞流程 |
| 9 | `reset_all` | 系统重置 | 系统 | — | — | 清空所有资产 |

> **orchestrator** 不计入 Subagent 清单。它是调度引擎，工具选择由其驱动，不产出资产。

---

## 二、资产文件对照

### 9 个核心资产文件

| 文件 | 负责 Tool | 读取方 | 生命周期 |
|------|----------|--------|---------|
| `worldbuilding.md` | worldbuilding | characters, act_map, sequence_list, scene_beats, story_checker | 创建→修改→(收敛控制) |
| `characters.md` | characters | act_map, sequence_list, scene_beats, subplot_manager, story_checker | 创建→修改 |
| `act_map.md` | act_map | sequence_list, scene_beats, foreshadowing_tracker, subplot_manager, story_checker | **★增强** 创建→修改→结构适配 |
| `sequence_list.md` | sequence_list | scene_beats, foreshadowing_tracker, subplot_manager, story_checker | **★增强** 创建→修改→(标记支线) |
| `scene_beat_outline.md` | scene_beats | story_checker | **★增强** 创建→修改→(关联伏笔/支线) |
| `foreshadowing.md` | foreshadowing_tracker | subplot_manager, story_checker | 规划→更新 |
| `subplots.md` | subplot_manager | story_checker | 开辟→active→merged |
| `_check_report.md` | story_checker | story_checker（前次结果参考） | 每次覆盖 |
| `draft_history.md` | —（自动维护） | — | 审计+修改记录 |

> `draft_history.md` 不由任何 Tool 直接写入，由 orchestrator 在 story_checker → refine 循环中自动维护。

### 文件依赖链（推荐生成顺序）

> 以下为推荐顺序，**非强制**。所有 Tool 始终对 orchestrator 可见，LLM 可根据用户需求灵活调整顺序。
> 缺失上游时 reads 中的对应标签为空，LLM 自然理解"没有上游参照"并直接基于用户描述输出。

```
worldbuilding.md  ← 独立，无上游
  │
  ▼
characters.md  ← 推荐世界观之后生成
  │
  ▼
act_map.md  ← 推荐世界观+角色之后（吸收 plot_synopsis 职能）
  │
  ▼
sequence_list.md  ← 推荐幕结构之后
  │
  ├──► foreshadowing.md  ← 推荐序列之后规划
  │
  ▼
scene_beat_outline.md  ← 推荐序列之后生成（可跳过伏笔直接生成）
  │
  ├──► subplots.md  ← 推荐有伏笔规划后开辟
  │
  ▼
_check_report.md  ← 推荐场景生成后审查
```

---

## 三、Tool 注册定义

### 合并模式说明

5 个基础工具（worldbuilding / characters / act_map / sequence_list / scene_beats）采用**合并模式**：

| 场景 | 表现 |
|------|------|
| 自身文件不存在 | → 引擎上下文为空 → LLM 自动进入"创建模式" |
| 自身文件已存在 | → 引擎注入文件内容 → LLM 自动进入"修改模式"（最小改动） |

**不需要 mode 参数**，不依赖 Orchestrator 判断。LLM 通过上下文是空还是满自然区分。

**ToolSpec 定义变化**：

```typescript
// v4（两套）
{
  id: 'generate_worldbuilding',
  reads: [],                    // 不读自己
  dependsOn: [],                // 永远可用
}
{
  id: 'refine_worldbuilding',
  reads: ['worldbuilding.md'],  // 读自己
  dependsOn: ['worldbuilding.md'],  // 必须有
}

// v5（合并）
{
  id: 'worldbuilding',
  reads: ['worldbuilding.md'],  // 自己在 reads 中
  dependsOn: [],                // 永远可用——文件不存在就创建，存在就修改
}
```

### 9 个 ToolSpec 定义

> **注意**：dependsOn 仅作为推荐顺序的元信息，不参与代码拦截。
> 引擎层 `getAvailableTools()` 直接返回全部 TOOL_REGISTRY，不再过滤。
> 结构感由每个 Tool 的 prompt 定义其层级位置 + reads 空标签机制维持。

```typescript
// 1. 世界观设定
{
  id: 'worldbuilding',
  reads: ['worldbuilding.md'],
  writes: ['worldbuilding.md'],
  outputTags: ['<<<WORLDBUILDING_START>>>', '<<<WORLDBUILDING_END>>>'],
  group: '基础设定',
  dependsOn: [],
}

// 2. 角色设定
{
  id: 'characters',
  reads: ['worldbuilding.md', 'characters.md'],
  writes: ['characters.md'],
  outputTags: ['<<<CHARACTERS_START>>>', '<<<CHARACTERS_END>>>'],
  group: '基础设定',
  dependsOn: ['worldbuilding.md'],
}

// 3. 幕结构（★增强）
{
  id: 'act_map',
  reads: ['worldbuilding.md', 'characters.md', 'act_map.md'],
  writes: ['act_map.md'],
  outputTags: ['<<<ACT_MAP_START>>>', '<<<ACT_MAP_END>>>'],
  group: '大纲结构',
  dependsOn: ['worldbuilding.md', 'characters.md'],
}

// 4. 序列清单（★增强）
{
  id: 'sequence_list',
  reads: ['worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md'],
  writes: ['sequence_list.md'],
  outputTags: ['<<<SEQUENCE_LIST_START>>>', '<<<SEQUENCE_LIST_END>>>'],
  group: '大纲结构',
  dependsOn: ['worldbuilding.md', 'characters.md', 'act_map.md'],
}

// 5. 场景节拍（★增强）
{
  id: 'scene_beats',
  reads: ['worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'foreshadowing.md'],
  writes: ['scene_beat_outline.md'],
  outputTags: ['<<<SCENE_BEAT_OUTLINE_START>>>', '<<<SCENE_BEAT_OUTLINE_END>>>'],
  group: '微观精铸',
  dependsOn: ['worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md'],
}

// 6. 伏笔规划
{
  id: 'foreshadowing_tracker',
  reads: ['act_map.md', 'sequence_list.md', 'foreshadowing.md'],
  writes: ['foreshadowing.md'],
  outputTags: ['<<<FORESHADOWING_START>>>', '<<<FORESHADOWING_END>>>'],
  group: '信息披露',
  dependsOn: ['sequence_list.md'],
}

// 7. 支线管理
{
  id: 'subplot_manager',
  reads: ['characters.md', 'foreshadowing.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'subplots.md'],
  writes: ['subplots.md'],
  outputTags: ['<<<SUBPLOTS_START>>>', '<<<SUBPLOTS_END>>>'],
  group: '支线管理',
  dependsOn: ['foreshadowing.md'],
}

// 8. 故事审查
{
  id: 'story_checker',
  reads: ['worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'scene_beat_outline.md', 'foreshadowing.md', 'subplots.md', '_check_report.md'],
  writes: ['_check_report.md'],
  outputTags: ['<<<CHECK_REPORT_START>>>', '<<<CHECK_REPORT_END>>>'],
  group: '检查',
  dependsOn: ['scene_beat_outline.md'],
}

// 9. 系统重置
{
  id: 'reset_all',
  reads: [],
  writes: [],
  outputTags: [],
  group: '系统',
  dependsOn: [],
}
```

---

## 四、运行时流程

### 标准创作流程（示例，非强制）

> 以下流程展示推荐顺序。实际上所有 Tool 始终可见，orchestrator 可根据用户需求跳序调用。

```
用户输入: "写一个科幻故事..."

① Tool 调度循环（FC 5轮上限 + 审计 3轮上限）

   Round 1: worldbuilding（创建世界观）→ characters（创建角色）
   Round 2: act_map（创建幕结构，含剧情方向）
   Round 3: sequence_list → foreshadowing_tracker（规划伏笔）
   Round 4: subplot_manager（如有支线需求）→ scene_beats
   Round 5: story_checker
      ├── ✅ 通过 → 回复用户
      └── ❌ 未通过 → orchestrator 判断问题层级
           ├── 序列层问题 → sequence_list → 再检查
           ├── 场景层问题 → scene_beats → 再检查
           └── 最多 3 轮审计修复
```

### 分支流程

**修改已有故事**：
```
用户: "把女主角改成更强势的性格"
→ characters（自身文件已存在→修改模式）
→ story_checker（验证修改后的一致性）
→ 回复用户
```

**添加支线**：
```
用户: "给男配角加一条爱情支线"
→ foreshadowing_tracker（补充规划这条支线涉及的信息披露）
→ subplot_manager（开辟支线）
→ scene_beats（在对应序列插入支线场景）
→ story_checker
→ 回复用户
```

**跳过上游直接生成下游**：
```
用户: "先写第3幕的几个关键场景，世界观后面再补"
→ scene_beats（reads 中 worldbuilding/characters/act_map 均为空）
→ Subagent 基于用户描述直接输出场景节拍，保持幕ID→序列ID编号体系
→ 后续补齐世界观后，可再调 scene_beats 做一致性对齐
```

---

## 五、检查器与修改闭环

```
story_checker 执行
      │
      ▼
  生成 _check_report.md
      │
      ▼
Orchestrator 读取报告
      │
      ├── PASS → 回复用户
      │
      └── FAIL → 判断修复层级
            │
            ├── 序列层（戏剧问题不符/统一语境缺失）
            │   → 调 sequence_list（修改模式）
            │   → increment audit_round
            │   → story_checker 再次
            │
            ├── 场景层（伏笔未铺设/目标-冲突缺失）
            │   → 调 scene_beats（修改模式）
            │   → increment audit_round
            │   → story_checker 再次
            │
            └── 支线层（支线未合并/信息未回收）
                → 调 subplot_manager（合并模式）
                → increment audit_round
                → story_checker 再次
      │
      └── audit_round >= 3 → 强制退出，告知用户
```

检查周期上限：**3 轮**（硬限制）。超限后强制退出。

---

## 六、v4 → v5 变更总览

| 变更项 | v4 | v5 |
|--------|----|----|
| Tool 数量 | 14（6 gen + 6 ref + 1 reset + 1 orch） | 9（5 合并 + 1 伏笔规划 + 1 支线管理 + 1 检查 + 1 reset）+ orch |
| FC Function 列表 | 12-14 个（按 dependsOn 过滤） | 9 个（全部始终可见，dependsOn 仅为元信息） |
| 资产文件 | 6 | 9 |
| 世界观模式 | 固定全量 | 全量（收敛控制由用户手动优化 prompt） |
| 幕结构 | 3-4 幕，6 列 | 3-12 幕，10 列 |
| 序列结构 | 5 列 | 11 列 |
| 场景节拍 | 10 列 | 15 列 |
| 伏笔管理 | 无 | 规划（foreshadowing_tracker）+ 审计（story_checker） |
| 支线管理 | 无 | 全生命周期（subplot_manager） |
| 检查能力 | 无（无格式校验以外的检查） | 6 维度统一检查 |
| 修改闭环 | gen → refine（手动） | generate → check → fix → recheck（自动 3 轮） |
