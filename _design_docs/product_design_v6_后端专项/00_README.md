# v6 后端专项设计

> 目标：把 StoryCrafter 3 从「浏览器内存 SPA + bundle 内焊死的 key/skill」演进为「本地 Node 后端 + Vite 前端」的可分发形态，覆盖四个用户需求：
>
> 1. 用户 `git clone` 后本地 localhost 一键启动
> 2. 对话/项目记录持久化，多项目并存
> 3. 用户可加装自己的 Skill（运行时装载，无需重新构建）
> 4. 可视化配置自己的 LLM API（provider / baseURL / key / model）

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [00_README.md](00_README.md) | 本文档，总览与决策记录 |
| [01_architecture.md](01_architecture.md) | 目标架构、目录布局、进程模型、数据流 |
| [02_persistence.md](02_persistence.md) | 多项目 + 对话 + 资产的持久化方案 |
| [03_skill_runtime.md](03_skill_runtime.md) | Skill 运行时加载改造（脱离 `import.meta.glob`） |
| [04_llm_proxy.md](04_llm_proxy.md) | LLM 代理层与可视化配置 |
| [05_api_contract.md](05_api_contract.md) | 前后端 HTTP 契约（路由、请求/响应 schema） |
| [06_migration_path.md](06_migration_path.md) | 分阶段落地路径与向后兼容策略 |
| [07_open_questions.md](07_open_questions.md) | 未决点与倾向性建议 |

## 关键决策（默认值，未与用户最终确认）

| 决策点 | 倾向 | 理由 |
| --- | --- | --- |
| 数据目录 | `server/data/`（项目内） | MVP 简单，方便调试和 gitignore；后续可加 `--data-dir` 参数指向 `~/.storycrafter/` |
| Skill 来源 | **双源 overlay**：`src/skills/` 内置 + `server/data/skills/` 用户 | 保留「clone 即可用」体验，同时支持热插拔 |
| Key 存储 | 明文 `config.json` + `chmod 600` + 文档警告 | 本地单用户场景，加密价值低；后续可上系统 keyring |
| 后端框架 | Express + tsx（dev）/ tsc 编译（prod） | 生态成熟、体量最小；不引入 Nest/Fastify 复杂度 |
| 存储介质 | 文件系统（Markdown + JSON） | 与现有资产模型一致，不引入 SQLite；单用户单进程无需事务 |
| 并发写 | 进程内串行队列 + 简单 mutex | 单用户单进程场景足够，避免文件锁跨平台差异 |
| 前端 API 层 | 新建 `web/src/api/`，统一封装 | 遵守全局指令的前后端分离约定 |

## 非目标（v6 不做）

- 多用户 / 认证 / 权限
- 云同步 / 远程存储
- 生产级部署（打包成桌面 app 走 Electron 的路子留给 v7）
- Skill Marketplace / 远程 Skill 拉取（v6 只支持本地目录）
- 迁移历史 IndexedDB 数据（当前实现根本没落地过）
