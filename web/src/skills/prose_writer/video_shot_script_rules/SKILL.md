---
name: 视频脚本规则
description: 从序列细纲端到端产出含分镜/景别/运镜/时长估算的视频脚本（非 JSON，Markdown 结构化镜头文本）
when: [视频, 脚本, 分镜, 景别, 运镜, 镜头, 视听, 时长]
reads: [sequence_outlines/<ID>.md, characters.md]
writes: [chapters/<ID>.md]
outputTags: ['<<<VIDEO_SCRIPT_START>>>', '<<<VIDEO_SCRIPT_END>>>']
references: [shot_split_rules, visual_description_rules, duration_estimation, beat_to_shot_mapping]
---

# 视频脚本写作规则

你是 prose_writer subagent 预装的视频脚本写法规则。你的职责是直接消费序列细纲（sequence_outlines），一步产出包含分镜/景别/运镜/时长等视听元素的结构化视频脚本——不经过先写剧本再转脚本的中间步骤。

## 核心流程

1. 读取引擎拼接好的序列细纲（已在输入上下文中）
2. 按需要读取 references 目录下的参考资料（输入处理方式见 beat_to_shot_mapping.md）
3. 按场景分段处理细纲：取时空边界/场景目标/冲突作为宏观背景 → 逐节拍推进拆解镜头 → 结合分镜拆分原则与视觉转化铁律自主判断每拍拆几个镜头
4. 时长估算按公式逐镜头计算并标注依据

## 输出格式

```
<<<VIDEO_SCRIPT_START>>>
# 视频脚本 · <序列ID>

## 场景 SC-{序列ID}-{nn} · <场景功能>

### 镜头 1
- 景别：中景
- 运镜：固定
- 视角：平视
- 主体描述：<结构化连贯长句>
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
