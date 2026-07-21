# StoryCrafter v7.9.9 · design_builder 活络化专项

## 1. 背景

当前设计期能力按多个 subagent 拆开：

```text
user_requirements_analyzer
worldbuilding
characters
act_map
sequence_list
foreshadowing_tracker
subplot_manager
sequence_builder
```

这套结构在工程上清晰，但在用户链路上偏“死”：用户只是想写一个场景，系统却容易被世界观、角色、幕结构、序列清单、序列层等前置资产卡住。

真实创作过程并不总是自上而下完整填表。很多时候用户会从一个场景、一个角色关系、一个冲突瞬间进入，再逐步补齐上游设计。因此设计入口需要更活络：

```text
用户想做设计相关任务
→ 只调用一个 design_builder
→ design_builder 通过 skill index 渐进式选择最小必要 skill
→ 能读上游就读，缺上游就降级/最小补齐/澄清
```

本专项只做方案设计，且实现边界限定在 **prompt 层改造**。不在本版本引入新的代码级 workflow engine。

## 2. 目标

### 2.1 产品目标

- 降低设计前置门槛，让用户可以从场景、角色、冲突等任意设计切入点开始。
- 保留层级治理：序列指导场景，场景指导节拍，下游不得反向污染上游。
- 让 Orchestrator 不再像流水线审批员，而是把设计类任务交给一个统一设计入口处理。
- 保持系统可解释：用户仍能知道当前使用了哪个设计 skill。

### 2.2 技术目标

- 设计期对外收敛为一个 `design_builder` subagent。
- `design_builder` 内部挂载多个设计 skill。
- 每个 skill 保留自己的 `reads` / `writes` / `outputTags`。
- Prompt 明确“最小必要写入”和“缺上游降级策略”。
- 前端日志仍可展示使用中的 skill，后续只需要使用现有事件字段或轻量 UI 改造。

## 3. 非目标

- 不新增更多 subagent。
- 不取消 `prose_writer` 与 `quality_checker`。
- 不让一个 skill 同时写多个无关资产。
- 不在 system prompt 注入所有设计资产全文。
- 不在本方案中实现代码迁移。

## 4. 目标架构

### 4.1 三类 Subagent

| Subagent | 职责 |
|---|---|
| `design_builder` | 设计资产创建、补齐、修订、局部展开 |
| `prose_writer` | 小说正文、短剧/长剧/电影剧本、视频脚本 |
| `quality_checker` | 结构、需求、角色、世界观、伏笔等质检 |

### 4.2 design_builder 内部 Skills

| Skill | 当前来源 | 读 | 写 |
|---|---|---|---|
| `requirements_rules` | `user_requirements_analyzer` | `user_requirements.md` | `user_requirements.md` |
| `worldbuilding_rules` | `worldbuilding` | `user_requirements.md`, `worldbuilding.md` | `worldbuilding.md` |
| `characters_rules` | `characters` | `user_requirements.md`, `worldbuilding.md`, `characters.md` | `characters.md` |
| `act_map_rules` | `act_map` | `user_requirements.md`, `worldbuilding.md`, `characters.md`, `act_map.md` | `act_map.md` |
| `sequence_list_rules` | `sequence_list` | `user_requirements.md`, `worldbuilding.md`, `characters.md`, `act_map.md`, `sequence_list.md` | `sequence_list.md` |
| `sequence_layer_rules` | `sequence_builder` | `act_map.md`, `sequence_list.md`, `characters.md` | `sequences/<ID>.md` |
| `scene_layer_rules` | `sequence_builder` | `sequences/<ID>.md`, `characters.md` | `scenes/<ID>.md` |
| `beat_layer_rules` | `sequence_builder` | `sequences/<ID>.md`, `scenes/<ID>.md`, `characters.md` | `beats/<ID>.md` |
| `foreshadowing_rules` | `foreshadowing_tracker` | `user_requirements.md`, `act_map.md`, `sequence_list.md`, `foreshadowing.md` | `foreshadowing.md` |
| `subplot_rules` | `subplot_manager` | `user_requirements.md`, `characters.md`, `foreshadowing.md`, `act_map.md`, `sequence_list.md`, `subplots.md` | `subplots.md` |

## 5. Prompt 层改造原则

### 5.1 design_builder 总 Prompt

`design_builder/subagent.md` 需要明确：

```text
你是统一设计构筑者。你不是一次性生成全套大纲的流水线，而是根据用户当前意图选择最小必要 skill。

执行规则：
1. 先阅读 Skill Index，判断用户真正要改的是哪一类设计资产。
2. 执行前必须 read_skill，读取目标 skill 完整规范。
3. 一次任务默认只写一个最小必要资产；只有用户明确要求“完整生成/全部补齐/一键构筑”时，才允许多 skill 连续执行。
4. 上游资产存在时，必须读取并服从。
5. 上游资产缺失但用户输入足够明确时，允许降级生成当前层草案，不强制补齐全套上游。
6. 上游资产缺失且用户输入不足时，只问一个澄清问题，不臆造。
7. 下游不得反向改写上游；只能提出上游修订建议。
8. 不要因为能使用多个 skill，就主动扩张任务范围。
```

### 5.2 缺上游降级策略

| 情况 | design_builder 行为 |
|---|---|
| 上游资产存在 | 读取并服从 |
| 上游资产缺失，但用户输入足够明确 | 直接生成当前层草案，并标注依赖假设 |
| 上游资产缺失，用户输入不足 | 向 Orchestrator 返回澄清问题 |
| 用户明确要求系统补齐 | 先补最小必要上游，再做当前层 |
| 下游发现上游矛盾 | 输出上游修订建议，不直接改上游 |

### 5.3 最小写入原则

默认行为：

```text
用户要求场景
→ 优先只写 scenes/<ID>.md
```

允许扩展行为：

```text
用户明确说“没有序列也帮我补一下”
→ 允许先写 sequences/<ID>.md
→ 再写 scenes/<ID>.md
```

禁止行为：

```text
用户要求改一个场景
→ 顺手重写世界观、角色、幕结构、序列清单
```

### 5.4 层级单向性

继续保留前置规则：

```text
序列指导场景
场景指导节拍
下游可以暴露上游问题
下游不能把自己的展开需要包装成上游已经改变的事实
```

对 `design_builder` 来说，这条规则尤其重要。因为它拥有多个设计 skill，如果总 prompt 不限制，它会比旧架构更容易“顺手全改”。

## 6. Orchestrator Prompt 改造

`orchestrator_v5.md` 应改为：

```text
设计期只暴露 design_builder 与 quality_checker。
当用户表达世界观、角色、幕结构、序列、场景、节拍、伏笔、支线等设计诉求时，优先调用 design_builder。
不要自己拆成 worldbuilding/characters/act_map/sequence_list/sequence_builder 多个工具。
design_builder 会通过 read_skill 渐进式选择最小必要设计规范。
```

同时保留：

```text
写作期只暴露 prose_writer。
质检由 quality_checker 执行。
```

## 7. Skill 改造要点

### 7.1 Skill 迁移方式

Prompt 层优先，不改变每个 skill 的业务正文。

可采取两步：

1. 先把现有设计 skill 的 subagent 归属从多个 subagent 收敛到 `design_builder`。
2. 再逐步微调 skill 文案，使它们适配统一入口。

### 7.2 需要补强的 Skill 文案

| Skill | 补强点 |
|---|---|
| `scene_layer_rules` | 缺序列时允许“场景草案”降级，但不能声明已完成正式场景层 |
| `beat_layer_rules` | 缺场景时优先拒绝或澄清，不直接从序列跳到节拍 |
| `sequence_layer_rules` | 若由场景需求触发补序列，只补当前目标序列的最小序列基线 |
| `requirements_rules` | 仍保持高精度低召回，不因为统一入口而记录模型推断 |
| `worldbuilding_rules` / `characters_rules` | 只在用户需求或当前任务确实需要时补齐，不做全局扩张 |

## 8. 前端调用日志与 Skill 展示

### 8.1 结论

收敛成一个 `design_builder` 后，**不是不能显示使用中的 skill**。

当前后端事件结构已经支持 skill 信息：

```ts
interface ExecutionEvent {
  toolId?: string
  toolName?: string
  skillId?: string
  skillName?: string
}
```

并且 isolated subagent 在调用 `read_skill` 后会发事件：

```ts
this.emit('subagent_loop_step', {
  toolId: subagent.id,
  toolName: subagent.name,
  skillId: skill.skillId,
  skillName: skill.name,
  message: `已选择规范：${skill.name}`,
})
```

`tool_complete` 也会带：

```ts
skillId: result.skillId
skillName: result.skillName
```

### 8.2 当前前端问题

现在前端日志的 `useExecutionSteps()` 主要按 `tool_start / tool_complete / tool_error` 合并步骤，并只展示：

```text
调用：{toolName}
reason
subtitle
```

它没有把 `skillName` 渲染出来，也没有把 `subagent_loop_step` 转成可见子步骤。

所以如果只把设计入口合并成 `design_builder`，但不改前端日志，用户看到的会变成：

```text
调用：设计构筑
已完成
```

看不到：

```text
使用规范：场景层规则
```

### 8.3 推荐 UI 行为

不需要大改。只要让日志在当前 step 上显示 skill 即可：

```text
调用：设计构筑
使用：场景层规则
目标：scenes/S1-1.md
```

前端可以通过两种方式实现：

1. 监听 `subagent_loop_step` 中的 `skillName`，更新当前 running step 的 subtitle。
2. 在 `tool_complete` 时读取 `event.skillName`，把完成行显示为 `已完成 · 场景层规则`。

### 8.4 日志渲染内容规格

合并为 `design_builder` 后，日志不能只显示统一 subagent 名称，否则用户无法判断系统到底在做世界观、角色、场景还是节拍。日志需要分成“主标题=统一入口，副标题=当前 skill 与目标资产”。

#### 默认折叠态

折叠态只显示宏观状态：

```text
执行日志
处理中 · 2/4
```

完成后：

```text
执行日志
已完成 4/4 个步骤 · 38 秒
```

如果有失败：

```text
执行日志
3 完成 / 1 失败 · 42 秒
```

#### 展开态单行结构

每一行采用：

```text
调用：设计构筑
使用：场景层规则
目标：scenes/S1-1.md
状态：已完成
```

对应 UI 层级：

| UI 字段 | 内容来源 |
|---|---|
| rowTitle | `调用：${toolName}` |
| rowReason | `使用：${skillName}`，没有 skill 时回退到 subagent reason |
| rowSubtitle | 优先显示写入目标、当前轮次、warning 数；没有则显示 instruction 摘要 |
| status | running / done / error |

#### 事件映射

| 事件 | 当前用途 | v7.9.9 推荐渲染 |
|---|---|---|
| `tool_start` | 创建一条 running step | title 显示 subagent：`调用：设计构筑` |
| `subagent_loop_start` | 当前未显示 | 可忽略，避免日志过细 |
| `subagent_loop_step` + `skillName` | 当前未显示 | 更新当前 running step：`使用：${skillName}` |
| `tool_complete` + `skillName` | 当前未显示 skill | step done；subtitle 显示 `已完成 · ${skillName}` 或写入路径 |
| `tool_error` | step error | 显示错误 message |
| `engine_finalizing` | 顶部 summary | 显示“正在整理本轮结果…” |

#### 示例：生成场景

用户输入：

```text
把 S1-1 的场景写出来
```

展开日志建议：

```text
调用：设计构筑
使用：场景层规则
目标：scenes/S1-1.md
已完成
```

如果缺少上游序列但用户输入足够明确，允许降级：

```text
调用：设计构筑
使用：场景层规则
目标：scenes/S1-1.md
已完成 · 含 1 条提示
提示：缺少 sequences/S1-1.md，已按用户输入生成场景草案
```

#### 示例：补角色

用户输入：

```text
把女主改得更冷静一点，但不要完美
```

展开日志建议：

```text
调用：设计构筑
使用：角色设定规则
目标：characters.md
已完成
```

#### 示例：一键补齐设计

用户输入：

```text
把缺的设计资产都补齐
```

如果 Orchestrator 明确允许多 skill 连续执行，日志应显示多行，而不是一行吞掉：

```text
调用：设计构筑
使用：世界观设定规则
目标：worldbuilding.md
已完成

调用：设计构筑
使用：角色设定规则
目标：characters.md
已完成

调用：设计构筑
使用：序列清单规则
目标：sequence_list.md
已完成
```

#### 不建议展示的内容

以下内容默认不展示，只在调试模式或更详细面板中展示：

- `read_skill` 原始参数
- `read_file` 文件全文
- `read_reference` 细节
- TAG 校验内部过程
- LLM 多轮内部消息

用户需要的是“用了哪个专业规则、写了什么资产、有没有警告”，不是工具调用裸日志。

### 8.5 方案判断

因此，合并 subagent 不会天然丢失 skill 可见性。

真正的问题是：**当前 UI 没有把已有 skill 字段展示出来。**

如果坚持不改前端，那日志确实会弱化为 subagent 级别；如果允许轻量 UI 改造，日志可以比现在更清楚，因为所有设计行为都聚合在一个入口下，并明确显示当前 skill。

## 9. 风险探查

### 9.1 design_builder 变成万能工具

统一入口后，模型可能主动扩张任务范围。

缓解：

- 总 prompt 强调“最小必要 skill”。
- 默认一次只写一个资产。
- 多 skill 连续执行必须有用户明确授权。

### 9.2 缺上游降级导致资产质量不稳定

允许从场景切入会更活络，但也会让场景资产缺少上游约束。

缓解：

- 降级产物必须标明依赖假设。
- 后续质检可识别“草案”与“正式设计资产”的差异。
- 用户进入写作期前仍需完成设计校准。

### 9.3 Orchestrator 过度依赖 design_builder

Orchestrator 可能把所有任务都丢给 `design_builder`。

缓解：

- 写作期仍只暴露 `prose_writer`。
- 质检仍由 `quality_checker` 承担。
- 导入归一化等机制任务是否并入 design_builder，需要单独评估。

### 9.4 Skill 选择错误

一个 subagent 下 skill 变多后，skill index 会变长，模型可能选错。

缓解：

- 每个 skill 的 `description` 和 `when` 要写得更尖锐。
- 目标层关键词前置。
- Orchestrator instruction 要明确“用户要的是世界观/角色/场景/节拍”。

### 9.5 日志可解释性下降

如果前端不显示 skill，统一 subagent 会让日志变粗。

缓解：

- 利用现有 `skillName` 字段显示当前 skill。
- 把 `read_skill` 事件作为子步骤或 subtitle。

## 10. 验收标准

- 设计期对外主要调用 `design_builder`。
- `design_builder` 能通过 read_skill 渐进式选择具体设计 skill。
- 缺上游时不会机械拒绝，而是按规则降级、最小补齐或澄清。
- 下游仍不能反向改写上游。
- 写作期 `prose_writer` 不受影响。
- 质检 `quality_checker` 不受影响。
- 执行日志能显示当前使用的 skill，至少显示 `skillName`。
