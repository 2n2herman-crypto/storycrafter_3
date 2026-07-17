---
name: 用户需求满足度检查
description: 逐一比照 user_requirements.md 中的每条需求，检查是否在对应资产文件中得到实现
when: [需求, 满足度, 用户, 要求, 覆盖, coverage, requirement]
reads: [user_requirements.md, worldbuilding.md, characters.md, act_map.md, sequence_list.md, sequences/*.md, scenes/*.md, beats/*.md]
writes: []
outputTags: []
---

# 用户需求满足度检查

你是质检 subagent 当前通过 `read_skill` 读取到的检查规则之一。你的职责是比照 `user_requirements.md` 中的每条需求，检查是否在对应的资产文件中得到了正确实现。

## 检查维度

按 `user_requirements.md` 的内容结构逐条检查：

### 1. 世界观需求
每条"世界观"下声明的需求，是否在 `worldbuilding.md` 中得到体现。

### 2. 角色需求
用户对特定角色的要求（身份、性格、关系），是否在 `characters.md` 及后续三层文件中被遵循。

### 3. 剧情方向需求
用户指定的剧情方向、冲突、转折，是否在 `act_map.md` / `sequence_list.md` / `sequences/*.md` 中得到贯彻。

### 4. 基调和风格需求
用户要求的风格/基调，是否在场景描述和节拍动作中保持一致（如要求"克苏鲁式心理恐怖"，但节拍全是打斗驱动——明显偏离）。

## 输出格式

```
# 用户需求满足度检查报告

## 1. 世界观需求
- ✅ [需求] "世界设定为非欧几何空间" —— worldbuilding.md 已体现
- ❌ [需求] "存在两种对立的魔法体系" —— worldbuilding.md 仅描述了一种 → 建议补充第二种体系说明

## 2. 角色需求
- ✅ [需求] "主角必须有黑暗过去" —— characters.md 第 3 节已定义"弧光轨迹"
- ⬜ [需求] "需要有一个笑面虎反派" —— characters.md 中未找到对应角色设定，当前资产中尚未实现

## 3. 剧情方向需求
- ✅ [需求] "第二幕中段有重大背叛" —— act_map.md A2 已标注"盟友叛变"
- ❌ [需求] "结局开放式，不解决主冲突" —— act_map.md A3 的"大高潮"描述为明确收束，与需求冲突 → 建议调整

## 4. 基调和风格需求
- ⚠️ [需求] "全程冷硬派侦探氛围" —— 大部分场景符合，但 scenes/S2-2.md 有纯搞笑节拍可能冲淡氛围

## 汇总
- ✅ 已满足：N 条
- ❌ 未满足/偏差：M 条
- ⬜ 尚未实现：K 条
```

每个发现附带：需求原文引用 + 对应资产位置 + 偏差描述 + 建议修复方向。
