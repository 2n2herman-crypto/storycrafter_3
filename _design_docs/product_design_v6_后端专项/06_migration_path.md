# 06 分阶段落地路径

原则：**每一阶段结束都能跑通全流程**，不允许「地基挖到一半」的中间态。阶段间可以停下来。

## 阶段 0：目录准备（不改运行逻辑）

- 在 root 新建 `server/` 空壳（package.json、tsconfig、hello express）。
- **不迁移** `src/` 到 `web/`——这个重命名放在阶段 2 做，避免早期阶段大量 diff 干扰 review。
- root package.json 加 `concurrently`、`tsx`，脚本 `dev` 起 web + server。
- Vite proxy `/api/*` → `http://localhost:3001`（已有骨架，改 target）。
- 后端只有一个 `GET /api/health` 探活。

**验收**：`npm run dev` 起两个进程，前端 `fetch('/api/health')` 通。现有 SPA 行为不变。

## 阶段 1：LLM 代理（先解决 key 暴露痛点）

- 后端实现 `POST /api/llm/chat`（先 non-streaming）+ `GET/PUT /api/config`。
- Config 存文件，MVP 允许 config.json 里 apiKey 用 `VITE_DEEPSEEK_API_KEY` 作为迁移默认值（env → 首启动种进 config.json，然后 env 就可以拿掉）。
- 前端 `LLMClient` 改打 `/api/llm/chat`；移除 `dangerouslyAllowBrowser`。
- 增加 Settings 页最小实现：只有一个 profile，能编辑 baseURL/apiKey/model。
- `.env.local` 从必需变可选，README 更新。

**验收**：删掉 `VITE_DEEPSEEK_API_KEY` 也能跑；DevTools Network 面板看不到直连厂商的请求。

## 阶段 2：目录结构调整（src → web/src）

- `git mv src web/src`；vite.config.ts 相应调整。
- 新建 `web/src/api/` 目录（此时只放 `llm.ts` 和 `config.ts`）。
- 更新 `.claude/CLAUDE.md` 的路径引用。

**验收**：全部功能等价，只是路径变了。

单独成阶段是因为 git 历史/blame 会集中受影响，与业务逻辑改动隔离更好 review。

## 阶段 3：资产持久化（HttpFileManager）

- 后端 `projects.ts` + `assets.ts` 路由 + `projectStore.ts` 服务。
- 前端新增项目选择器（暂时可以只支持单项目「default」，不做完整多项目 UI）。
- `HttpFileManager` 实现，`App.tsx` DI 切换。
- `assetStore.refreshAllFiles()` 逻辑不变，只是 FileManager 换了。

**验收**：刷新页面资产还在；`server/data/projects/default/assets/*.md` 里能看到真文件。

## 阶段 4：多项目 + 对话持久化

- 前端项目列表/新建/切换 UI。
- 对话历史/执行日志追加到后端。
- 切项目时 chat/asset 都从后端重新拉取。

**验收**：多个项目独立，切来切去数据不串；关掉浏览器再打开对话还在。

## 阶段 5：Skill 运行时加载

- 后端 `skillRegistry.ts` 扫描内置 + overlay。
- 前端 `skillLoader.ts` 改成 `loadRegistry()` 异步。
- `App.tsx` 加 boot gate；`OrchestratorEngine` 改为运行时注入 registry。
- Settings 页加「Skill 库」tab，列出所有 subagent/skill + source 标签 + 加载错误。
- 「刷新」按钮 → `POST /api/skills/refresh`。

**验收**：把 `server/data/skills/worldbuilding/my_variant/SKILL.md` 放进去，点刷新，前端 Skill 库列表出现，subagent 描述被 overlay 覆盖生效。

## 阶段 6：打磨（可选，按需推进）

- SSE 化 LLM 流式响应（第一版 non-streaming 也能用，但延迟感差）。
- fs.watch overlay 目录自动刷新。
- Settings 多 profile + 快速切换。
- 生产模式：`npm run build && npm start` 单端口分发。
- 项目导出/导入（zip 压缩包）。
- 内置 skill 编辑（可选：让用户在 UI 里改 SKILL.md？——建议不做，避免 UX 复杂化）。

## 向后兼容

- 数据格式无历史包袱（InMemoryFileManager 从不落地），不用写迁移。
- `.env.local` 的 `VITE_DEEPSEEK_API_KEY` 保留兼容路径：**阶段 1 起**如果 env 存在且 config.json 不存在，后端首次启动读 env 生成 config，然后就与 env 解耦。README 更新说明。
- Orchestrator prompt / Subagent / Skill 内容**零改动**，四层框架不动。

## 风险与降级

| 风险 | 触发条件 | 降级方案 |
| --- | --- | --- |
| 阶段 1 后 SSE 兼容问题 | DeepSeek 流式与 OpenAI SDK 细节差异 | 先 non-streaming 上线，SSE 放阶段 6 |
| 阶段 3 fs 竞争 | 用户开两个 tab 同项目并发编辑 | 串行队列（02 文档）+ 前端加操作锁定态 |
| 阶段 5 registry 异步破坏面广 | `SUBAGENT_REGISTRY` 模块级 const 使用点多 | 保留一个 `getRegistrySync()` 返回快照，异步就绪后一次性 seed；改动局部化 |
| 用户 skill 加载错误级联 | 一个坏 frontmatter 挂掉整个 registry | 加载错误改为 skip + 收集，`/api/skills/errors` 暴露 |
| 分发时后端启动失败 | Node 版本 / 端口冲突 | root README 写清 Node ≥18；后端启动加端口自动 fallback (`3001 → 3002 → ...`) |

## 时间粗估（仅供决策，非承诺）

| 阶段 | 粗估 |
| --- | --- |
| 0 | 半天 |
| 1 | 1-2 天 |
| 2 | 半天（纯移动）|
| 3 | 1-2 天 |
| 4 | 1-2 天 |
| 5 | 2-3 天（面最广） |
| 6 | 按需 |

单人节奏，含调试和文档更新。总计约 6-10 天到「四个目标全部达成」。
