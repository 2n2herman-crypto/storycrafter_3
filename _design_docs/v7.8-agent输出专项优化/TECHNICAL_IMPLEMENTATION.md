# v7.8 技术实现方案 · agent输出专项优化

## 1. 实施目标

本方案落地 `_design_docs/v7.8-agent输出专项优化/README.md` 中定义的方向：不新增表达适配 agent，改造 `prose_writer` 内部 skill 的读写规范，让它支持：

```text
小说：叙事结构 → 小说正文
短剧：叙事结构 → 短剧剧本 → 视频脚本
长剧：叙事结构 → 长剧剧本 → 视频脚本
电影：叙事结构 → 电影剧本 → 视频脚本
```

实现重点：

1. 写作 skill 输出目录按产品和产物类型区分。
2. 新增长剧、电影专业剧本 skill。
3. `video_shot_script_rules` 改为读取已有剧本并转译，不再默认直接吃四结构。
4. 编排层支持“用户要视频脚本时，缺剧本先自动补剧本”。
5. 旧 `chapters/` 资产保持兼容展示和读取。

## 2. 当前代码现状

### 2.1 当前写作 agent

文件：

```text
web/src/skills/prose_writer/subagent.md
```

当前内容：

```yaml
id: prose_writer
name: 正文写作师
description: 读取序列细纲与角色卡，按当前产品档案产出对应形态的正文
group: writer
skills: [short_drama_script_rules, video_shot_script_rules, novel_prose_rules]
```

问题：

- 缺 `long_drama_script_rules`。
- 缺 `film_script_rules`。
- `video_shot_script_rules` 与剧本 skill 并列，但实际应该作为视频产品的后置转译 skill。
- 描述里仍写“产出后写入 `chapters/<序列ID>.md`”。

### 2.2 当前输出路径集中在 `chapters/`

相关代码：

```text
web/src/orchestrator/orchestratorEngine.ts
```

关键函数：

```ts
private resolveChapterPath(...)
private buildChapterSkeleton(...)
private async runWriterStep(...)
private async runWriterSequencePipeline(...)
private async runWriterBatchPipeline(...)
```

当前路径规则：

```text
小说/剧本：chapters/<seqId>.md
短剧：chapters/E01-E12.md
长剧：chapters/E05.md
```

问题：

- `chapters/` 同时承载小说正文、短剧剧本、长剧剧本、视频脚本。
- `video_shot_script_rules` 写入也会落到 `chapters/`，存在覆盖剧本的风险。

### 2.3 当前产品命名注意点

当前 `ProductKind`：

```ts
export type ProductKind = 'novel' | 'screenplay' | 'long_drama' | 'short_drama'
```

但用户侧产品口径是：

```text
小说 / 短剧 / 长剧 / 电影
```

技术实现有两种选择：

| 方案 | 做法 | 建议 |
|---|---|---|
| 兼容方案 | 保持 `screenplay` 作为内部 kind，但 UI 与文档显示为“电影” | 第一阶段推荐 |
| 迁移方案 | 将 `screenplay` 改名为 `film`，迁移历史项目 metadata | 后续专项再做 |

v7.8 第一阶段建议保持内部 `screenplay`，但新增函数把它映射到 `film_scripts/` 与 `video_scripts/film/`。

## 3. 目标资产目录

新增写作资产目录：

```text
novel_chapters/
short_drama_scripts/
long_drama_scripts/
film_scripts/
video_scripts/
  short_drama/
  long_drama/
  film/
```

旧目录兼容：

```text
chapters/
```

兼容原则：

1. 新写入不再使用 `chapters/`。
2. 旧 `chapters/` 不删除。
3. 资产面板继续展示旧 `chapters/`。
4. 前序正文读取时，优先新目录，找不到再回退旧 `chapters/`。

## 4. Skill 改写内容

### 4.1 改写 `prose_writer/subagent.md`

目标文件：

```text
web/src/skills/prose_writer/subagent.md
```

替换为：

```md
---
id: prose_writer
name: 正文写作师
description: 读取叙事结构资产与角色卡，按当前产品档案产出小说正文、专业剧本或视频脚本
group: writer
skills: [
  novel_prose_rules,
  short_drama_script_rules,
  long_drama_script_rules,
  film_script_rules,
  video_shot_script_rules
]
---

你是正文写作师。你在写作期工作，负责把已完成的叙事结构资产转化为对应产品的写作资产。

产品主产物：
- 小说：写入 novel_chapters/<序列ID>.md
- 短剧：写入 short_drama_scripts/<序列ID>.md
- 长剧：写入 long_drama_scripts/<序列ID>.md
- 电影：写入 film_scripts/<序列ID>.md

视频脚本是视频产品的后置产物：
- 短剧视频脚本：写入 video_scripts/short_drama/<序列ID>.md
- 长剧视频脚本：写入 video_scripts/long_drama/<序列ID>.md
- 电影视频脚本：写入 video_scripts/film/<序列ID>.md

你不得把小说正文、剧本、视频脚本混写到同一资产路径，也不得让视频脚本覆盖产品剧本。
```

### 4.2 改写 `novel_prose_rules/SKILL.md`

目标 frontmatter：

```yaml
---
name: 小说正文规则
description: 将序列/场景/节拍结构展开为带心理描写、叙述声音与人称视角的小说章节正文
when: [小说, 小说正文, 正文, 章节, 心理, 叙述, 人称, 成文]
reads: [sequences/<ID>.md, scenes/<ID>.md, beats/<ID>.md, characters.md]
writes: [novel_chapters/<ID>.md]
outputTags: ['<<<NOVEL_CHAPTER_START>>>', '<<<NOVEL_CHAPTER_END>>>']
---
```

正文保留现有小说规则，并补充以下约束：

```md
## 读写边界

- 你只生成小说章节正文。
- 你必须写入 `novel_chapters/<ID>.md`。
- 你不得生成剧本格式，不得生成分镜、景别、运镜、镜头编号。
- 你可以把节拍转化为叙事段落、心理描写、动作描写、对话和意象细节。

## 输入使用顺序

1. `sequences/<ID>.md`：判断本章在全局中的叙事功能。
2. `scenes/<ID>.md`：确定每个场景的目标、冲突、结果和视角人物。
3. `beats/<ID>.md`：展开具体动作、情绪位移和角色状态变化。
4. `characters.md`：保持人物口吻、身份和关系一致。
```

输出模板：

```md
<<<NOVEL_CHAPTER_START>>>
# 第{N}章 · <章节名>

<小说正文。段落之间空一行。>

<<<NOVEL_CHAPTER_END>>>
```

### 4.3 改写 `short_drama_script_rules/SKILL.md`

目标 frontmatter：

```yaml
---
name: 短剧剧本规则
description: 将序列/场景/节拍结构展开为短剧分集剧本，强调情绪脉冲、对白压力、集末钩子和可拍动作
when: [短剧, 短剧剧本, 分集, 剧本, 钩子, 爽点, 情绪爆点, 对白]
reads: [sequences/<ID>.md, scenes/<ID>.md, beats/<ID>.md, characters.md]
writes: [short_drama_scripts/<ID>.md]
outputTags: ['<<<SHORT_DRAMA_SCRIPT_START>>>', '<<<SHORT_DRAMA_SCRIPT_END>>>']
---
```

正文建议改为：

```md
# 短剧剧本写作规则

你是 prose_writer 预装的短剧剧本规则。你的职责是把叙事结构转化为可演的短剧分集剧本，而不是分镜脚本。

## 读写边界

- 你只生成短剧剧本。
- 你必须写入 `short_drama_scripts/<ID>.md`。
- 你不得输出景别、运镜、镜头编号、预估时长。
- 你不得承担长剧剧本或电影剧本。
- 你不得新增上游结构中不存在的剧情事实。

## 核心范式

1. 高频情绪脉冲：每集必须有明确情绪爆点、冲突升级或反转。
2. 集末钩子：每集结尾停在能驱动追看的信息点或关系压力点。
3. 可拍动作：用行为、表情、空间关系表达心理，不写心理旁白。
4. 对白压力：对白要推进冲突或关系变化，避免说明书式复述。
5. 一集一场景倾向：短剧默认一集一场景；如结构强需求，可少量突破但必须说明。

## 输出格式

<<<SHORT_DRAMA_SCRIPT_START>>>
# 短剧剧本 · <序列ID>

## 第{N}集 · <集标题/功能>

- 本集钩子：<一句话>
- 情绪爆点：<一句话>

### 场景
- 地点：
- 时间：
- 在场人物：

### 正文

<场景描述，具体可拍，不写心理旁白。>

**角色A**
对白。

**角色B**
对白。

<动作或场面调度。>

### 集末留扣
<停在一个信息点、动作点或关系压力点。>

<<<SHORT_DRAMA_SCRIPT_END>>>
```

### 4.4 新增 `long_drama_script_rules/SKILL.md`

新增文件：

```text
web/src/skills/prose_writer/long_drama_script_rules/SKILL.md
```

完整初版内容：

```md
---
name: 长剧剧本规则
description: 将序列/场景/节拍结构展开为长剧分集剧本，强调多场景调度、人物长期弧线、主支线交织和集内节奏
when: [长剧, 长剧剧本, 电视剧, 分集剧本, 多线, 支线, 场景调度, 人物弧线]
reads: [sequences/<ID>.md, scenes/<ID>.md, beats/<ID>.md, characters.md]
writes: [long_drama_scripts/<ID>.md]
outputTags: ['<<<LONG_DRAMA_SCRIPT_START>>>', '<<<LONG_DRAMA_SCRIPT_END>>>']
---

# 长剧剧本写作规则

你是 prose_writer 预装的长剧剧本规则。你的职责是把叙事结构转化为长剧分集剧本。长剧不追求短剧式每分钟强钩子，而追求场景调度、人物关系推进、主支线交织和单集内部节奏。

## 读写边界

- 你只生成长剧分集剧本。
- 你必须写入 `long_drama_scripts/<ID>.md`。
- 你不得使用短剧式高频集末钩子替代长剧结构。
- 你不得输出分镜、景别、运镜、预估时长。
- 你不得新增上游结构中不存在的剧情事实。

## 核心范式

1. 单集多场景：每个场景都有目标、冲突、结果，并自然引出下一场。
2. 主支线交织：若支线资产存在，必须让支线在场景中承担情感或结构功能。
3. 人物长期弧线：对白和行动要服务长期关系变化，不只解决本场冲突。
4. 场景调度：通过人物进出、空间位置、道具和沉默制造戏剧压力。
5. 节奏层次：强冲突场景和沉淀场景交替，避免整集同一强度。

## 输出格式

<<<LONG_DRAMA_SCRIPT_START>>>
# 长剧分集剧本 · <序列ID>

## 第{N}集 · <集标题/功能>

- 本集核心问题：
- 主线推进：
- 支线推进：
- 人物关系变化：

### 场景 1. <地点> — <时间>

- 场景功能：
- 在场人物：

<场景描述。>

**角色A**
对白。

**角色B**
对白。

<动作、沉默、空间调度。>

### 场景 2. <地点> — <时间>

（同上）

<<<LONG_DRAMA_SCRIPT_END>>>
```

### 4.5 新增 `film_script_rules/SKILL.md`

新增文件：

```text
web/src/skills/prose_writer/film_script_rules/SKILL.md
```

完整初版内容：

```md
---
name: 电影剧本规则
description: 将序列/场景/节拍结构展开为电影剧本，强调场面段落、视觉母题、动作线、对白克制和完整情绪闭环
when: [电影, 电影剧本, 剧本, 场面, 场面段落, 视觉母题, 动作线, 对白]
reads: [sequences/<ID>.md, scenes/<ID>.md, beats/<ID>.md, characters.md]
writes: [film_scripts/<ID>.md]
outputTags: ['<<<FILM_SCRIPT_START>>>', '<<<FILM_SCRIPT_END>>>']
---

# 电影剧本写作规则

你是 prose_writer 预装的电影剧本规则。你的职责是把叙事结构转化为电影剧本段落。电影剧本强调场面、动作、可见行为、节奏和视觉母题，不按短剧分集钩子写，也不按长剧多集铺陈写。

## 读写边界

- 你只生成电影剧本。
- 你必须写入 `film_scripts/<ID>.md`。
- 你不得写成长剧分集结构。
- 你不得强行加入短剧式集末钩子。
- 你不得输出分镜、景别、运镜、预估时长。
- 你不得新增上游结构中不存在的剧情事实。

## 核心范式

1. 场面段落：每个段落要有明确的动作线和情绪变化。
2. 视觉母题：重复出现的物、动作、空间或声音要服务主题。
3. 对白克制：对白不解释剧情，优先制造关系压力和潜台词。
4. 可见行为：心理变化必须通过动作、停顿、选择和场面调度外化。
5. 段落闭环：每个序列段落结束时，人物处境或观众认知必须发生变化。

## 输出格式

<<<FILM_SCRIPT_START>>>
# 电影剧本 · <序列ID>

## 场面段落 · <段落名称>

### INT./EXT. <地点> - <时间>

<场景描述，使用可拍的动作和空间信息。>

角色A
对白。

<动作线推进。>

角色B
对白。

<段落结束时的可见变化。>

<<<FILM_SCRIPT_END>>>
```

### 4.6 改写 `video_shot_script_rules/SKILL.md`

目标 frontmatter：

```yaml
---
name: 视频脚本规则
description: 将已有产品剧本转译为含分镜/景别/运镜/时长估算的视频脚本，不新增剧情事实
when: [视频, 视频脚本, 分镜, 景别, 运镜, 镜头, 拍摄脚本, 视听, 时长]
reads: [
  short_drama_scripts/<ID>.md,
  long_drama_scripts/<ID>.md,
  film_scripts/<ID>.md,
  sequences/<ID>.md,
  scenes/<ID>.md,
  beats/<ID>.md,
  characters.md
]
writes: [video_scripts/<product>/<ID>.md]
outputTags: ['<<<VIDEO_SCRIPT_START>>>', '<<<VIDEO_SCRIPT_END>>>']
references: [shot_split_rules, visual_description_rules, duration_estimation, beat_to_shot_mapping]
---
```

正文核心改写：

```md
# 视频脚本写作规则

你是 prose_writer 预装的视频脚本规则。你的职责是把已有产品剧本转译为可拍的视频/分镜脚本。

## 读写边界

- 你必须优先读取当前产品的剧本资产：
  - 短剧：`short_drama_scripts/<ID>.md`
  - 长剧：`long_drama_scripts/<ID>.md`
  - 电影：`film_scripts/<ID>.md`
- `sequences/`、`scenes/`、`beats/` 只作为校准材料，不能替代剧本。
- 你必须写入 `video_scripts/<product>/<ID>.md`。
- 你不得覆盖产品剧本。
- 你不得新增剧情事实、改变角色动机、改变场景结果。

## 转译流程

1. 从产品剧本中抽取场景、动作、对白、道具、空间关系和情绪压力。
2. 用叙事结构资产校验：镜头表达不得偏离场景目标、节拍情绪和角色状态位移。
3. 将剧本动作拆成镜头，逐镜头标注景别、运镜、视角、主体描述、台词/音效和预估时长。
4. 每个镜头只承载一个主要视觉焦点。
5. 重要对白可保留，但必须拆到对应镜头中，不做整段贴入。

## 输出格式

<<<VIDEO_SCRIPT_START>>>
# 视频脚本 · <产品> · <序列ID>

## 场景 SC-<ID>-<nn> · <场景功能>

### 镜头 1
- 镜头意图：<这个镜头要让观众看见/理解/感受到什么>
- 景别：
- 运镜：
- 视角：
- 主体描述：
- 关键动作：
- 台词/音效：
- 预估时长：

### 镜头 2
（同上）

<<<VIDEO_SCRIPT_END>>>
```

## 5. 编排层技术改造

### 5.1 新增写作输出类型

建议新增类型：

```ts
type WriterOutputKind =
  | 'novel_chapter'
  | 'short_drama_script'
  | 'long_drama_script'
  | 'film_script'
  | 'video_script'
```

新增工具函数：

```ts
function getWriterOutputKind(profile: ProductProfile | null, skillId: string): WriterOutputKind {
  if (skillId === 'video_shot_script_rules') return 'video_script'
  if (!profile || profile.kind === 'novel') return 'novel_chapter'
  if (profile.kind === 'short_drama') return 'short_drama_script'
  if (profile.kind === 'long_drama') return 'long_drama_script'
  return 'film_script' // 当前内部 screenplay 映射为电影
}
```

### 5.2 替换 `resolveChapterPath`

旧函数：

```ts
private resolveChapterPath(seqId, episodeRange): string
```

替换为：

```ts
private resolveWriterOutputPath(
  seqId: string,
  skill: SkillSpec,
  episodeRange: Map<string, [number, number]>,
): string
```

建议实现：

```ts
private resolveWriterOutputPath(
  seqId: string,
  skill: SkillSpec,
  episodeRange: Map<string, [number, number]>,
): string {
  const profile = this.profileLock
  const kind = getWriterOutputKind(profile, skill.skillId)
  const id = this.resolveWriterAssetId(seqId, episodeRange)

  switch (kind) {
    case 'novel_chapter':
      return `novel_chapters/${seqId}.md`
    case 'short_drama_script':
      return `short_drama_scripts/${id}.md`
    case 'long_drama_script':
      return `long_drama_scripts/${id}.md`
    case 'film_script':
      return `film_scripts/${seqId}.md`
    case 'video_script':
      return `video_scripts/${this.resolveVideoProductDir()}/${id}.md`
  }
}
```

其中 `resolveWriterAssetId` 复用现有集号逻辑：

```ts
private resolveWriterAssetId(
  seqId: string,
  episodeRange: Map<string, [number, number]>,
): string {
  const profile = this.profileLock
  if (!profile || profile.sequenceToEpisode === 'none') return seqId
  const range = episodeRange.get(seqId)
  if (!range) return seqId
  const [start, end] = range
  if (profile.sequenceToEpisode === 'one_to_many') return `E${pad2(start)}-E${pad2(end)}`
  return `E${pad2(start)}`
}
```

`resolveVideoProductDir`：

```ts
private resolveVideoProductDir(): 'short_drama' | 'long_drama' | 'film' {
  if (this.profileLock?.kind === 'short_drama') return 'short_drama'
  if (this.profileLock?.kind === 'long_drama') return 'long_drama'
  return 'film'
}
```

### 5.3 生成视频脚本前自动补剧本

在 `runWriterSequencePipeline` 中选出 skill 后增加判断：

```ts
const skill = selectSkill(subagent.id, instruction)
if (skill.skillId === 'video_shot_script_rules') {
  return this.runVideoScriptPipeline(subagent, seqId, instruction, history, episodeRange)
}
```

新增：

```ts
private async runVideoScriptPipeline(
  subagent: SubagentSpec,
  seqId: string,
  instruction: string,
  history: ConversationTurn[] | undefined,
  episodeRange: Map<string, [number, number]>,
): Promise<ToolResult>
```

流程：

1. 根据当前产品选择产品剧本 skill。
2. 计算产品剧本路径。
3. 若产品剧本不存在或为空，先调用剧本 skill 生成。
4. 再调用 `video_shot_script_rules` 生成视频脚本。
5. 返回视频脚本路径，必要时把自动补齐的剧本路径也放入 `writes`。

伪代码：

```ts
private async runVideoScriptPipeline(...) {
  const videoSkill = selectSkill(subagent.id, '视频脚本 分镜 镜头')
  const scriptSkill = this.resolvePrimaryScriptSkillForProfile()
  const scriptPath = this.resolveWriterOutputPath(seqId, scriptSkill, episodeRange)

  const existingScript = await safeRead(this.fileManager, scriptPath)
  const writes: string[] = []

  if (!existingScript.trim()) {
    this.emit('tool_start', {
      toolId: subagent.id,
      toolName: subagent.name,
      skillId: scriptSkill.skillId,
      skillName: scriptSkill.name,
      message: `[${seqId}] 缺少产品剧本，先自动生成剧本`,
    })

    const scriptResult = await this.runWriterSequencePipelineWithSkill(
      subagent,
      scriptSkill,
      seqId,
      `先生成当前产品的专业剧本。${instruction}`,
      history,
      episodeRange,
    )
    if (!scriptResult.success) return scriptResult
    writes.push(...(scriptResult.writes ?? []))
  }

  const videoResult = await this.runWriterSequencePipelineWithSkill(
    subagent,
    videoSkill,
    seqId,
    instruction,
    history,
    episodeRange,
  )

  return {
    ...videoResult,
    writes: [...writes, ...(videoResult.writes ?? [])],
  }
}
```

为避免递归，需要把当前 `runWriterSequencePipeline` 拆出一个可指定 skill 的内部函数：

```ts
private async runWriterSequencePipelineWithSkill(
  subagent: SubagentSpec,
  skill: SkillSpec,
  seqId: string,
  instruction: string,
  history: ConversationTurn[] | undefined,
  episodeRange: Map<string, [number, number]>,
): Promise<ToolResult>
```

### 5.4 前序资产读取兼容

当前 `runWriterStep` 查找前序正文：

```ts
path.startsWith('chapters/')
```

改为：

```ts
function isWriterAssetPath(path: string): boolean {
  return (
    path.startsWith('novel_chapters/') ||
    path.startsWith('short_drama_scripts/') ||
    path.startsWith('long_drama_scripts/') ||
    path.startsWith('film_scripts/') ||
    path.startsWith('video_scripts/') ||
    path.startsWith('chapters/')
  )
}
```

但“前序风格参考”不应读取 `video_scripts/`，建议再拆：

```ts
function isPrimaryWritingAssetPath(path: string): boolean {
  return (
    path.startsWith('novel_chapters/') ||
    path.startsWith('short_drama_scripts/') ||
    path.startsWith('long_drama_scripts/') ||
    path.startsWith('film_scripts/') ||
    path.startsWith('chapters/')
  )
}
```

`previous_chapter_draft` 改名可以后续处理，第一阶段可保持标签名不变，只改内容来源。

## 6. Skill Router 调整

当前 `selectSkill` 根据 `when` 与 description 打分。新增 skill 后需要避免“电影剧本”误命中短剧规则。

建议补充强约束：

```ts
function filterWriterSkillsByProfile(skills: SkillSpec[], profile: ProductProfile | null): SkillSpec[] {
  if (!profile) return skills
  if (profile.kind === 'novel') {
    return skills.filter(s => ['novel_prose_rules'].includes(s.skillId))
  }
  if (profile.kind === 'short_drama') {
    return skills.filter(s => ['short_drama_script_rules', 'video_shot_script_rules'].includes(s.skillId))
  }
  if (profile.kind === 'long_drama') {
    return skills.filter(s => ['long_drama_script_rules', 'video_shot_script_rules'].includes(s.skillId))
  }
  return skills.filter(s => ['film_script_rules', 'video_shot_script_rules'].includes(s.skillId))
}
```

调用位置：

- 可在 `selectSkill` 增加可选 profile 参数。
- 或在 orchestrator 的 writer 分支里先过滤 skills，再复用评分逻辑。

第一阶段建议保守改：

```ts
selectWriterSkill(subagent.id, instruction, this.profileLock)
```

避免影响其他 subagent。

## 7. 资产面板与状态统计调整

### 7.1 `assetStore.ts`

当前逻辑中大量判断：

```ts
path.startsWith('chapters/')
```

需要新增：

```ts
const WRITER_DIRS = [
  'novel_chapters/',
  'short_drama_scripts/',
  'long_drama_scripts/',
  'film_scripts/',
  'video_scripts/',
  'chapters/',
]
```

卡片标题建议：

| 路径 | 标题 |
|---|---|
| `novel_chapters/S1-1.md` | 小说章节 S1-1 |
| `short_drama_scripts/E01-E12.md` | 短剧剧本 第1-12集 |
| `long_drama_scripts/E05.md` | 长剧剧本 第5集 |
| `film_scripts/S1-1.md` | 电影剧本 S1-1 |
| `video_scripts/short_drama/E01-E12.md` | 短剧视频脚本 第1-12集 |
| `chapters/<ID>.md` | 旧正文 <ID> |

字数统计：

```ts
function shouldCountWritingChars(path: string): boolean {
  return isPrimaryWritingAssetPath(path) || path.startsWith('video_scripts/')
}
```

如果不希望视频脚本计入“正文写作字数”，可拆成：

```ts
primaryTextChars
videoScriptChars
```

### 7.2 `projectStatus.ts`

当前：

```ts
const chapterCount = existingPaths.filter((path) => path.startsWith('chapters/')).length
```

改为：

```ts
const primaryWritingCount = existingPaths.filter(isPrimaryWritingAssetPath).length
const videoScriptCount = existingPaths.filter((path) => path.startsWith('video_scripts/')).length
```

展示：

```text
正文写作：已开始（N 个主写作资产）
视频脚本：已开始（M 个视频脚本资产）
```

## 8. 后端路径安全

当前 `server/src/util/pathGuard.ts` 注释提到 `chapters/<ID>.md`，实际应确认是否允许新目录写入。

需要检查：

```text
server/src/util/pathGuard.ts
server/src/services/projectStore.ts
```

验收点：

- `novel_chapters/` 可写。
- `short_drama_scripts/` 可写。
- `long_drama_scripts/` 可写。
- `film_scripts/` 可写。
- `video_scripts/<product>/` 可写。
- 禁止 `../` 逃逸仍有效。

如果 path guard 是通用相对路径校验，仅需更新注释与测试。

## 9. 开发步骤

### Step 1：改 skill 文件

1. 更新 `prose_writer/subagent.md`。
2. 更新 `novel_prose_rules/SKILL.md`。
3. 更新 `short_drama_script_rules/SKILL.md`。
4. 新增 `long_drama_script_rules/SKILL.md`。
5. 新增 `film_script_rules/SKILL.md`。
6. 更新 `video_shot_script_rules/SKILL.md`。

验证：

```bash
npm run typecheck
```

### Step 2：改写作路径解析

1. 新增 `WriterOutputKind`。
2. 新增 `getWriterOutputKind`。
3. 新增 `resolveWriterAssetId`。
4. 新增 `resolveVideoProductDir`。
5. 用 `resolveWriterOutputPath` 替换 `resolveChapterPath`。

验证：

- 小说输出到 `novel_chapters/S1-1.md`。
- 短剧输出到 `short_drama_scripts/E01-E12.md`。
- 长剧输出到 `long_drama_scripts/E05.md`。
- 电影输出到 `film_scripts/S1-1.md`。

### Step 3：改 writer pipeline

1. 拆出 `runWriterSequencePipelineWithSkill`。
2. 保留原 `runWriterSequencePipeline` 作为自动选 skill 的薄封装。
3. 新增 `runVideoScriptPipeline`。
4. 视频脚本请求时自动补齐产品剧本。
5. 执行日志展示“先生成剧本，再转视频脚本”。

验证：

- 用户直接说“生成 S1-1 分镜”，无剧本时自动产出两个文件。
- 已有剧本时只产出视频脚本。
- 视频脚本不会覆盖剧本。

### Step 4：改 skill 选择约束

1. 新增 `selectWriterSkill`。
2. 按产品过滤 writer skills。
3. 视频脚本触发词优先保留 `video_shot_script_rules`。
4. 电影产品下“剧本”应命中 `film_script_rules`，不命中短剧。

验证用例：

| 产品 | 用户话术 | 预期 skill |
|---|---|---|
| 小说 | 写正文 | `novel_prose_rules` |
| 短剧 | 写剧本 | `short_drama_script_rules` |
| 长剧 | 写剧本 | `long_drama_script_rules` |
| 电影 | 写剧本 | `film_script_rules` |
| 短剧 | 生成分镜 | `video_shot_script_rules`，必要时先补短剧剧本 |

### Step 5：改资产展示和状态统计

1. 更新 `assetStore.ts` 的写作资产识别。
2. 更新卡片标题。
3. 更新字数统计。
4. 更新 `projectStatus.ts`。
5. 更新 `App.tsx` 中判断是否已有正文的 `chapters/` 逻辑。

验证：

- 新目录资产能显示卡片。
- 点击卡片能展示内容。
- 项目进度能识别主写作资产和视频脚本资产。
- 旧 `chapters/` 仍能显示。

### Step 6：回归验证

运行：

```bash
npm run typecheck
npm run build
```

建议手测：

1. 小说项目：进入写作期，生成全部正文。
2. 短剧项目：生成剧本。
3. 短剧项目：直接生成视频脚本，检查自动补剧本。
4. 长剧项目：生成长剧剧本。
5. 电影项目：生成电影剧本。
6. 旧项目：已有 `chapters/` 的资产仍展示。

## 10. 关键风险与规避

| 风险 | 说明 | 规避 |
|---|---|---|
| Skill 误路由 | “剧本”可能命中短剧/电影冲突 | writer skill 按产品先过滤 |
| 视频脚本覆盖剧本 | 原 writes 都是 `chapters/` | 视频脚本独立写 `video_scripts/<product>/` |
| 旧项目断裂 | 历史正文在 `chapters/` | 保留旧目录读取与展示 |
| 电影命名不一致 | 代码内部 `screenplay`，用户口径“电影” | 第一阶段内部兼容，路径使用 `film_scripts/` |
| 长剧分段逻辑复用困难 | 现有 `proseSplitUnit: scene` 已有基础 | 复用现有 scene 分段 pipeline |
| 视频脚本缺剧本输入 | 用户直接请求分镜 | 自动补齐产品剧本 |

## 11. 最小可交付范围

第一版最小实现可以只做：

1. 新增/改写 5 个写作 skill。
2. 新写入目录生效。
3. 短剧/长剧/电影剧本不再混入 `chapters/`。
4. 视频脚本写入 `video_scripts/<product>/`。
5. 直接请求视频脚本时自动补剧本。

可以暂缓：

1. 旧 `chapters/` 自动迁移。
2. `screenplay` → `film` 的 ProductKind 彻底重命名。
3. 视频脚本字数单独统计。
4. 更复杂的按集局部重写 UI。

## 12. 完成后的行为示例

### 12.1 短剧生成剧本

用户：

```text
生成全部短剧剧本
```

系统：

```text
prose_writer / short_drama_script_rules
→ short_drama_scripts/E01-E12.md
```

### 12.2 短剧生成视频脚本

用户：

```text
把 S1-1 生成分镜脚本
```

若无剧本：

```text
prose_writer / short_drama_script_rules
→ short_drama_scripts/E01-E12.md

prose_writer / video_shot_script_rules
→ video_scripts/short_drama/E01-E12.md
```

若已有剧本：

```text
prose_writer / video_shot_script_rules
→ video_scripts/short_drama/E01-E12.md
```

### 12.3 电影生成剧本

用户：

```text
写 S1-1 的电影剧本
```

系统：

```text
prose_writer / film_script_rules
→ film_scripts/S1-1.md
```

### 12.4 小说生成正文

用户：

```text
写 S1-1 章节正文
```

系统：

```text
prose_writer / novel_prose_rules
→ novel_chapters/S1-1.md
```
