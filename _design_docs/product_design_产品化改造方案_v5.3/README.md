# StoryCrafter 3 v5.3 四层框架改造（Orchestrator → Subagent → Skill Router → Skill）

> 版本：v5.3
> 目标：把扁平的 **Orchestrator → Tool** 模型升级为 **Orchestrator → Subagent → Skill Router → Skill** 四层框架，并将各 Agent 的 system prompt 打包成可热插拔的标准 Skill 文件夹。
> 范围：调度框架、Subagent/Skill 加载与注册、frontmatter 协议、类型与 Store 适配。
> 约束：本轮每个 Subagent 只带 1 个 Skill（= 其原 prompt）；FC 面（`id` + `description`）逐字不变，Orchestrator 侧调度行为与 v5.2 等价。

---

## 一、改造背景

v5.2 及之前是**扁平**的 `Orchestrator → Tool` 模型：

- `src/orchestrator/toolRegistry.ts` 里 10 个 `ToolSpec` 硬编码为数组，每个 Tool = 一次 LLM 调用。
- 每个 Tool 的 system prompt 是 `src/llm/prompts/*.md` 里的**单个**文件，`reads/writes/outputTags` 写死在 Tool 上，1 Tool ↔ 1 prompt ↔ 1 文件输出。
- 多个 prompt 内部其实已隐含"多技能"（`worldbuilding` 自判架空/现实、`subplot_manager` 有 OPEN/MERGE/REFINE、`story_checker` 有多个检查维度），但这些能力被焊死在单个 prompt 里，无法被外部热插拔或独立选择。

核心判断：**能力（Skill）与角色（Subagent）耦合过死，无法复用、无法热插拔、无法在同一角色下并存多种能力。**

---

## 二、四层职责模型（权威）

| 层 | 负责 | 不负责 | 载体 |
| --- | --- | --- | --- |
| Orchestrator | 拆任务、通过 FC 选 Subagent、合并结果 | 具体执行细节 | `orchestratorEngine.ts` + `src/llm/prompts/orchestrator_v5.md` |
| Subagent | 角色定位、任务规划、选择技能、质量控制 | 不内置所有工具逻辑 | `src/skills/<subagentId>/subagent.md` |
| Skill Router | 在该 Subagent 可用 Skills 中选最合适的一个 | 不决定业务目标 | `src/orchestrator/skillRouter.ts` |
| Skill | 可复用能力/流程/脚本/模板/工具调用 | **不决定自己属于哪个 Agent** | `src/skills/<subagentId>/<skillId>/SKILL.md` |

两个 `description` 分属不同层：

- `subagent.md.description` → 喂 Orchestrator FC（LLM 决定是否调用该 Subagent）。
- `SKILL.md.description` / `when` → 喂 Skill Router（决定用该 Subagent 名下哪个 Skill）。

---

## 三、磁盘布局与标准格式

```
src/skills/
  <subagentId>/
    subagent.md                 # Subagent manifest：frontmatter + 角色前缀正文
    <skillId>/
      SKILL.md                  # Skill manifest：frontmatter + system prompt 正文
      references/  templates/  scripts/   # 可选，后续 Skill 用，本轮不建
```

### subagent.md frontmatter（供 Orchestrator FC + 分组）

```yaml
---
id: worldbuilding
name: 世界观设定
description: 创建或修改世界观设定。文件不存在时自动创建……   # → FC function.description
group: 基础设定
---
<角色前缀正文：该 Subagent 的角色定位/任务规划/质量控制说明，作为 Skill body 的前置 system prompt>
```

### SKILL.md frontmatter（供 Skill Router 选择 + 执行协议）

```yaml
---
name: 世界观设定
description: 处理世界观构建与背景设定；架空与现实题材皆可     # Skill Router 读它在 ≥2 skill 时选择
when: [世界观, 设定, 背景, 架空, 现实]                      # 可选：确定性关键词命中
reads: ['user_requirements.md', 'worldbuilding.md']
writes: ['worldbuilding.md']
outputTags: ['<<<WORLDBUILDING_START>>>', '<<<WORLDBUILDING_END>>>']
---
<body = 迁移过来的原 prompt 正文，逐字不改>
```

关键约束：

- **per-skill I/O**：`reads/writes/outputTags` 移到 SKILL.md（同一 Subagent 的不同 Skill 可读写不同文件/标签）。
- **归属靠目录、不靠声明**：`skillLoader` 从**路径**解析 `subagentId/skillId`（不信 frontmatter）。SKILL.md frontmatter 若出现 `subagent`/`owner`/`agent` 键 → loader 抛错。
- **frontmatter 值含 `>>>`**：`outputTags` 必须加引号；解析器把数组项当不透明字符串、不解释 `>`。

---

## 四、改了什么（文件级）

### 删除

- `src/orchestrator/toolRegistry.ts`（扁平 `TOOL_REGISTRY` 硬编码数组）。
- `src/llm/prompts/` 下 10 个 subagent prompt（保留 `orchestrator_v5.md`）。
- `src/llm/client.ts` 中无引用的 `callAgent` 死代码。

### 新增

- `src/skills/skillLoader.ts` —— 加载/注册中枢：
  - `import.meta.glob('./*/subagent.md', {query:'?raw',eager:true})` + `'./*/*/SKILL.md'` 发现 manifest，从**路径**解析 `subagentId/skillId`。
  - 手写零依赖 `parseFrontmatter`（扁平标量 + 内联数组，不支持块标量/嵌套）。
  - 导出 `SUBAGENT_REGISTRY`、`SKILLS_BY_SUBAGENT`、`getSubagent`、`getAvailableSubagents`、`getSkills`、`buildFunctionSpec`（仅转发 `id`+`description`）。
  - 校验：每个 Subagent ≥1 Skill、`id` 与目录名一致、无属主键。
- `src/orchestrator/skillRouter.ts` —— `selectSkill(subagentId, instruction)`。
- `src/skills/<subagentId>/subagent.md` × 10 + `src/skills/<subagentId>/<skillId>/SKILL.md` × 10。

### 改造

- `orchestratorEngine.executeTool`：从"直接读 Tool 的 prompt 文件"改为 `selectSkill → 读 skill.reads → assembleContext → system prompt = preamble + skill.body → validateOutput(skill)`。
- `contextAssembler.assembleContext(reads[], files)`、`outputValidator.validateOutput(output, skill)` 改吃 `SkillSpec`。
- 类型：`ToolSpec` → `SubagentSpec`（`id/name/description/group/preamble`）；新增 `SkillSpec`（`subagentId/skillId/name/description/when/reads/writes/outputTags/preamble/body`）；`ExecutionEvent`/`ToolResult` 增补 `skillId?/skillName?/writes?`（保留 `toolId/toolName`，语义=subagent）。
- Store：`assetStore.buildAssetMeta` 遍历 `SUBAGENT_REGISTRY × 各 skill.writes` 映射到 subagent 分组；`chatStore` 精准刷新改用 `event.writes`。

### 迁移映射（skillId 用原 prompt basename，1:1 可审计）

| 现 prompt | subagent.md | SKILL.md |
| --- | --- | --- |
| worldbuilding.md | skills/worldbuilding/subagent.md | skills/worldbuilding/worldbuilding/SKILL.md |
| characters.md | skills/characters/subagent.md | skills/characters/characters/SKILL.md |
| act_map.md | skills/act_map/subagent.md | skills/act_map/act_map/SKILL.md |
| sequence_list.md | skills/sequence_list/subagent.md | skills/sequence_list/sequence_list/SKILL.md |
| scene_beats.md | skills/scene_beats/subagent.md | skills/scene_beats/scene_beats/SKILL.md |
| foreshadowing_tracker.md | skills/foreshadowing_tracker/subagent.md | .../foreshadowing_tracker/SKILL.md |
| subplot_manager.md | skills/subplot_manager/subagent.md | .../subplot_manager/SKILL.md |
| user_requirements_analyzer.md | .../subagent.md | .../user_requirements_analyzer/SKILL.md |
| story_checker.md | skills/story_checker/subagent.md | .../story_checker/SKILL.md |
| reset_all.md | skills/reset_all/subagent.md | .../reset_all/SKILL.md（reads/writes/outputTags 均空）|

---

## 五、设计了什么（关键决策）

1. **归属靠目录、不靠声明**：Skill 绝不声明属主 Agent，归属完全由 `src/skills/<subagentId>/` 路径决定 → 满足"Skill 不决定自己属于哪个 Agent"的硬约束。
2. **热插拔 = 目录约定 + glob 注册**：`import.meta.glob` 在**构建/dev-reload 期**自动发现注册。往某 Subagent 目录丢一个新 `<skillId>/SKILL.md` 文件夹即接入其可用范围，无需改引擎代码。**注意这是构建期解析，非浏览器运行期文件系统**——不是运行中浏览器里实时拖入。
3. **Skill Router 零成本直选**：1 skill 时直接返回、**不调 LLM**；≥2 skill 时按 `when` 关键词命中(+2)/`description` token 命中(+1) 确定性打分，平局或零命中回退第一个。本轮全部走直选路径（≥2 分支预留但可达）。
4. **system prompt 现拼角色前缀**：`skill.preamble`（角色定位/质量控制）+ `\n\n` + `skill.body`（能力正文）。这是**有意的非零回归**——system prompt 字节与 v5.2 不同，但角色前缀写得克制，只加角色定位不改创作规则，把偏差降到最小。
5. **reset_all 靠空 Skill 信号**：其 Skill 的 `writes:[]` + `outputTags:[]` 触发无 LLM 的 `clearAll()`，保持 Subagent 身份的统一性。
6. **自研零依赖 frontmatter 解析器**：只支持扁平标量 + 内联数组，含 `>>>` 的值必须加引号。选择自研是因为 `js-yaml` 仅作为 eslint 间接依赖存在、未在 package.json 声明、无 `@types`。

---

## 六、执行协议（orchestratorEngine.executeTool）

1. `selectSkill(subagentId, instruction)` 选定 Skill（1 skill 时直接返回、不调 LLM）。
2. 若为空 Skill（`writes:[]`+`outputTags:[]`）→ `clearAll()`，不调 LLM（reset_all）。
3. 按 `skill.reads` 从 FileManager 读取文件；缺失文件视为空内容。
4. `assembleContext(skill.reads, files)` 把每个文件包成 XML 标签。
5. system prompt = `skill.preamble ? preamble + '\n\n' + skill.body : skill.body`，附加 `<user_revision_instruction>`。
6. 调 LLM，最多重试 3 次；`validateOutput(output, skill)` 校验必须包含 `skill.outputTags` START/END，并把 tag 内 Markdown 写入 `writes[0]`。

---

## 七、风险 / 边界

- **Vite glob ≠ 运行期热插拔**：最大预期偏差；热插拔发生在 dev-reload/重建期。
- **frontmatter 解析器**：只支持扁平标量 + 内联数组，不支持块标量/嵌套；`outputTags` 必须加引号；未知键忽略，属主键抛错。
- **单文件输出**：validator 仍只写 `writes[0]`；未来 Skill 若需多文件输出要先扩展校验/提取逻辑。
- **行为差异（非零回归）**：因拼接角色前缀，system prompt 字节与 v5.2 不同 → 输出可能微调，属有意为之。
- **Skill Router ≥2-skill 选择**：确定性打分已实现但本轮无真实多-skill 场景验证。

---

## 八、验证

1. `npx tsc -b`（真实类型检查；根 tsconfig 是 solution/project references）。本次四层改造涉及的所有文件（skills/orchestrator/store/types/llm）**类型零错误**；20 份 manifest frontmatter 全部解析正确（`>>>` 标签完整、reset_all 空数组、无属主键）；10 份 SKILL body 与原 prompt 逐字一致。
2. `npm run dev` 手动 smoke：确认资产卡片正常填充、执行日志显示各工具事件（+新增 skill 字段）、reset_all 清空生效、story_checker 审计闭环触发、创作后 user_requirements 状态标记自动更新。
3. `VITE_DEEPSEEK_API_KEY=... node test_api.mjs` 验证 FC 连通性（FC 面未变，应与现状一致）。

> 已知遗留（与本次改造无关）：`src/App.tsx` 仍 import 已删除的 `components/Layout/DiffLayout`，新的 `MultiColumnLayout.tsx` 无人引用——这是上一轮未完成的 UI 迁移（v5.4 视觉改造相关），导致整体 `npx tsc -b` 无法全绿。本次四层改造的所有文件类型干净。

---

## 九、非目标

v5.3 本轮不处理：

- 单个 Subagent 挂 ≥2 个 Skill 的真实业务场景（框架已就绪，能力待引入）。
- Skill Router 的 LLM tiebreak（预留开关，本轮不接）。
- 多文件输出的 validator 扩展。
- 前端视觉风格（属 v5.4 范围）。
- `InMemoryFileManager` 持久化、Orchestrator 渐进式消息压缩。
