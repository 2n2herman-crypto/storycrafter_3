# StoryCrafter 3 — 产品概念总纲

> **一句话定义**：一个基于多 Agent 协作的**故事创作辅助工具**，用户通过与 AI 系统对话，逐步完成从世界观设定 → 宏观大纲 → 场景节拍精铸的完整创作流程。

---

## 产品愿景

让创作者将精力集中在「讲什么故事」上，而非「如何编排文档结构」。通过多 Agent 协作，自动将口语化的创作灵感转化为结构化的叙事蓝图。

### 核心理念

| 原则 | 含义 |
|------|------|
| **AI 辅助，人做决策** | AI 生成大纲和结构建议，用户始终掌握确认权 |
| **渐进式细化** | 从世界观 → 宏观大纲 → 微观节拍，逐层聚焦 |
| **永远不丢基线** | 每次确认自动生成快照，随时对比修改前后差异 |
| **Agent 即插件** | 每个创作环节对应一个 Agent，可插拔、可替换 |

---

## MVP 范围（Phase 1a — Web 模式）

- **4 阶段状态机**：STATE_1_CONCEPT → STATE_2_MACRO → STATE_3_MICRO → STATE_COMPLETED
- **6 个核心资产文件**：worldbuilding.md / characters.md / plot_synopsis.md / act_map.md / sequence_list.md / scene_beat_outline.md
- **2 个 Subagent**：框架编排师（幕-序列）、场景精铸师（场景-节拍）
- **纯前端运行**：Vite + React + TypeScript + DeepSeek API（浏览器直接调用）
- **InMemoryFileManager**：内存 Map 存储，验证核心逻辑后迁移 Electron

---

## 架构哲学

```
用户灵感（口语化）
    │
    ▼ ── 意图提纯 ──▶ 结构化指令
    │
    ▼ ── 调度引擎 ──▶ AgentRegistry（声明式）
    │                    ├─ Subagent A：幕-序列
    │                    └─ Subagent B：场景-节拍
    │
    ▼ ── 输出校验 ──▶ MD 资产文件 + *.approved.md 快照
    │
    ▼ ── Diff 展示 ──▶ 三栏布局：基线 / 当前 / 卡片
```

---

## 扩展方向（Phase 1b+）

- **Electron 壳**：本地文件系统、Word/Excel 导入、chokidar 监听
- **更多 Agent**：世界观开发、角色设计、支线设计、伏笔管理、审阅验收
- **DAG 编排**：Agent 之间支持并行执行与依赖关系

---

> *详细设计请参阅 `开发规划.md`（实施路线）、`技术开发文档.md`（架构细节）、`design-doc.md`（前端设计）、`全程的调度规则.md`（调度逻辑）。*
