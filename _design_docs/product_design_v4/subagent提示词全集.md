# Subagent System Prompt 全集（v4）

> **说明**：本文档是 v4 所有 Subagent System Prompt 的索引。
> 每个提示词为独立文件，位于 `prompts/` 目录下，方便手动调参和管理。

---

## 目录结构

```
product_design_v4/
└── prompts/
    ├── orchestrator_v4.md              # A — Orchestrator 系统提示词
    │
    ├── generate_worldbuilding.md        # B1 — 世界观生成
    ├── generate_characters.md           # B2 — 角色设定生成
    ├── generate_plot_synopsis.md        # B3 — 剧情概要生成
    │
    ├── generate_act_map.md              # C1 — 幕级地图生成
    ├── generate_sequence_list.md        # C2 — 序列清单生成
    ├── generate_scene_beats.md          # C3 — 场景节拍生成
    │
    ├── refine_worldbuilding.md          # D1 — 世界观精炼
    ├── refine_characters.md             # D2 — 角色设定精炼
    ├── refine_plot_synopsis.md          # D3 — 剧情概要精炼
    ├── refine_act_map.md                # D4 — 幕结构精炼
    ├── refine_sequence_list.md          # D5 — 序列清单精炼
    ├── refine_scene_beats.md            # D6 — 场景节拍精炼
    │
    └── reset_all.md                     # E — 系统重置
```

---

## A. Orchestrator System Prompt

| 文件 | ID | 用途 |
|------|-----|------|
| [prompts/orchestrator_v4.md](prompts/orchestrator_v4.md) | — (系统级) | 故事总监与工具决策者。通过 Function Calling 调度 Tool，不直接生成内容 |

---

## B. 基础设定生成

| 文件 | ID | 输出 TAG | 描述 |
|------|-----|----------|------|
| [prompts/generate_worldbuilding.md](prompts/generate_worldbuilding.md) | `generate_worldbuilding` | `<<<WORLDBUILDING_START>>> / <<<WORLDBUILDING_END>>>` | 根据用户描述生成世界观设定 |
| [prompts/generate_characters.md](prompts/generate_characters.md) | `generate_characters` | `<<<CHARACTERS_START>>> / <<<CHARACTERS_END>>>` | 根据世界观生成角色设定 |
| [prompts/generate_plot_synopsis.md](prompts/generate_plot_synopsis.md) | `generate_plot_synopsis` | `<<<PLOT_SYNOPSIS_START>>> / <<<PLOT_SYNOPSIS_END>>>` | 根据世界观+角色生成剧情概要 |

## C. 大纲结构与微观精铸生成

| 文件 | ID | 输出 TAG | 描述 |
|------|-----|----------|------|
| [prompts/generate_act_map.md](prompts/generate_act_map.md) | `generate_act_map` | `<<<ACT_MAP_START>>> / <<<ACT_MAP_END>>>` | 从概念设定生成幕级结构 |
| [prompts/generate_sequence_list.md](prompts/generate_sequence_list.md) | `generate_sequence_list` | `<<<SEQUENCE_LIST_START>>> / <<<SEQUENCE_LIST_END>>>` | 从幕地图生成序列清单 |
| [prompts/generate_scene_beats.md](prompts/generate_scene_beats.md) | `generate_scene_beats` | `<<<SCENE_BEAT_OUTLINE_START>>> / <<<SCENE_BEAT_OUTLINE_END>>>` | 从全上游生成场景节拍 |

## D. 精炼/修改

| 文件 | ID | 输出 TAG | 描述 |
|------|-----|----------|------|
| [prompts/refine_worldbuilding.md](prompts/refine_worldbuilding.md) | `refine_worldbuilding` | `<<<WORLDBUILDING_START>>> / <<<WORLDBUILDING_END>>>` | 最小改动精炼已有世界观 |
| [prompts/refine_characters.md](prompts/refine_characters.md) | `refine_characters` | `<<<CHARACTERS_START>>> / <<<CHARACTERS_END>>>` | 最小改动精炼已有角色 |
| [prompts/refine_plot_synopsis.md](prompts/refine_plot_synopsis.md) | `refine_plot_synopsis` | `<<<PLOT_SYNOPSIS_START>>> / <<<PLOT_SYNOPSIS_END>>>` | 最小改动精炼已有剧情 |
| [prompts/refine_act_map.md](prompts/refine_act_map.md) | `refine_act_map` | `<<<ACT_MAP_START>>> / <<<ACT_MAP_END>>>` | 最小改动精炼已有幕结构 |
| [prompts/refine_sequence_list.md](prompts/refine_sequence_list.md) | `refine_sequence_list` | `<<<SEQUENCE_LIST_START>>> / <<<SEQUENCE_LIST_END>>>` | 最小改动精炼已有序列 |
| [prompts/refine_scene_beats.md](prompts/refine_scene_beats.md) | `refine_scene_beats` | `<<<SCENE_BEAT_OUTLINE_START>>> / <<<SCENE_BEAT_OUTLINE_END>>>` | 最小改动精炼已有节拍 |

## E. 系统

| 文件 | ID | 描述 |
|------|-----|------|
| [prompts/reset_all.md](prompts/reset_all.md) | `reset_all` | 清空所有已生成内容 |

---

## 提示词结构说明

每个提示词文件遵循统一结构：

```
# 角色                    — 明确身份定位
## 输入                   — 收到的 XML 上下文标签
## 任务                   — 需要完成的具体工作
## 输出格式               — TAG 包裹的 MD 模板
## 规则                   — 禁令和约束条件
```

## 引用方式

在 ToolRegistry 中通过 `systemPromptFile` 引用：

```typescript
{
  id: 'generate_worldbuilding',
  systemPromptFile: 'prompts/generate_worldbuilding.md',  // 指向 prompts/ 下的独立文件
  // ...
}
```

实际代码实现时，将 `prompts/` 目录下的 `.md` 文件复制到 `src/llm/prompts/`，通过 Vite 的 `?raw` 静态导入加载。
