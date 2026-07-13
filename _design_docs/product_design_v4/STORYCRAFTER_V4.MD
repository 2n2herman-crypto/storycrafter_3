# StoryCrafter 3 v4 — 产品概念总纲

> **副标题**：意图驱动的故事创作辅助工具

---

## 一、核心理念

StoryCrafter 是多 Agent 协作的**故事创作辅助工具**。用户通过与 AI 系统对话，逐步完成从世界观设定 → 宏观大纲 → 场景节拍精铸的完整创作流程。

**核心交互模型**：

```
用户输入 → Orchestrator LLM 分析意图 → 通过 Function Calling 选择并调用 Tools
         → Tools 执行具体创作任务 → Orchestrator 继续调用更多 Tools 或回复用户
```

用户自由表达创作意图，AI 系统智能调度工具完成工作——无需手动推进阶段，无需点击确认按钮。

---

## 二、架构总览

```
┌─────────────────────────────────────────────────┐
│                    用户                           │
│   "帮我完善世界观，然后生成幕结构"                  │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              Orchestrator LLM                    │
│    （故事总监 + 工具决策者）                       │
│                                                   │
│  工具清单：                                       │
│  ├─ refine_worldbuilding     → 精炼世界观         │
│  ├─ refine_characters        → 精炼角色           │
│  ├─ generate_act_map         → 生成幕结构         │
│  ├─ generate_scene_beats     → 生成场景节拍       │
│  └─ ...                                          │
│                                                   │
│  决策过程：                                       │
│  Step 1: 用户要求"完善世界观"                     │
│        → 调用 refine_worldbuilding(instruction)   │
│  Step 2: 用户要求"生成幕结构"                     │
│        → 调用 generate_act_map(instruction)       │
│  Step 3: 向用户汇报完成情况                        │
└──────────────────┬──────────────────────────────┘
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
┌─────────────────┐  ┌─────────────────┐
│  Tool A          │  │  Tool B          │
│ （Subagent 封装） │  │ （Subagent 封装） │
│  上下文：reads 文件│  │  上下文：reads 文件│
│  输出：writes 文件│  │  输出：writes 文件│
└─────────────────┘  └─────────────────┘
```

---

## 三、技术选型

| 维度 | 选型 |
|------|------|
| **调度模式** | Function Calling 驱动的 Tool 调度 |
| **Agent 封装** | Subagent → Tool（通过 ToolSpec 声明式注册） |
| **上下文管理** | 按 ToolSpec.reads 文件级隔离 + 可选内容级剪裁 |
| **校验机制** | `<<<TAG>>>` 协议 + 最多 3 次自动重试 |
| **前端交互** | 纯对话（Chat Only），所有功能通过聊天驱动 |
| **LLM** | DeepSeek API（`deepseek-v4-flash`），支持 Function Calling |

---

## 四、系统范围

### 包含
- Tool 注册表 + Function Calling 调度的 Orchestrator
- 上下文隔离与剪裁机制
- 纯对话交互的前端
- 基于 TAG 协议的 Subagent 输出校验
- 文件状态管理（pending / generated / modified）

### 不包含（未来版本）
- Electron 桌面壳 + 文件系统持久化
- .docx / .xlsx 格式导入
- 多用户协作
- 故事结构模板市场

---

## 五、设计原则

1. **Orchestrator 绝不自己编故事内容** — 只做调度和决策，具体创作由 Tools 执行
2. **Tool 输出必须是纯 MD 表格 + `<<<TAG>>>` 包裹** — 不用 JSON/YAML，不输出前言
3. **Tool 上下文隔离** — 每个 Tool 只能看到其 `reads` 声明的文件
4. **指令剪裁** — Orchestrator 将用户复杂需求拆解为每个 Tool 的具体指令
5. **Processing 状态下不排队** — 新消息直接丢弃，用户等完成后重发
6. **所有 Tool 信息从 ToolRegistry 声明式读取** — 加新 Tool 不改调度引擎
7. **全中文交互** — 用户界面和回复全部中文
8. **上游修改提示级联** — 上游文件（如世界观）被修改后，Orchestrator 自动提示用户下游文件可能需要同步更新。系统不自动重写下游，但让用户知情并自主决策
