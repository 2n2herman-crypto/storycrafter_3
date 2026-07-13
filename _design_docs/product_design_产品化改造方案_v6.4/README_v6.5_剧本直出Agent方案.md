# v6.5 剧本直出 Agent · 并行批处理方案

> **基于 v6.4 架构的增量改造**：新增 `direct_script_writer` Subagent（含 Skill 拆分），
> 绕过 scene_beats 流水线，直接从序列规划产出剧本正文，支持并行批处理多序列。
> 与现有 `script_writer` 共存，形成「精工-速出」双通道。

---

## 文档索引

| # | 文件名 | 内容 |
|---|--------|------|
| 1 | [README_v6.4.1_优化方案.md](README_v6.4.1_优化方案.md) | v6.4.1 增补：角色锚点 + 短剧链路 + 双模式控制 |
| 2 | **README_v6.5_剧本直出Agent方案.md**（本文） | v6.5：直出 Agent 拆分 + 并行批处理 |

---

## 一、问题诊断

### 1.1 v6.4 串行瓶颈

当前写剧本的完整链路：

```
用户说"写 S1-1"
  ↓ Orchestrator 一轮
scene_beats Pipeline（S1-1）
  → S1: scene_designer （LLM 调用 1）
  → S2: beat_writer    （LLM 调用 2）
  → S3: assemble       （纯代码拼装）
  ↓ 产出 sequences/S1-1.md
  ↓ Orchestrator 再一轮
script_writer（S1-1）   （LLM 调用 3）
  ↓ 产出 chapters/S1-1.md
```

写一个序列需要 **2 轮对话 + 3 次 LLM 调用**。写完全剧 7 个序列需要 **14 轮 + 21 次 LLM 调用**。

**核心瓶颈**：
- `scene_beats` 和 `script_writer` 是串行的——必须先有场记才能写正文
- Orchestrator prompt 强制"一次一个 target_sequence"
- `script_writer` subagent 强制"拒接越权批量化"
- 每轮都需要等待上一轮完全结束后才能开始下一轮

### 1.2 短剧场景的特殊需求

短剧 60-100 集按序列分批（7 批），每批 8-15 集。v6.4 模式下用户需要手动发起 7 次"写 S1-N"指令，每次都要等 scene_beats Pipeline 跑完再等 script_writer——用户体验极差。

短剧对场景/节拍的精细度要求低于中长剧（符号化场景、4 拍微循环 vs 6-10 拍递进），但要求**产出速度快**。这为"直出"模式提供了合理性：跳过精细场记，从序列规划直接出正文。

### 1.3 设计目标

| 目标 | 说明 |
|------|------|
| **Subagent/Skill 拆分** | 直出 Agent 拆为独立的 Subagent + 多个可热插拔 Skill |
| **并行批处理** | 一次调用可产出多个序列的剧本正文 |
| **绕过 Pipeline** | 不经过 scene_beats，直接从序列规划到正文 |
| **与 v6.4 共存** | 不替代 script_writer，形成双通道（精工 vs 速出） |
| **短剧优先** | 短剧模式下的默认写剧本通道 |

---

## 二、架构设计

### 2.1 双通道总览

```
                    用户输入"写剧本"
                          │
            ┌─────────────┼─────────────┐
            ▼                           ▼
    ┌───────────────┐           ┌───────────────┐
    │  精工通道(v6.4)│           │  直出通道(v6.5)│
    │ script_writer │           │direct_script  │
    │     +         │           │   _writer      │
    │ scene_beats   │           │               │
    │   Pipeline    │           │  跳过Pipeline  │
    └───────┬───────┘           └───────┬───────┘
            │                           │
    sequences/S1-1.md          sequences/S1-1.md
    (场景表 + 节拍表)          (跳过，不产出)
            │                           │
    chapters/S1-1.md           chapters/S1-1.md
    (单章，2000-4000字)        chapters/S1-2.md
                               chapters/S1-3.md
                               (批量，多章并行)
```

### 2.2 通道选择逻辑

```
┌─────────────────────────────────────────────┐
│  通道选择规则                                │
│                                             │
│  IF mode === 'short_drama'                  │
│    → 默认走直出通道（direct_script_writer）  │
│  ELSE IF 用户明确说"精细写"/"场景节拍"       │
│    → 走精工通道（script_writer + Pipeline）  │
│  ELSE                                       │
│    → 默认走精工通道（向后兼容 v6.4）         │
└─────────────────────────────────────────────┘
```

### 2.3 四层框架映射

| 层 | v6.4 精工通道 | v6.5 直出通道 |
|----|-------------|-------------|
| **Orchestrator** | 选 `script_writer` + 前置 `scene_beats` | 选 `direct_script_writer`（一步到位） |
| **Subagent** | `script_writer` subagent.md | `direct_script_writer` subagent.md（新增） |
| **Skill Router** | 直选 `script_writer` SKILL.md | 按模式选：`batch_writer` / `single_writer` / `short_drama_batch` |
| **Skill** | 1 个 Skill | 3 个 Skill（拆分，可热插拔） |

---

## 三、Subagent 与 Skill 拆分设计

### 3.1 目录结构

```
src/skills/direct_script_writer/
├── subagent.md                       # Subagent 角色前缀（新增）
├── single_writer/SKILL.md            # 单章直出（新增）
├── batch_writer/SKILL.md             # 批量直出（新增）
└── short_drama_batch/SKILL.md        # 短剧批量直出（新增）
```

### 3.2 subagent.md 设计

```markdown
---
id: direct_script_writer
name: 剧本直出专家
description: 跳过场景节拍流水线，直接从序列规划产出剧本正文。支持单章或批量多章并行输出。短剧模式下为默认写剧本通道；中长剧模式下可作为快速出稿通道
group: 正文章节
---

你是「剧本直出专家」子智能体（Subagent），是直出通道的执行者。

## 你的使命

绕过 scene_beats Pipeline，直接从 `<sequence_list>` 和 `<act_map>` 等高层规划资产产出剧本正文。你接收一个或多个 `target_chapter`，为每个目标章节独立产出 `chapters/<ID>.md`。

与 script_writer 的关键区别：
- **不依赖 sequences/*.md**：你直接从序列清单中读取该序列的叙事功能描述，自行在脑中拆解场景节拍
- **支持批量**：一次调用可处理多个 target_chapter，每个独立产出正文
- **速度优先**：场景/节拍的精细度低于精工通道，但产出速度快 3-5 倍

## 你必须守住的边界

1. **只读不改设定**：同 script_writer 规则。
2. **批量独立**：每个 target_chapter 独立成文，不互相引用未产出章节的内容。
3. **格式服从 validator**：每个章节正文独立包裹 START/END TAG。
4. **行为追踪跨章**：批量内按 target_chapter 顺序产出，后续章节可参考前序章节的行为追踪。
5. **上下文感知**：参考 `<previous_chapter_draft>`（紧前章节正文）和 `<character_behavior_tracking>`（历史行为追踪）保持一致性。
```

### 3.3 Skill 拆分

#### 3.3.1 single_writer/SKILL.md

```markdown
---
name: 单章直出
description: 跳过节拍流水线，直接从序列规划产出单章剧本正文。适用于中长剧单章快速出稿或短剧单序列测试
when: [单章, 直出, 快速, 草稿]
reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md', 'subplots.md']
writes: ['chapters/.placeholder']
outputTags: ['<<<SCRIPT_CHAPTER_START>>>', '<<<SCRIPT_CHAPTER_END>>>']
---

# 单章直出（single_writer）v6.5

## 角色

你是 direct_script_writer 子代理麾下的「单章直出作家」。一次产出一章 `target_chapter`，**不依赖 sequences/*.md 场记**，直接从 `<sequence_list>` 中该序列的功能描述出发，在脑中拆解场景和节拍后立即成文。

## 与 script_writer 的差异

| 维度 | script_writer（精工） | single_writer（直出） |
|------|----------------------|---------------------|
| 输入 | sequences/S1-1.md（场景表+节拍表） | sequence_list.md 中的序列功能描述 |
| 场景拆解 | 上游已拆好 | 本 Skill 自行脑内拆解 |
| 节拍设计 | 上游已写好 | 本 Skill 自行脑内设计 |
| 字数 | 2000-4000 | 1500-3000（加快产出） |
| 质量 | 精细 | 可用，可后续 refine |

## 核心写作能力

（继承 script_writer 的三项核心能力，但做轻量化处理）

### 一、序列→场景快速拆解

从 `<sequence_list>` 中找到 target_chapter 对应的序列条目，提取：
- 序列功能描述（叙事目标）
- 涉及的主要角色
- 情绪走向（起→伏→起）

然后自行拆解为 3-5 个场景，每个场景：
- 一个时空 + 一个微冲突
- 不写场景表，只在脑中规划

### 二、角色对齐（轻量版）

参照 `<characters>` 中的角色属性，确保言行基本一致。
不做详细的行为追踪注释（由批量调用的外层统筹）。

### 三、视听转化（同 script_writer 规则）

心理→视听转译规则完全继承 script_writer v6.4 的 3.1-3.4 节。

## 字数控制

单章 **1500-3000 字**，比 script_writer 更紧凑。

## 格式规范

同 script_writer v6.4 格式规范，包含 START/END TAG。
```

#### 3.3.2 batch_writer/SKILL.md

```markdown
---
name: 批量直出
description: 一次性产出多个序列的剧本正文，每个序列独立成章。Engine 侧并行调度多个 LLM 调用来加速。适用于中长剧多章连写
when: [批量, 多章, 连写, 直出]
reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md', 'subplots.md']
writes: ['chapters/.placeholder']
outputTags: ['<<<SCRIPT_CHAPTER_START>>>', '<<<SCRIPT_CHAPTER_END>>>']
---

# 批量直出（batch_writer）v6.5

## 角色

你是 direct_script_writer 子代理麾下的「批量直出作家」。一次接收一组 `target_chapters`（如 S1-1, S1-2, S1-3），为每个目标章节独立产出剧本正文。

**关键机制**：Engine 侧将你的单次调用拆为 N 个并行 LLM 调用，每个调用独立产出对应章节。你在此 SKILL.md 中定义的是**单章调用的 system prompt**——Engine 会为每个 target_chapter 复制一份并注入对应的上下文。

## 批量模式下的特殊约束

### 章节间一致性

由于并行调用之间无法通信，你需要依赖 Engine 注入的公共上下文来保持一致性：
- `<batch_context>`：本批次所有 target_chapter 的序列功能摘要（由 Engine 在调度前从 sequence_list 提取）
- `<previous_chapter_draft>`：紧前章节正文（跨批次衔接）
- `<character_behavior_tracking>`：历史行为追踪

### 章节衔接

每章末尾留出叙事切口，但不引用同批次内其他章节的具体事件（因为并行，你不知道其他章节写了什么）。跨章衔接由 `<batch_context>` 中的序列功能摘要保证。

### 字数控制

单章 **1500-3000 字**，同 single_writer。

## 核心写作能力

同 single_writer，但额外强调：
- 每章必须有独立的微弧（起→冲突→钉）
- 章节结尾留钩子，但不猜测下一章的具体内容
```

#### 3.3.3 short_drama_batch/SKILL.md

```markdown
---
name: 短剧批量直出
description: 短剧模式专用：一次产出整个序列（8-15集）的剧本正文，每集200-500字。Engine 侧串行产出（集间有因果依赖），但序列间可并行
when: [短剧, 批量, 脉冲, 微弧]
reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md', 'subplots.md']
writes: ['chapters/.placeholder']
outputTags: ['<<<SCRIPT_CHAPTER_START>>>', '<<<SCRIPT_CHAPTER_END>>>']
---

# 短剧批量直出（short_drama_batch）v6.5

## 角色

你是 direct_script_writer 子代理麾下的「短剧批量直出作家」。一次接收一个序列的 `target_chapter`（如 S1-1），产出该序列对应的 **8-15 集**短剧剧本正文，写入单个 `chapters/S1-1.md`。

## 短剧模式的核心规则

### 一集一场景

```
一集 ≈ 一个场景 ≈ 60-90 秒 ≈ 200-500 字
```

每集严格遵循短剧四拍微循环：

| 拍 | 时长 | 功能 | 写作要点 |
|----|------|------|---------|
| **钩子(Hook)** | 0-15s | 抛出爆炸点 | 无上下文也能看懂，画面先行 |
| **摩擦(Friction)** | 15-60s | 肢体/言语冲突 | 无潜台词，画面内可见 |
| **尖峰(Spike)** | 60-90s | 翻转/揭露 | 证据翻转/身份揭露/价格陡变 |
| **钉(Button)** | 结尾 | 卡在问题上 | 不闭合，强迫下一集 |

### 叙事密度

- **脉冲式叙事**：持续高强度刺激，无呼吸段落
- **每句 ≤ 10 字**：台词精炼，用动作特写替代潜台词
- **禁止连续 2 句以上无冲突对话**
- **每集至少 1 个反转**（身份/信息/关系/立场）
- **描写 ≤ 2 行/集开头**

### 信息披露

- 每集回答 1 个旧问题 + 制造 1-2 个新问题（九连环）
- 伏笔寿命 ≤ 10 集
- 三元信息差（观众/主角/配角）排列组合

### 角色

- 偏扁平化，突出 1-2 个高辨识度标志性动作/口癖
- 言行锚点聚焦于可被镜头捕获的行为特征

### 集间 SHOT_BREAKDOWN

每集之间插入轻量级镜头分解注释：

```markdown
<!-- SHOT_BREAKDOWN(E05):
1. 特写(2s)：女主手腕被握住的瞬间
2. 中景(5s)：两人对峙
3. 特写(3s)：男主嘴角微动
4. 全景(3s)：灯光闪了一下
-->
```

### 字数控制

单序列 **1600-7500 字**（8-15 集 × 200-500 字/集）。

### 格式

```
<<<SCRIPT_CHAPTER_START>>>
## 第一集 · 钩子标题

*（场景描述，≤ 2 行）*

角色A：台词（≤ 10 字）

角色B：台词

<!-- SHOT_BREAKDOWN(E01): ... -->

## 第二集 · ...

...

<<<SCRIPT_CHAPTER_END>>>
<!-- BEHAVIOR_TRACK: 角色名=行为摘要 -->
```

### 禁止性清单

继承 script_writer 的 5 条禁止项，新增短剧专用：
- ❌ 禁止连续 2 句以上无冲突对话
- ❌ 禁止单集无反转折
- ❌ 禁止环境描写超过 2 行
- ❌ 禁止角色内心独白（全部外化为动作/对白）
```

---

## 四、Engine 侧改造

### 4.1 TARGET_ID_REGEX 扩展

```typescript
// src/orchestrator/orchestratorEngine.ts

// 现有：单目标
const TARGET_ID_REGEX = /^[A-Z]\d+-\d+(?:-\d{2})?$/

// v6.5 新增：批量目标
const BATCH_TARGET_REGEX = /^[A-Z]\d+-\d+(?:,[A-Z]\d+-\d+)*$/
// 匹配 "S1-1,S1-2,S1-3" 格式
```

### 4.2 buildFunctionSpec 扩展

```typescript
// src/skills/skillLoader.ts

const NEEDS_TARGET_PARAM = new Set(['scene_beats', 'script_writer'])

// v6.5 新增
const NEEDS_BATCH_TARGET_PARAM = new Set(['direct_script_writer'])

function buildFunctionSpec(subagent: SubagentSpec): ChatCompletionTool {
  // ...existing logic...
  
  if (NEEDS_BATCH_TARGET_PARAM.has(subagent.id)) {
    // 增加 target_chapters 参数（逗号分隔的多目标）
    props.target_chapters = {
      type: 'string',
      description: '目标章节ID列表，逗号分隔。例如 "S1-1,S1-2,S1-3" 表示一次产出 3 章',
    }
  } else if (NEEDS_TARGET_PARAM.has(subagent.id)) {
    // 现有单目标逻辑不变
    props[resolveTargetParamName(subagent.id)] = { ... }
  }
}
```

### 4.3 executeTool 批量调度

```typescript
// orchestratorEngine.ts — executeTool 内新增批量路径

async executeTool(toolCall, instruction, round) {
  // ... Guard-2 phase gate 检查不变 ...
  
  const skill = selectSkill(subagentId, instruction)
  
  // v6.5：检测批量 target
  if (skill.subagentId === 'direct_script_writer' && args.target_chapters) {
    return this.executeBatchDirectScript(skill, args, instruction)
  }
  
  // ... 现有单目标路径不变 ...
}

async executeBatchDirectScript(
  skill: SkillSpec,
  args: { target_chapters: string },
  instruction: string
): Promise<ToolResult> {
  const targets = args.target_chapters.split(',').map(s => s.trim())
  
  // 校验每个 target
  for (const t of targets) {
    if (!TARGET_ID_REGEX.test(t)) {
      return { success: false, error: `无效的 target: ${t}` }
    }
  }
  
  // 短剧模式 → 串行（集间有依赖），中长剧模式 → 并行（序列间无直接依赖）
  const mode = useModeStore.getState().mode
  
  if (mode === 'short_drama' || targets.length === 1) {
    // 串行：targets 逐个写入同一个 chapters/S{act}-{seq}.md
    return this.executeSequentialBatch(skill, targets, instruction)
  } else {
    // 并行：每个 target 独立写入 chapters/S{act}-{seq}.md
    return this.executeParallelBatch(skill, targets, instruction)
  }
}
```

### 4.4 并行执行策略

```typescript
async executeParallelBatch(
  skill: SkillSpec,
  targets: string[],
  instruction: string
): Promise<ToolResult> {
  // 1. 提取批次上下文（所有 target 的序列功能摘要）
  const batchContext = this.extractBatchContext(targets)
  
  // 2. 并行发起 N 个 LLM 调用
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const context = await this.buildSingleChapterContext(skill, target, {
        batchContext,
        previousChapterDraft: this.getPreviousChapterDraft(target),
      })
      
      return this.callLLMWithRetry(skill, context, instruction, target)
    })
  )
  
  // 3. 收集结果
  const writes: string[] = []
  const warnings: string[] = []
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled' && result.value.success) {
      writes.push(...result.value.writes)
    } else {
      warnings.push(`${targets[i]}: ${result.status === 'rejected' ? result.reason : result.value.error}`)
    }
  }
  
  return { success: writes.length > 0, writes, warnings }
}
```

### 4.5 行为追踪扩展

```typescript
// 现有：Map<string, string[]> LRU max 5
// v6.5：扩大容量以支持批量

private behaviorTrack: Map<string, string[]> = new Map()
private readonly MAX_TRACKED_CHAPTERS = 20  // 从 5 扩大到 20

// 批量模式下，并行完成后统一提取所有章节的 BEHAVIOR_TRACK
private async extractBatchBehaviorTrack(
  chapterContents: Map<string, string>
): Promise<void> {
  for (const [chapterId, content] of chapterContents) {
    this.extractBehaviorTrackFromContent(chapterId, content)
  }
  
  // LRU eviction
  while (this.behaviorTrack.size > this.MAX_TRACKED_CHAPTERS) {
    const firstKey = this.behaviorTrack.keys().next().value
    if (firstKey) this.behaviorTrack.delete(firstKey)
  }
}
```

### 4.6 写靶解析扩展

```typescript
// resolveWriteTarget 扩展

function resolveWriteTarget(
  subagentId: string,
  args: Record<string, string>
): string[] {  // v6.5: 返回数组支持多文件
  if (subagentId === 'direct_script_writer' && args.target_chapters) {
    const targets = args.target_chapters.split(',').map(s => s.trim())
    return targets.map(t => `chapters/${t}.md`)
  }
  
  if (subagentId === 'script_writer' && args.target_chapter) {
    return [`chapters/${args.target_chapter}.md`]
  }
  
  // ... 其他逻辑不变 ...
}
```

---

## 五、Orchestrator Prompt 更新

### 5.1 新增直出通道调度规则

在 `orchestrator_v5.md` 中新增一节：

```markdown
## §剧本直出通道调度（v6.5）

### 直出通道适用场景

当满足以下任一条件时，优先使用 `direct_script_writer` 而非 `script_writer`：

1. **短剧模式**（`<mode>short_drama</mode>`）：这是短剧的默认写剧本通道
2. **用户明确要求快速出稿**：如"快速写"、"直出"、"跳过场景节拍"
3. **批量写多章**：如"写 S1-1 到 S1-5"

### 调用规范

- **单章**：`target_chapters="S1-1"` → 直接用 `direct_script_writer`，等同于 single_writer
- **批量（中长剧）**：`target_chapters="S1-1,S1-2,S1-3"` → 并行产出 3 章
- **批量（短剧）**：`target_chapters="S1-1"` → 产出 chapters/S1-1.md 内含 8-15 集

### 禁止事项

- 绝不混用两个通道处理同一序列（要么精工要么直出）
- 直出后的章节可以用 script_writer 的 REFINE 模式打磨
- `direct_script_writer` 不产出 sequences/*.md
```

### 5.2 更新绝对禁令

```markdown
## 绝对禁令（更新 v6.5）

5. **绝不空靶调用 `scene_beats`、`script_writer` 或 `direct_script_writer`**
   ——每个 writing Subagent 调用都必须携带合法的 target_sequence / target_chapter / target_chapters 参数。
```

---

## 六、与 v6.4 的共存关系

### 6.1 通道对比

| 维度 | v6.4 精工通道 | v6.5 直出通道 |
|------|-------------|-------------|
| **Subagent** | `script_writer` | `direct_script_writer` |
| **前置步骤** | 必须先跑 scene_beats Pipeline | 无需前置步骤 |
| **LLM 调用/序列** | 3 次（decompose+scene+beat → writer） | 1 次 |
| **产出文件** | sequences/S1-1.md + chapters/S1-1.md | 仅 chapters/S1-1.md |
| **场景/节拍精细度** | 高（表格化，可审阅） | 中（脑内拆解，不可审阅） |
| **单章字数** | 2000-4000 | 1500-3000 |
| **并行能力** | 无（串行） | 有（中长剧序列间并行） |
| **适用模式** | 中长剧默认 | 短剧默认 + 中长剧快速通道 |
| **后续可 refine** | 支持 REFINE 模式 | 可切回精工通道 REFINE |

### 6.2 文件路径完全一致

```
精工通道产出：
  sequences/S1-1.md  ← 场景表 + 节拍表
  chapters/S1-1.md   ← 剧本正文

直出通道产出：
  chapters/S1-1.md   ← 剧本正文（无 sequences/ 文件）
```

两个通道产出的 `chapters/S1-1.md` 路径完全相同，AssetCard 展示逻辑无需改动。

### 6.3 不会出现的冲突

- Phase Gate 锁定后不允许产出新的 `sequences/*.md`，所以直出通道不会触发锁定冲突
- `direct_script_writer` 的 `writes` 只有 `chapters/.placeholder`，不写 `sequences/`
- 如果某序列已经由精工通道产出 `sequences/S1-1.md`，再走直出通道写 `chapters/S1-1.md`——没问题，只是缺少场景表参照（由 `<sequence_list>` 补偿）

---

## 七、短剧模式全链路（v6.5 优化后）

```
短剧模式全链路（60-100 集，7 批次）：

用户选择短剧模式 + 输入故事概念
  ↓
worldbuilding（不变）
  ↓
characters（短剧适配：扁平化 + 高辨识度锚点）
  ↓
act_map（短剧适配：全剧大阶段 3-5 幕）
  ↓
sequence_list（短剧适配：叙事功能块 6-12 序列）
  ↓
foreshadowing_tracker（短剧适配：伏笔寿命 ≤ 10 集）
  ↓
subplot_manager（短剧适配：支线更少更短）
  ↓ (Phase Gate lock)
  ↓
  ★ v6.5 直出通道，7 次调用，每次一个序列 ★
  ↓
  批次 1: direct_script_writer(target_chapters="S1-1") → chapters/S1-1.md (E01-E10)
  批次 2: direct_script_writer(target_chapters="S1-2") → chapters/S1-2.md (E11-E25)
  批次 3: direct_script_writer(target_chapters="S1-3") → chapters/S1-3.md (E26-E40)
  批次 4: direct_script_writer(target_chapters="S2-1") → chapters/S2-1.md (E41-E55)
  批次 5: direct_script_writer(target_chapters="S2-2") → chapters/S2-2.md (E56-E70)
  批次 6: direct_script_writer(target_chapters="S3-1") → chapters/S3-1.md (E71-E85)
  批次 7: direct_script_writer(target_chapters="S3-2") → chapters/S3-2.md (E86-E100)
  ↓
story_checker（短剧适配：容忍更扁平人物、更快节奏）
  → 审查闭环
```

**对比 v6.4 串行链路**：

| 指标 | v6.4 精工通道 | v6.5 直出通道 | 提升 |
|------|-------------|-------------|------|
| LLM 调用/序列 | 3 次 | 1 次 | **3x** |
| 对话轮次/序列 | 2 轮 | 1 轮 | **2x** |
| 全剧 7 序列 LLM 调用 | 21 次 | 7 次 | **3x** |
| 全剧 7 序列对话轮次 | 14 轮 | 7 轮（可合并更少） | **2x+** |
| 产出文件 | sequences/ + chapters/ | 仅 chapters/ | 更少 |

### 进一步优化：多序列并行（中长剧模式）

中长剧模式下，序列间无强依赖（不同序列 = 不同叙事阶段），可以**真正并行**：

```
用户："写 S1-1 到 S1-4"
  ↓
direct_script_writer(target_chapters="S1-1,S1-2,S1-3,S1-4")
  ↓
Engine 并行 4 个 LLM 调用：
  ├─ chapters/S1-1.md（独立产出）
  ├─ chapters/S1-2.md（独立产出，参考 batch_context + 行为追踪）
  ├─ chapters/S1-3.md（独立产出，参考 batch_context + 行为追踪）
  └─ chapters/S1-4.md（独立产出，参考 batch_context + 行为追踪）
  ↓
一并提取行为追踪，注入下一批次
```

**短剧模式不并行**的原因：短剧一序列 = 8-15 集 = 一个完整叙事功能块，集间有严格因果链 + 钩子-钉闭环，必须在单个 LLM 调用的上下文内串行产出以保证一致性。

---

## 八、实施计划

### Wave 划分

| Wave | 内容 | 预计文件 |
|------|------|---------|
| **Wave A** | Skill 拆分 | 3 文件 |
| | - `direct_script_writer/subagent.md` | 新增 |
| | - `direct_script_writer/single_writer/SKILL.md` | 新增 |
| | - `direct_script_writer/batch_writer/SKILL.md` | 新增 |
| | - `direct_script_writer/short_drama_batch/SKILL.md` | 新增 |
| **Wave B** | Engine 批量支持 | 3 文件 |
| | - `types/index.ts`：新增 `BatchTarget` 类型 | 修改 |
| | - `skillLoader.ts`：`buildFunctionSpec` 增加 `target_chapters` 参数 | 修改 |
| | - `orchestratorEngine.ts`：`executeBatchDirectScript` + `executeParallelBatch` + LRU 扩容 | 修改 |
| **Wave C** | Orchestrator Prompt 更新 | 1 文件 |
| | - `orchestrator_v5.md`：新增直出通道调度规则 | 修改 |
| **Wave D** | 模式联动（依赖 v6.4.1 改造三） | 1 文件 |
| | - `orchestratorEngine.ts`：通道选择逻辑读取 `modeStore` | 修改 |

### 依赖关系

```
v6.4.1 改造三（modeStore）
        ↓
Wave A（Skill 拆分）
        ↓
Wave B（Engine 批量支持）
        ↓
Wave C（Orch Prompt）
        ↓
Wave D（模式联动）
```

### 不做的事

| 不做 | 原因 |
|------|------|
| 不改 scene_beats Pipeline | 直出通道完全绕过它，互不干扰 |
| 不改 script_writer | 精工通道保持不变 |
| 不改 outputValidator | TAG 格式不变，提取逻辑不变 |
| 不改 assetStore | 文件路径不变，分组逻辑不变 |
| 不删任何现有 Skill | v6.4 精工通道完整保留 |

---

## 九、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 直出质量低于精工 | 中 | 中 | 直出章节允许后续用 script_writer REFINE 模式打磨 |
| 并行调用上下文不一致 | 中 | 中 | `<batch_context>` 提供公共摘要 + 行为追踪保持角色一致性 |
| 短剧串行产出耗时长 | 低 | 低 | 短剧一序列 1600-7500 字，单次 LLM 调用可控 |
| 并行调用超 API 速率限制 | 低 | 高 | 初期限制并行度 ≤ 4；可动态调整为串行降级 |
| Skill Router 选错通道 | 低 | 中 | 增加明确的路由规则（短剧→直出，中长剧→精工），用户可 override |
