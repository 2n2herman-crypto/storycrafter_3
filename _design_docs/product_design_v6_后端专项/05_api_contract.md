# 05 API 契约

所有路由前缀 `/api`。JSON 请求/响应默认 UTF-8。错误统一：

```jsonc
// 4xx / 5xx 响应体
{ "error": { "kind": "...", "message": "...", "detail": {} } }
```

`kind` 枚举：`bad_request | not_found | conflict | auth | rate_limit | network | upstream | config | internal`。

## 配置

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 拿全量 config（**apiKey 字段 mask 成 `sk-****xxxx`**） |
| PUT | `/api/config` | 覆盖式更新（前端传完整 config；apiKey 传 `null` 表示保持原值不动） |
| POST | `/api/config/profiles` | 新增 profile，返回 id |
| DELETE | `/api/config/profiles/:id` | 删除；不能删 active profile |
| POST | `/api/config/active` | body `{profileId}` |
| POST | `/api/llm/test` | body `{profileId}`；后端发 minimal chat 探活；返回 `{ok, latencyMs, model, error?}` |

## LLM 代理

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/llm/chat` | body 为 OpenAI-compatible chat.completions；`stream=true` 时返回 `text/event-stream` |

## 项目

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表 `[{id, name, createdAt, updatedAt}]` |
| POST | `/api/projects` | body `{name}`；返回 `{id, ...}` |
| GET | `/api/projects/:id` | 项目 metadata |
| PATCH | `/api/projects/:id` | 更新 name/description |
| DELETE | `/api/projects/:id` | 硬删 |
| POST | `/api/projects/:id/duplicate` | (可选/后置) fork |

## 资产（对应 FileManager）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/assets` | 列出该项目所有资产 `[{path, size, updatedAt}]` |
| GET | `/api/projects/:id/assets/*` | 读单文件；返回 `{path, content, updatedAt}` |
| PUT | `/api/projects/:id/assets/*` | body `{content}` 覆盖写；返回 `{path, updatedAt}` |
| DELETE | `/api/projects/:id/assets/*` | 删单文件 |
| DELETE | `/api/projects/:id/assets` | 清空全部（reset_all 用） |

path 参数示例：`/api/projects/abc/assets/worldbuilding.md`。后端校验 path 只允许 `[A-Za-z0-9_.-]+\.md`，禁绝对路径和 `..`。

## 对话

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:id/chat` | 拿完整对话（消息数组 + 执行事件流）；可选 `?limit=&before=` 分页 |
| POST | `/api/projects/:id/chat/messages` | 追加一条消息 `{role, content, ...}` |
| POST | `/api/projects/:id/chat/events` | 追加一条 ExecutionEvent |
| DELETE | `/api/projects/:id/chat` | 清空对话（不清资产） |

响应：

```jsonc
GET /api/projects/:id/chat →
{
  "messages": [ ... ],
  "events":   [ ... ]     // ExecutionEvent[]
}
```

## Skill 库

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/skills` | 完整 registry `{subagents: [...], skills: {subagentId: [...]}}`；含 `source: "builtin" \| "overlay"` 标签 |
| POST | `/api/skills/refresh` | 重扫 overlay 目录 + 内置目录，返回新 registry |
| GET | `/api/skills/errors` | 上次扫描时坏掉的 skill 列表 `[{path, error}]` |
| GET | `/api/skills/events` | SSE，overlay 目录 fs.watch 变更推送（v6 可选） |

registry 响应类型（示意）：

```ts
type SkillRegistryDTO = {
  subagents: Array<SubagentSpec & { source: 'builtin' | 'overlay' }>
  skills:    Record<string, Array<SkillSpec & { source: 'builtin' | 'overlay' }>>
}
```

## 前端 API 层组织

`web/src/api/` 必须**集中**所有后端调用（遵守全局指令）。禁止组件里直接 fetch。

```
web/src/api/
├── client.ts     # fetch 封装、baseURL、错误 parse、SSE iterator
├── config.ts     # getConfig, updateConfig, testConnection
├── llm.ts        # chat (streaming + non-streaming)
├── projects.ts   # list, create, get, update, delete
├── assets.ts     # 提供 HttpFileManager 实现
├── chat.ts       # loadHistory, appendMessage, appendEvent, clear
└── skills.ts     # loadRegistry, refresh, subscribeEvents
```

字段命名规范：**后端一律 camelCase**（Node/TS 天然），前后端不做转换层，简化。这偏离了全局指令里「后端不得耦合前端命名风格」的措辞——但因为后端也是 TS，camelCase 是两端共同的原生风格，非耦合而是共同选择。此点在 07_open_questions.md 里列出待确认。
