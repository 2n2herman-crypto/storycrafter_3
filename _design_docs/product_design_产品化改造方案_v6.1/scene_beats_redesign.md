# Scene Beats 子代理重构规格（scene_beats_redesign）

> 本篇归档 [`scene_beats`](../src/skills/scene_beats/) 从单体输出到 per-sequence 物理切片的完整设计决策记录，作为 [README §H](./README.md#h-scene-beats-子代理重构--以序列为单位物理切片二轮细化) 的展开版实施参考。配套阅读 [implementation_plan W0/W5](./implementation_plan.md) 与已落地的 SKILL 正文本身。

---

## 0. 一句话定性

把 scene_beats 的产物从「一张压扁全部序列的巨型表格」拆成「每个序列一份独立 `.md`」，让下游 writer 单次只消化几百 token 提纲——这是 Phase Gate 门控之外的第二道防线：**不是禁止下游改上游，而是主动降低它每次的有效阅读密度**。

---

## 1. 动机溯源

现行 monolithic `scene_beat_outline.md` 把 N 个序列的场景表+节拍表连续排布在单文件内，一部中型作品轻松突破数千 token。Transformer 架构的经典 attention 衰减规律表明位于输入中段的细节最易丢失——这正是剧本偏离提纲的高频病灶所在。

即便 §B 的 Guard 已经锁死不让 writer 回流污染上游设定，writer 在 *读取* 这张巨表作创作素材时仍逃不开该衰减效应。因此必须从数据组织层面预先切片：

```
旧: writer ──读──► [S1全表][S2全表]…[Sn全表]   ← 中段 S3~Sn-2 易丢
新: writer(Si-j call) ──读──► [Si-j单一小表]+[少量锚点参照]
```

低密度进 → 高密度出 的二元隔离由此名副其实。

---

## 2. 数据契约变更

| 维度 | 旧 | 新 |
|------|----|----|
| 物理产物 | `scene_beat_outline.md` | `sequences/S{幕}-{序}.md × N` |
| writes[0] | `'scene_beat_outline.md'` | `'sequences/.placeholder'`(engine dynamic-resolved)|
| 调度粒度 | 一次铺满全书 | 一次一个 target_sequence |
| refine 判据 | 读自身旧全文非空 | 注入 `<current_target>` 非空 或 instruction 显式动词信号 |
| 场景数上限 | 序列 2~5 | 序列 3~6(合并压力解除可承载更细颗粒)|

ID 三级体系**保持不变**确保上下游兼容：

| 层 | 格式 | 例 |
|----|------|-----|
| 序列 | `S{幕}-{序}` | S1-1 / S2-3 |
| 场景 | `SC-{target_sequence}-{nn}` | SC-S1-1-01 |
| 节拍 | `B-{所属场景ID}-{n}` | B-SC-S1-1-01-1 |

---

## 3. Reads 收窄论证

新版 frontmatter `reads` 仅含七项固定薄文件:

```yaml
reads:
  - worldbuilding.md        # 世界规则锚点防穿帮
  - characters.md           # 人物动机弧线跨章咬合
  - act_map.md              # 幕归属与时序坐标
  - sequence_list.md        # 相邻序列衔接关系
  - foreshadowing.md        # 本序列 planned 伏笔落地义务
  - subplots.md             # 支线穿插不打架主轴节奏  
  - user_requirements.md    # 基调风格硬约束
```

要点：
- **删除自读**:不再有 self-reference 式读取自身旧全文——因为单体已不存在;
- **保留全局架构**作"穿帮防护":即便聚焦局部也要保证人物弧线世界规则支线交错与邻接序列咬合不冲突或重复铺设同 ID 元素;
- 总量虽七项但都是几 KB 设定文档远低于旧版那张可能上万字的宽表,**净信息密度下降明显达成目标**.

为何不像 script_writer 那样也注入 `<current_sequence_beats>`?因为 beats 本身就是生产者而不是消费者——它创造内容不需要先看自己的同类产出;refine 所需历史由 `<current_target>` 提供.

---

## 4. Create / Refine 判定机制演进路径

### 当前临时方案(MVP,W0-W1 过渡期)

依赖 Orchestrator 通过 instruction **显式传递意图关键词**(如「修改」「调整」指向既存章节)。LLM body 内置规则识别这些词切换 REFINE 行为保原 ID 不动只修单元格文字。

弱点:**完全靠 LLM 自觉**,长链路下 Orc 可能记忆失准漏传导致误判走 CREATE 全量覆盖既有成果造成 diff 浪费甚至破坏用户手动微调过的版本.

### 目标方案(W1.T1.3 通电后稳定态)

引擎在 resolveWriteTarget 时同步读取 resolved path 已存在内容并以专属标签注入上下文:

```xml
<current_target>
... 该 sequences/Sx-y.md 此刻已有全文 ...
</current_target>  (create 时此标签体为空字符串)
```

body 规则升级为优先采信机械信号:`<current_target>` 内容长度 >0 即强制进入 REFINE 模式忽略 instruction 措辞歧义. 这是确定性保障优于 prompt 自律.

两条方案对外部接口透明可平滑过渡无需 skill 层改动只需补齐 engine 能力即可享受稳定性增益.

---

## 5. Progress Perception(进度感知痛点)

困难核心:[`assembleContext`](../src/orchestrator/contextAssembler.ts#L19-L37) 只吃静态声明的 `skill.reads`,无法运行时列举已生成的 `sequences/*.md`. 而 Orchestrator 编排下一批 target_sequence 时需要知道哪些尚未完成才能正确下发指令.

候选三方案权衡:

| 方案 | 实现 | 优点 | 缺点 | 取舍结论 |
|------|------|------|------|----------|
| ①指令透传 | Orc 凭 executionLog 反推已完成列表塞进下次调用的 instruction | 零侵入立即生效 | 依赖 LLM 记忆准确长链路易漏 | ✅ MVP 采用(W5 前)|
| ②asset 清单注入 | contextAssembler 增设可选 meta-block 自动列 fm.listAssetFiles() 结果包成 `<existing_assets>` | 机械可靠惠及所有 subagent | 中等工程量需扩 assembleContext | 🔒 待 W1.T1.4 解锁后启用并支撑 W5 audit skill 自动化盘点 |
| ③进度索引文件 `_beats_progress.md` | 维护 done-list 写入隐藏资产 | 直观 | 引入持久副作用违反最小存储面 | ❌ 弃用 |

MVP→理想态过渡期间二者并存兼容(instruction hint 作为 fallback 即使 listing 未就绪也能工作).

---

## 6. Sequence_split Skill 关键设计决策备忘

落地的 [`sequence_split/SKILL.md`](../src/skills/scene_beats/sequence_split/SKILL.md) 若干非显然选择的归档理由:

- **outputTags 名沿用旧的 `<<<SCENE_BEAT_OUTLINE_START>>>/_END>>>`**:validator 按 declared tag pair 提取不在乎语义命名是否匹配当前职责变化;复用名减少认知迁移负担且 loader 自然兼容不必动 outputValidator/types.
- **writes 用 placeholder 字符串 `'sequences/.placeholder'`**:frontmatter parser 要求 writes 至少有一项让 asArray 返回非空数组通过校验;真实 path 由 T1.2 effectiveWrites override 替换占位项不影响 validator extractBetween 后写入 extracted[effectiveWrites[0]]的逻辑链路.
- **场景数上限从 2~5 放宽至 3~6**:monolithic 时代担心整张表过长截断故压缩每段规模;per-sequence 化后单文件独立承担风险大幅释放允许更细颗粒不被压力抵消反而提升后续 writer 可发挥空间.
- **TAG 内首行强制标题格式 `# {target_sequence}: <一句话主题>`**:统一头部便于人类肉眼快速辨识该 .md 归属哪个序列也有助于 future grep 工具批量索引.
- **format stability 五条铁律照搬旧版精华经验证明有效**:尤其禁竖线字符规则防止 Markdown 表格断裂是 v5.2 重构沉淀下来的血泪教训不可丢弃.

---

## 7. DUAL-SKILL ROUTING · 第二枚 skill 上线路径预演

虽然本期缓发但仍要提前规化好接入蓝图以免临场返工. 待 W1.T1.4(dynamic asset listing injection)就绪后方可开建第二枚.

### 目录结构终态
```
src/skills/scene_beats/
├── subagent.md                      ← preamble 微调提及 dual-skill 协议
├── sequence_split/
│   └── SKILL.md                     ← 主力生产通路(本期已建)
└── cross_sequence_check/
    └── SKILL.md                     ← 辅助覆盖率审计(gated by W1.T1.4)
```

### Router 打分策略推演([selectSkill](../src/orchestrator/skillRouter.ts))

[`scoreSkill`](../src/skills/../orchestrator/skillRouter.ts) 给 each candidate 加分逻辑是:`when[]` keyword 命中 +2 per match, description 分词命中 +1 per match ≥2 字符 token. 平局且零分则回退首个(skill 数组顺序即 glob 发现次序).

为保证日常请求稳定路由主力而仅在显式询问覆盖率时切辅助侧,when 关键词集合应精心正交分离:

```yaml
sequence_split.when:       ['切片','细化','展开','修订','创建','场景','节拍']
cross_sequence_check.when: ['覆盖','缺口','进度','未完成','一致性盘点']
```

典型 routing case 分析:

| 用户/Orc instruction 含特征词 | split 得分 | check 得分 | winner |
|-------------------------------|-----------|------------|--------|
| "请细化 S3-1 的场景和节拍"     | '场景''节拍'+4,'细化'+? = 高 | 0 | split ✓ |
| "看看还有哪几个序列没写完"      | 0          | '缺口'?+'未完成'?+?'进度'? ≈ 高 | check ✓ |
| "继续推进剧情结构建设"(模糊)    | 0          | 0          | tie@0→fallback first=split |

第三种零命中平局回退首个正是期望行为(默认推进生产),符合渐进交互模式下的高频诉求分布. 但若实际观察发现 Orc 经常以泛指措辞触发本意想问进度却落到 split 导致浪费一次调用产生无用新增文件,可在 W5 实测后再回头收紧 split.when 让其更挑剔些提高区分度.

注意 selectSkill 是确定性打分不调 LLM 所以即便偶尔误路也无额外 API 成本只是产出一个未必有用的工具结果供 Orc 决策下一步修正方向,Orc 通常能在收到 tool_complete(writes=['sequences/X-Y.md'])反馈后判断是否符合原始意图进而重新调度.

### Cross_sequence_check 报告形态草案

输出 hidden report 类似 story_checker pattern(`_check_report.md`)以便被 orchestratorEngine 特例分支(L423-L430 同款)将完整报告文本注回 messages 供 Orc 直接消费做下一步编排判断而不必再二次解析提取关键数字.

report body 大致结构:
```
## 覆盖率快报
act_map 声明序列总数:N
sequences/*.md 已生成:M(N-M 个待铺)
缺失明细:S{i}-{j} ... 

## ID 冲突检测
重复场景ID:(若有列出位置)
孤立引用:未被任何 sequence 包含却在某处出现的 B-ID 等

## 建议
推荐下一批并行调用≤5个 target_sequence=[...]
```

Orc 读到此 report 后能精确编排出剩余批次 schedule 解决 H.7 strict-one-per-call 下首批铺设体验问题——这是 dual-skill 真实价值兑现的关键卖点之一也是激活仓库长期闲置的多选通路的合理业务载体.

---

## 8. 向后兼容 & 存量迁移

InMemoryFileManager 易失性意味着不存在线上持久化的旧版 `scene_beat_outline.md` 需迁移的情况——刷新页面自然清零回到全新状态直接采用新的 per-sequence 协议起步即可. 因此本次大改无须编写专门的 data migration script 也无须维护 legacy reader 兼容代码路径省去技术债包袱.

若将来引入 ElectronFileManager 持久化之后老项目首次启动遇到遗留 monolithic outline 时,migration policy 推荐:**一次性 reset_all 清空重来**而非尝试自动切割转换(per-sequence 化涉及大量主观分段判断不如人工重新生成质量高). 这一政策应在 Electron 版发布 release notes 明确告知以防用户期待无损升级失望.

---

## 9. 开放议题跟踪

继承 README §H.7 open question 关于首批铺设体验(strict one-vs limited-batch). 默认维持 strict-one 以守框架对称美感,dual-skill 上线后的 cross_sequence_check 是否足以缓解其体验劣势需要实测验证后复盘决定要不要进一步加 batch loop support 到 executeTool 内部. 此条目暂记 backlog 低优跟进.
