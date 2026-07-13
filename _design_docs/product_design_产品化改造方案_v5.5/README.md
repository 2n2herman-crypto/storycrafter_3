# StoryCrafter 3 v5.5 — 跨轮需求记忆改造

> 版本：v5.5
> 目标：让「多轮对话中逐渐明晰」的需求能够被稳定捕捉、累积并落入 `user_requirements.md`，解决当前主对话「完全无记忆」导致的跨轮能力丢失问题。
> 前置：v5.3 四层框架（Orchestrator → Subagent → Skill Router → Skill）。

---

## 一、改造背景

当前主对话链路（[chatStore.sendMessage](../src/store/chatStore.ts) → [OrchestratorEngine.processUserInput](../src/orchestrator/orchestratorEngine.ts)）存在两处记忆断点：

1. **单次调用内无历史**：`processUserInput` 每轮都新建 `messages` 数组，只塞入本次 `userInput`，函数结束即丢弃。
2. **跨轮无历史回传**：`chatStore` 虽存有完整对话 `messages`，但仅用于 UI 渲染，从不回传给引擎。

结果：Orchestrator 每轮只看到一句孤立输入，看不到上文。唯一的跨轮状态是 FileManager 里的资产文件（经 Skill 的 `reads` 注入），**而非对话记忆**。

这与需求的两类来源直接冲突：

| 需求类型 | 形态 | 当前是否被捕捉 |
|---------|------|--------------|
| **单轮判断得出** | 用户一句话里明确说清的需求 | ✅ 可被 analyzer 提取 |
| **多轮逐渐明晰** | 跨多条 message 才成型的需求；含指代性澄清（"那个再坚强点"、"对，就那样"） | ❌ 脱离上文无法理解，能力丢失 |

---

## 二、根因结论

`user_requirements.md` 本应是**跨轮记忆的载体**（持久化、被所有创作工具 `reads`），但两个断点使其无法承载「逐渐明晰」类需求：

1. **需求合并不保证每轮发生**：analyzer 作为 Subagent 只在 Orchestrator 主动选它时才做内容合并；引擎里的后处理调用（[orchestratorEngine.ts:273-286](../src/orchestrator/orchestratorEngine.ts)）**只更新状态标记 ✅/⬜，不合并新需求内容**。用户某轮补充的需求，若 Orchestrator 未点 analyzer，就不会写入文档。
2. **analyzer 看不到对话流**：即使被调用，它拿到的只有「本次孤立指令 + 已有需求文档」。指代性澄清无法解析。

---

## 三、v5.5 设计原则

**把 `user_requirements.md` 当作"编译后的记忆"**：不把原始对话历史灌进每个 LLM 调用（贵且不稳），而是**每轮把对话蒸馏进结构化需求文档**，让文档成为持续累积的唯一记忆源。

同时，为解析指代性澄清，给关键环节喂一个**最近 N 条对话窗口**（而非全量历史）。本次两条机制都做：

- **机制 A**：analyzer 每轮确定性执行一次「合并模式」，不依赖 Orchestrator 选择。
- **机制 B**：把对话窗口同时喂给 analyzer 与 Orchestrator，使二者都能理解上文指代。

---

## 四、文档索引

| 文档 | 内容 |
|------|------|
| `01_问题分析.md` | 两类需求来源、当前记忆断点的代码级定位 |
| `02_设计方案.md` | 机制 A / B 的详细设计、数据流、角色映射、token 预算 |
| `03_开发步骤.md` | 分步实施清单、改动文件、验证方式 |

---

## 五、改动范围概览

- 修改：[chatStore.ts](../src/store/chatStore.ts)（回传对话窗口）
- 修改：[orchestratorEngine.ts](../src/orchestrator/orchestratorEngine.ts)（前置合并 + 历史注入）
- 修改：[contextAssembler.ts](../src/orchestrator/contextAssembler.ts)（对话窗口渲染辅助）
- 修改：[user_requirements_analyzer/.../SKILL.md](../src/skills/user_requirements_analyzer/user_requirements_analyzer/SKILL.md)（合并模式结合对话上下文）
- 修改：[orchestrator_v5.md](../src/llm/prompts/orchestrator_v5.md)（说明对话历史可用）
- 不修改：下游创作 Skill、前端 UI、outputValidator、fileManager（下游因已 `reads` 需求文档自动受益）
