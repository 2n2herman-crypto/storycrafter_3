# v6.4-3 写作 Agent 开发方案

## 一、架构定位

### 1.1 与现有体系的关系

```
Orchestrator (FC 选 Subagent)
  └── script_writer (Subagent)
       └── script_writer/SKILL.md (单 Skill)
            ├── 上游 reads（设计资产——只读）
            ├── engine resolveExtraContext（同幕序列 + 前章正文 + 行为追踪）
            └── 输出 chapters/<ID>.md
```

**关键定位**：
- `script_writer` **不是** pipeline（区别于 `scene_beats` 的四步纵切）。pipeline 适用于确定性步骤拆解（先场景表 → 节拍表 → 拼装），写作是创造性单步任务，不需要硬编码步骤
- 也不宜拆成多个 Skill——三项能力是同一 SKILL.md 正文的不同章节，不是可互换/可路由的技能
- 与上游 subagent **没有双向关系**：上游产出设计资产后冻结（Phase Gate），writer 只读不写。

### 1.2 锁定机制决定了什么

Phase Gate 锁定的**六项静态资产 + `sequences/*`** 在 writing 期：

| 特征 | 含义 |
|------|------|
| 只读不可写 | `isLockedPath(path)` → Guard-2 拦截写操作 |
| 拍照基线 | `phaseStore.getBaseline(path)` 提供锁定时刻的内容快照 |
| 但 writer 本身可以写入 | `chapters/*` 不在 LOCKED_STATIC_PATHS + sequences/* 范围 |

这意味着 writer 在写作期：

```
可读：user_requirements.md + worldbuilding.md + characters.md + act_map.md
     + sequence_list.md + foreshadowing.md + subplots.md + sequences/S*.md (只读)
     + chapters/(其他已完成章节)  (可读)
可写：chapters/<当前目标>.md (唯一可写资产)
不可写：六项静态资产 + sequences/* (引擎硬闸门)
```

### 1.3 Subagent 身份的「护栏」定位

`script_writer/subagent.md`（preamble）的职责是**划定不可逾越的红线**，而非指导具体写作技巧（那是 SKILL.md body 的事）。preamble 维持现有四条边界即够：

1. 只读不改设定
2. 章内闭环不悬挂——本章主要冲突须推进到一个明确的节拍点（不一定是完全解决），但章节末尾需为下一章留出自然叙事切口：通过情绪延续（如角色未说完的话）、空间衔接（如门的开关）或信息钩子（如新发现的线索）实现，不使用机械 cliffhanger
3. 格式服从 validator
4. 拒接越权批量化（每次一个 target_chapter）
5. 上下文感知——本章写作时可参考 `<same_act_sequences>`（同幕全部序列）、`<previous_chapter_draft>`（紧前章节正文）和 `<character_behavior_tracking>`（前章角色行为摘要），以保持全书文风、节奏和角色言行的一致性

三项新能力全部落于 SKILL.md body，不改变 preamble。

---

## 二、Skill 结构设计

### 2.1 SKILL.md frontmatter（不变）

```yaml
---
name: 剧本正文写作
description: 将场景节拍表格展开为带对白、描写与情绪密度的剧本文本，整文写入 chapters/<target>.md。每次仅产出一个章节
when: [剧本, 正文, 章节, 展开, 成文, 台词, 续写]
reads: ['user_requirements.md', 'worldbuilding.md', 'characters.md', 'act_map.md', 'sequence_list.md', 'foreshadowing.md', 'subplots.md']
writes: ['chapters/.placeholder']
outputTags: ['<<<SCRIPT_CHAPTER_START>>>', '<<<SCRIPT_CHAPTER_END>>>']
---
```

与 v6.1 一致的 frontmatter。三项能力不进 frontmatter（无新 reads、新 writes、新 outputTags）。

### 2.2 SKILL.md body 结构（v6.4 改写版）

body 保留 v6.1 的骨架，在每个章节内注入 v6.4 新能力：

```
# 剧本正文写作（script_writer）

## 角色
（不变）

## 上游参照区段
### 基础区段（不变）
### v6.4 新增区段说明
- <same_act_sequences>：同幕全部序列的场记内容（如 target=S1-3 时注入 S1-1、S1-2、S1-3 的完整场记），每序列包裹在 <slice id="S1-N"> 子标签中，由引擎动态注入
- <previous_chapter_draft>：紧前章节已产出正文全文（CREATE 模式下注入，供 Writer 感知实际文风），由引擎动态注入
- <character_behavior_tracking>：本次会话已有章节的角色行为摘要（由引擎动态注入）

## 双模式判定（不变）

## 核心写作能力

### 一、跨序列组织与伏笔感知
#### 1.1 章节定位说明
每章开头用一句话说明此章节在全剧/本幕中的叙事定位。
示例：「本章是 S1 的收束章节，引爆 A-B 线第一次正面交锋，同时为 S2 埋下 B 角色动机转向的伏笔。」

#### 1.2 伏笔落地先检
落笔前扫描 foreshadowing.md 中标记了 belongsTo=本序列范围的全部条目。将：
- 本序列应铺设（plant）的伏笔自然嵌入对话/动作
- 本序列应回收（payoff）的伏笔确保情绪累积到位后再揭示
- 非本序列的伏笔不做处理

#### 1.3 同幕序列感知 + 前章正文衔接
借助 <same_act_sequences> 和 <previous_chapter_draft> 确保：
- 本章开端照应前章末尾的场景（避免生硬回跳）
- 本章末尾为下一章留出合理切口
- 角色情绪状态在同幕跨序列连续区间内平滑过渡
- 文风、节奏、对白密度与前章正文保持一致

### 二、角色对齐与反 OOC
#### 2.1 言行锚点参照
characters.md 中为本角色定义的写作锚点（语言风格、身体语言、压力反应模式）是本章塑造该角色的**最低基准线**：
- 首次登场按锚点描写建立辨识度
- 后续出场保持一贯性
- 若角色在特定情节转折点需要做出"反常"行为，必须有充分的事件触发作为动机支撑

#### 2.2 角色行为追踪（输出注释）
在正文末尾输出行为追踪注释（对 LLM 自身的记忆辅助）：
<!-- BEHAVIOR_TRACK: 角色名=行为摘要 -->
例如：
<!-- BEHAVIOR_TRACK: 林川=拍桌怒斥+沉默离开，情绪锚：背叛→克制失望 -->
<!-- BEHAVIOR_TRACK: 王总=冷笑+钢笔签名，权力姿态：用日常动作维护权威 -->

引擎会在下一次 script_writer 调用时将这些注释内容聚合为 <character_behavior_tracking> 注入上下文。每章限 1-3 个主要角色。

#### 2.3 OOC 自检
定稿前逐一核查：
□ 所有登场角色言行是否在 characters.md 定义范围内？
□ 是否有角色做出了与之前章节矛盾的行为却缺乏动机交代？
□ 每个行为是否有对应的事件触发，而非凭空产生？
□ 是否避免了"单纯用形容词描述角色"的 show-don't-tell 错误？

### 三、视听转化
#### 3.1 心理→视听转译
**原则**：角色的内心活动必须通过可被"镜头"捕捉的外化信号传达。

| 如果原文是... | 改写为... |
|---|---|
| 他很紧张 | 他指节在桌面敲了三下又停住，咽了口唾沫 |
| 她想起那件事 | 她目光落在空了的相框上，手指沿着相框边缘摩挲 |
| 他们之间的气氛很尴尬 | 两人谁也没看谁。茶凉了，杯沿凝着水珠 |

#### 3.2 叙事手法→镜头语言
- 闪回：使用 `*画面淡入·三小时前*` 或 `*闪回：那个雨夜*` 格式标明时间切换
- 平行叙事：用 `*与此同时，城市的另一端……*` 进行场景转换
- 象征提示：重要道具出场须有镜头停留（特写/角色与之互动/环境气氛烘托）

#### 3.3 场景描写密度控制
- 开篇/场景切换：允许 3-5 行建立氛围
- 对话中：描写 ≤2 行，以台词为主推动叙事
- 情绪峰值：恢复密度用于定格（2-3 行镜头"凝住"）

#### 3.4 禁止性清单
- 全知叙述（"他不知道，这是他最后一次..."）
- 纯心理直述超过一句且无外化动作对应
- 长于 5 行的无对话环境描写
- 情感标签代替行为展示（禁止直接写"她很伤心"，必须写行为）

## 字数控制（不变）
## 格式规范（不变）
## CREATE 形态示范（更新示例以体现三项能力）
```

---

## 三、Engine 侧扩展

### 3.1 resolveExtraContext 增强

当前 `executeTool` 中 `script_writer` 分支的 resolveExtraContext：

```ts
context = appendExtraLabels(context, [
  { label: 'current_draft', content: currentDraft },
  { label: 'current_target', content: currentDraft },
  { label: 'current_sequence_beats', content: seqBeatsDoc },
])
```

v6.4 扩展为：

```ts
context = appendExtraLabels(context, [
  { label: 'current_draft', content: currentDraft },
  { label: 'current_target', content: currentTargetDoc },
  { label: 'current_sequence_beats', content: seqBeatsDoc },
  // v6.4 新增（替代原 v6.4 初稿的 prev/next_sequence_beats）：
  { label: 'same_act_sequences', content: sameActXml },
  { label: 'previous_chapter_draft', content: prevChapterDoc },
  { label: 'character_behavior_tracking', content: behaviorTrackingSummary },
])
```

注意：`<previous_chapter_draft>` 仅在 CREATE 模式（即 `!currentDraft`）时注入——REFINE 模式已有 `<current_draft>`，重复注入无意义。

#### 同幕序列计算（替代原来的相邻序列）

```ts
function findSameActSequences(fm: FileManager, target: string, allPaths: AssetFileInfo[]): {
  sameActXml: string
} {
  const seqId = normalizeToSequenceId(target)   // S1-2
  const actPrefix = seqId.replace(/-\d+$/, '')   // S1

  const seqPaths = allPaths
    .filter(a => a.path.startsWith('sequences/') && a.path.endsWith('.md') && a.exists)
    .map(a => a.path)
    .sort()

  const sameActPaths = seqPaths.filter(p => {
    const sId = p.replace(/^sequences\//, '').replace(/\.md$/, '')
    return sId.startsWith(actPrefix + '-')
  })

  // 读取全部同幕序列，包成 <slice> 子标签
  const sameActXml = sameActPaths
    .map(p => {
      const sId = p.replace(/^sequences\//, '').replace(/\.md$/, '')
      const content = await safeRead(fm, p)
      return `<slice id="${sId}">\n${content}\n</slice>`
    })
    .join('\n')

  return { sameActXml }
}
```

同幕只有 1 个序列时 `<same_act_sequences>` 只含该序列本身的 `<slice>`——Writer 仍可正常使用（边界自然退化）。

#### 前章正文计算

```ts
function findPrevChapter(fm: FileManager, target: string, allPaths: AssetFileInfo[]): string {
  const chapterPaths = allPaths
    .filter(a => a.path.startsWith('chapters/') && a.path.endsWith('.md') && a.exists)
    .map(a => a.path)
    .sort()

  const targetPath = `chapters/${target}.md`
  const targetIdx = chapterPaths.findIndex(p => p === targetPath)
  if (targetIdx > 0) {
    return await safeRead(fm, chapterPaths[targetIdx - 1])
  }
  return ''  // 无前章正文（首章）
}
```

#### 行为追踪摘要

在 `executeTool` 层维护一个 `Map<string, string[]>`，key=target_chapter，value=该章节中出现的 `<!-- BEHAVIOR_TRACK: ... -->` 注释内容。每次 call 完成后从输出中 regex 提取，汇总后在下一次注入。

**实现位置**：`OrchestratorEngine` 实例属性 `private behaviorTrack: Map<string, string[]> = new Map()`

**示例逻辑**：

```ts
// script_writer call 结束后
const trackRegex = /<!--\s*BEHAVIOR_TRACK:\s*(.+?)\s*-->/g
let match: RegExpExecArray | null
const tracks: string[] = []
while ((match = trackRegex.exec(output)) !== null) {
  tracks.push(match[1].trim())
}
if (tracks.length > 0) {
  this.behaviorTrack.delete(target)  // 先删再插，保证 LRU 插入顺序正确（Map.set 不改变已有 key 的位置）
  this.behaviorTrack.set(target, tracks)
  // 清理过时条目：只保留最近 5 个 chapter 的追踪记录
  if (this.behaviorTrack.size > 5) {
    const oldest = this.behaviorTrack.keys().next().value
    if (oldest) this.behaviorTrack.delete(oldest)
  }
}
```

注入时的摘要字符串：

```ts
const behaviorTrackingSummary = [...this.behaviorTrack.entries()]
  .map(([ch, items]) => `<chapter id="${ch}">\n${items.map(i => `- ${i}`).join('\n')}\n</chapter>`)
  .join('\n\n')
```

### 3.2 视听转化软校验

能力三（视听转化）完全依赖 SKILL.md body 中的 prompt 指令，LLM 可能不遵守。在 `executeTool` 成功分支中做轻量 regex 扫描，产生非阻塞 warning，写入 execution event。

**实现位置**：`executeTool` 方法内 `script_writer` 成功返回后，`result.success` 为 true 时调用 `this.runSoftValidation(output)`。

**检测项**：

| 检测 | Regex/逻辑 | 警告信息 |
|------|-----------|----------|
| 全知叙述句式 | `/他不知道[，,\s]*这是[他她].*?[最后终]/` | "检测到疑似全知叙述句式" |
| 直白情感标签 | `/她?很(伤心\|难过\|生气\|愤怒\|害怕\|紧张\|开心\|高兴\|失望\|焦虑\|恐惧)/g` | "检测到直白情感标签（建议用行为替代）" |
| 过长无对话描写 | 按段落分割，检测超过 5 行且不含双引号/冒号对话标记的连续文本 | "检测到超过 5 行的无对话描写段落" |

**代码骨架**：

```ts
private runSoftValidation(output: string): string[] {
  const warnings: string[] = []

  // 1. 全知叙述句式
  if (/他不知道[，,\s]*这是[他她].*?[最后终]/.test(output)) {
    warnings.push('检测到疑似全知叙述句式（如"他不知道，这是他最后一次..."）')
  }

  // 2. 直白情感标签
  const emotionMatches = output.match(/她?很(?:伤心|难过|生气|愤怒|害怕|紧张|开心|高兴|失望|焦虑|恐惧)/g)
  if (emotionMatches && emotionMatches.length > 0) {
    warnings.push(`检测到 ${emotionMatches.length} 处直白情感标签：${emotionMatches.slice(0, 3).join('、')}。建议用行为替代`)
  }

  // 3. 过长无对话描写
  const paragraphs = output.split(/\n\n+/)
  for (let i = 0; i < paragraphs.length; i++) {
    const lines = paragraphs[i].split('\n').filter(l => l.trim())
    if (lines.length > 5 && !/[「「"」"」：]/.test(paragraphs[i])) {
      warnings.push(`检测到第 ${i + 1} 段超过 5 行的无对话描写段落`)
      break  // 只报一次
    }
  }

  return warnings
}
```

**写入方式**：返回的 `warnings` 数组塞入 `ExecutionEvent` 的 `warnings` 字段（需在 `src/types/index.ts` 的 `ExecutionEvent` 中新增 `warnings?: string[]`）。执行日志中 warn 级别展示，不阻塞落盘。

### 3.3 SKILL.md 文件落地

- 直接在 `src/skills/script_writer/script_writer/SKILL.md` 上做全文改写
- 不是新建文件——当前文件已存在，overwrite 即可
- 因为 `buildFunctionSpec` / `selectSkill` / `validateOutput` 不依赖 body 内容，只依赖 frontmatter，body 改写不会影响加载和校验逻辑

---

## 四、不做的事情

| 不做 | 理由 |
|------|------|
| 不拆多 Skill | 三项能力是同一个写作规范的不同侧面，同时启用，无路由需求 |
| 不新增 reads 文件 | 同幕序列和前章正文靠 engine 运行时展开，不入 frontmatter |
| 不改 contextAssembler.ts | 同幕序列、前章正文和行为追踪的拼接走 caller 侧 appendExtraLabels，守 INV-2 |
| 不改 contextAssembler.ts | 相邻序列和行为追踪的拼接走 caller 侧 appendExtraLabels，守 INV-2 |
| 不改 outputValidator.ts | writes/outputTags 无变化 |
| 不改 skillLoader.ts | frontmatter 无新字段，glob 展开已在 v6.3 实现 |
| 不改 skillRouter.ts | script_writer 只有一个 skill |

---

## 五、影响面汇总

| 文件 | 改动性质 |
|------|----------|
| `src/skills/script_writer/script_writer/SKILL.md` | **实质改动**——body 全面改写为 v6.4 版（措辞对齐：相邻序列→同幕序列+前章正文） |
| `src/orchestrator/orchestratorEngine.ts` | **中改**——resolveExtraContext 扩展（同幕序列+前章正文）+ 实例属性 behaviorTrack（Map 顺序修正）+ 软校验方法 runSoftValidation |
| `src/types/index.ts` | **小改**——`AssetCardData` 加可选字段 + `ExecutionEvent` 加 `warnings?: string[]` |
| `src/skills/script_writer/subagent.md` | **小改**——preamble 边界更新（闭环→留切口 + 新增上下文感知边界） |
| `src/store/uiStore.ts` | **小改**——加 collapsedSections 状态 |
| `src/store/assetStore.ts` | **小改**——`getAssetList` 注入 locked/wordCount |
| `src/components/AssetCard.tsx` | **小改**——锁定角标 |
| `src/components/Layout/AssetCardPanel.tsx` | **中改**——写作期父级折叠 + 折叠状态联动 uiStore |
| `src/components/Layout/CurrentPanel.tsx` | **小改**——写作期只读提示条 |
| `src/components/Layout/HeaderBar.tsx` | **小改**——进度概览增强 |
| `src/App.tsx` | **小改**——phase 转换时联动 selectedPath/折叠状态 |
