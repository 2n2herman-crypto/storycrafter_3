# v6.1 实施路线图（implementation_plan）

> 本篇是 [README.md](./README.md) 总纲之下的执行手册：把抽象设计拆成可独立交付的 wave，每个 wave 即一个 PR 边界。配套阅读 [`scene_beats_redesign.md`](./scene_beats_redesign.md) 与 [`script_writer_spec.md`](./script_writer_spec.md)。

---

## 0. 全局节奏与依赖

```
W0 (prompt 资产重组)          ✅ 已完成
   │
   ├──────────────► W4 (Orc prompt 补丁)        ⏳ 可随时开工
   │
W1 (引擎协议扩展) ──┬──► W3 (UI 接入)
                   └──► W5 (cross_sequence_check 上线)
                   
W2 (Phase Gate 门控体系)       与 W1 并行可行
```

| Wave | 名称 | 前置 | 状态 |
|------|------|------|------|
| W0 | prompt 层资产重组 | — | ✅ 本轮交付 |
| W1 | 引擎协议扩展·resolveWriteTarget + 动态注入原语 | W0 | ⏳ 待开工 |
| W2 | Phase Gate 门控体系 phaseStore + Guard-1/2 + reset_all 联动 | 无强依赖,可与 W1 并行 | ⏳ 待开工 |
| W3 | UI 三处接入 HeaderBar / AssetCardPanel / BaselinePanel 兜底 | W1 提供 resolved paths 数据流 | ⏳ 待开工 |
| W4 | Orchestrator Prompt 补丁 writing-phase 编排段 | W0 | ⏳ 低风险可早做 |
| W5 | cross_sequence_check 第二枚 skill 挂载激活 router 多选验证 | W1 的 dynamic enumeration 子集就绪 | 🔒 gated |

> **Wave 边界即 PR 边界**——每完成一个 wave 应能 `npx tsc -b` 绿灯且不破坏既有 design 链路可用性。

---

## Wave 0 · 已交付内容快照（本轮）

### 新增/改造文件清单
```
src/skills/
├── scene_beats/
│   ├── subagent.md                    ← 改:preamble 身份升格「序列场记架构师」+低密度守护者姿态
│   ├── sequence_split/SKILL.md        ← 新:per-sequence 主力 skill,writes placeholder,outputTags 复用 SCENE_BEAT pair
│   └── scene_beats/(已删除)           ← 删:monolithic 时代遗产单体 SKILL 目录
└── script_writer/                     ← 整目录新
    ├── subagent.md                    
    └── script_writer/SKILL.md         
```

### 设计选择备忘
- 单一 Skill 决策(scene_beats & script_writer 各一):遵循 v5 gen/refine 合并哲学;第二枚 audit 类 skill 因依赖尚未存在的 dynamic-enumeration 引擎能力而**主动缓发**,见 §H.7。
- outputTags 名复用旧值(`SCENE_BEAT_OUTLINE_START/END`)而非换名:`validateOutput()` 仅按声明 tag 提取,语义变更不影响校验逻辑稳定性,减少认知迁移成本。
- writes 用 `.placeholder` 占位符让 loader 通过"至少一项非空数组"约束,真实路径由 engine resolve。

### 验收口径(W0 独立验收点)
1. `npm run dev` 启动无白屏(loader 不抛 frontmatter 解析错);
2. 浏览器内既有创作链路(worldbuilding→characters→…→scene_beats)仍跑通到产出 sequences/*.md(注意:**此刻尚不能真正按 target_sequence 工作**,因为 buildFunctionSpec 还没加该参数、executeTool 也未实现 resolveWriteTarget —— 这是预期内的半成品状态,W0 只负责把 prompt 协议铺好等 W1 来通电);
3. 当前实际行为退化为:writes[0]=placeholder 字面量被 validator 写入名为 `sequences/.placeholder` 文件(无害垃圾),LLM 收到的 systemPrompt 是新版 preamble 但 instruction 缺 target 信息 → 可能输出仍含 START/END 包裹但落盘位置错误;
4. 因此 **W0 完成后不建议给最终用户使用**,仅作为开发分支自测里程碑存在直到 W1 通电后才形成完整功能闭环。

⚠️ 这条说明很重要避免误判进度质量。

---

## Wave 1 · 引擎协议扩展(核心基建)

### 目标
打通两路切片共享的动态写靶通路及其伴生的运行时读入注入机制。

### Task 分解

#### T1.1 FC 参数增容
改 [`buildFunctionSpec`](../src/skills/skillLoader.ts#L250-L268):据 subagent.id 选择性附加 optional 参数:
```ts
const extraParams = needsTargetParam(subagent.id)
  ? { target_chapter: { type:'string', description:'...' } }      // writer 场景
  : { target_sequence:{ type:'string', description:'...' } }     // beats 场景
// 合并进 parameters.properties(non-required)
```
其中 `needsTargetParam(id)` 维护一个白名单常量集合 `{scene_beats, script_writer}`,便于未来扩员。

正则护栏放 description 里提示格式 `/^[A-Z]\d+-\d+(?:-\d{2})?$/`,engine 实际执行时再做硬校验拒非法。

#### T1.2 executeTool 解析写靶(resolveWriteTarget)
在现有 [`orchestratorEngine.executeTool`](../src/orchestrator/orchestratorEngine.ts#L131-L213) 内 selectSkill 之后插入:

```
const argTarget = parseArgTarget(toolCall.args, subagent.id) // 读 args.target_{chapter|sequence}
if(argTarget && validateIdFormat(argTarget)){
    const prefix = id==='script_writer'?'chapters':'sequences'
    const effectiveWrites=[`${prefix}/${argTarget}.md`, ...skill.writes.slice(1)]
} else if(needsTargetParam(subagent.id) && !argTarget){
    emit tool_error '必须提供目标标识' return early
} else {
    effectiveWrites=skill.writes
}
```

把后续所有引用 `skill.writes` 改为 `effectiveWrites`(影响 L180 校验写入循环和 L185 ToolResult.writes 返回字段)。validator 行为不变依旧 extractBetween 后填入 extracted[effectiveWrites[0]]。

#### T1.3 同步喂读注入(current_target/current_draft/current_sequence_beats)

resolve 出有效 path 时,**额外读取其当前已有内容**(若不存在则空串),并把它追加进 assembleContext 结果里以专属标签包裹:

| Subagent | 注入标签 | 含义 |
|----------|----------|------|
| scene_beats | `<current_target>` | 该序列场记切片现状(create/refine 自动判定信号源)|
| script_writer | `<current_draft>` | 该章节剧本草稿现状(refine 信号)+ 同时把对应 sequence_split 产物作 `<current_sequence_beats>` 一并喂入供作家展开依据|

需要小改 [`assembleContext`](../src/orchestrator/contextAssembler.ts#L19-L37) 或新增姊妹函数接受额外 `(extraLabels)` 参数透传拼接。建议后者保持单一职责清晰。

#### T1.4 dynamic asset listing injection(为 W5 解锁做准备但本 wave 先占位接口)

新增可选函数 `listGeneratedAssets(fm,prefix:string)` 在 contextAssembler 中暴露;暂不在任何 skill 默认调用,留待 W5 cross_sequence_check 启用时挂上即可产生 `<existing_assets>` 标签满足 H.4 方案②需求。提前预埋降低未来返工面积。

### 验收口径(W1 完成)
- 对话框输「细化 S1-2 序列」,Orchestrator 选 scene_beats 且携带 target_sequence=S1-2,instruction 经解析生成 `sequences/S1-2.md`;
- 再次输同一指令触发 refine:create 时 LLM 看到 `<current_target></current_target>` 空;refine 时看到上次产物全文;
- writer 同理对 chapters/* 生效;
- DevTools Network 抓 deepseek request body,function arguments 含 target_* field ✓.

---

## Wave 2 · Phase Gate 门控体系

详见 README §A/B/G,此处只补 task 细节不复述原理。

### T2.1 新建 src/store/phaseStore.ts
zustand store 导出 lock/unlock/isLocked/isLockedPath/getBaseline/reset,内部维护 LOCKED_PATHS 七项固定集 + baselines Map<path,content>(注:第七项从字符串 `'scene_beat_outline.md'` 改为概念化"All generated sequences/\*.md",lock() 时遍历 fm.listAssetFiles() 过滤此 glob 入基线).

### T2.2 orchestratorEngine 插两层 guard
Guard-1 processUserInput 入口过滤 availableSubagents→toolSpecs 前 filter by currentPhase.
Guard-2 executeTool 开头再判一次兜底拒绝越界调用并向 messages push 错误反馈供 Orchestrator 自纠转向.

### T2.3 reset_all 联动 hook
[`isResetSkill`](../src/orchestrator/orchestratorEngine.ts#L57-L59) 触发的 clearAll() 之后立即调 usePhaseStore.getState().reset() 回 designing 清空 baseline. 注意 zustand store import 方向防止循环依赖(phaseStore 不应反向 import engine).

### 验收口径(W2 完成)
- 七大资产齐全时手动调 lock() 成功切换 phase;
- 故意缺一份时抛带缺失列表的错误 toast;
- writing 期对话中要求修改 worldbuilding 被 Guard 直接拦下或 Orchestrator 礼貌劝阻,worldbuilding.md git diff 为空字节级不变;
- reset_all 把 assets/baselines/chapters 全清空且回 designing.

---

## Wave 3 · UI 三处接入

### T3.1 HeaderBar CTA 按钮([HeaderBar.tsx](../src/components/Layout/HeaderBar.tsx))
designing/writing 两态互斥控件如 README E-2 所述. 进度文案 X/Y 来源:listAssetFiles 过滤 chapters/*.md 计数 vs act_map regex 数序列总数. 异步算放组件 useState useEffect 即可不污染全局 store.

### T3.2 AssetCardPanel cards 兜底分组命名(assetStore.getAssetList 扩展)
路径前缀判断 group fallback:`path.startsWith('sequences/')?'大纲结构':path.startsWith('chapters/')?'正文章节':''`. filename 取 basename 去 .md 作展示.

### T3.3 BaselineTab approved 绑定(uiStore.baselineTab='approved')
writing 期切到此 tab 时左视窗数据源改为 phaseStore.getBaseline(selectedCard);pre-edit 保持现 previousContent 行为不变. DiffViewer/utils/diff.ts 零改动只换数据来源管道.

### T3.4 App.tsx init wiring
启动期实例化 phaseStore(无需外部 dep,zustand 自管理 state);若采用懒注册也可省略显式 init 仅靠模块单例. 给 HeaderBar 传 onLock/onUnlock callback props 由 App 持有 fileManager ref 调用 store action.

### 验收口径(W3 完成)
完整 e2e 流程手测通过参照 README Verification step 1~10.

---

## Wave 4 · Orchestrator Prompt 补丁(轻量软引导)

最低风险最早可做项. 改 [`orchestrator_v5.md`](../src/llm/prompts/orchestrator_v5.md):
- 「绝对禁令」末尾加第5条:只在 writing 阶段用 script_writer 必须配 target_chapter;
- 新增「§写作阶段编排」短节描述锁定后的任务形态变化及遇用户想改设定时的劝阻话术模板;
- 「批量调度策略推荐顺序第4步」改成针对 act_map 解析出的序列数 N 依次或批≤5 调 scene_beats(target_sequence=...)直至全覆盖;
- 加一行注明 script_writer 不要与其他工具并行因体积大易截断 context.

由于 Guard 已经物理保障安全边界这段 prompt 主要服务体验顺畅性不是安全保障线,容许措辞弹性较大迭代成本低.

---

## Wave 5 · cross_sequence_check 第二枚 skill(gated by W1.T1.4)

待 dynamic asset listing primitive 就绪后方可开建. 此前 Orchestrator 通过观察 executionLog 的 tool_complete(writes=['sequences/X-Y.md']) 反推已完成清单作为临时替代方案(H.4 方案① MVP). 

新建 `src/skills/scene_beats/cross_sequence_check/SKILL.md`:reads 利用 listing primitive 自动列举全部 sequences/*.md 对照 act_map 解析序列全集计算覆盖率缺口,产出 `_beats_coverage.md` hidden report(similar to _check_report pattern at engine L423-L430 inject full text back into messages for Orc decision-making).

selectSkill 此时首次面对 ≥2 candidate 进入打分分支(`when:[覆盖,缺口,进度]` vs `sequence_split.when:[切片,...]`),正式填补 CLAUDE.md "≥2-skill 尚无真实场景验证"已知缺口.

router 关键词路由策略详细推演见 redesign doc §DUAL-SKILL ROUTING 章节.

---

## 风险登记册

| # | 风险 | 影响 wave | 缓解策略 |
|---|------|-----------|----------|
| R1 | InMemoryFileManager 易失导致刷新丢稿长期未解 | 全局背景噪音 | 不在本计划范围,记一笔由持久化专项处理(ElectronFileManager 等)|
| R2 | DeepSeek API key 受额度上限可能在长流程中途断流 | W3/W5 大型联调时段 | test_api.mjs smoke 提前探活;失败优雅降级提示用户稍候重试 |
| R3 | CONTEXT_LIMIT_CHARS=22000 截断可能切断大 chapter 输出尾部 TAG 导致 validation fail retry 循环烧光 MAX_RETRIES=3 配额 | W1 起(writer)| SKILL body 强制字数 ≤4000 留足余量;compressMessages 兜底但不保证末尾不被截 |
| R4 | 双向 unlock 后用户继续编辑设定却忘记重新 lock 就接着写作导致前后章基于不同基线穿帮 | W2 用户操作风险 | UI 上解锁同时弹明显 banner 提示「当前处于开放编辑态,新生成章节将不再受保护一致性」引导用户重锁后再续写 |
| R5 | loader glob eager load 所有 .md 到 bundle 增加 initial payload size | W0 起 | 每个 SKILL 几 KB 量级累积可控;真优化走 lazy import 再议 |

## 回归测试矩阵(人工 checklist 版)

每次合 PR 至少过一遍以下最小回归子集确保存量链路没退化:

- [ ] cold start npm run dev 白屏检查
- [ ] 从空起步一句 user input 创建 worldbuilding 卡片正常显示 modified diff
- [ ] story_checker 正常产出 _check_report.md 注回 messages(Orc 能读到结论文本)
- [ ] reset_all 清空资产卡片消失 chatStore 重置 isProcessing=false
- [ ] npx tsc -b 零 error
