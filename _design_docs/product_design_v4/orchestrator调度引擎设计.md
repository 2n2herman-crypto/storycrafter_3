# Orchestrator 调度引擎设计（v4）

> **角色**：故事总监与工具决策者（Story Director & Tool Orchestrator）

---

## 一、Orchestrator 角色定义

- **工具决策者**：分析用户意图，通过 Function Calling 决定调用哪个 Tool
- **指令拆解者**：将用户复杂需求拆分为每个 Tool 的具体指令
- **多步调度者**：对于多步骤需求，编排 Tool 调用序列
- **质量把关者**：校验 Tool 输出是否符合 TAG 协议

---

## 二、System Prompt（v4 版）

以下是 Orchestrator 的 System Prompt，定义其行为边界：

```
# 角色

你是故事创作系统的「总监理与工具决策者」（Story Director & Tool Orchestrator）。

## 核心职责

1. 分析用户的故事创作需求
2. 从可用工具列表中选择合适的 Tool 来处理用户请求
3. 对于多步骤需求，按正确顺序调用多个 Tool
4. 将 Tool 的执行结果汇总为用户友好的回复

## 绝对禁令

1. 绝不能直接生成任何故事内容（世界观、角色、剧情、场景节拍等）
2. 绝不能绕过 Tool 直接修改资产文件
3. 绝不能编造不存在的 Tool
4. 绝不能对用户撒谎——Tool 执行失败时必须如实报告

## 工具调度规则

1. 分析用户输入 → 判断需要调用哪些 Tool
2. 对于有依赖关系的 Tool（一个 Tool 的输出是另一个的输入），先调用依赖方
3. 对于无依赖关系的 Tool，可以同时调用（并行）
4. 每次最多调用 3 个 Tool
5. 最多连续进行 5 轮 Tool 调用
6. Tool 执行完成后，将结果汇总为用户易懂的回复

## 指令裁剪规则

将用户需求拆解后传递给每个 Tool：
- 复杂需求（"完善世界观然后生成幕结构"）→ 拆成两步，各自传递相关指令
- 简单需求（"把主角名字改成张三"）→ 直接传递
```

---

## 三、System Prompt 中的工具列表注入

Orchestrator 的 System Prompt 中包含 `{available_tools_json}` 占位符（见上方提示词中的"可用工具清单"部分）。调度引擎在初始化消息列表时，通过字符串替换注入：

```typescript
// 运行时注入
const availableTools = buildFunctionSpecs(existingFiles, TOOL_REGISTRY)
const systemPrompt = ORCHESTRATOR_V4_PROMPT.replace(
  '{available_tools_json}',
  JSON.stringify(availableTools, null, 2)
)
```

**注入时机**：每次调用 `processUserInput()` 时重新注入。因为 `existingFiles` 会随 Tool 执行而变化（新文件生成后，更多 Tool 变为可用），所以**每轮调度循环**开始时都需要重新计算可用工具并注入。

**在设计文档/prompts 目录中的 `orchestrator_v4.md` 文件中**，`{available_tools_json}` 占位符位于提示词末尾，标记 Tool 列表插入位置。实际实现时，Tool 列表由 `buildFunctionSpec` 动态生成，不会在 prompt 文件中硬编码。

---

## 四、调度循环

### 完整流程

```
processUserInput(userInput)
  │
  ├── ① 初始化消息列表
  │     system_prompt = ORCHESTRATOR_V4_PROMPT
  │     messages = [system, userInput]
  │
  ├── ② 计算可用工具
  │     availableTools = buildAvailableTools(existingFiles, TOOL_REGISTRY)
  │     toolSpecs = availableTools.map(buildFunctionSpec)
  │
  ├── ③ 进入调度循环（最多 5 轮）
  │     │
  │     ├── 调用 LLM (messages, tools=toolSpecs, tool_choice='auto')
  │     │
  │     ├── 检查 finish_reason
  │     │     │
  │     │     ├── 'tool_calls' →
  │     │     │   for each tool_call:
  │     │     │     解析参数 → 查找 ToolSpec
  │     │     │     执行 Tool → 写入文件
  │     │     │     返回结果到 LLM
  │     │     │   继续循环（回到 ③）
  │     │     │
  │     │     └── 'stop' →
  │     │       返回 LLM 的文本响应 → 展示给用户
  │     │
  │     └── 超过 5 轮 → 强制结束，返回超时消息
  │
  └── ④ 刷新前端 UI
        assetStore.refreshAllFiles()
```

### 可用工具计算

```typescript
function buildAvailableTools(existingFiles: Set<string>): ToolSpec[] {
  return TOOL_REGISTRY.filter(tool => {
    if (!tool.dependsOn || tool.dependsOn.length === 0) return true
    return tool.dependsOn.every(f => existingFiles.has(f))
  })
}
```

### Tool 执行函数

```typescript
async function executeTool(tool: ToolSpec, instruction: string): Promise<ToolResult> {
  // ① 读取上下文
  const files: Record<string, string> = {}
  for (const path of tool.reads) {
    files[path] = await fileManager.readFile(path)
  }

  // ② 组装上下文
  const context = assembleContext(tool, files)

  // ③ 加载 System Prompt
  const systemPrompt = loadSystemPrompt(tool.systemPromptFile)

  // ④ 组装完整 Prompt
  const userContent = buildAgentPrompt(tool, context, instruction)

  // ⑤ 调用 LLM + 校验（最多 3 次重试）
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const output = await llm.sendMessage(systemPrompt, userContent)
    const validation = validateOutput(output, tool)

    if (validation.valid) {
      for (const [file, content] of Object.entries(validation.extracted)) {
        await fileManager.writeFile(file, content)
      }
      return { success: true, writes: Object.keys(validation.extracted) }
    }
  }

  return { success: false, error: '输出校验失败' }
}
```

---

## 五、调度循环的执行顺序

### 5.1 Tool 执行顺序

当 LLM 在一次响应中返回多个 `tool_calls` 时，调度引擎**按顺序串行执行**：

```typescript
// 单次 LLM 响应中返回的多个 tool_calls
const tool_calls = [
  { id: 'call_1', function: { name: 'refine_worldbuilding', arguments: '...' } },
  { id: 'call_2', function: { name: 'generate_act_map', arguments: '...' } },
]

// 引擎按数组顺序串行执行
for (const tool_call of tool_calls) {
  const result = await executeTool(toolSpec, instruction)
  // 写入结果后，下一个 Tool 才能读取到最新的文件
}
```

**为什么串行？** 因为 Tool 之间存在隐式依赖——即使两个 Tool 没有显式 `dependsOn` 关系（如 `refine_worldbuilding` 和 `generate_act_map`），后者可能需要读取前者刚刚写入的最新内容。串行执行能保证每个 Tool 看到的上下文是最新的。

**并行场景**：真正的并行发生在**不同调度轮次**之间无法并行的，因为每轮都依赖上一轮 LLM 的决策结果。

### 5.2 多轮调度循环的上下文管理

这是 v4 的核心设计要点。每轮 Tool 调用后，LLM 的对话历史会增长，需要管理 token 窗口：

```
Round 1:
  messages = [system, userInput]
  → LLM 返回 tool_calls([refine_worldbuilding])
  → 执行 Tool → 得到 result_1
  → messages.push(tool_call_1, tool_result_1)

Round 2:
  messages = [system, userInput, tool_call_1, tool_result_1]
  → LLM 返回 tool_calls([generate_act_map])
  → 执行 Tool → 得到 result_2
  → messages.push(tool_call_2, tool_result_2)

... 以此类推，每轮追加 2 条消息
```

**最大消息增长量**：
- 5 轮 × 最多 3 个 Tool × (1 条 call + 1 条 result) = 30 条工具相关消息
- 加上 system prompt + user input = ~32 条消息上限

**token 管理策略**：

```
每轮开始前：
  if (messages 总 tokens > CONTEXT_LIMIT) {
    对最旧的 tool_call / tool_result 对做摘要压缩
    或丢弃最早的非关键消息
  }

CONTEXT_LIMIT 建议值：
  模型上下文窗口的 70%（保留余量给 Tool 的响应输出）
  例如 deepseek-v4-flash 为 32K → CONTEXT_LIMIT ≈ 22K
```

**摘要压缩策略**（当 token 接近限制时启用）：
1. 保留 system prompt（始终完整）
2. 保留最新 2 轮 tool_call / tool_result 对（完整保留）
3. 对更早的工具调用记录做摘要：`"此前已完善世界观、生成角色"`

---

## 七、错误处理策略

| 错误场景 | 处理方式 | 用户看到的消息 |
|----------|----------|---------------|
| Tool 执行重试 3 次失败 | 跳过此 Tool，继续其他 Tool | "XXX 生成失败，已跳过" |
| 所有 Tool 都失败 | 返回错误消息 | "处理失败，请简化需求后重试" |
| LLM Function Calling 超时 | 返回超时消息 | "系统响应超时，请重试" |
| 依赖文件不满足 | Tool 不注册到工具列表 | (LLM 不会看到此 Tool) |
| 用户输入无法匹配任何 Tool | LLM 直接回复用户 | "我需要更具体的创作需求..." |
| 超过 5 轮 Tool 调用 | 强制结束循环 | "需求过于复杂，请分批提交" |
| `finish_reason = 'length'` | 返回截断警告 + 已有结果 | "响应过长被截断，已执行的部分已完成" |
| `finish_reason = 'content_filter'` | 返回内容过滤提示 | "内容被过滤，请调整表达方式" |
| API 返回空响应或异常 | 单次重试（最多 2 次） | "系统响应异常，请重试" |

### finish_reason 处理逻辑

```typescript
switch (finish_reason) {
  case 'tool_calls':
    // 正常：解析参数，串行执行 Tool，继续循环
    break
  case 'stop':
    // 正常：返回 LLM 的文本回复给用户，结束循环
    break
  case 'length':
    // 截断：返回已有内容 + 警告（"内容过长被截断，请分批处理"）
    if (round === 0) return '请简化需求后重试'
    return accumulatedResponse + '（响应过长，已截断）'
  case 'content_filter':
    // 过滤：提示用户调整表达
    return '内容被安全过滤，请调整表达方式后重试'
  default:
    // 未知：记录日志，返回通用错误
    return '系统处理异常，请重试'
}
```

---

## 八、Reset Tool

当用户要求"推翻重来"、"重新开始"、"换一个故事"时，Orchestrator 调用 `reset_all` Tool：

```typescript
{
  id: 'reset_all',
  name: '重置所有内容',
  description: '清空所有已生成的故事内容，从头开始。当用户要求"推翻重来"、"重新开始"、"换一个故事"时调用此工具',
  systemPromptFile: 'prompts/reset_all.md',
  reads: [],
  writes: [],
  outputTags: [],
  group: '系统',
}
```

### 执行机制

`reset_all` 通过**特殊约定**工作，而非特殊 case 代码：

1. `reset_all` 的 `writes: []` 且 `outputTags: []` —— 调度引擎检测到两者都为空时，视为"清空操作"
2. 调度引擎**不调用 Subagent LLM**（因为没有 systemPromptFile 需要执行生成），直接执行 `fileManager.clearAll()`
3. 返回 `ToolResult { success: true, writes: [] }`
4. `reset_all` 的 prompt 文件仅用于向 AI 说明此工具的用途和行为，不包含实际的 LLM 调用

**判断逻辑**：

```typescript
if (tool.writes.length === 0 && tool.outputTags.length === 0) {
  // 清空操作：不调 LLM，直接清除
  await fileManager.clearAll()
  return { success: true, writes: [] }
} else {
  // 正常生成/精炼操作：调 LLM → 校验 → 写入
  return executeNormalTool(tool, instruction)
}
```

这个规则对调度引擎来说不是"特殊 case"，而是一个通用的协议约定：**`writes: []` + `outputTags: []` = 清空操作**。任何将来注册的 Tool，只要满足此条件，也按清空操作处理。

---

## 九、调度引擎状态管理

调度引擎需要管理**调用轮次**和**工具计数**以防止失控：

```typescript
interface SchedulerState {
  currentRound: number      // 当前是第几轮 Tool 调用
  maxRounds: 5              // 最大轮次
  toolsCalled: string[]     // 已调用的 Tool ID 列表
  toolResults: ToolResult[] // 已执行的 Tool 结果
}
```

- `currentRound` 在循环中递增
- 达到 `maxRounds` 强制退出
- `toolsCalled` 用于检测循环依赖（一个 Tool 反复被调用）
