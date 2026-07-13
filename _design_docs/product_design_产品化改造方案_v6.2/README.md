# StoryCrafter v6.2 设计方案 · scene_beats 精简重构

> 承接 [`v6.1`](../product_design_产品化改造方案_v6.1/README.md) 的整体阶段闸门与"per-sequence 物理切片"共识不变;本篇**仅重构 scene_beats subagent 的内部实现**,削掉 v6.1 落地过程中出现的过度设计,同时把当时缓发的结构化校验补上。

---

## Context · 为什么要 v6.2

v6.1 把 scene_beats 从单体拆成四步内部纵切流水线(`sequence_decompose → scene_designer → beat_writer → assemble`),每步各调一次 LLM,中间产物落 `_seq/<ID>/*.md` 临件,终步 `clearByPrefix` 回收。跑通之后回看,这套设计对"per-sequence 切片"这个真正的目标而言,**多做了三层可去掉的复杂度**:

1. **S0 sequence_decompose 是伪工序**——它产出的几百 token 提纲(戏剧问题/场景数预估/角色子集/情绪曲线)本质上是"给 S1 场景骨架师看的前置心算",完全可以内嵌进 S1 自身的 system prompt 让模型一次想清楚,不必额外一次 LLM 调用+落盘+回读。
2. **S3 assemble 是伪工序**——它的核心工作是把 `<prev_scenes>` / `<prev_beats>` 两张表 verbatim 复制到成品模板里,再加一段一致性心算注释。让 LLM 做 verbatim 复制恰恰是它最容易翻车的事(漏行/改字/破坏分隔符),而"复制拼接"本身是确定性字符串操作,交给引擎代码 100% 可靠。
3. **临件目录 + 前缀隐藏 + 自动回收**是为服务上面两道伪工序而建的配套设施,它们消失后整套 `_seq/` 生命周期机制在 scene_beats 场景下也不再需要。

同时,v6.1 遗留一个真实缺口:**validator 只校验 START/END tag,不校验列数/ID 引用/类型词库**,单步 LLM 出错时 retry 只能盲重试烧配额。这在 v5.2 讨论里就提过,一直没做。v6.2 把它一起补上——**拆流水线换来的"每步专注"红利,只有配上结构化反馈才能兑现**。

命名撞车带来的认知税(`sequence_list` vs `sequence_decompose`)也随 S0 的删除顺带清零。

---

## 一句话定性

对外契约不变:**FC 一次调用 `scene_beats(target_sequence=Sx-y)` → 落盘一份 `sequences/Sx-y.md`**。对内实现从 4 步 LLM 削减为 2 步 LLM + 1 步引擎代码,取消临件落盘,新增结构化输出校验。

---

## 用户口径的目标(原话)

> 序列清单按序列切分,然后执行场次编写、节拍编写等,编写完再按序列为单位整理成一个 md 文件,所以最后会有多份序列为单位的文件。

映射到实现上就是三阶段管道:**"按序列切分"** 由 Orchestrator 依照 `sequence_list.md` 逐个下发 `target_sequence` 完成(这部分逻辑 v6.1 已就位不动);**"场次编写→节拍编写"** 是 scene_beats 内部两步 LLM 的职责;**"按序列整理成一个 md"** 是引擎代码拼装 `sequences/Sx-y.md` 的收口动作。

---

## 现状制约(必须承认的硬事实)

复读一遍以免设计漂移。

1. [`validateOutput()`](../src/orchestrator/outputValidator.ts#L17-L43) 固定按 `outputTags=[start,end]` 单对提取,写入 `extracted[skill.writes[0]]`。多 tag / 多 writes 不支持。
2. [`orchestratorEngine`](../src/orchestrator/orchestratorEngine.ts) 已有 `PIPELINE_REGISTRY` 分支与 `runPipeline` 私有方法(v6.1 建),对 Orchestrator 表现为原子化单次 tool_call。此处**保留分支存在但精简 steps 内容与实现方式**。
3. [`fileManager.clearByPrefix()`](../src/orchestrator/fileManager.ts#L68-L76) 接口保留(将来他用)但 scene_beats 不再调用。
4. [`assembleContext`](../src/orchestrator/contextAssembler.ts#L19-L37) + `appendExtraLabels`(定义在 engine 内部)机制不动,继续用于 S1→S2 的 `<prev_scenes>` 注入。
5. sequence_list.md 是全书序列骨架总表(11 列),`Skill.reads` 已包含它——scene_designer 通过读这张表定位当前 target 所属行的信息,不需要 v6.1 的 S0 二次拆解。

---

## 总体架构

```
FC: scene_beats(target_sequence='S1-2', instruction='...')
     │
     ▼
┌─ Guard: target 格式合法性 & Phase Gate ─┐
│         非法直接拒绝不下沉给 LLM        │
└──────────────────┬──────────────────────┘
                   ▼
        PIPELINE_REGISTRY[scene_beats]
                   │
      ┌────────────┴────────────┐
      ▼                         │
┌────────────┐  内存 scenesMd    │
│ S1 scene_designer (LLM)       │ 场景表 7 列
│ writes: 内存变量 (非落盘)     │
└────────────┘                  │
      │                         │
      ▼                         │
┌────────────┐                  │
│ S2 beat_writer (LLM)          │ 节拍表 6 列
│ reads: prev_scenes            │
│ writes: 内存变量 (非落盘)     │
└────────────┘                  │
      │                         │
      ▼                         │
┌────────────┐                  │
│ S3 assembleSequenceOutline    │ 纯代码,零 LLM
│ (engine code)                 │ 拼装标题 + 两表 + 结构审计注释
│ writes: sequences/<ID>.md     │
└────────────┘
```

对比 v6.1 的差异:

| 维度 | v6.1 现状 | v6.2 目标 |
|------|-----------|-----------|
| LLM 步数 | 4 (decompose/designer/writer/assemble) | 2 (designer/writer) |
| 中间落盘 | `_seq/<ID>/*.md` 三份临件 | 无,内存变量传递 |
| 终步落盘 | assemble LLM 产出 → sequences/<ID>.md | 引擎代码拼装 → sequences/<ID>.md |
| Validator | 只查 START/END tag 存在 | 加结构化钩子(列数/ID 引用/类型词库/裸竖线) |
| skill 目录 | 4 个 SKILL.md | 2 个 SKILL.md |
| 失败面 | 4× LLM retry 域 | 2× LLM retry 域 |
| 平均 LLM 调用 | ~4 次/序列 | ~2 次/序列 |

保留的 v6.1 卖点:

- **对 Orchestrator 原子化**:仍是单次 tool_call = 一个 sequences/<ID>.md,MAX_ROUNDS=10 压力不变;
- **PIPELINE_REGISTRY 分支存在**:未来若真需要给别的 subagent 挂多步管道(如 script_writer 长章分段),同一套 runPipeline 骨架可复用,不必再造轮子;
- **create/refine 双模**:S1 通过 `<current_target>`(此前落盘的成品) + `<current_scenes_snapshot>` 判定;S2 同理拿 `<current_beats_snapshot>` 判定。判据从"临件是否存在"改为"终品 sequences/<ID>.md 是否非空+抽表回填"(细节见 §D)。

---

## 分模块设计

### A. Skill 目录变更

**删除**:

```
src/skills/scene_beats/
├── sequence_decompose/    ← 删
└── assemble/              ← 删
```

**保留**(仅内容 frontmatter 精调):

```
src/skills/scene_beats/
├── subagent.md            ← 改:preamble 反映"两步 LLM+代码收口"新定位
├── scene_designer/
│   └── SKILL.md           ← 改:reads 依旧七项,body 内嵌 S0 心算维度让模型一次到位
└── beat_writer/
    └── SKILL.md           ← 改:reads 依旧七项,body 仍消费 <prev_scenes>
```

理由:sequence_decompose 的六要素心算(戏剧问题/场景数 N/角色子集/伏笔归属/情绪曲线/引导要点)全部下沉到 scene_designer 的 preamble 章节,让模型在生成场景表 *之前* 先在推理中走一遍,只是不再产出中间提纲文件。这是把"两步的信息整合"塞进"一步的思考链"里,LLM 完全 handle 得住(几百 token 的心算 vs 生成场景表本身,不构成注意力压力)。

### B. Engine 侧变更

#### B-1. PIPELINE_REGISTRY 精简

改 [`orchestratorEngine.ts`](../src/orchestrator/orchestratorEngine.ts#L102-L111):

```ts
const PIPELINE_REGISTRY: Record<string, PipeRegistryValue> = {
  scene_beats: {
    steps: [
      { skillId: 'scene_designer' },  // S1: LLM
      { skillId: 'beat_writer' },     // S2: LLM
      // S3 assemble 不在 steps 里——由 runPipeline 收尾时直接调 assembleSequenceOutline()
    ],
  },
}
```

`PipeStepDef.tempRel` 字段删除(不再需要落盘路径模板),`PipeRegistryValue` 结构简化。

#### B-2. runPipeline 改造

关键差异点:

- **中间产物在内存变量传递**,不走 `fileManager.writeFile` 也不 `readFile`,直接把 `validateOutput` 返回的 `extracted` 内容作为下一步 `<prev_scenes>` 注入源;
- **不再 `clearByPrefix`**——因为没有临件需要回收;
- **终步落盘由引擎函数 `assembleSequenceOutline(target, scenesMd, beatsMd)` 完成**,该函数是纯字符串拼装 + 结构复核,零 LLM 调用;
- **失败位点上报**改为"S1/S2/S3"三段命名,S3 结构复核失败上报的是"上游两步 LLM 已通过但拼装期发现引用不一致",Orchestrator 可据此提示用户重跑或人工介入。

伪代码骨架(实际实现见 §H 影响面清单):

```ts
private async runPipeline(subagent, pipe, target, instruction, history) {
  const finalPath = `sequences/${target}.md`
  const priorFinal = await safeRead(fm, finalPath)

  // S1: scene_designer
  const scenesMd = await this.runOneLLMStep({
    skillId: 'scene_designer',
    extraLabels: priorFinal ? [{ label: 'current_target', content: priorFinal }] : [],
    // ... assembleContext + preamble+body + retry×MAX_RETRIES
  })
  if (scenesMd === null) return abort('S1')

  // S2: beat_writer
  const beatsMd = await this.runOneLLMStep({
    skillId: 'beat_writer',
    extraLabels: [
      { label: 'prev_scenes', content: scenesMd },
      ...(priorFinal ? [{ label: 'current_target', content: priorFinal }] : []),
    ],
  })
  if (beatsMd === null) return abort('S2')

  // S3: 引擎代码拼装 + 结构复核 (无 LLM)
  const { finalMd, auditIssues } = assembleSequenceOutline(target, scenesMd, beatsMd)
  await fm.writeFile(finalPath, finalMd)

  return {
    success: true,
    writes: [finalPath],
    output: '',
    skillId: 'beat_writer',   // 归属最后一步 LLM 的 skillId 供事件流展示
    skillName: '节拍明细',
    // auditIssues 通过 event 上报或直接嵌入 finalMd 底部 HTML 注释,由 story_checker 后续消化
  }
}
```

#### B-3. assembleSequenceOutline() 引擎函数

新增到 `src/orchestrator/orchestratorEngine.ts` 内部私有函数(或抽到 `src/orchestrator/sceneBeatsAssembler.ts` 单文件均可,取轻量优先内嵌):

职责三项:

1. **提取正文**:从 scenesMd / beatsMd 中 extractBetween 各自 START/END tag,取出裸表 Markdown;
2. **拼装成品**:按固定模板串起标题、场景表标题、场景表、节拍表标题、节拍表、审计注释,外层包上 `<<<SCENE_BEAT_OUTLINE_START>>>` / `<<<SCENE_BEAT_OUTLINE_END>>>` 复用旧下游 tag 契约(script_writer 消费 `<current_sequence_beats>` 时正则匹配这对 tag);
3. **结构复核**:调用 §C 的 `structuralCheckSceneBeats(scenesMd, beatsMd)` 收集问题列表 → 若有则以 `<!-- audit-note: xxx -->` 追加于成品尾部,不阻断落盘(比 LLM 自审可靠得多)。

拼装模板:

```
<<<SCENE_BEAT_OUTLINE_START>>>
# {target_sequence}

### 场景表

{scenesMdBody}

### 节拍表

{beatsMdBody}

<!-- audit-note: {issue1} -->   （仅在有问题时追加,可 0~N 条）
<<<SCENE_BEAT_OUTLINE_END>>>
```

标题句 v6.1 曾从 decompose brief 里抽取,现在直接 `# {target_sequence}` 极简即可;若未来要更漂亮可从 sequence_list.md 反查该行的"序列定位/命名"列填入,属可选增强不入 v6.2 MVP。

### C. 结构化 Validator 钩子(v6.2 附赠红利)

#### C-1. 类型扩展

改 `src/types/index.ts`:

```ts
export interface SkillSpec {
  // ... 既有字段
  /** v6.2:可选结构化校验钩子。extracted 通过 START/END tag 提取后,再跑此函数;
   *  返回 null=通过, string=错误消息用作 retry 反馈追加到 userContent 尾部。
   *  未定义 = 保持既有行为(仅 tag 存在性校验)。
   *  钩子在 SKILL.md frontmatter 无法声明——由 skillLoader 按 subagentId/skillId 静态注册。
   */
  structuralCheck?: (extracted: string) => string | null
}
```

#### C-2. validator 集成点

改 `src/orchestrator/outputValidator.ts` `validateOutput`,在提取成功后追加钩子调用:

```ts
if (missingTags.length === 0) {
  const content = extractBetween(output, startTag, endTag)
  if (content !== null && skill.writes.length > 0) {
    if (skill.structuralCheck) {
      const err = skill.structuralCheck(content)
      if (err) {
        return { valid: false, missingTags: [], extracted: {}, structuralError: err }
      }
    }
    extracted[skill.writes[0]] = content
  }
}
```

`ValidationResult` 增字段 `structuralError?: string`,orchestratorEngine 重试消息生成时判断:若 structuralError 存在则 `userContent += "\n\n⚠️ 结构错误:" + err`,让模型看到具体反馈而非盲重试。这是 retry 从"抽奖"变"有反馈修正"的关键杠杆。

#### C-3. 钩子注册

新增文件 `src/skills/scene_beats/structuralChecks.ts`,导出两枚检查函数:

```ts
export function checkSceneTable(md: string): string | null {
  // 1. 首行必须是 |场景ID|...|视角人物| 且列数 = 7
  // 2. 分隔行合法 |---|...|
  // 3. 每数据行列数 = 7
  // 4. 场景ID 格式 /^SC-[A-Z]\d+-\d+-\d{2}$/
  // 5. 视角人物 & 出场角色不为空(允许 —)
  // 6. 单元格内无裸竖线(禁 `|`)
  // 违规首条返回中文提示;全通过 return null
}

export function checkBeatTable(md: string, scenesMd?: string): string | null {
  // 1. 列数 = 6
  // 2. 节拍序号 /^B-SC-[A-Z]\d+-\d+-\d{2}-\d+$/
  // 3. 所属场景 ∈ scenesMd 中出现的 SC-ID 集合(若提供 scenesMd 参数)
  // 4. 节拍类型 ∈ {铺垫/触发/对抗/转折/收束}
  // 5. 同场景内相邻两拍类型不相同
  // 6. 无裸竖线
  // 违规首条返回中文提示;全通过 return null
}
```

在 skillLoader 加载完毕后由引擎侧一次性挂钩(loader 本身不感知业务钩子,保持零依赖前缀原则):

```ts
// orchestratorEngine 构造函数或模块加载期一次性执行
import { checkSceneTable, checkBeatTable } from '../skills/scene_beats/structuralChecks'
const designerSkill = getSkills('scene_beats').find(s => s.skillId === 'scene_designer')
if (designerSkill) designerSkill.structuralCheck = checkSceneTable
const writerSkill = getSkills('scene_beats').find(s => s.skillId === 'beat_writer')
// beat_writer 的 check 需要 scenesMd 参数——由 runPipeline 内联匿名函数包装后临时挂载,或改用 closure(见 §H)
```

第二条 beat_writer 的检查涉及跨 skill 数据(需要 scenes 表的 SC-ID 集合),故不能在模块加载期静态挂载,而是在 `runPipeline` 内每次动态绑定:

```ts
writerSkillView.structuralCheck = (beatsMd) => checkBeatTable(beatsMd, scenesMd)
```

这是**为什么必须做在 runPipeline 里而非 validator 里全局配置**——上下文关联性使然。可接受的代价。

### D. Skill Body 微调

#### D-1. scene_designer/SKILL.md

frontmatter 保持:reads(七项固定薄设定),writes: ['sequences/.scenes-placeholder'],outputTags: ['<<<SCENE_TABLE_START>>>', '<<<SCENE_TABLE_END>>>']。placeholder 由 engine 忽略——runPipeline 不再落盘中间产物,extracted 内容直接进内存变量,writes[0] 只是 validator 内部记账用,反正也不会真触发 fm.writeFile。

body 变化点:

- **删除**"上游参照区段 `<prev_decompose>`"整节——本步不再有前置 LLM 步骤;
- **新增**"§场景数与要素心算"章节,把原 sequence_decompose 的六要素(戏剧问题/场景数 N/角色子集/伏笔归属/情绪曲线/引导要点)让模型 *在生成表格前先默想* 但不必写出,以此保证输出质量不因删掉 S0 而下滑;
- **REFINE 判据**改为:`<current_target>` 非空(即 sequences/<ID>.md 已存在的完整成品) → 从中抽取旧的场景表 verbatim 作为微调基线;
- **格式稳定性铁律**照旧,并新增一条:"validator 会做列数/ID 格式/裸竖线的机械校验,retry 时会拿到具体错位提示,请精确修正而非重来"——让模型知道有反馈通路。

#### D-2. beat_writer/SKILL.md

frontmatter:reads 七项固定,writes: ['sequences/.beats-placeholder'],outputTags: 沿用 `<<<BEAT_TABLE_START>>>` / `<<<BEAT_TABLE_END>>>`。

body 关键调整:

- `<prev_scenes>` 参照区段说明保留(唯一注入源)——上一步 S1 的表格 verbatim 塞进来供逐场景铺节拍;
- REFINE 判据同 D-1,`<current_target>` 内抽出旧节拍表作基线;
- 追加校验反馈说明。

#### D-3. subagent.md preamble 收尾说明

`scene_beats/subagent.md` 正文改为:

- 定位仍是"序列场记架构师",但**明确对外契约**:引擎按硬编码序推进 scene_designer → beat_writer 两步 LLM 后由代码拼装,不再提"四步"、"临件"、"assemble skill"等 v6.1 术语;
- 强调 target_sequence 参数必填合法格式;
- Skill Router 不参与选择(与 v6.1 一致,继续绕开);
- 未来若挂第二枚 skill(如 cross_sequence_check)仍走独立入口,不混搭进 pipeline。

### E. Frontmatter placeholder 命名规则

v6.1 遗留的 placeholder 命名散乱:

- `sequences/.placeholder` (assemble)
- `_seq/.decompose.ph` / `.scenes.ph` / `.beats.ph`(三份临件)

v6.2 简化为固定占位模式,让 loader 通过"至少一项非空数组"约束但绝不会被 fm.writeFile 触达:

```yaml
# scene_designer/SKILL.md
writes: ['sequences/.scenes-placeholder']

# beat_writer/SKILL.md
writes: ['sequences/.beats-placeholder']
```

runPipeline 明确不再消费 skill.writes[0] 作为落盘路径(旧 v6.1 会在 step.tempRel 里覆盖),仅 validator 内部拿它作 extracted key。落盘统一由 assembleSequenceOutline 走 finalPath = `sequences/${target}.md`。

### F. AssetStore 兜底(与 v6.1 一致,微检)

[`getAssetList()`](../src/store/assetStore.ts#L192-L207) 已有 `sequences/*` 前缀 → '大纲切片' 兜底分组。v6.2 无 `_seq/` 生成故不需要新的过滤规则,反而应确保没有幽灵条目——由 §B-2 不再调 clearByPrefix 但也不 writeFile 中间产物,天然无遗留。

如果历史会话在 v6.1 期间已积累过 `_seq/<ID>/*.md`,升级后需要一次性 `reset_all` 清空(InMemoryFileManager 刷新即失,ElectronFileManager 未上线,故实际不构成问题)。

### G. Orchestrator Prompt 无变化

`orchestrator_v5.md` 不动。scene_beats 对 Orchestrator 表现完全一致——单次 tool_call 消费一个 target_sequence 落盘一份 `sequences/*.md`,内部实现细节对上层透明。

Phase Gate 门控(v6.1 W2)不动;script_writer 消费 `sequences/<ID>.md` 的契约(v6.1 W1)不动。

### H. 影响面清单(待实施的文件级)

| 类型 | 文件 | 性质 |
|------|------|------|
| 删除 | `src/skills/scene_beats/sequence_decompose/` | 整目录 |
| 删除 | `src/skills/scene_beats/assemble/` | 整目录 |
| 改 | `src/skills/scene_beats/subagent.md` | preamble 重写为两步 LLM 表述 |
| 改 | `src/skills/scene_beats/scene_designer/SKILL.md` | body 内嵌 S0 心算维度,删 `<prev_decompose>` 说明 |
| 改 | `src/skills/scene_beats/beat_writer/SKILL.md` | body 微调,追加校验反馈说明 |
| 新增 | `src/skills/scene_beats/structuralChecks.ts` | checkSceneTable + checkBeatTable |
| 改 | `src/orchestrator/orchestratorEngine.ts` | PIPELINE_REGISTRY 精简至 2 steps;runPipeline 改内存传递 + 引擎收尾;新增 assembleSequenceOutline() 私有函数;删 STEP_LABEL_MAP.sequence_decompose/.assemble 项;删 tempDirPrefixOf/clearByPrefix 调用点 |
| 改 | `src/orchestrator/outputValidator.ts` | validateOutput 后置 structuralCheck 钩子调用;ValidationResult 增 structuralError 字段 |
| 改 | `src/types/index.ts` | SkillSpec 增 structuralCheck?;ValidationResult 增 structuralError? |

不动的文件:

- `src/skills/skillLoader.ts` — buildFunctionSpec 已支持 target_sequence 参数;
- `src/orchestrator/contextAssembler.ts` — assembleContext + listGeneratedAssets 都可复用;
- `src/orchestrator/fileManager.ts` — clearByPrefix 接口保留(未来他用),本次不删接口只是不调用;
- `src/orchestrator/skillRouter.ts` — 仍不参与 pipeline;
- `src/store/*` — assetStore 兜底逻辑已就位;
- `src/components/*` — UI 层零改动;
- `src/llm/prompts/orchestrator_v5.md` — Orchestrator prompt 零改动;
- `.claude/CLAUDE.md` — 只需在"v5.3 更新记录"下方追加一节"v6.2 更新记录"说明精简理由,权威描述迁移到 SKILL.md 本身。

---

## Wave 拆分(每 Wave = 一个 PR 边界)

沿用 v6.1 的 wave 语言,便于串接:

| Wave | 名称 | 前置 | 交付物 |
|------|------|------|--------|
| **W0** | 结构化 validator 基建 | 无 | types 扩展 + validator 钩子集成 + orchestratorEngine 重试消息追加 structuralError |
| **W1** | Skill 目录精简 + prompt 迁移 | W0 无强依赖(可并行) | 删 decompose/assemble 目录,改 subagent/designer/writer 三份 md |
| **W2** | Pipeline runPipeline 改造 | W1 (需要新 SKILL body) | PIPELINE_REGISTRY 精简 / runPipeline 内存传递 / assembleSequenceOutline() 引擎函数 / structuralCheck 钩子挂载 |
| **W3** | structuralChecks 落地与联调 | W0 + W2 | checkSceneTable + checkBeatTable 实现;e2e 手测生成→refine→reset 全流程 |

Wave 边界即 PR 边界——每 Wave 完成应能 `npx tsc -b` 绿灯且既有链路不退化。

---

## 边界情况处理

| 场景 | 行为 |
|------|------|
| S1 LLM 三次都过不了结构校验 | runPipeline 返回 success:false + error 定位在 S1;Orchestrator 拿到"scene_designer 场景表连续 3 次未通过结构校验:{具体错误}"文本反馈自行决定重新调度或转向 |
| S2 LLM 通过 tag 校验但 SC-ID 引用 S1 表里没有的场景 | checkBeatTable 拦下,retry 附带具体缺失 SC-ID 列表,S2 内自纠 |
| S3 拼装期发现 audit issue(比如伏笔 F-id 未在 foreshadowing 注册) | 不阻断落盘,追加 `<!-- audit-note -->` 供 story_checker 消化 |
| refine 模式(target 已存在) | S1/S2 各自收到 `<current_target>` 非空信号,SKILL body 内自动切换 refine 保原 ID 不动 |
| 用户短时间内连续对同一 target_sequence 提修改指令 | 每次都完整重跑 S1+S2+S3;S1/S2 SKILL body 的 refine 规则保证 ID 稳定,diff 噪音可控 |
| 中途 API 断流(deepseek 额度耗尽) | 已进入 S1 但未完成 → 抛错整体 abort;已完成 S1 未开 S2 → 内存变量丢失,下次重跑整条流水线(无临件残留天然幂等) |
| runPipeline 内 structuralCheck 钩子挂载失败(找不到 SkillSpec) | 早退返回 error,不静默降级——避免用户误以为通过但结构其实是脏的 |

---

## 风险登记册

| # | 风险 | 缓解 |
|---|------|------|
| R1 | S0 心算下沉到 S1 后,scene_designer 单次 LLM 负担变重可能出现"想多了写不完场景表"截断 | SKILL body 明确:心算部分不许写进输出正文,只作模型内部推理;若发现输出前置说明文字重试时明确禁止;实测若仍频繁截断可回退到 v6.1 分两步 |
| R2 | 结构化 checkBeatTable 对 scenesMd 中 SC-ID 集合的解析可能过严误伤边缘合法情况(如全角符号) | checkSceneTable/BeatTable 首个版本采取"宽松匹配"——不判断单元格内容语义合规性,只判断格式与引用关系。语义级审计仍交给 story_checker |
| R3 | assembleSequenceOutline() 提取 START/END 内部裸表时若 LLM 混入额外 markdown 段落会把非表格内容一并塞进成品 | extractBetween 简单取 tag 中间全文;若担心可加一条"只保留匹配 `^\|` 起始的行"的过滤器。**首版不做**——LLM 遵守 SKILL body 约束的可能性高,过滤器属过度防御 |
| R4 | v6.1 → v6.2 无版本迁移路径,若 InMemoryFileManager 意外持久化(未来 Electron 上线)导致遗留 `_seq/*` 幽灵条目 | 附一次性 reset_all 提示,或 ElectronFileManager 首次启动扫描并静默清理 `_seq/` 前缀。本 wave 不涉及 |
| R5 | script_writer 消费 `<current_sequence_beats>` 的正则若强绑 v6.1 assemble skill 的 `# {target}: 主题句` 头部格式 | 检查 script_writer/SKILL.md 是否依赖此格式;若依赖,assembleSequenceOutline() 模板需保留可选副标题槽或不动即可(默认 `# S1-1` 简洁头兼容大多数下游读法) |

---

## Verification(端到端手测步骤)

1. `npx tsc -b` 绿灯零 error;
2. `npm run dev` 冷启动无白屏、loader 不抛 frontmatter/目录错;
3. 走完 designing 期基础链路 → 触发 `scene_beats(target_sequence='S1-1')`;
4. DevTools Network 观察:该 tool_call 内部发出**恰好 2 次** deepseek requests(S1 + S2),第三次为 story_checker 或其他,不再是 4 次;
5. 落盘检查:`sequences/S1-1.md` 存在,内容包含 `# S1-1` + 场景表 + 节拍表 + (可能的 audit-note);无 `_seq/S1-1/` 目录;
6. 结构错误注入测试:临时在 scene_designer SKILL body 里加一句"故意输出 6 列而非 7 列"——观察 validator 拦下 + retry 消息带具体列数差异;
7. Refine 测试:对同一 S1-1 再发一次"把第二场的冲突升级",观察 S1/S2 各自看到 `<current_target>` 非空、diff 相对上次成品最小化;
8. reset_all 归零,重跑全流程验证 InMemoryFileManager 干净;
9. 手动对 sequences/S1-1.md 做 script_writer 消费(target_chapter=S1-1),确认 `<current_sequence_beats>` 注入正常、script_writer 生成 chapters/S1-1.md 不受 v6.2 改动影响;
10. `test_api.mjs` smoke 通过(无需改)。

---

## Open Questions(non-blocking,留待落地时决定)

1. **assembleSequenceOutline 标题句是否要更丰富?** 默认 `# {target_sequence}`;若想拼 `# S1-1: 平静表象裂痕初现` 需要从 sequence_list.md 解析该行"序列定位/命名"列填入,增加解析代码复杂度换到人类可读性提升。**倾向 MVP 用极简标题,后续按需增强**。
2. **structuralCheck 是否要跑在 S1/S2 每次 retry 前的临时挂载,还是通过一次性全局注册?** §C-3 已论证:beat_writer 因需要 scenesMd 上下文只能 runPipeline 内动态绑定;scene_designer 可静态注册但为一致性也放 runPipeline 里做。**倾向全部动态挂载**统一实现。
3. **audit-note 是否要独立成一份 `_beats_audit.md` 而非嵌在 sequences/<ID>.md 尾部?** 独立文件方便 story_checker 批量扫描但引入新持久副作用;嵌入尾部则天然随资产走。**倾向嵌入尾部**,story_checker 若需要可后续正则批扫。

---

## 与 v6.1 的语义连续性

v6.2 只重构 scene_beats 内部实现,**不撤销 v6.1 已建立的**:

- Phase Gate 门控(A/B/G 节);
- 动态写靶协议(C 节 → v6.1 W1);
- script_writer subagent(D 节);
- UI 三处接入(E 节 → v6.1 W3);
- Orchestrator prompt 补丁(F 节 → v6.1 W4)。

只是把 v6.1 §H 里的四步流水线实现降级为两步 LLM + 代码收口,并补上 v6.1 未做的结构化校验。当年 v6.1 §H.7 open question(strict one-per-call 首批铺设体验)仍未拍板,继续 backlog。
