# v6.4.1 设计文档优化 · 三大改造方案（修正版）

> 基于 v6.4 原有四份设计文档 + 短剧逻辑.md 研究，补齐三项结构性缺口：
> 1. 角色 Subagent 能力缺陷（言行锚点）
> 2. 短剧四层结构 → 剧本/视听脚本转换链路（**结构不变，内容适配**）
> 3. 双产品模式（短剧/中长剧）前端控制
>
> **v6.4.1 修正说明**（2026-07-11）：
> - 修正资产逻辑：**一序列一文件，结构不变**——短剧模式不引入 per-episode 文件路径，sequences/S{幕}-{序}.md 和 chapters/S{幕}-{序}.md 仍是最小资产单位
> - 修正设计理念：短剧适配是在**同一文件结构内做内容密度和列语义的适配**，不是改变文件组织方式
> - 修正模式参数：移除 `chapterPathFormat` 等涉及文件路径变化的参数

---

## 文档索引

| # | 文件名 | 内容 |
|---|--------|------|
| 1 | [01_角色Subagent改造方案.md](#一角色-subagent-改造方案补全言行锚点) | characters SKILL.md 输出格式扩展 + subagent.md preamble 更新 |
| 2 | [02_短剧转换链路方案.md](#二短剧四层结构--剧本视听脚本转换链路) | 短剧模式内容适配策略 + 视听脚本层设计（同文件、不同内容） |
| 3 | [03_双模式前端控制方案.md](#三双产品模式前端控制方案) | 模式选择器 + 参数注入 + 各层联动规则 |

---

## 一、角色 Subagent 改造方案（补全言行锚点）

### 1.1 问题诊断

当前 `characters/SKILL.md` 输出 8 项属性表：

| 属性 | 内容 |
|------|------|
| 姓名 | 角色全名 |
| 身份 | 角色在故事中的身份/职业/地位 |
| 年龄 | 年龄范围或具体年龄 |
| 性格 | 核心性格特征（3-5 个关键词） |
| 动机 | 角色想要什么、为什么 |
| 弧光 | 角色在故事中的成长轨迹 |
| 外貌 | 外形特征描述 |
| 世界观关联 | 角色与世界观/环境的关系 |

但 v6.4 写作 Agent 的「能力二：角色对齐与反 OOC」要求 Writer 参照角色的**言行锚点**来保持一致性：

| 锚点类型 | 说明 | 示例 |
|----------|------|------|
| 语言风格 | 句式偏好、用词习惯、语气 | "多用短句，习惯用反问，自称'老子'" |
| 身体语言 | 标志性动作/姿态 | "紧张时会摸左腕手表，愤怒时反而声音更轻" |
| 行为模式 | 压力下的典型反应 | "面对权威角色时回避眼神接触但坚持己见" |

这三类锚点在当前 `characters.md` 输出中**完全缺失**——Writer 只能从"性格"列模糊推断，导致角色言行一致性缺乏硬参照。

### 1.2 改造内容

#### 1.2.1 characters SKILL.md 输出格式扩展

在现有 8 项属性表后追加**「言行锚点」子表**：

```markdown
### 角色名

| 属性 | 内容 |
|------|------|
| 姓名 | ... |
| ...（现有 8 项不变）... |

**言行锚点**

| 维度 | 描述 |
|------|------|
| 语言风格 | 句式偏好（长句/短句）、习惯用语、口癖、对高位/低位角色的称呼变化 |
| 身体语言 | 标志性姿态、紧张/愤怒/放松时的习惯动作、空间距离偏好 |
| 行为模式 | 面对冲突/压力/亲密关系时的典型反应模式 |
```

**关键设计决策**：

- 言行锚点作为**可选子表**（主角和重要配角必有，其他配角省略），不强制所有角色输出
- 锚点内容要求**具体可拍摄**：不写"性格暴躁"，写"愤怒时拍桌→起身→踱步→压低声音"这类可被镜头捕获的链式行为
- 保留现有 8 项属性表不动（INV-3 零破坏），锚点子表是纯增量

#### 1.2.2 SKILL.md 正文增加「言行锚点编写指南」

在「每个角色的属性表」之后增加一节：

```markdown
### 言行锚点（主角与重要配角必有）

**原则**：锚点是角色在「可被镜头捕获」层面的行为指纹，不重复性格列已有的抽象特征。

#### 语言风格锚点
- 句式偏好（短句/长句/反问句/命令句）
- 对高位角色的称呼变化（正式→随意、尊称→直呼的转换时机）
- 习惯用语/口癖（每角色限 1-2 个，以免标签化）

#### 身体语言锚点
- 静止状态下的习惯姿态（站姿/坐姿/手部位置）
- 紧张/愤怒/放松时的标志性动作（每个情绪态限 1 个具象动作）
- 与人互动时的空间距离偏好（近身/保持距离/因角色而异）

#### 行为模式锚点
- 面对冲突时倾向于进攻/回避/谈判/沉默——并写出典型行为链而非单动作
- 面对压力时的情绪显露方式（外化/内化/转移）
- 对特定角色类型（权威/晚辈/异性/对手）的固定反应模式

**禁止**：锚点中出现「性格倔强」「为人善良」等纯形容词——每一条锚点都必须描述一个具体可视的动作或语言特征。
```

#### 1.2.3 subagent.md preamble 更新

在角色定位段增加一条责任边界：

```markdown
## 你的责任边界

4. **言行锚点是下游写作质量的硬依赖**：主角和重要配角必须输出「言行锚点」子表（语言风格/身体语言/行为模式三列）。下游 script_writer 依赖这些锚点来维持跨章节角色言行一致性——若锚点缺失，Writer 只能从「性格」列模糊推断，极易产生 OOC 漂移。锚点必须是「可被镜头捕获」的具体行为特征，不能是纯形容词堆砌。
```

### 1.3 影响面

| 文件 | 改动性质 |
|------|----------|
| `src/skills/characters/characters/SKILL.md` | **实质改动**——输出格式增加言行锚点子表 + 新增编写指南节 |
| `src/skills/characters/subagent.md` | **小改**——preamble 新增角色锚点责任边界 |
| 其他 | 无影响（reads/writes/outputTags 不变） |

### 1.4 v6.4 写作 Agent 联动

Writer 的 SKILL.md 2.1 节「言行锚点参照」已经有对应的使用规范：

> 若角色有写作锚点（语言风格、身体语言、压力反应模式），则角色首次在本章登场时按锚点塑造…

现在 characters 产出提供了锚点数据，这条规范从"若角色有"的假设变为"按 `<characters>` 中锚点子表执行"的确定性指令。Writer 端无需改动——它已经在按这个规范做事，只是之前 characters 不产锚点导致规范空转。

---

## 二、短剧四层结构 → 剧本/视听脚本转换链路

### 2.1 问题诊断

当前 v6.4 的 scene_beats → script_writer 链路是为**中长剧**设计的：

```
sequence_list (S1-1, S1-2, ..., S3-8 共 ~24 个序列)
  ↓ (scene_beats Pipeline，每次一个 target_sequence)
sequences/S1-1.md (场景表 + 节拍表)
  ↓ (script_writer，每次一个 target_chapter)
chapters/S1-1.md (剧本正文)
```

这个链路假设**一个序列 ≈ 一个章节**，适用于中长剧（12-40 集 × 40-60 分钟）。

但短剧（60-100 集 × 1-3 分钟）有完全不同的结构特性：

| 维度 | 中长剧 | 短剧 |
|------|--------|------|
| 单集长度 | 42-60 分钟 | 1-3 分钟 |
| 总集数 | 12-40 集 | 60-100 集 |
| 场景/集 | 5-10 个场景 | **1 个场景** |
| 序列/集 | 1 集含多个序列 | **1 序列 ≈ 1 幕**（8-15 集） |
| 节拍/场景 | 6-10 拍 | **4-6 拍**（微循环） |
| 节拍总数 | 12-20 拍/集 | **4-6 拍/集** |
| 叙事节奏 | 韵律节奏（呼吸式） | **脉冲节奏**（90 秒闭环） |
| Kernel/Satellite | 40% / 60% | **90% / 10%**（核化） |

**核心设计原则（用户明确要求）**：

> **结构是产品的特色——短剧支持是更深层次叙事的方法。整体输出结构不能变，但各 Subagent 在内容填写上需要做短剧方面的优化。**
>
> 具体而言：
> - 一场景 = 一集（短剧的"一景一集"模式）
> - 一序列文件 = 最小资产单位（**不引入 per-episode 文件路径**）
> - 幕结构、序列场景节拍的数量、内容中的短剧支持性——都在**同一文件结构内适配**

### 2.2 核心设计理念：同一框架 + 同一结构 + 内容适配

遵循 短剧逻辑.md 第 10 节的 v7 设计方向——**不需要两套框架，也不需要两套文件结构**：

> 短剧和长剧在框架结构上共享同一套【幕-序-场-节+信息披露】层级。差异不在于结构本身，而在于各层级的量级、密度和评判标准。

v6.4.1 进一步明确：**文件路径、资产组织方式完全一致，改动只发生在各 Subagent 产出的表格内容和列语义层面。**

```
中长剧：sequences/S1-1.md → 场景表(7列×3-6行) + 节拍表(6列×12-30行) → chapters/S1-1.md(2000-4000字)
短剧：  sequences/S1-1.md → 场景表(7列×8-15行) + 节拍表(6列×32-90行) → chapters/S1-1.md(1600-7500字)
        ↑ 文件路径完全相同 ↑                    ↑ 内容密度和列语义不同 ↑
```

### 2.3 各 Subagent 短剧模式内容适配

#### 2.3.1 act_map：幕定义从「单集内分割」→「全剧大阶段」

| 维度 | 中长剧 | 短剧 |
|------|--------|------|
| 幕数量 | 每集 4-5 幕 | 全剧 3-5 幕 |
| 幕跨度 | 单集内 10-15 分钟/幕 | 全剧 20-30 集/幕 |
| 幕功能 | 商业段分割的戏剧单元 | 叙事大阶段（建立→对抗→收束） |

**SKILL.md 适配**：短剧模式下 prompt 追加一段说明——

> 短剧模式：幕定义从「单集内分割」改为「全剧大阶段」。3-5 幕覆盖全剧 60-100 集，每幕约 20-30 集。幕名称采用叙事功能描述（Premise Arc / Escalation Arc / Dark Middle / Resolution Arc）而非序号。

**文件路径不变**：`act_map.md`。

#### 2.3.2 sequence_list：划分模式从「时间块」→「叙事功能块」

| 维度 | 中长剧 | 短剧 |
|------|--------|------|
| 序列总数 | 12-24 个（每序列 3-5 场景） | 6-12 个（每序列 8-15 集） |
| 划分依据 | 时间和事件的自然起止 | 叙事功能的转变点 |
| 序列关系 | 因果链 | 势能曲线（建立→消耗→重建） |

**SKILL.md 适配**：短剧模式下序列数量降低（6-12 vs 12-24），每个序列承载 8-15 集（≈一集一场景），划分依据从「时间段」变为「叙事功能块」。

**文件路径不变**：`sequence_list.md`。

#### 2.3.3 scene_designer：场景表行数扩展 + 短剧列语义适配

短剧模式下的场景表**仍然是 7 列**，但行数从 `[3,6]` 扩展为 `[8,15]`，列语义做短剧适配：

| 列 | 中长剧语义 | 短剧语义 |
|----|----------|---------|
| 场景ID | SC-S1-1-01（场景） | SC-S1-1-01（一集 = 一场景） |
| 场景功能 | 叙事功能标签 | 微弧定位（建置·初遇 / 升级·对峙 / 反转·打脸） |
| 场景目标(Objective) | 角色目标 | 本集要回答/制造的问题 |
| 冲突与障碍 | 叙事冲突 | 画面内可见的肢体/言语冲突（无潜台词） |
| 场景结果(Outcome) | 叙事结果 | 钉（卡在问题而非答案上，强迫下一集） |
| 时空边界 | 常规时空 | 符号化空间标注（复用性提示） |
| 视角人物 | 不变 | 不变 |

关键适配点：
- N ∈ [8,15] 行（替代 [3,6]），每行 = 一集
- 场景结果必须形成"钉"——卡在问题/悬念上，而非闭合收束
- 时空边界增加复用性标注（短剧场景复用率高）
- **核心不变**：7 列结构、SC-ID 格式、TAG 包裹、validator 校验规则全部保持不变

**文件路径不变**：`sequences/S{幕}-{序}.md`（场景表部分）。

#### 2.3.4 beat_writer：节拍密度翻倍 + 4 拍微循环引擎

短剧模式下的节拍表**仍然是 6 列**，但每场景节拍数降低（4-6 拍替代 6-10 拍），因为短剧的每集只有 60-90 秒：

| 维度 | 中长剧 | 短剧 |
|------|--------|------|
| 节拍/场景 | 6-10 | 4-6 |
| 总节拍/序列 | 12-30 | 32-90（行数多但每行浅） |
| 节拍类型 | 铺垫/触发/对抗/转折/收束 | 钩子/摩擦/尖峰/钉（短剧四拍引擎） |
| 动作-反应描述 | A说X→B回应Y | 动作链式描述（进门→注视→冷哼，连续动作） |
| 情绪/信息变化 | 情绪增量 | 情绪位移（日常→不安→压抑→震动→悬念） |
| 关联伏笔 | F-id | F-id（伏笔寿命 ≤ 10 集） |

**类型词库扩展**：短剧模式在原有 `铺垫/触发/对抗/转折/收束` 五选一之外，增加短剧专用变体 `钩子/摩擦/尖峰/钉`。validator 扩展主词集合以支持两种词库（根据模式参数动态切换校验集合）。同场景内相邻两拍仍禁止使用相同主词。

**文件路径不变**：`sequences/S{幕}-{序}.md`（节拍表部分）。

#### 2.3.5 script_writer：字数降档 + 镜头标注 + 叙事密度适配

短剧模式下的 script_writer 仍然输出 `chapters/S{幕}-{序}.md`，内容适配如下：

| 维度 | 中长剧 | 短剧 |
|------|--------|------|
| 单章字数 | 2000-4000 字 | 1600-7500 字（8-15 集 × 200-500 字/集） |
| 叙事密度 | 展开式（unfold） | 脉冲式（pulse） |
| 冲突构造 | 情景式冲突（slow burn） | 对话式冲突（每句都是行动，≤10 字） |
| 输出格式 | 纯正文 | 正文 + 集间 SHOT_BREAKDOWN |
| 描写密度 | 章节开头 3-5 行 | 每集开头 ≤ 2 行 |
| 信息负荷 | 对白可有寒暄、潜台词 | 每句承担推进+情感+信息多重功能 |
| 禁止性清单 | 现有四禁 | 增加：禁止 > 2 句的连续无冲突对话 / 禁止单集无反转 |

**镜头标注（短剧特有）**：在每集正文段落之间嵌入集级 SHOT_BREAKDOWN 注释：

```markdown
<!-- SHOT_BREAKDOWN(E05):
1. 特写(2s)：女主手腕被握住的瞬间，镜头上移→眼神
2. 中景(5s)：两人对峙，身后是模糊的全桌人
3. 特写(3s)：男主嘴角微动，欲言又止
4. 全景(3s)：包厢灯光闪了一下，画面淡出
-->
```

这是轻量级的参考注释，不属于 outputTags 包裹区间，outputValidator 不做校验。

**文件路径不变**：`chapters/S{幕}-{序}.md`。

#### 2.3.6 foreshadowing_tracker：伏笔寿命缩短

| 维度 | 中长剧 | 短剧 |
|------|--------|------|
| 伏笔最大寿命 | 20 集 | 10 集 |
| 钩子密度 | 1-2 个/集 | 1 个强钩 + 多个微型钩（每 15 秒一个抓力点） |
| 信息披露公式 | 维持兴趣（cognitive） | 制造冲动（compulsive）：每集回答 1 旧问 + 制造 1-2 新问 |

SKILL.md 正文追加伏笔寿命约束说明，不改输出格式。

#### 2.3.7 characters：角色可偏扁平化

短剧模式下 characters SKILL.md 追加提示：

> 短剧模式：角色可偏扁平化（突出辨识度 > 深度弧光），言行锚点聚焦于 1-2 个高辨识度的标志性动作/口癖。

**文件路径不变**：`characters.md`。

### 2.4 链路整合视图

```
短剧模式全链路（60-100集，与中长剧完全相同文件路径）：

用户选择短剧模式 + 输入故事概念
  ↓
worldbuilding（不变）
  ↓
characters（内容适配：扁平化 + 高辨识度锚点）
  ↓
act_map（内容适配：全剧大阶段 3-5 幕，非单集内分割）
  ↓
sequence_list（内容适配：叙事功能块划分，6-12 序列）
  ↓
foreshadowing_tracker（内容适配：伏笔寿命 ≤ 10 集）
  ↓
subplot_manager（内容适配：支线更少更短）
  ↓ (Phase Gate lock)
scene_beats Pipeline（内容适配：集级微弧表 + 4 拍微循环）
  → S1 scene_designer：场景表 7 列 × 8-15 行（每行=一集）
  → S2 beat_writer：节拍表 6 列 × 32-90 行（每集 4-6 拍，钩子/摩擦/尖峰/钉）
  → S3 assemble：拼装 sequences/S{幕}-{序}.md
  ↓
script_writer（内容适配：1600-7500 字脉冲式叙事 + SHOT_BREAKDOWN）
  → 单文件 chapters/S{幕}-{序}.md 内含 8-15 集完整剧本
  → 末尾 BEHAVIOR_TRACK 行为追踪注释
  ↓
story_checker（内容适配：容忍更扁平人物、更快节奏）
  → 审查闭环
```

**核心不变项总结**：

| 不变项 | 说明 |
|--------|------|
| 文件路径 | `sequences/S{幕}-{序}.md`、`chapters/S{幕}-{序}.md`、`act_map.md` 等全部不变 |
| 表格列结构 | 场景表 7 列、节拍表 6 列不变 |
| SC-ID / B-ID 格式 | 标识符格式不变 |
| TAG 包裹 | START/END TAG 不变 |
| validator 框架 | 校验框架不变（仅节拍类型词库按模式扩展） |
| Pipeline 步骤序 | S1→S2→S3 不变 |
| Phase Gate | 锁定机制不变 |

### 2.5 短剧 100 集的会话拆分策略

**核心问题**：100 集的内容编排不能在一个会话中完成。需要分批策略。

**方案**：按序列（短剧语义 = 按叙事功能阶段）分批，每批对应一个 sequences/S{幕}-{序}.md。

| 批次 | 对应序列 | 集数范围 | 叙事阶段 |
|------|---------|---------|---------|
| 批次 1 | S1-1 | E01-E10 | 黄金窗口·建立预设（Premise Arc） |
| 批次 2 | S1-2 | E11-E25 | 发展期·冲突升级（Escalation Arc 上半） |
| 批次 3 | S1-3 | E26-E40 | 发展期·"几乎"循环（Escalation Arc 下半） |
| 批次 4 | S2-1 | E41-E55 | 暗黑中部·情境恶化（Dark Middle 上半） |
| 批次 5 | S2-2 | E56-E70 | 暗黑中部·信息翻牌（Dark Middle 下半） |
| 批次 6 | S3-1 | E71-E85 | 收束期·次线先收（Resolution Arc 上半） |
| 批次 7 | S3-2 | E86-E100 | 收束期·主线终结（Resolution Arc 下半） |

**每批次内的调用模式**：

1. 用户选择要写的序列（如"写 S1-1，短剧模式，E01-E10"）
2. Orchestrator 一次 `scene_beats` 调用产出该序列的集级微弧表（场景表 10 行 = 10 集 + 节拍表 40-60 行）
3. `script_writer` 一次调用将该序列的完整场景节拍展开成 chapters/S1-1.md（1600-5000 字，内含 10 集）
4. 行为追踪跨批次通过 `behaviorTrack` 内存 Map 维持

**与中长剧的链路差异总结**：

| 节点 | 中长剧 | 短剧 |
|------|--------|------|
| scene_beats 场景表行数 | 3-6 行 | 8-15 行 |
| scene_beats 节拍表行数 | 12-30 行 | 32-90 行 |
| 节拍类型词库 | 铺垫/触发/对抗/转折/收束 | 增加钩子/摩擦/尖峰/钉变体 |
| script_writer 字数 | 2000-4000 字/章 | 1600-7500 字/章（多集合并） |
| script_writer 叙事密度 | unfold（展开式） | pulse（脉冲式） |
| script_writer 附加输出 | BEHAVIOR_TRACK | SHOT_BREAKDOWN + BEHAVIOR_TRACK |
| 文件路径 | 一致 | 一致 |
| 伏笔寿命 | 10-20 集 | 5-10 集 |
| 分批策略 | 逐序列 | 逐序列（同） |

---

## 三、双产品模式前端控制方案

### 3.1 设计原则

1. **模式选择是全局的、会话级的**——一次故事创作从始至终是同一模式，不支持中途切换
2. **结构不变，内容适配**——模式参数影响各 Subagent 产出的内容密度和列语义，不改变文件路径和资产组织方式
3. **默认值驱动**——用户选择模式后所有参数自动预填，高级用户可覆盖

### 3.2 模式参数定义

```ts
// src/types/index.ts 新增
export type StoryMode = 'medium_drama' | 'short_drama'

export interface ModeParameters {
  // === 集级参数 ===
  episodeLengthMinutes: [number, number]   // [最小, 最大] 分钟
  totalEpisodes: [number, number]          // [最小, 最大] 集

  // === 场景/节拍参数 ===
  scenesPerSequence: [number, number]      // 场景数/序列（短剧 = 集数/序列）
  beatsPerScene: [number, number]          // 节拍数/场景（集）
  beatsPerSequence: [number, number]       // 节拍数/序列

  // === 伏笔参数 ===
  foreshadowingMaxLifespan: number         // 伏笔最大寿命（集）
  hooksPerEpisode: number                  // 每集钩子数

  // === 序列参数 ===
  sequenceSplitMode: 'time_block' | 'narrative_function'  // 序列划分模式
  actDefinition: 'per_episode' | 'whole_story'             // 幕的定义

  // === 场景参数 ===
  sceneSpatialDepth: 'narrative' | 'symbolic'  // 空间描述深度

  // === 写作参数 ===
  chapterWordCount: [number, number]       // 每章字数范围
  chapterDensity: 'unfold' | 'pulse'       // 叙事密度类型
  outputFormat: 'prose' | 'shot_annotated' // 输出格式
  beatModel: '6_10_progressive' | '4_beat_micro_cycle'  // 节拍引擎

  // === 角色参数 ===
  characterDepth: 'rounded' | 'flat_iconic'  // 角色深度倾向
}

export const MODE_DEFAULTS: Record<StoryMode, ModeParameters> = {
  medium_drama: {
    episodeLengthMinutes: [40, 60],
    totalEpisodes: [12, 40],
    scenesPerSequence: [3, 6],
    beatsPerScene: [6, 10],
    beatsPerSequence: [12, 30],
    foreshadowingMaxLifespan: 20,
    hooksPerEpisode: 1,
    sequenceSplitMode: 'time_block',
    actDefinition: 'per_episode',
    sceneSpatialDepth: 'narrative',
    chapterWordCount: [2000, 4000],
    chapterDensity: 'unfold',
    outputFormat: 'prose',
    beatModel: '6_10_progressive',
    characterDepth: 'rounded',
  },
  short_drama: {
    episodeLengthMinutes: [1, 3],
    totalEpisodes: [60, 100],
    scenesPerSequence: [8, 15],
    beatsPerScene: [4, 6],
    beatsPerSequence: [32, 90],
    foreshadowingMaxLifespan: 10,
    hooksPerEpisode: 1,
    sequenceSplitMode: 'narrative_function',
    actDefinition: 'whole_story',
    sceneSpatialDepth: 'symbolic',
    chapterWordCount: [1600, 7500],
    chapterDensity: 'pulse',
    outputFormat: 'shot_annotated',
    beatModel: '4_beat_micro_cycle',
    characterDepth: 'flat_iconic',
  },
}
```

### 3.3 模式选择器 UI

**位置**：HeaderBar 左区，Phase Gate 锁定 CTA 之前。

**组件**：`ModeSelector` —— 两个大卡片的二选一。

```
┌─────────────────────────────────────────────────────┐
│  创作模式                                            │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────┐        │
│  │  📺  中长剧       │  │  📱  短剧         │        │
│  │                  │  │                  │        │
│  │  12-40 集        │  │  60-100 集        │        │
│  │  40-60 分钟/集   │  │  1-3 分钟/集      │        │
│  │  5-10 场景/集    │  │  1-2 场景/集      │        │
│  │  展开式叙事       │  │  脉冲式叙事       │        │
│  └──────────────────┘  └──────────────────┘        │
│                                                     │
│  ⚠️ 选定后不可更改（两种模式的结构差异过大）         │
└─────────────────────────────────────────────────────┘
```

**交互规则**：

- 仅在设计期（phase=designing）且无任何产出（无 `act_map.md`/`worldbuilding.md` 等核心资产）时可切换
- 一旦开始产出设计资产 → 模式锁定，不可更改
- 如果用户确实需要切换 → 先用 `reset_all` 清空全部内容后重新选择
- 默认选中「中长剧」（向后兼容 v6.4）

### 3.4 Store 设计

```ts
// src/store/modeStore.ts
import { create } from 'zustand'
import type { StoryMode, ModeParameters } from '../types'
import { MODE_DEFAULTS } from '../types'

interface ModeState {
  mode: StoryMode
  params: ModeParameters
  locked: boolean           // 是否已锁定（有产出后锁定）
  setMode: (mode: StoryMode) => void
  lock: () => void
  unlock: () => void
}

export const useModeStore = create<ModeState>((set, get) => ({
  mode: 'medium_drama',
  params: MODE_DEFAULTS.medium_drama,
  locked: false,
  setMode: (mode) => {
    if (get().locked) return  // 锁定后不可切换
    set({ mode, params: MODE_DEFAULTS[mode] })
  },
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
}))
```

### 3.5 Engine 侧联动

Engine 在以下节点读取 `modeStore` 参数：

| 节点 | 读取参数 | 影响行为 |
|------|---------|---------|
| `buildFunctionSpec` | `outputFormat`, `beatModel` | 短剧模式给 `script_writer` description 追加 `（短剧模式：脉冲式叙事，附镜头分解）` |
| `resolveExtraContext` | `outputFormat`, `chapterDensity` | 短剧模式注入 `<mode>` 标签告知 Writer 当前模式参数 |
| `runPipeline` | `beatModel`, `scenesPerSequence` | 短剧模式给 scene_designer/beat_writer 注入模式参数上下文 |
| `Guard-1` 可见性 | 不变 | 可见性规则跨模式通用 |
| `behaviorTrack` | 不变 | 追踪机制跨模式通用 |
| `runSoftValidation` | `outputFormat` | 短剧模式新增 SHOT_BREAKDOWN 存在性检查 |

### 3.6 各 Subagent 模式联动

| Subagent | 是否受模式影响 | 影响方式 |
|----------|--------------|---------|
| `user_requirements_analyzer` | ❌ 不变 | — |
| `worldbuilding` | ❌ 不变 | — |
| `characters` | ⚠️ 轻微 | 短剧模式注入 `角色可偏扁平化、突出辨识度` |
| `act_map` | ✅ 显著 | 幕定义从「单集内分割」→「全剧大阶段」 |
| `sequence_list` | ✅ 显著 | 划分模式从「时间块」→「叙事功能块」，序列数降低 |
| `scene_beats` | ✅ 显著 | 场景表行数/节拍密度/类型词库全部适配 |
| `foreshadowing_tracker` | ⚠️ 轻微 | 伏笔寿命窗口缩短 |
| `subplot_manager` | ⚠️ 轻微 | 支线更少更短 |
| `script_writer` | ✅ 显著 | 字数/密度/镜头分解/禁止清单全部适配 |
| `story_checker` | ⚠️ 轻微 | 容忍更扁平人物、更快节奏 |

**实现策略**：

- **不变项**：`worldbuilding`、`user_requirements_analyzer`、`reset_all` → 零改动
- **轻微影响项**：通过 Engine 侧 `resolveExtraContext` 注入 `<mode>` 标签，让 LLM 自行感知模式差异，不改 SKILL.md 正文
- **显著影响项**：通过 **Skill 热插拔**方式，在对应 Subagent 目录下增加 `_short/SKILL.md` variant

### 3.7 Skill 热插拔方案（短剧 Variant）

```
src/skills/scene_beats/
├── subagent.md                    # 不变
├── structuralChecks.ts            # 模式感知（节拍类型词库扩展）
├── scene_designer/SKILL.md        # 中长剧：场景骨架（现有）
├── beat_writer/SKILL.md           # 中长剧：节拍明细（现有）
├── scene_designer_short/SKILL.md  # 短剧：集级微弧表（行数 8-15，列语义适配）
└── beat_writer_short/SKILL.md     # 短剧：4 拍微循环（词库：钩子/摩擦/尖峰/钉）

src/skills/script_writer/
├── subagent.md                    # 不变
├── script_writer/SKILL.md         # 中长剧（现有）
└── script_writer_short/SKILL.md   # 短剧：脉冲式叙事 + SHOT_BREAKDOWN

src/skills/act_map/
├── subagent.md                    # 不变
├── act_map/SKILL.md               # 中长剧（现有）
└── act_map_short/SKILL.md         # 短剧：全剧大阶段 3-5 幕

src/skills/sequence_list/
├── subagent.md                    # 不变
├── sequence_list/SKILL.md         # 中长剧（现有）
└── sequence_list_short/SKILL.md   # 短剧：叙事功能块划分
```

**PIPELINE_REGISTRY 模式感知**：

```ts
// orchestratorEngine.ts
const PIPELINE_REGISTRY: Record<string, PipelineConfig> = {
  scene_beats: {
    steps: [
      { skillId: 'scene_designer', label: 'prev_scenes', /* ... */ },
      { skillId: 'beat_writer', label: 'prev_beats', /* ... */ },
    ],
    stepsShort: [
      { skillId: 'scene_designer_short', label: 'prev_scenes', /* ... */ },
      { skillId: 'beat_writer_short', label: 'prev_beats', /* ... */ },
    ],
  },
}
```

`runPipeline` 启动前读取 `useModeStore.getState().mode`，选择走 `steps` 还是 `stepsShort`。

**Skill Router 的短剧模式路由**：当 `modeStore.mode === 'short_drama'` 且对应 Subagent 存在 `<skillId>_short` variant 时，优先选短剧 variant；否则回退到默认 Skill。

### 3.8 前端联动一览

| UI 区域 | 中长剧行为 | 短剧行为 |
|---------|----------|---------|
| HeaderBar 模式标签 | `📺 中长剧` | `📱 短剧` |
| HeaderBar 进度概览 | 「已写 X 章 / 共 Y 序列」 | 「已写 X 章 / 共 Y 序列」（同） |
| AssetCardPanel 分组 | 现有分组 | 同（无新增分组） |
| AssetCard 章节卡片 | `S1-1` | `S1-1`（路径同） |
| AssetCard 字数显示 | 2000-4000 | 1600-7500 |
| CurrentPanel 编辑区 | 正文预览 | 正文 + 镜头分解面板 |
| Orchestrator instruction 话术 | "写 S1-1" | "写 S1-1，短剧模式，E01-E10" |

---

## 四、实施顺序

```
改造一（角色锚点）──┐
                    ├──→ 改造三（前端双模式基础）──→ 改造二（短剧内容适配 Skill variant）
改造二（短剧链路）──┘
```

建议分批：

| 批次 | 内容 | 预计文件改动 |
|------|------|-------------|
| **Phase 1** | 改造一（角色锚点）+ 改造三基础（modeStore + ModeSelector UI） | 4 文件 |
| **Phase 2** | 改造二前半（Engine 模式感知 + PIPELINE_REGISTRY 双模式 + Skill Router 短剧路由） | 3 文件 |
| **Phase 3** | 改造二后半（6 × SKILL.md short variant + structuralChecks 扩展） | 7 文件 |
| **Phase 4** | 改造三收尾（Orchestrator prompt 动态注入 + 前端联动） | 3 文件 |

---

## 五、与 v6.4 原始文档的关系

| v6.4 原始文档 | 本方案状态 |
|---------------|-----------|
| `01_前端交互改造方案.md` | 保留，增加改造三内容（ModeSelector + 双模式联动） |
| `02_写作agent功能清单.md` | 保留，改造一的角色锚点产出让能力二的"若角色有"变为确定性 |
| `03_写作agent开发方案.md` | 保留，改造二增加短剧内容适配设计 |
| `04_开发实施步骤.md` | 保留，改造一/二/三的实施步骤合并入 Wave 序列 |

本方案（v6.4.1）是 v6.4 的增补方案，不推翻 v6.4 的四份原始文档，只在以下维度做结构性补充：

1. characters 能力补全（原 02 文档说"不在 v6.4 范围内"——现在补上）
2. 短剧模式内容适配（原文档未覆盖的主题；**结构不变，内容适配**）
3. 双模式前端控制（原 01 文档未覆盖的主题）
