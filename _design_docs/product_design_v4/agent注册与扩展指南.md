# Agent 注册与扩展指南（v4）

> **核心原则**：新增一个 Tool = 在 ToolRegistry 中加一条记录，不改任何调度代码

---

## 一、ToolRegistry API

`ToolRegistry` 是所有 Tool 的单一来源，提供以下 API：

```typescript
// ===== ToolRegistry API =====

/** 获取所有注册的 Tool */
getAllTools(): ToolSpec[]

/** 根据 ID 查找单个 Tool */
getTool(id: string): ToolSpec | undefined

/** 根据已有文件列表计算可用 Tool */
getAvailableTools(existingFiles: Set<string>): ToolSpec[]

/** 获取指定 group 的所有 Tool */
getToolsByGroup(group: string): ToolSpec[]

/** 获取所有 group 标签 */
getAllGroups(): string[]

/** 注册一个新 Tool（动态注册） */
registerTool(tool: ToolSpec): void

/** 批量注册 Tool */
registerTools(tools: ToolSpec[]): void
```

### 实现方式

`ToolRegistry` 是 `TOOL_REGISTRY` 数组的封装：

```typescript
class ToolRegistry {
  private tools: ToolSpec[]

  constructor(tools: ToolSpec[]) {
    this.tools = tools
  }

  getAll(): ToolSpec[] {
    return this.tools
  }

  get(id: string): ToolSpec | undefined {
    return this.tools.find(t => t.id === id)
  }

  getAvailable(existingFiles: Set<string>): ToolSpec[] {
    return this.tools.filter(tool => {
      if (!tool.dependsOn || tool.dependsOn.length === 0) return true
      return tool.dependsOn.every(f => existingFiles.has(f))
    })
  }

  register(tool: ToolSpec): void {
    if (this.tools.find(t => t.id === tool.id)) {
      throw new Error(`Tool ${tool.id} 已存在`)
    }
    this.tools.push(tool)
  }
}
```

---

## 二、ToolSpec 完整字段说明

```typescript
interface ToolSpec {
  /**
   * 【必填】唯一标识符
   * 命名规则：{动词}_{名词}，全小写+下划线
   * 如：generate_worldbuilding, refine_characters, reset_all
   * 将作为 Function Calling 的 function.name
   */
  id: string

  /**
   * 【必填】人类可读名称
   * 用于前端资产卡片分组展示
   * 如：世界观生成、幕级地图生成
   */
  name: string

  /**
   * 【必填】Tool 描述
   * ⚠️ 最关键字段！直接作为 function.description 传给 LLM
   * LLM 据此决定是否调用此 Tool
   * 必须包含：
   *   - 此 Tool 能做什么（功能范围）
   *   - 什么情况下应该调用此 Tool（适用场景）
   *   - 什么情况下不应该调用此 Tool（边界）
   * 如："根据世界观和剧情概要生成幕级故事结构，包括幕划分、功能定位、情绪目标、核心冲突升级。
   *     当用户要求'生成幕结构'、'划分幕'、'设计故事框架'时调用此工具。"
   */
  description: string

  /**
   * 【必填】System Prompt 文件路径
   * 指向 src/llm/prompts/ 下的 .md 文件
   * 多个 Tool 可以共享同一个 System Prompt
   */
  systemPromptFile: string

  /**
   * 【必填】上下文隔离边界（读取的文件列表）
   * 执行此 Tool 时，只读取这些文件注入上下文
   * 不在列表中的文件对 Tool 不可见
   * 为空数组表示不需要读取任何文件
   */
  reads: string[]

  /**
   * 【必填】产出文件列表
   * Tool 执行后写入的文件
   * 如果 Tool 要修改已有文件，也要列在这里
   */
  writes: string[]

  /**
   * 【必填】输出校验 TAG 列表
   * 格式：['<<<TAGNAME_START>>>', '<<<TAGNAME_END>>>']
   * 必须与 System Prompt 中要求 LLM 输出的 TAG 一致
   */
  outputTags: string[]

  /**
   * 【必填】前端分组标签
   * 用于 AssetCardPanel 按组展示
   * 可选值：基础设定、大纲结构、微观精铸、系统
   */
  group: string

  /**
   * 【可选】依赖文件列表
   * 只有这些文件都存在时，Tool 才可用
   * 用于隐式表达创作顺序
   * 没有依赖或始终可用的 Tool 不设置此字段
   */
  dependsOn?: string[]
}
```

---

## 三、新增一个 Tool 的标准流程

### 3 步完成

以新增一个"时间线生成"Tool 为例：

### Step 1：编写 System Prompt

在 `src/llm/prompts/` 下创建 `generate_timeline.md`：

```markdown
# 角色
你是故事时间线生成专家。

# 任务
根据世界观、角色和剧情概要生成故事时间线。

# 输出格式
<<<TIMELINE_START>>>
## 故事时间线
| 时间点 | 事件 | 涉及角色 | 重要性 |
<<<TIMELINE_END>>>

# 规则
- 只输出 <<<TAG>>> 包裹的内容
- 不写任何前言或说明
- 时间线必须与世界观一致
```

### Step 2：注册 Tool

在 ToolRegistry 中注册：

```typescript
{
  id: 'generate_timeline',
  name: '时间线生成',
  description: '根据世界观、角色和剧情概要生成故事时间线。' +
    '当用户要求"生成时间线"、"创建时间轴"、"整理事件顺序"时调用此工具。',
  systemPromptFile: 'prompts/generate_timeline.md',
  reads: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md'],
  writes: ['timeline.md'],
  outputTags: [
    '<<<TIMELINE_START>>>',
    '<<<TIMELINE_END>>>'
  ],
  group: '大纲结构',
  dependsOn: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md'],
}
```

### Step 3：完成

**不需要修改任何其他代码。**
- 调度引擎自动将新 Tool 注册到 Function Calling 列表中
- LLM 自动在新响应中看到此 Tool
- 前端自动在对应 group 下展示新的资产卡片

---

## 四、最佳实践

### 4.1 Tool 粒度原则

```
过粗（不好）：
  generate_all_story        → 生成所有内容
  问题：LLM 难以判断何时调用，一次调用消耗大量 Token

过细（也不好）：
  update_protagonist_name   → 修改主角名字
  问题：Tool 太多，LLM 选择困难

适中（推荐）：
  refine_worldbuilding      → 精炼世界观（处理所有世界观相关修改）
  generate_act_map          → 生成幕结构（一次性生成完整幕级地图）
  粒度：一个 Tool = 一个文件或一组紧密关联的文件
```

### 4.2 Description 编写规则

`description` 是影响 LLM 调用准确性的最关键因素：

```
❌ 坏的描述：
  "生成幕结构"
  （太短，LLM 不清楚何时调用）

✅ 好的描述：
  "根据世界观和剧情概要生成幕级故事结构，包括幕划分、功能定位、情绪目标、核心冲突升级。
  当用户要求'生成幕结构'、'划分幕'、'设计故事框架'、'构建大纲'时调用此工具。
  如果用户只要求修改角色设定或场景细节，不要调用此工具。"
```

### 4.3 Tool ID 命名规范

```
规则：{动词}_{名词}
动词：generate（生成新文件）、refine（修改已有文件）、reset（重置）
名词：worldbuilding、characters、act_map、sequence_list、scene_beats

示例：
- generate_worldbuilding
- refine_characters
- generate_act_map
- reset_all
```

### 4.4 依赖管理

```
Tool A（generate_worldbuilding）
  → 无依赖
  → 任何时候都可调用

Tool B（generate_characters）
  → dependsOn: ['worldbuilding.md']
  → 需要 worldbuilding 生成后才可调用

Tool C（generate_act_map）
  → dependsOn: ['worldbuilding.md', 'characters.md', 'plot_synopsis.md']
  → 需要世界观、角色、剧情都生成后才可调用

原理：ToolRegistry 的 getAvailable() 自动过滤出可用 Tool
```

---

## 五、MVP Tool 清单速查

| Tool ID | 类型 | Group | 依赖 |
|---------|------|-------|------|
| `generate_worldbuilding` | 生成 | 基础设定 | 无 |
| `generate_characters` | 生成 | 基础设定 | worldbuilding.md |
| `generate_plot_synopsis` | 生成 | 基础设定 | worldbuilding.md, characters.md |
| `generate_act_map` | 生成 | 大纲结构 | 三个基础文件 |
| `generate_sequence_list` | 生成 | 大纲结构 | act_map.md |
| `generate_scene_beats` | 生成 | 微观精铸 | 五个上游文件 |
| `refine_worldbuilding` | 精炼 | 基础设定 | worldbuilding.md |
| `refine_characters` | 精炼 | 基础设定 | characters.md |
| `refine_act_map` | 精炼 | 大纲结构 | act_map.md |
| `refine_scene_beats` | 精炼 | 微观精铸 | scene_beat_outline.md |
| `reset_all` | 系统 | 系统 | 无 |
