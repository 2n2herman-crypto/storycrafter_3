# StoryCrafter v7.8 · agent输出专项优化

## 1. 背景

当前 `prose_writer` 作为写作期核心 agent，内部挂载了多个写作 skill：

- `novel_prose_rules`
- `short_drama_script_rules`
- `video_shot_script_rules`

它们本来承担不同写作范式，但目前读写规范过于接近，尤其都倾向使用 `chapters/<ID>.md` 作为输出资产。这会导致小说正文、短剧剧本、视频脚本在资产语义上混用，后续无法稳定支持“剧本再转脚本”的产品链路。

本专项聚焦：**不新增 agent，优先优化写作 agent 内部 skill 的读写规范和资产边界**。

## 2. 核心痛点

### 2.1 产品方向多于现有写作范式

当前产品方向实际应覆盖：

| 产品方向 | 产品类型 | 写作主产物 | 是否需要后置视频脚本 |
|---|---|---|---|
| 小说 | 文本产品 | 小说章节正文 | 否 |
| 短剧 | 视频产品 | 短剧分集剧本 | 是 |
| 长剧 | 视频产品 | 长剧分集剧本 | 是 |
| 电影 | 视频产品 | 电影剧本 | 是 |

但当前 skill 只覆盖：

| 当前 Skill | 已覆盖能力 | 缺口 |
|---|---|---|
| `novel_prose_rules` | 小说正文 | 输出目录需与视频产品区分 |
| `short_drama_script_rules` | 短剧剧本 | 不能泛化承担长剧/电影 |
| `video_shot_script_rules` | 视频/分镜脚本 | 输入应优先来自专业剧本，而不是直接从四结构推断 |

### 2.2 资产名冲突

当前多个写作 skill 都写入：

```text
chapters/<ID>.md
```

这会造成三个问题：

1. 小说章节与视频产品剧本混在同一语义目录下。
2. 短剧剧本与视频脚本可能互相覆盖。
3. 资产面板无法从路径判断“这是小说正文、剧本还是分镜脚本”。

### 2.3 短剧、长剧、电影不能共用一个剧本 skill

短剧、长剧、电影都属于视频产品，但剧本专业范式不同：

| 产品 | 剧本核心 |
|---|---|
| 短剧 | 高频钩子、情绪脉冲、集末留扣、一集一场景倾向 |
| 长剧 | 多线推进、分集结构、人物长期弧线、场景调度 |
| 电影 | 完整闭环、场面段落、视觉母题、对白克制、节奏控制 |

因此 `short_drama_script_rules` 不能作为所有视频产品的通用兜底。

### 2.4 视频脚本不应直接替代剧本

视频脚本/分镜脚本更适合作为剧本后的二级产物：

```text
叙事设计资产
→ 专业剧本
→ 视频/分镜脚本
```

而不是：

```text
叙事设计资产
→ 视频/分镜脚本
```

后者会让视频脚本 writer 从场景/节拍中直接推断镜头意图，缺少已经成形的动作、对白、场面调度和表演压力。

## 3. 设计原则

1. **不污染设计大纲**：四结构继续只负责叙事传达，不加入镜头意图、景别、运镜等媒介表达字段。
2. **不急于新增 agent**：继续使用 `prose_writer`，通过内部 skill 分工完成多阶段写作。
3. **产品主产物先行**：小说产小说正文；短剧/长剧/电影先产专业剧本。
4. **视频脚本后置**：视频/分镜脚本读取剧本转译，不直接覆盖剧本。
5. **资产路径表达语义**：从路径即可判断产物类型，避免 `chapters/` 成为所有正文的混合目录。

## 4. 目标链路

### 4.1 小说链路

```text
sequences/<ID>.md
scenes/<ID>.md
beats/<ID>.md
characters.md
→ novel_prose_rules
→ novel_chapters/<ID>.md
```

小说正文是最终产物，不默认生成视频脚本。

### 4.2 短剧链路

```text
sequences/<ID>.md
scenes/<ID>.md
beats/<ID>.md
characters.md
→ short_drama_script_rules
→ short_drama_scripts/<ID>.md
→ video_shot_script_rules
→ video_scripts/short_drama/<ID>.md
```

短剧先生成分集剧本，再根据剧本转分镜/拍摄脚本。

### 4.3 长剧链路

```text
sequences/<ID>.md
scenes/<ID>.md
beats/<ID>.md
characters.md
→ long_drama_script_rules
→ long_drama_scripts/<ID>.md
→ video_shot_script_rules
→ video_scripts/long_drama/<ID>.md
```

长剧需要新增专业化 skill，强调分集结构、多线推进、人物长期弧线和场景调度。

### 4.4 电影链路

```text
sequences/<ID>.md
scenes/<ID>.md
beats/<ID>.md
characters.md
→ film_script_rules
→ film_scripts/<ID>.md
→ video_shot_script_rules
→ video_scripts/film/<ID>.md
```

电影需要新增专业化 skill，强调完整电影剧本格式、场面段落、视觉母题和节奏控制。

## 5. Skill 读写规范

### 5.1 `novel_prose_rules`

| 项 | 规范 |
|---|---|
| 职责 | 将叙事结构展开为小说章节正文 |
| 输入 | `sequences/<ID>.md`、`scenes/<ID>.md`、`beats/<ID>.md`、`characters.md`、`product_profile` |
| 输出 | `novel_chapters/<ID>.md` |
| 不做 | 不生成剧本格式；不生成分镜；不写景别/运镜 |
| 触发词 | 小说、正文、章节、成文、心理描写、叙述、人称 |

输出标签建议：

```text
<<<NOVEL_CHAPTER_START>>>
...
<<<NOVEL_CHAPTER_END>>>
```

### 5.2 `short_drama_script_rules`

| 项 | 规范 |
|---|---|
| 职责 | 将叙事结构展开为短剧分集剧本 |
| 输入 | `sequences/<ID>.md`、`scenes/<ID>.md`、`beats/<ID>.md`、`characters.md`、`product_profile` |
| 输出 | `short_drama_scripts/<ID>.md` |
| 不做 | 不直接生成分镜脚本；不输出景别/运镜表；不承担长剧/电影剧本 |
| 触发词 | 短剧、短剧剧本、分集、钩子、爽点、情绪爆点、对白 |

短剧剧本需要明确：

- 集级结构。
- 场景描述。
- 角色动作。
- 角色对白。
- 情绪脉冲。
- 集末钩子。
- 可拍但不拆镜。

输出标签建议：

```text
<<<SHORT_DRAMA_SCRIPT_START>>>
...
<<<SHORT_DRAMA_SCRIPT_END>>>
```

### 5.3 `long_drama_script_rules`

| 项 | 规范 |
|---|---|
| 职责 | 将叙事结构展开为长剧分集剧本 |
| 输入 | `sequences/<ID>.md`、`scenes/<ID>.md`、`beats/<ID>.md`、`characters.md`、`product_profile` |
| 输出 | `long_drama_scripts/<ID>.md` |
| 不做 | 不生成短剧式高频钩子；不直接生成分镜脚本 |
| 触发词 | 长剧、长剧剧本、电视剧、分集剧本、多线、场景调度 |

长剧剧本需要强调：

- 单集内部多场景结构。
- 主线与支线的分配。
- 人物长期关系弧线。
- 场景之间的承接。
- 对白与行动共同推进。

输出标签建议：

```text
<<<LONG_DRAMA_SCRIPT_START>>>
...
<<<LONG_DRAMA_SCRIPT_END>>>
```

### 5.4 `film_script_rules`

| 项 | 规范 |
|---|---|
| 职责 | 将叙事结构展开为电影剧本 |
| 输入 | `sequences/<ID>.md`、`scenes/<ID>.md`、`beats/<ID>.md`、`characters.md`、`product_profile` |
| 输出 | `film_scripts/<ID>.md` |
| 不做 | 不写成长剧分集；不按短剧钩子节奏强行切集；不直接生成分镜脚本 |
| 触发词 | 电影、电影剧本、剧本、场面、对白、动作线、视觉母题 |

电影剧本需要强调：

- 场面段落。
- 视觉母题。
- 动作线与对白的克制。
- 场景转场。
- 整体节奏闭环。

输出标签建议：

```text
<<<FILM_SCRIPT_START>>>
...
<<<FILM_SCRIPT_END>>>
```

### 5.5 `video_shot_script_rules`

| 项 | 规范 |
|---|---|
| 职责 | 将已有剧本转译为视频/分镜/拍摄脚本 |
| 输入优先级 | 1. 当前产品剧本；2. `sequences/<ID>.md`；3. `scenes/<ID>.md`；4. `beats/<ID>.md`；5. `characters.md` |
| 输出 | `video_scripts/<product>/<ID>.md` |
| 不做 | 不新增剧情事实；不改角色动机；不改剧本场景结果；不覆盖原剧本 |
| 触发词 | 视频脚本、分镜、镜头、景别、运镜、拍摄脚本、视听、时长 |

不同产品的剧本输入路径：

| 产品 | 优先读取 |
|---|---|
| 短剧 | `short_drama_scripts/<ID>.md` |
| 长剧 | `long_drama_scripts/<ID>.md` |
| 电影 | `film_scripts/<ID>.md` |

输出标签建议：

```text
<<<VIDEO_SCRIPT_START>>>
...
<<<VIDEO_SCRIPT_END>>>
```

## 6. 路由与自动补齐逻辑

### 6.1 用户请求小说正文

用户表达：

```text
写正文 / 生成小说正文 / 写第 S1-1 章
```

触发：

```text
novel_prose_rules
```

输出：

```text
novel_chapters/<ID>.md
```

### 6.2 用户请求短剧/长剧/电影剧本

用户表达：

```text
生成短剧剧本 / 写长剧分集 / 写电影剧本
```

触发：

```text
short_drama_script_rules
long_drama_script_rules
film_script_rules
```

输出对应产品剧本资产。

### 6.3 用户请求视频脚本/分镜脚本

用户表达：

```text
生成视频脚本 / 生成分镜 / 转拍摄脚本 / 拆镜头
```

自动补齐逻辑：

1. 判断当前产品方向。
2. 检查对应产品剧本是否存在。
3. 如果剧本不存在，先调用对应剧本 skill。
4. 再调用 `video_shot_script_rules`。
5. 视频脚本写入 `video_scripts/<product>/<ID>.md`。

示例：

```text
短剧产品下，用户说“生成 S1-1 分镜脚本”
→ 检查 short_drama_scripts/S1-1.md
→ 不存在则先跑 short_drama_script_rules
→ 再跑 video_shot_script_rules
→ 写 video_scripts/short_drama/S1-1.md
```

## 7. 资产目录规范

建议新增以下写作资产目录：

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

保留旧 `chapters/` 的兼容策略：

1. 旧项目已存在的 `chapters/<ID>.md` 不删除。
2. 新写入按产品写入新目录。
3. 资产状态统计同时扫描旧目录与新目录。
4. 若迁移工具存在，可将旧 `chapters/` 按项目产品类型迁入新目录。

## 8. 当前能力差距

| 能力 | 当前是否支持 | 问题 |
|---|---|---|
| 小说正文 | 部分支持 | 输出路径需从 `chapters/` 改为 `novel_chapters/` |
| 短剧剧本 | 部分支持 | 输出路径需从 `chapters/` 改为 `short_drama_scripts/` |
| 长剧剧本 | 不支持 | 缺少 `long_drama_script_rules` |
| 电影剧本 | 不支持 | 缺少 `film_script_rules` |
| 视频脚本 | 部分支持 | 应改为优先读取产品剧本，并写入 `video_scripts/<product>/` |
| 剧本到脚本链路 | 不支持 | 需要自动补齐：缺剧本先生成剧本，再生成视频脚本 |

## 9. 实施步骤

### 阶段一：文档与 Skill Frontmatter 调整

- 修改 `novel_prose_rules` 的 writes。
- 修改 `short_drama_script_rules` 的 writes。
- 修改 `video_shot_script_rules` 的 reads/writes。
- 新增 `long_drama_script_rules`。
- 新增 `film_script_rules`。
- 更新 `prose_writer/subagent.md` 的 skills 列表。

### 阶段二：路径解析与写入目标改造

- 将 `resolveChapterPath` 泛化为 `resolveWriterOutputPath`。
- 按产品与 skill 类型决定输出目录。
- 保留旧 `chapters/` 的读取兼容。
- 资产卡片扫描新增写作目录。

### 阶段三：视频脚本自动补齐

- 当选中 `video_shot_script_rules` 时，先检查对应产品剧本。
- 如果剧本缺失，自动调用当前产品的剧本 skill。
- 自动补齐过程必须在执行日志中显示两步：
  - `生成产品剧本`
  - `转写视频脚本`

### 阶段四：状态统计与 UI 展示

- 正文写作状态拆成：
  - 小说正文。
  - 产品剧本。
  - 视频脚本。
- 资产卡片标题按目录展示：
  - 小说章节。
  - 短剧剧本。
  - 长剧剧本。
  - 电影剧本。
  - 视频脚本。

## 10. 验收标准

- 小说产品生成正文时，只写入 `novel_chapters/<ID>.md`。
- 短剧产品生成剧本时，只写入 `short_drama_scripts/<ID>.md`。
- 长剧产品生成剧本时，只写入 `long_drama_scripts/<ID>.md`。
- 电影产品生成剧本时，只写入 `film_scripts/<ID>.md`。
- 生成视频脚本时，不覆盖产品剧本，只写入 `video_scripts/<product>/<ID>.md`。
- 用户直接请求视频脚本且剧本不存在时，系统自动先生成剧本再生成视频脚本。
- `short_drama_script_rules` 不再作为长剧/电影的兜底剧本规则。
- 旧 `chapters/` 中已有资产仍可被读取和展示，不造成历史项目断裂。

## 11. 一句话结论

v7.8 不新增表达适配 agent，而是把 `prose_writer` 内部 skill 从“并列写作范式”改造成“按产品分工、可串联产出”的写作体系：

```text
小说：叙事结构 → 小说正文
短剧：叙事结构 → 短剧剧本 → 视频脚本
长剧：叙事结构 → 长剧剧本 → 视频脚本
电影：叙事结构 → 电影剧本 → 视频脚本
```

核心改造点是：**读写规范、资产路径、自动补齐链路，而不是新增一层独立表达 agent**。
