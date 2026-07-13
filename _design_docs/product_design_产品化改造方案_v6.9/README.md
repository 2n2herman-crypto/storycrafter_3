# v6.9 写作 Agent 优化专项

> 聚焦成文 writer：**序列级原子化 + 多序列并发批量 + 文件命名产品特化**。
> 与 v6.7.5（scene_beats 并行，开发中）解耦——本专项只动 writer 链路，不动 scene_beats。

## 1. 痛点（代码核实）

| # | 痛点 | 代码依据 |
|---|---|---|
| ① | 短剧 writer 每次 tool_call 只产 1 集，8-15 集需 Orche 调 8-15 次 → 撞 `MAX_ROUNDS=10`/`MAX_TOOLS_PER_ROUND=5`，20+ 序列短剧写不完 | [SKILL.md:173](../../src/skills/short_drama_writer/short_drama_writer/SKILL.md#L173)「单次只产一集…由引擎逐集调用累积」、[orchestrator_v5.md:114](../../src/llm/prompts/orchestrator_v5.md#L114)「你每次调用产一集，引擎逐集调用累积」 |
| ② | writer 无批量能力，写多序列必须 Orche 逐序列点名 tool_call | [orchestratorEngine.ts:591-608](../../src/orchestrator/orchestratorEngine.ts#L591) writer 走单 Skill 直发，target_chapter 必填、只处理单序列 |
| ③ | 文件名 `chapters/S1-1.md` 看不出含哪些集，与「一序列=多集弧」语义脱节 | [orchestratorEngine.ts:607](../../src/orchestrator/orchestratorEngine.ts#L607) `resolvedPath = chapters/${seqId}.md` |

## 2. 目标（用户拍板）

1. **写作支持多序列并发输出**——一次 tool_call 内并发铺多个序列正文。
2. **十几集一起输出**——一个序列作为一个单元产出（短剧内部逐集累积），不再 Orche 逐集调用。
3. **链路**：触发写作任务 → 创建序列为单位资产文件，命名为该序列所含集 `E01-Exx.md`。

### 决策记录

| 决策点 | 选择 | 说明 |
|---|---|---|
| 整序列产出方式 | **内部逐集累积** | 一次 tool_call 内部循环逐集调 writer LLM 累积成整序列文件；复用现有逐集逻辑，稳健不崩；LLM 调用次数不变但 Orche 只消耗 1 次配额 |
| 适用产品 | **全部四产品** | 统一多序列并发批量机制；命名规则产品特化 |
| 并发范围 | **仅 writer** | v6.7.5 scene_beats 并发另算；v6.9 新增通用 `runWithConcurrency` 供 v6.7.5 未来复用，不动 scene_beats 调用点 |

## 3. Wave 映射速查

| Wave | 内容 | 关键载体 |
|---|---|---|
| A 序列级原子化 | writer 从单 Skill 直发升级为「序列级写作 pipeline」：空靶 `runWriterBatchPipeline`（全量并发）/ 带靶 `runWriterSequencePipeline`（单序列）；短剧内部逐集循环累积，长剧/小说/剧本单次产整序列 | [orchestratorEngine.executeTool](../../src/orchestrator/orchestratorEngine.ts#L452) WRITER 分支重构 |
| B 多序列并发 | 新增通用 `runWithConcurrency` 有界并发池（上限 3）+ `WRITER_CONCURRENCY` 常量；writer 批量调用它；429 退避 `sendWithRateLimit` | orchestratorEngine 新增私有方法 |
| C 文件命名产品特化 | `buildEpisodeRangeMap`（序列→全局集号区间）+ `resolveChapterPath`（按产品拼路径）；短剧 `E01-Exx.md` / 长剧 `E01.md` / 小说剧本 `chapters/<seqId>.md` | orchestratorEngine 新增函数 |
| D FC 协议 | writer `target_chapter` 改可选（留空=全量并发批量）；`buildFunctionSpec` 描述对齐 scene_beats 的 target_sequence 模式 | [skillLoader.buildFunctionSpec](../../src/skills/skillLoader.ts#L265) |
| E Orche prompt | 第5条「writer 绝不空靶」→「空靶=全量并发批量」；短剧约定改为「一次调用产整序列、引擎内部逐集累积」；新增 writer 批量调度节 | [orchestrator_v5.md](../../src/llm/prompts/orchestrator_v5.md) |
| F UI 适配 | `assetStore.computeLabel` 加 `E\d+` 模式 →「第X-Y集」/「第X集」展示名；精准刷新按 `event.writes` 路径无需改 | [assetStore.computeLabel](../../src/store/assetStore.ts#L56) |

## 4. 新链路（用户视角）

```
用户「把所有序列的正文写出来」（target_chapter 留空）
  → writer 被 Orche 选中
  → runWriterBatchPipeline：
      ① 读 sequence_list 解析全部 seqIds
      ② buildEpisodeRangeMap 算每序列全局集号区间
      ③ runWithConcurrency(并发 3) 跑 runWriterSequencePipeline(seqId)
  → 每个序列：
      ① 建档骨架落盘（E01-E12.md / E05.md / S1-1.md）→ UI 立即出卡片
      ② 短剧：逐集循环调 writer LLM（每集 1 次，<current_draft> 累积）
         长剧/小说/剧本：单次调 writer LLM 产整序列
      ③ 收口落盘 + 提取 BEHAVIOR_TRACK/FORESHADOW + updateBatchProgress
  → 汇总单 ToolResult（writes = 全部序列文件路径）
```

## 5. 关键不变式（INV）

- **INV-1** `validateOutput` 主体不改
- **INV-2** `assembleContext`/`buildAgentPrompt` 不改
- **INV-3** `types/index.ts` 零改；命名规则用 `profile.kind`+`sequenceToEpisode` 在 engine 内分支，不加 `ProductProfile` 字段
- **INV-4** 目录约定归属不动
- **INV-5** `runWriterSequencePipeline` 自包含（无跨序列共享可变状态）—— 并行硬前提
- **INV-6** 短剧/长剧 writer SKILL 输出约定改（只输出本单元、引擎追加，修复逐集覆写丢集 bug）；小说/剧本 SKILL 不改
- **INV-7** scene_beats 零改动（v6.7.5 另算）
- **INV-8** story_checker 零改动（reads 是 `sequences/*.md`，不读 chapters）

## 6. 文档结构

- [01_产品设计文档.md](./01_产品设计文档.md) — 现状、目标、新链路、命名规则、数据流、用户视角
- [02_开发方案.md](./02_开发方案.md) — 改动清单（精确到行/函数）、代码骨架、不变式、风险、验证、回滚
