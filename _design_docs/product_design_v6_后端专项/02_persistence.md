# 02 持久化：多项目 / 对话 / 资产

## 数据根布局

```
server/data/
├── config.json                       # 全局配置（LLM provider 等）
├── projects.json                     # 项目索引：id → {name, createdAt, updatedAt}
├── projects/
│   └── <projectId>/                  # projectId = uuid v4 或 slug
│       ├── metadata.json                # {name, description, createdAt, updatedAt, activeSkills?}
│       ├── chat_history.json            # 对话消息数组（追加写）
│       ├── execution_log.jsonl          # 执行事件流（每行一条 ExecutionEvent，追加写）
│       └── assets/
│           ├── user_requirements.md
│           ├── worldbuilding.md
│           ├── characters.md
│           ├── act_map.md
│           ├── sequence_list.md
│           ├── scene_beat_outline.md
│           ├── foreshadowing.md
│           ├── subplots.md
│           ├── _check_report.md         # 下划线开头 = 内部资产，不展示卡片
│           └── draft_history.md
└── skills/                           # 用户 overlay skill（见 03）
```

设计要点：

- **projectId 用 uuid**（`crypto.randomUUID()`），避免中文/空格路径的跨平台问题；项目名单独存 `metadata.json`。
- **projects.json 是索引缓存**，可从子目录扫描重建，用于加速项目列表。
- **execution_log 用 JSONL**：追加友好、崩溃安全、便于后续做时间线回放。
- **assets 用真 Markdown 文件**：与现有 FileManager API 契合，用户可直接用编辑器查看。

## 与 FileManager 的映射

现状 `InMemoryFileManager` 接口（简化）：

```ts
interface FileManager {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>       // reset_all 用
}
```

`HttpFileManager` 保持同一接口，实现改为：

```ts
class HttpFileManager implements FileManager {
  constructor(private projectId: string, private api: ApiClient) {}
  read(path)  { return this.api.get(`/api/projects/${this.projectId}/assets/${path}`) }
  write(p, c) { return this.api.put(`/api/projects/${this.projectId}/assets/${p}`, { content: c }) }
  list()      { return this.api.get(`/api/projects/${this.projectId}/assets`) }
  clear()     { return this.api.delete(`/api/projects/${this.projectId}/assets`) }
}
```

`OrchestratorEngine`、`assetStore` 拿到的仍是 `FileManager`，不感知底层是内存还是 HTTP。

## 项目切换与生命周期

- `App.tsx` 启动流程新增：
  1. `GET /api/config` 判断是否已配置 LLM，未配置 → 引导 Settings 页。
  2. `GET /api/projects` 拉项目列表。
  3. 用户选项目 → 拿 `projectId` 构造 `HttpFileManager(projectId)` → 注入 store。
  4. `assetStore.refreshAllFiles()` 走一次全量拉取。
- 新建项目：`POST /api/projects { name }` → 后端创建目录 + 空 metadata → 返回 projectId。
- 删除项目：`DELETE /api/projects/:id`，回收站方案 v6 不做，直接 rm -rf；前端弹二次确认。
- 复制项目（fork）：`POST /api/projects/:id/duplicate`，MVP 可后置。

## 对话历史持久化

现状 `chatStore.messages` 只在内存。改造：

- 每条 user/assistant 消息通过 `POST /api/projects/:id/chat/messages` 追加。
- 每个 `ExecutionEvent`（工具调用、写入、检查报告）通过 `POST /api/projects/:id/chat/events` 追加到 `execution_log.jsonl`。
- 前端仍维护本地 `messages` 状态用于渲染；每次进项目时 `GET /api/projects/:id/chat` 一次性拉取全量。
- 长历史后端返回**分页**（最近 N 条 + `?before=timestamp`），前端按需加载；MVP 可直接返回全量，后续再加分页。

## 并发写策略

单用户单进程场景，并发主要来自：Orchestrator 同一轮里多个 Subagent 串行写不同资产（本来就串行）、前端多个 tab（罕见）。

方案：

```ts
// server/src/util/fsQueue.ts
const queues = new Map<string, Promise<void>>()  // key = projectId
export function enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  queues.set(projectId, next.then(() => {}))
  return next
}
```

所有写操作（assets / chat / metadata）过 `enqueue(projectId, ...)`，保证同一项目内串行。读操作不排队，允许脏读——反正每次操作后前端会 refresh。

## 与 reset_all 的关系

`reset_all` 现在调 `FileManager.clear()`。`HttpFileManager.clear()` → `DELETE /api/projects/:id/assets`，后端把 `assets/` 目录清空但保留项目本身。**不清对话历史**——用户可能想在同一对话里重置资产继续讨论。是否也清历史留作 UX 选项（reset with history vs reset assets only）。

## 潜在陷阱

- **路径穿越**：`assets/${path}` 必须校验 path 不含 `..` / 绝对路径，只允许白名单文件名。用 `path.resolve` + `startsWith(projectRoot)` 判断。
- **中文文件名**：现有资产文件是英文，安全；但 projectId 若允许中文会踩 macOS NFD/NFC 问题——所以用 uuid。
- **崩溃恢复**：写 JSONL 用 `fs.appendFile`（原子小写入）；`metadata.json` 用「写临时文件 + rename」原子替换。
- **磁盘空间**：`execution_log.jsonl` 会无限增长。v6 不做 rotation，加个 warning：单项目 > 50MB 时前端提示。
