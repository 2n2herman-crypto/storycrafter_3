---
name: 视频脚本规则
description: 将已有产品剧本转译为含分镜/景别/运镜/时长估算的视频脚本，不新增剧情事实
when: [视频, 视频脚本, 分镜, 景别, 运镜, 镜头, 拍摄脚本, 视听, 时长]
reads: [short_drama_scripts/<ID>.md, long_drama_scripts/<ID>.md, film_scripts/<ID>.md, sequences/<ID>.md, scenes/<ID>.md, beats/<ID>.md, characters.md]
writes: [video_scripts/<product>/<ID>.md]
outputTags: ['<<<VIDEO_SCRIPT_START>>>', '<<<VIDEO_SCRIPT_END>>>']
references: [shot_split_rules, visual_description_rules, duration_estimation, beat_to_shot_mapping]
---

# 视频脚本写作规则

你是 prose_writer subagent 预装的视频脚本写法规则。你的职责是把已有产品剧本转译为可拍的视频/分镜脚本。

## 读写边界

- 你必须优先读取当前产品的剧本资产：
  - 短剧：`short_drama_scripts/<ID>.md`
  - 长剧：`long_drama_scripts/<ID>.md`
  - 电影：`film_scripts/<ID>.md`
- `sequences/`、`scenes/`、`beats/` 只作为校准材料，不能替代剧本。
- 你必须写入 `video_scripts/<product>/<ID>.md`。
- 你不得覆盖产品剧本。
- 你不得新增剧情事实、改变角色动机、改变场景结果。

## 核心流程

1. 从产品剧本中抽取场景、动作、对白、道具、空间关系和情绪压力。
2. 用叙事结构资产校验：镜头表达不得偏离场景目标、节拍情绪和角色状态位移。
3. 将剧本动作拆成镜头，逐镜头标注景别、运镜、视角、主体描述、台词/音效和预估时长。
4. 每个镜头只承载一个主要视觉焦点。
5. 重要对白可保留，但必须拆到对应镜头中，不做整段贴入。

## 输出格式

```
<<<VIDEO_SCRIPT_START>>>
# 视频脚本 · <产品> · <序列ID>

## 场景 SC-{序列ID}-{nn} · <场景功能>

### 镜头 1
- 镜头意图：<这个镜头要让观众看见/理解/感受到什么>
- 景别：中景
- 运镜：固定
- 视角：平视
- 主体描述：<结构化连贯长句>
- 关键动作：<镜头内发生的具体动作>
- 光影/氛围：<如无必要可省略>
- 台词/音效：<若有>
- 预估时长：<按时长估算公式，标注依据如"台词18字÷8+1=3s">

### 镜头 2
（同上结构，镜头间空一行）

## 场景 SC-{序列ID}-{nn+1}
（下一个场景的镜头组）
<<<VIDEO_SCRIPT_END>>>
```

## References

本 Skill 目录下有 4 份参考资料，按需通过 read_reference 读取：
- `shot_split_rules`：节奏控制与分镜拆分原则（含 T1-T7 手法表）
- `visual_description_rules`：视觉转化五大铁律与四维度描述规范
- `duration_estimation`：时长估算公式表
- `beat_to_shot_mapping`：输入处理方式说明
