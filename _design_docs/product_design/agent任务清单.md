# 各 Agent 的任务和权限边界 (Tasks & Permission Boundaries)

通过 **AgentRegistry 声明式注册表** + Orchestrator 代码层的通用调度引擎，严格限制各 Agent 的”读写权限”。  
**核心原则**：每个 Agent 的读写边界由 `agentRegistry.ts` 中的 `AgentSpec` 统一声明，调度引擎自动遵守，无需硬编码 if/else。

---

## 0. AgentRegistry 声明式权限管理

所有 Agent 的权限在 `src/orchestrator/agentRegistry.ts` 中统一声明：

```typescript
interface AgentSpec {
  id: string                     // 唯一标识
  name: string                   // 人类可读名称
  description: string            // 一句话描述能力
  reads: string[]                // 读权限：可读取哪些 MD 文件
  writes: string[]               // 写权限：可写入哪些 MD 文件
  outputTags: string[]           // 输出校验 TAG 列表
  systemPromptFile: string       // System Prompt 文件路径
  phase: number                  // 归属阶段
  group: string                  // 前端分组标签
}
```

**调度引擎的通用循环**（`agentDispatcher.ts`）在运行时：
1. 从 `AgentRegistry` 查出当前阶段需执行的 Agent 列表
2. 读取 `AgentSpec.reads` → 只注入这些文件到上下文
3. **只提取**输出中 `AgentSpec.outputTags` 对应的表格内容
4. 写入 `AgentSpec.writes` 指定的文件

**权限强制执行流程**：

```
AgentRegistry 声明 → 调度引擎读取 → 上下文组装只注入 reads 中的文件
                                    → 输出校验只提取 writes 对应的 TAG 内容
                                    → 写入 writes 指定的文件
```

---

## 1. Main Agent-Orchestrator (主调度Agent)

*   **核心任务**：对话管理、意图提纯、通用调度引擎运行、状态机流转控制、MD文件读写管理。
*   **读权限 (Read)**：用户的自然语言输入、所有 MD 资产文件（通过 fileManager）。
*   **写权限 (Write)**：
    *   Phase 1 直接写入：`worldbuilding.md`, `characters.md`, `plot_synopsis.md`
    *   Phase 2+ 间接写入：通过提取 Subagent 输出覆盖 `AgentSpec.writes` 中的文件
*   **边界局限**：
    *   **绝对禁止**直接生成或修改任何故事大纲、场景、节拍的具体内容。
    *   **禁止**将原始用户对话直接透传给 Subagent（必须先提纯）。
    *   **禁止**自行理解 MD 表格内部业务逻辑（只做读写、校验、拼接）。

## 2. Sub-Agent A (Story Framework Mixer)

*   **核心任务**：基于基础设定，生成并迭代宏观故事骨架。
*   **权限来源**：`agentRegistry.ts` 中 `subagent_a` 的声明。
*   **读权限 (Read-Only)**：由 `AgentSpec.reads` 定义 → `['worldbuilding.md', 'characters.md', 'plot_synopsis.md', 'story_structure.md']`
*   **写权限 (Write-Only)**：由 `AgentSpec.writes` 定义 → `['act_map.md', 'sequence_list.md']`
*   **边界局限**：
    *   只能输出 `AgentSpec.outputTags` 对应的两个 MD 表格。
    *   严禁修改、重写或输出任何关于世界观、角色设定或剧情梗概的内容。
    *   Orchestrator 代码层只提取其输出中 `outputTags` 对应的表格，丢弃其他文本。

## 3. Sub-Agent B (Beat Smith)

*   **核心任务**：基于宏观骨架和基础设定，生成并迭代微观场景与节拍。
*   **权限来源**：`agentRegistry.ts` 中 `subagent_b` 的声明。
*   **读权限 (Read-Only)**：由 `AgentSpec.reads` 定义 → `['worldbuilding.md', 'characters.md', 'plot_synopsis.md', 'act_map.md', 'sequence_list.md']`
*   **写权限 (Write-Only)**：由 `AgentSpec.writes` 定义 → `['scene_beat_outline.md']`
*   **边界局限**：
    *   只能输出 `AgentSpec.outputTags` 对应的场景-节拍 MD 宽表。
    *   **绝对禁止**修改上游的幕结构、序列结构或任何基础设定。
    *   Orchestrator 代码层只提取 `outputTags` 对应的表格内容，确保上游文件不被篡改。

---

## 4. Frontend (Electron/Web 前端应用)

*   **核心任务**：提供三栏式 Diff 查看器、对话面板、文件导入功能。
*   **卡片数据来源**：从 `AgentRegistry` 读取所有 Agent 的 `writes` 文件列表 + `group` 分组信息，动态生成右侧栏卡片，**不硬编码文件列表**。
*   **读权限 (Read-Only)**：全部 MD 资产文件及对应的 `*.approved.md` 快照文件。
*   **写权限 (Write-Only)**：`*.approved.md` 快照文件；原生 MD 文件仅接受用户显式”导入到资产卡片”操作。
*   **边界局限**：
    *   **绝对禁止**自行生成或修改任何故事内容。
    *   三栏布局中，左侧栏仅读取基线快照，中间栏仅显示最新内容 + diff 高亮，不提供直接编辑功能。
    *   文件导入仅做格式解析（.docx / .xlsx / .md），内容必须经用户确认后才能写入资产卡片。

---

## 5. 扩展指南：如何加一个新 Agent

只需以下操作：

```
1. 写 System Prompt 文件 → src/llm/prompts/newAgent.md
2. 在 agentRegistry.ts 加一条 AgentSpec 记录
3. 在 workflows.ts 的对应阶段加入 Agent ID
```

调度引擎自动适配，无需修改：
- `agentDispatcher.ts` — 通用循环
- `contextAssembler.ts` — 从 reads 自动组装
- `outputValidator.ts` — 从 outputTags 自动校验
- `assetStore.ts` — 从 Registry 动态读取
- `AssetCardPanel.tsx` — 从 Registry 动态分组