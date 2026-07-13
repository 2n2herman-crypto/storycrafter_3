# Tool 系统架构设计

> **核心**：将 Subagent 封装为 Tool，通过 DeepSeek Function Calling 协议实现意图驱动的智能调度

---

## 一、设计目标

1. **声明式注册** — 所有 Tool 信息通过 `ToolRegistry` 声明，调度引擎不硬编码任何 Tool 逻辑
2. **Function Calling 原生集成** — 利用 LLM 原生的函数调用能力，不自己实现意图→工具映射
3. **多轮调用链** — 支持 Orchestrator LLM 连续调用多个 Tool 完成复杂任务
4. **新增零成本** — 加新 Tool 只需注册，不改调度引擎代码

---

## 二、ToolSpec 定义

`ToolSpec` 是 Tool 的"身份卡"：

```typescript
interface ToolSpec {
  /** 唯一标识符，用于 Function Calling 的 function.name */
  id: string

  /** 人类可读的名称（前端展示用） */
  name: string

  /**
   * Tool 描述（最关键字段）
   * 直接作为 function.description 传给 LLM，
   * LLM 据此决定是否调用此 Tool。
   * 必须准确描述 Tool 的能力和适用场景。
   */
  description: string

  /** Subagent System Prompt 文件路径（src/llm/prompts/ 下的 .md 文件） */
  systemPromptFile: string

  /**
   * 上下文隔离边界
   * 执行此 Tool 时，只读取这些文件注入上下文。
   * 不在列表中的文件对 Tool 不可见。
   */
  reads: string[]

  /** Tool 执行后写入的文件列表 */
  writes: string[]

  /** 输出校验 TAG 列表（<<<TAG_START>>> / <<<TAG_END>>>） */
  outputTags: string[]

  /** 前端分组展示标签（如 '基础设定'、'大纲结构'、'微观精铸'） */
  group: string

  /**
   * 可选：依赖文件列表
   * 如果指定，Tool 在这些文件存在前不可调用。
   * 用于隐式表达创作阶段依赖关系。
   */
  dependsOn?: string[]
}
```

---

## 三、ToolRegistry

`ToolRegistry` 是 `ToolSpec[]` 的封装管理器，是所有 Tool 的单一来源。

### MVP Tool 清单

```typescript
const TOOL_REGISTRY: ToolSpec[] = [
  // ===== 基础设定生成 =====
  {
    id: 'generate_worldbuilding',
    name: '世界观生成',
    description: '根据用户描述生成完整的世界观设定，包括世界背景、物理法则、社会结构、历史等',
    systemPromptFile: 'prompts/generate_worldbuilding.md',
    reads: [],
    writes: ['worldbuilding.md'],
    outputTags: ['<<<WORLDBUILDING_START>>>', '<<<WORLDBUILDING_END>>>'],
    group: '基础设定',
  },
  {
    id: 'generate_characters',
    name: '角色设定生成',
    description: '根据世界观和用户描述生成角色设定',
    systemPromptFile: 'prompts/generate_characters.md',
    reads: ['worldbuilding.md'],
    writes: ['characters.md'],
    outputTags: ['<<<CHARACTERS_START>>>', '<<<CHARACTERS_END>>>'],
    group: '基础设定',
    dependsOn: ['worldbuilding.md'],
  },
  {
    id: 'generate_plot_synopsis',
    name: '剧情概要生成',
    description: '根据世界观和角色生成剧情概要',
    systemPromptFile: 'prompts/generate_plot_synopsis.md',
    reads: ['worldbuilding.md', 'characters.md'],
    writes: ['plot_synopsis.md'],
    outputTags: ['<<<PLOT_SYNOPSIS_START>>>', '<<<PLOT_SYNOPSIS_END>>>'],
    group: '基础设定',
    dependsOn: ['worldbuilding.md', 'characters.md'],
  },

  // ===== 大纲结构生成 =====
  {
    id: 'generate_act_map',
    name: '幕级地图生成',
    description: '从世界观和剧情概要生成幕级故事结构（幕划分、功能定位、情绪目标、核心冲突升级）',
    systemPromptFile: 'prompts/generate_act_map.md',
    reads: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md'],
    writes: ['act_map.md'],
    outputTags: ['<<<ACT_MAP_START>>>', '<<<ACT_MAP_END>>>'],
    group: '大纲结构',
    dependsOn: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md'],
  },
  {
    id: 'generate_sequence_list',
    name: '序列清单生成',
    description: '基于幕级地图生成序列级故事结构（序列划分、功能定位、必须完成事件、可选钩子）',
    systemPromptFile: 'prompts/generate_sequence_list.md',
    reads: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md', 'act_map.md'],
    writes: ['sequence_list.md'],
    outputTags: ['<<<SEQUENCE_LIST_START>>>', '<<<SEQUENCE_LIST_END>>>'],
    group: '大纲结构',
    dependsOn: ['act_map.md'],
  },

  // ===== 微观精铸生成 =====
  {
    id: 'generate_scene_beats',
    name: '场景节拍生成',
    description: '基于世界观、角色、剧情概要、幕结构和序列清单生成详细的场景-节拍整体大纲',
    systemPromptFile: 'prompts/generate_scene_beats.md',
    reads: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md', 'act_map.md', 'sequence_list.md'],
    writes: ['scene_beat_outline.md'],
    outputTags: ['<<<SCENE_BEAT_OUTLINE_START>>>', '<<<SCENE_BEAT_OUTLINE_END>>>'],
    group: '微观精铸',
    dependsOn: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md', 'act_map.md', 'sequence_list.md'],
  },

  // ===== 精炼/修改 Tool =====
  {
    id: 'refine_worldbuilding',
    name: '世界观精炼',
    description: '根据用户反馈精炼和完善已有世界观设定，不重新生成，在原有基础上修改',
    systemPromptFile: 'prompts/refine_worldbuilding.md',
    reads: ['worldbuilding.md'],
    writes: ['worldbuilding.md'],
    outputTags: ['<<<WORLDBUILDING_START>>>', '<<<WORLDBUILDING_END>>>'],
    group: '基础设定',
    dependsOn: ['worldbuilding.md'],
  },
  {
    id: 'refine_characters',
    name: '角色设定精炼',
    description: '根据用户反馈精炼和完善已有角色设定，在原有基础上修改',
    systemPromptFile: 'prompts/refine_characters.md',
    reads: ['characters.md', 'worldbuilding.md'],
    writes: ['characters.md'],
    outputTags: ['<<<CHARACTERS_START>>>', '<<<CHARACTERS_END>>>'],
    group: '基础设定',
    dependsOn: ['characters.md'],
  },
  {
    id: 'refine_plot_synopsis',
    name: '剧情概要精炼',
    description: '根据用户反馈精炼和完善已有剧情概要，在原有基础上修改',
    systemPromptFile: 'prompts/refine_plot_synopsis.md',
    reads: ['plot_synopsis.md', 'worldbuilding.md', 'characters.md'],
    writes: ['plot_synopsis.md'],
    outputTags: ['<<<PLOT_SYNOPSIS_START>>>', '<<<PLOT_SYNOPSIS_END>>>'],
    group: '基础设定',
    dependsOn: ['plot_synopsis.md'],
  },
  {
    id: 'refine_act_map',
    name: '幕结构精炼',
    description: '根据用户反馈精炼和完善已有幕级地图，调整幕划分、冲突升级等',
    systemPromptFile: 'prompts/refine_act_map.md',
    reads: ['act_map.md', 'worldbuilding.md', 'plot_synopsis.md'],
    writes: ['act_map.md'],
    outputTags: ['<<<ACT_MAP_START>>>', '<<<ACT_MAP_END>>>'],
    group: '大纲结构',
    dependsOn: ['act_map.md'],
  },
  {
    id: 'refine_sequence_list',
    name: '序列清单精炼',
    description: '根据用户反馈精炼和完善已有序列清单，调整序列划分和事件',
    systemPromptFile: 'prompts/refine_sequence_list.md',
    reads: ['sequence_list.md', 'act_map.md'],
    writes: ['sequence_list.md'],
    outputTags: ['<<<SEQUENCE_LIST_START>>>', '<<<SEQUENCE_LIST_END>>>'],
    group: '大纲结构',
    dependsOn: ['sequence_list.md'],
  },
  {
    id: 'refine_scene_beats',
    name: '场景节拍精炼',
    description: '根据用户反馈精炼和完善已有的场景节拍大纲，调整场景、节拍分布等',
    systemPromptFile: 'prompts/refine_scene_beats.md',
    reads: ['scene_beat_outline.md', 'act_map.md', 'sequence_list.md'],
    writes: ['scene_beat_outline.md'],
    outputTags: ['<<<SCENE_BEAT_OUTLINE_START>>>', '<<<SCENE_BEAT_OUTLINE_END>>>'],
    group: '微观精铸',
    dependsOn: ['scene_beat_outline.md'],
  },

  // ===== 系统 Tool =====
  {
    id: 'reset_all',
    name: '重置所有内容',
    description: '清空所有已生成的故事内容，从头开始。当用户要求"推翻重来"、"重新开始"、"换一个故事"时调用此工具',
    systemPromptFile: 'prompts/reset_all.md',
    reads: [],
    writes: [],
    outputTags: [],
    group: '系统',
  },
]
```

---

## 四、Function Calling 映射协议

将一个 `ToolSpec` 映射为 DeepSeek/OpenAI 兼容的 Function Calling 参数：

```typescript
function buildFunctionSpec(tool: ToolSpec): object {
  return {
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: `传递给 ${tool.name} 的具体修改指令。从用户原始需求中提取与此工具相关的部分，去掉无关内容。`
          }
        },
        required: ['instruction']
      }
    }
  }
}
```

**字段映射说明：**

| 字段 | 来源 | 说明 |
|------|------|------|
| `name` | `ToolSpec.id` | 必须与注册表中的 ID 完全匹配 |
| `description` | `ToolSpec.description` | LLM 据此决定是否调用，**必须写得足够详细** |
| `parameters.instruction` | Orchestrator 从用户输入裁剪 | 只传该 Tool 需要知道的部分指令 |

### Instruction 裁剪规则

Orchestrator 在将用户输入传递给 Tool 时，需要做指令裁剪：

```
用户输入: "帮我完善世界观设定，然后根据完善后的世界观生成幕结构"

Tool 1 (refine_worldbuilding) 收到的 instruction:
  "完善世界观设定"

Tool 2 (generate_act_map) 收到的 instruction:
  "根据完善后的世界观生成幕结构"
```

规则：
- 提取用户输入中与该 Tool 能力相关的部分
- 去掉与该 Tool 无关的指令
- 保持语义完整（不要截断成片段）

> **MVP 简化**：可以将完整用户输入作为 `instruction` 传给每个 Tool，让 Tool 自行忽略无关部分。

---

## 五、多轮 Tool 调用链

### 调用模式

```
Orchestrator LLM ←→ 用户
    │
    ├── (循环) ──────────────────────────────────────┐
    │                                                  │
    │  LLM 返回 tool_calls                              │
    │      │                                            │
    │      ├── Tool 1 (instruction_1)                   │
    │      │    ├── 上下文组装（仅 reads 文件）            │
    │      │    ├── Subagent LLM 调用                    │
    │      │    ├── TAG 校验 + 内容提取                  │
    │      │    └── 写入 writes 文件                     │
    │      │                                            │
    │      ├── Tool 2 (instruction_2)  ← 并行或顺序      │
    │      │    └── ...                                  │
    │      │                                            │
    │  Tool 结果返回 LLM                                  │
    │      │                                            │
    │  LLM 再次分析，可能继续调用更多 Tool                 │
    │      └── (回到循环头)                              │
    │                                                  │
    └── LLM 返回文本响应 → 展示给用户                    │
```

### 约束规则

1. **单次响应最多调用 3 个 Tool**（防止 Token 爆炸）
2. **Tool 调用有顺序依赖时**（一个 Tool 的输出是另一个的输入），Orchestrator LLM 应串行调用
3. **Tool 调用无依赖时**（如 refine_worldbuilding 和 refine_characters），可以使用 parallel 并行调度
4. **Orchestrator 最多进行 5 轮 Tool 调用**（防止无限循环）

---

## 六、Tool 执行流程

```
executeTool(toolSpec, instruction)
  │
  ├── ① 检查依赖 — dependsOn 文件是否都存在？
  │     └── 否 → 返回错误："依赖文件未生成，请先生成 XXX"
  │
  ├── ② 读取上下文 — toolSpec.reads 中的文件
  │     └── 组装为 XML 格式
  │
  ├── ③ 加载 System Prompt
  │     └── loadSystemPrompt(toolSpec.systemPromptFile)
  │
  ├── ④ 组装完整 Prompt
  │     └── context + instruction（XML 包裹）
  │
  ├── ⑤ 调用 LLM（最多 3 次重试）
  │     ├── 成功 → 继续
  │     └── 失败 → 返回错误
  │
  ├── ⑥ 校验输出（TAG 检查）
  │     ├── 通过 → 提取内容
  │     └── 失败 → 重试（追加格式提示）
  │
  └── ⑦ 写入文件
        └── toolSpec.writes 中的文件
```

---

## 七、Tool 可用性规则

Tool 是否可用（显示给 Orchestrator LLM）取决于：

1. **所有 `dependsOn` 文件存在** → Tool 可以调用
2. **`dependsOn` 为空或未设置** → Tool 始终可用
3. **`writes` 文件已存在** → Tool 仍然可用（视为"修改/重新生成"操作）
