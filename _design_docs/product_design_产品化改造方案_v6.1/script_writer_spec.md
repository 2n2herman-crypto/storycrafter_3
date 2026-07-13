# Script Writer Subagent 规格（script_writer_spec）

> 本篇归档写作专家 agent 的完整契约定义，配套阅读 [README §D](./README.md#d-script-writer-subagent-definition热插拔目录)、[implementation_plan Wave 1](./implementation_plan.md#wave-1--引擎协议扩展核心基建)，以及源端实物 [`script_writer/subagent.md`](../src/skills/script_writer/subagent.md) + [`SKILL.md`](../src/skills/script_writer/script_writer/SKILL.md)。

---

## 0. 定位

二元体系里的**执行终端·高密度出口**：吃进几百 token 的提纲骨架吐出几千字的可演剧本文本。Phase Gate 保证它的每次进食都被严格限定在单个序列范围内从而免疫 lost-in-middle；它是这套防御设计的最终受益者也是最直接的成效检验者。

身份前缀见 preamble：「剧本作家」姿态强调创意受困于锁定基线的牢笼之内进行组合演绎而非自由突破重构——这与传统的一次性长文 generator 有本质区别。

---

## 1. Function Calling 参数协议

仅 writing phase 通过 Guard-1 进入 spec 面。FC 参数 schema 由 [`buildFunctionSpec`](../src/skills/skillLoader.ts#L250-L268) 条件附加:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `instruction` | string | yes | 通用任务描述(Orc 裁剪后的本轮需求片段)|
| `target_chapter` | string | no* | 目标章节标识符,格式 `/^[A-Z]\d+-\d+(?:-\d{2})?$/`,例 `S1-1` 或更细粒度 `SC-S1-1-02` |

\* 标 non-required 只是 OpenAI tool schema 层面声明宽松；engine 实际 dispatch 时会校验若缺值直接 emit tool_error 早返回拒绝下沉给 LLM —— 因为没有合法 target 就没法 resolveWriteTarget 整套机制瘫痪.

为什么不在 schema 里标 required 强制模型必填？保守起见留余地应对某些边缘情形(如纯咨询型对话不该触发 writer 调用却被强行附参);同时 required=false 允许其他不需参数的 subagent 继续共用同一份 buildFunctionSpec 模板不用特判分流简化实现复杂度.

---

## 2. Resolve 流程伪码(T1.2/T1.3 实施)

```
executeTool(subagent='script_writer', args):
  argTarget ← args.target_chapter ?? null
  
  if !argTarget or not REGEX_MATCH(argTarget):
      emit('tool_error', msg='必须提供合法格式的 target_chapter')
      return FAIL early                              // 安全护栏拒穿越
      
  resolvedPath ← f"chapters/{argTarget}.md"
  sourceSeqPath← f"sequences/{normalize(argTarget)}.md"
                  // normalize: 若传入的是 SC-S1-1-02 则取其父序列 S1-1 作映射键
                  
  currentDraft ← tryRead(resolvedPath) else ''      // 既存草稿(refine 信号)
  seqBeatsDoc  ← tryRead(sourceSeqPath) else ''     // 对应序列场记(展开蓝本)
  
  extraContext ← [
      '<current_draft>'         + currentDraft + '</current_draft>',
      '<current_sequence_beats>'+ seqBeatsDoc  + '</current_sequence_beats>'
  ].join('\n\n')
  
  assembledFull ← assembleContext(staticReads) + '\n\n' + extraContext
  
  sysPrompt ← preamble + '\n\n' + skill.body
  userMsg   ← buildAgentPrompt(assembledFull, args.instruction)
  
  retry up to MAX_RETRIES=3 times:
      llmOut ← llm.sendMessage(sysPrompt, userMsg)
      validation ← validateOutput(llmOut, {
          ...,
          writes:[resolvedPath],                    // override 原 placeholder!
          outputTags:['SCRIPT_CHAPTER_START','END'] 
      })
      
      if valid:
          writeFile(validation.extracted[resolvedPath])
          return OK with result.writes=[resolvedPath]
          
      on format error append retry hint to userMsg continue
  
  return FAIL after retries exhausted               // 见 R3 风险登记
```

关键不变式:**validator 业务函数一行不改**,effectiveWrites 透传替换即可复用所有现有校验提取逻辑链条. 这是当初 C/H.2 选择通用动态写靶方案的回报兑现点.

---

## 3. Create / Refine 区别处置

| 维度 | CREATE(`<current_draft>` 为空) | REFINE(`<current_draft>` 非空或 instruction 含明确改稿动词) |
|------|-----------------------------------|-------------------------------------------------------------|
| 起点 | 白纸从零起草 | 沿用现有段落结构与角色台词基调不动主体骨架 |
| 改动幅度 | 全文新建约2000~4000字 | 最小必要修补只在指定维度上调优质感或堵漏洞 |
| ID 锚定 | 无须考虑(正文不带结构性编号) | 尽量不改人物出场先后次序与转折节点位置以利读者连贯追读 |
| diff 表现 | previousContent 空 status=generated | previousContent 存在上版 status=modified 卡片亮红提示对照 |

REFINE 不像 scene_beats 那样强守 ID 数字(剧本正文不含表格行号),改为软约束"沿袭叙事脉络". 因 hardcode 太严反伤作家润色时的灵活性得不偿失.

---

## 4. Characters Whitelist Enforcement 权衡

preamble 第一红线规定本章登场人物必须是 `<characters>` 登记者,不得凭空赋予未定义能力背景. 但这条目前**只能依靠 LLM 自律遵守而无 code-level 硬过滤兜底**.

权衡两种 enforcement level:

| Level | 做法 | 利弊 |
|-------|------|------|
| 软(prompt-only)(现状选) | 仅 systemprompt 约束违规概率取决于模型遵从度 | 实现简单零成本灵活度高容许创造性扩展;缺点偶发越界难即时拦截事后才暴露于 review |
| 硬(post-write validator 解析人名校验) | 校验阶段抽 entity 名比对 characters 注册表不符则 reject retry | 鲁棒性强但要引入中文实体抽取算法+NLP 库过重投入产出比差且回退 retry 又烧额度 |

现状选软路线接受偶发越界并通过末尾【⚠️ 待补设定】注释标记机制引导上层介入评估是否正式建档补充新元素. 这个折衷务实可控属刻意为之的设计取向而非疏忽.

W5 之后如真发现频繁出现擅自虚构 NPC 问题再考虑加轻量启发式黑名单检查也不迟,届时基于积累的真实日志样本针对性优化比现在盲猜更经济.

---

## 5. Foreshadowing Disclosure Reconciliation Flow

对照 `<foreshadowing>` 清单逐项核验归属本章范围内的 plant/payoff 项目落地状况形成内部 checklist(LLM 心算过程):

```
for item in foreshadowing.items where scope ∈ thisChapterRange:
    if item.type == PLANT expected here:
        assert chapter_text naturally embeds the seed without obvious telltale markers
    
    elif item.type == PAYOFF scheduled to fire here:
        prior_accumulation_strength ← evaluate earlier chapters' setup adequacy
        if strength >= threshold:
            proceed with reveal at dramatic peak moment
        else:
            defer payoff to later chapter AND add 【⚠️ 待补设定】note explaining rationale
            log warning in _beats_coverage style tracking file(optional)
```

不允许为了凑指标数提前揭破后手伏笔制造廉价惊喜感,亦不许遗忘承诺读者的信息披露义务留下烂尾坑位. 这两项都属于会被 story_checker(designing-phase only,writing 被 gate 屏蔽了 checker 故此处靠 writer 自检代替)抓到的合规性问题但因为 writing 期内 checker 不可达所以责任完全落在 writer 身上,prompt 要反复强化这一自我审查意识.

---

## 6. Structure Cadence 四段式来源

并非教条规定而是稳妥走势模板源自经典戏剧理论的三幕微观循环适配短篇章体裁:

1. 入场承接上章余烬建立当下心理坐标系 — 给读者 continuity anchor 降低跳读门槛;
2. 推进主线使冲突逐步升温遇阻反复 — 制造张力曲线上升坡度积蓄势能;
3. 安排关键转折引爆情感峰值瞬间 — 本章情绪高点同时也是叙事意义结晶时刻;
4. 收束给出转向后的新稳态或开放切口引向下一章 — 既闭合又勾连满足阶段性成就感的同时埋下持续追读动力.

只要呼吸起伏大致如此即可不强求四段均分篇幅比例根据题材气质自行调节长短配速. 死板照搬公式反而僵化丧失文学灵气违背初衷.

---

## 7. Word Count Boundary Rationale

single chapter 推荐区间 **2000~4000 汉字** 来自如下预算测算:

```
deepseek-v4-flash 32K ctx window ÷ safety_factor ≈ CONTEXT_LIMIT_CHARS=22000 chars 截断阈值
估算 token≈chars×f(f∈[1.5,2.5] depending language mix Chinese denser than English)

systemPrompt(preamble+body 约3000 chars static fixed overhead)
+reads(assembled seven setting docs variable but typically ≤5000 chars combined baseline)
+current_sequence_beats(single sequence table usually 500~1500 chars)
+user_instruction(small ~100 chars)
─────────────────────────────────────
input subtotal ceiling before generation starts ≈9000 chars used out of 22000

留给 generated output 余量 ≈13000 chars ⇒ 中文约6500汉字理论上限
取半安全系数得4000字实践阈值留缓冲应付极端情况(retry追加hint膨胀 message history等突发增量)
低于2000字则情感厚度不足显得仓促干瘪失去单独成章价值
```

这个计算同时也佐证了 README §C "为什么不一口气多章批产" 的隐忧合理性:即使技术上勉强够装两三章 input 叠加也会逼近临界极易爆雷触底触发 R3 risk chain reaction. 渐进交互制不仅规避 round limit 更重要的是守住 quality-density sweet spot.

---

## 8. Format Contract Checklist

提交前的硬规范一览(body 内文已详细阐述这里汇总备查):

- [ ] TAG 首尾分别精确包含 `<<<SCRIPT_CHAPTER_START>>>` 和 `<<<SCRIPT_CHAPTER_END>>>`
- [ ] END TAG 之后零字节附加包括署名脚注致谢语之类一律谢绝
- [ ] START 与 END 之间不再重复出现这对标识自身串
- [ ] 纯 Markdown 文本严禁 JSON/YAML/code block 围栏包裹正文
- [ ] `## 二级标题`用于分隔章内幕段,`### 三级标题`标识场景切换
- [ ] 舞台指示动作描述括号包裹或斜体二选一贯穿全篇勿混搭
- [ ] 对话独占行说话人引导符开头便于扫读
- [ ] 中文为主英文专有名词必要时混排但不滥用翻译腔
- [ ] 章节总体积控制在2000~4000汉字之间宁可分两次调用不要超万字堆叠

任一条违背后果:validateOutput 检不到对应 TAG → fail → consume 1 of MAX_RETRIES=3 quota → 多次失败耗尽配额整个 turn abort 返回错误响应给用户体验灾难. 因此 prompt 设计极尽清晰直白不留歧义余地最大限度预防模型失误节约宝贵 retry 经济学.

---

## 9. Retry Budget Conservation Mindset

MAX_RETRIES=3 是稀缺资源. 每次 fail 都意味着一轮 full LLM 往返消耗时间金钱双倍代价且不一定第二次就能纠正(format issue sometimes systemic due ambiguous instruction rather than random glitch).

为此 SKILL body 在多处主动植入防呆指引:

- 字数预警前置告知别贪心超限引发尾部 TAG 被截断连锁失效;
- 格式铁律明示禁忌清单杜绝无意犯规;
- 示例提供具体形态示范降低理解偏差概率;
- 双模判定条件列举穷尽量减少 mode misclassification;

这些都是为了让 model 第一次就对少烧钱提升整体吞吐效率. 设计 prompt 时始终带着「token economy」意识衡量每一句话的信息含量 ROI 不能光顾着讲清楚还要简练有力.

---

## 10. Symmetric Beauty With Upstream scene_beats

Writer 与 scene_beats share identical infrastructure backbone:

- same optional-target-param mechanism(buildFunctionSpec conditional attach by id whitelist);
- same resolveWriteTarget logic(executeTool compute prefix from id then construct effectiveWrites array overriding original placeholder entry);
- same sync-read-on-resolve principle(extra label injection feeding currentDraft/currentTarget/currentSequenceBeats back into assembled context enabling auto create-refine detection);

这种对称性带来三个收益:

1. **心智收敛**:开发者只需掌握一套 mental model 同时理解两端行为差异仅在于 prefix(chapters vs sequences)和标签名(current_draft vs current_target)其余完全镜像复制粘贴级别的相似度;
2. **测试矩阵折叠**:回归用例可以 parametric sweep across both agents sharing fixture templates dramatically reduce test author burden once automation framework lands(目前手工 e2e 仍受益于此对称性能交叉印证 bug 归因更快);
3. **扩展友好**:未来再加第三个类似 single-file-producer 性质的新 producer agent(比如 lore_codex_writer?)几乎 zero incremental engineering cost just declare new dir follow convention plug into existing pipeline—这就是当初抽象 generic dynamic-target protocol 的长远投资回报兑现点.

---

## 11. Future Second-Skill Reservation Placeholder

当前唯一 skill(script_writer 同名目录)足够 cover MVP 需求. 但预留以下两类潜在差异化技能构想备用待业务成熟或有客户痛点驱动时择日上线填补细分市场空白:

| 候选 skillId | 适用情境 sketch | 备注 |
|--------------|----------------|------|
| rhythm_polish | 已存 chapter 整体节奏微调速控张力曲线松紧但不改正情节走向 | 比 general refine 更专注 pacing dimension 可能配合 audio cue markup 增强 stage direction richness |
| dialogue_refine | 台词专项打磨潜台词层次语气个性化去除书面腔增强口语感 | 需要 read more dialogue craft reference corpus possibly external knowledge base integration higher complexity |

两者皆 gated behind Phase Gate already active(no special prerequisite beyond what mainline provides). 启用时遵循同样的 hot-plug directory convention drop folder under src/skills/script_writer/<new_skill>/SKILL.md 即可经 import.meta.glob eager registration automatic discovery without touching engine codebase—this is exactly why four-layer framework was built for such extensibility scenarios ready waiting utilization opportunity arises organically driven by real demand signals not speculative premature optimization now.
