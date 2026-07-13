# 02 · Subagent 架构与记忆/对话管理概要（v6.6）

> 说明 v6.6 的 Subagent 家族拓扑、产品档案驱动机制、记忆管理与对话/会话/批次管理。
> 数据结构与契约表见 [03_产品设计文档.md](03_产品设计文档.md)。

---

## 一、设计目标（用户明确要求）

1. **输出最稳定**：成文层按产品单一职责特化，杜绝互斥指令共存；结构参数由档案注入而非 LLM 猜测。
2. **支持四产品输出**：小说 / 剧本 / 长剧脚本 / 短剧脚本，共享四层骨架、语义可变。
3. **支持不同文件输入的范式**：任意输入文件 → 归一化 → 种子资产。

---

## 二、Subagent 家族拓扑

v6.6 把 Subagent 分为四区：**输入区、设计区、成文区（产品特化）、审查区**。

```
┌── 输入区 ──────────────────────────────────────┐
│  input_normalizer   任意文件 → 归一化种子资产    │
└────────────────────────────────────────────────┘
┌── 设计区（产品档案参数化，四产品共用）──────────┐
│  user_requirements_analyzer                     │
│  worldbuilding                                  │
│  characters                                     │
│  act_map          ← 幕数/语义 随档案            │
│  sequence_list    ← 序列数/语义 随档案          │
│  foreshadowing_tracker  ← 伏笔寿命 随档案        │
│  subplot_manager                                │
│  scene_beats(Pipeline)  ← 场景数/节拍数/词库 随档案│
└────────────────────────────────────────────────┘
┌── 成文区（产品特化，互斥可见，仅暴露 1 个）──────┐
│  novel_writer        （产品=小说时可见）         │
│  screenplay_writer   （产品=剧本时可见）         │
│  long_drama_writer   （产品=长剧脚本时可见）     │
│  short_drama_writer  （产品=短剧脚本时可见）     │
└────────────────────────────────────────────────┘
┌── 审查区 ───────────────────────────────────────┐
│  story_checker    ← 审查标准 随档案             │
│  reset_all                                      │
└────────────────────────────────────────────────┘
```

### 2.1 为什么设计区共用、成文区特化

| 区 | 策略 | 理由 |
|----|------|------|
| 设计区 | **同一 Subagent + 档案参数化** | 幕/序/场/节的**结构逻辑**四产品一致（都是"因果闭环的叙事单元层级"），差异只是数量与语义标签——参数化即可，无需拆分，避免维护 4×N 份 prompt。 |
| 成文区 | **产品特化 Subagent，互斥可见** | 成文**风格规则彼此互斥**（小说要心理描写、剧本禁心理描写）。若塞进一个 prompt 用条件分支，LLM 极易串味 → 输出不稳定。一个产品一个 writer，prompt 干净单一，**稳定性最高**。 |

这就是"**分层混合路线**"：上游参数化，下游特化。

---

## 三、产品档案驱动机制（ProductProfile）

### 3.1 档案是什么

`ProductProfile` 是**会话级、锁定不可变**的配置对象，描述"当前产品的四层规格"。它是 v6.6 一切模式差异的**唯一真源**（single source of truth），取代 v6.4.1 设想的散落 modeStore/ModeParameters。

档案承载四类信息（详见 03 文档）：
- **层语义槽**：每层在本产品里叫什么、代表什么（如短剧"幕"=全剧大阶段）。
- **层量级参数**：每层数量区间与约束（如短剧"每幕恰 1 序列"）。
- **叙事单位映射**：序列↔集↔场景↔文件的对应关系。
- **校验集合**：validator 用的 ID 正则、节拍词库、列数。
- **绑定成文 Subagent**：本产品暴露哪个 writer。

### 3.2 档案如何驱动各层

```
ProductProfile（锁定于会话）
    │
    ├─→ buildFunctionSpec：成文区只暴露 profile.writerSubagentId 对应的 writer
    │
    ├─→ 设计区各 Subagent：resolveExtraContext 注入 <product_profile> 标签
    │     （告知本层的数量区间、语义标签、命名约束）
    │
    ├─→ scene_beats Pipeline：注入场景数/节拍数区间 + 节拍词库
    │
    └─→ validator：按 profile.validationSet 选择校验规则（列数/正则/词库）
```

**关键**：Subagent 的 SKILL.md 正文**不写死数字**，改为引用"档案给定的区间"；具体数值运行时由 `<product_profile>` 注入。这样一份 SKILL.md 服务四产品，靠档案区分——**既非 variant 翻倍，也非纯注入无语义**，而是"语义槽 + 参数注入"。

---

## 四、记忆管理

v6.6 的记忆分三层：**静态设定层、运行时状态层、会话上下文层**。

### 4.1 静态设定层（持久资产）
- 即现有资产文件：worldbuilding/characters/act_map/sequence_list/foreshadowing/subplots + sequences/* + chapters/*。
- Phase Gate 锁定后为只读基线。

### 4.2 运行时状态层（跨调用内存，v6.6 强化）

| 状态 | 结构 | 用途 | 相对 v6.4 |
|------|------|------|-----------|
| **角色行为追踪** `behaviorTrack` | `Map<chapterId, string[]>` | 跨章维持角色言行一致（BEHAVIOR_TRACK 注释提取） | v6.4 已设想，v6.6 保留 |
| **伏笔运行时状态** `foreshadowingState` | `Map<F-id, {planted, paidoff, atChapter}>` | 记录每条伏笔的 plant/payoff 实际落地位置，防重复 plant / 提前 payoff | **v6.6 新增**（补 v6.5 缺口 J） |
| **产品档案锁** `profileLock` | `ProductProfile \| null` | 会话级产品锁定 | **v6.6 新增** |
| **批次进度** `batchProgress` | `Map<sequenceId, status>` | 记录成文批次完成状态，支持断点续写 | **v6.6 新增** |

- 运行时状态存于 `OrchestratorEngine` 实例，随会话生命周期存在。
- 均带**有界淘汰**（behaviorTrack LRU、foreshadowingState 按幕范围裁剪），防上下文膨胀。

### 4.3 会话上下文层（单次 LLM 调用的注入）
- 通过 caller 侧 `appendExtraLabels` 注入的动态标签：`<product_profile>` / `<same_act_sequences>` / `<previous_chapter_draft>` / `<character_behavior_tracking>` / `<foreshadowing_state>`。
- 守 INV-2：不改 `contextAssembler.assembleContext` 函数体。

---

## 五、对话 / 会话 / 批次管理

### 5.1 三级生命周期

```
会话（Session）：一次完整创作，绑定一个锁定的 ProductProfile
  └── 对话轮（Turn）：一次 sendMessage，重置 round 计数器
        └── 批次（Batch）：成文期一次可覆盖一个或多个成文单元
              └── 调用（Call）：单个 Subagent 的一次 LLM 执行
```

### 5.2 产品锁定的时机
- **唯一锁定入口**：用户在 UI 顶部产品选择器**显式选定**产品方向时，`profileLock` 落定（不靠 LLM 从对话推断，详见 03 §1.3）。
- ~~"首次产出任一设计资产时锁定"~~——**已废弃**：设计资产的数量/结构需 `<product_profile>` 注入才能生成，若"先产资产再锁定"则构成先有鸡先有蛋。故锁定时机收敛为单一的 UI 选择。
- **Guard-0**：`profileLock=null` 时设计区+成文区全部 Subagent 从 FC 面隐藏，仅 `reset_all` 可用，Orchestrator 引导用户先选产品。
- 锁定后 `buildFunctionSpec` 依据 `profileLock.writerSubagentId` 决定成文区可见性。
- 解锁只能通过 `reset_all`（清空全部资产 + 释放 profileLock）。

### 5.3 成文批次策略（吸收 v6.5，去掉不稳定并行）

| 产品 | 成文单元 | 批次粒度 | 调度 |
|------|---------|---------|------|
| 小说 | 一章 | 一次一章 | 串行 |
| 剧本 | 一序列 | 一次一序列 | 串行 |
| 长剧脚本 | 一集(=一序列) | 一次一集 | 串行 |
| 短剧脚本 | 一序列(=一幕=多集) | **按集分段续写**（`proseSplitUnit:'episode'`） | 串行（集间强因果，逐集产出 REFINE 追加进同一 chapters 文件） |

- **默认串行**：保证 behaviorTrack / foreshadowingState 的顺序依赖成立 → 一致性稳定。
- **断点续写**：`batchProgress` 记录已完成序列，用户可分多个对话轮逐批推进（短剧 100 集 = 7 批，逐批调用）。
- **并行**作为后续可选优化（需先解决角色/伏笔跨并行一致性，见 04 风险），v6.6 不默认启用。

### 5.4 Orchestrator 调度规则更新要点
- 成文期只能调用**当前产品绑定的 writer**（其余 writer 不进 FC 面）。
- 每个 writer 调用必须携带合法 target（沿用 `TARGET_ID_REGEX` 单目标，串行推进）。
- 输入归一化 `input_normalizer` 仅在会话早期（无设计资产时）可调用。

---

## 六、与现有代码基线的兼容

| 现有机制 | v6.6 处置 |
|----------|----------|
| 四层框架 / Skill Router / 目录热插拔 | **保留**，新增 Subagent 沿用目录约定注册 |
| scene_beats 2 步 Pipeline + 代码拼装 | **保留结构**，仅注入档案参数 + 扩展 validator 词库 |
| Phase Gate | **保留**，profileLock 与之并存 |
| behaviorTrack | **保留**并新增 foreshadowingState 等运行时状态 |
| script_writer | **退役**为兼容别名或直接由四个特化 writer 取代（见 04 迁移策略） |
| contextAssembler INV-2 | **守恒**，新标签走 appendExtraLabels |
