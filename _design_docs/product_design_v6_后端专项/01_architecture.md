# 01 目标架构

## 目录布局（改造后）

```
storycrafter_3/
├── package.json              # workspace root，脚本编排 dev/build/start
├── server/                   # 【新】Node 后端
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts              # 入口：起 express + 扫 skills + 加载 config
│   │   ├── routes/
│   │   │   ├── projects.ts       # 项目 CRUD、切换、导出
│   │   │   ├── chat.ts           # 对话历史读写、执行日志追加
│   │   │   ├── assets.ts         # 资产 md 读写（原 FileManager 的后端版）
│   │   │   ├── skills.ts         # skill registry 查询、刷新
│   │   │   ├── llm.ts             # LLM 代理（OpenAI-compatible 透传）
│   │   │   └── config.ts         # provider 配置读写
│   │   ├── services/
│   │   │   ├── projectStore.ts   # 文件系统封装 + 串行队列
│   │   │   ├── skillRegistry.ts  # 运行时 skill 扫描 + overlay 合并
│   │   │   ├── llmProxy.ts       # OpenAI-compatible 转发
│   │   │   └── configStore.ts    # config.json 读写 + 权限位
│   │   └── util/
│   │       ├── fsQueue.ts        # 按 project id 分片的写队列
│   │       └── frontmatter.ts    # 从 web 复用（或移到 shared）
│   └── data/                     # 【gitignore】用户数据根
│       ├── config.json
│       ├── skills/               # 用户装的 skill overlay
│       └── projects/<projId>/…
├── web/                      # 【重命名】原 src/ 迁到这里
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── api/                  # 【新】统一后端调用层
│       │   ├── client.ts             # fetch 封装、错误处理
│       │   ├── projects.ts
│       │   ├── chat.ts
│       │   ├── assets.ts
│       │   ├── skills.ts
│       │   ├── llm.ts
│       │   └── config.ts
│       ├── skills/               # 内置 skill 保留（bundle 兜底）
│       ├── orchestrator/         # 保留，只改 LLMClient 打后端
│       ├── store/                # FileManager 换 HttpFileManager
│       └── ...
└── shared/                   # 【可选】前后端共享的类型/frontmatter 解析器
    └── src/
        ├── types.ts
        └── frontmatter.ts
```

## 进程模型

单机双进程：

- **web 前端**：Vite dev server（5173），提供 SPA，`/api/*` proxy 到后端。
- **server 后端**：Express（默认 3001），暴露 REST + SSE。
- 生产模式：后端 `express.static` 直接托管 `web/dist/`，单进程单端口。

启动脚本（root `package.json`）：

```json
{
  "scripts": {
    "dev": "concurrently -k 'npm:dev:server' 'npm:dev:web'",
    "dev:server": "cd server && tsx watch src/index.ts",
    "dev:web": "cd web && vite",
    "build": "cd web && vite build && cd ../server && tsc",
    "start": "node server/dist/index.js"
  }
}
```

用户视角：`git clone && npm i && npm run dev`，浏览器打开 `http://localhost:5173`。

首次启动如果 `server/data/config.json` 不存在，前端引导到「LLM 设置」页填 key，保存后进正常流程。

## 数据流对比

### v5.3 现状

```
User → chatStore → OrchestratorEngine
                    ├─ LLMClient (浏览器直连 DeepSeek，key 在 bundle)
                    ├─ skillRegistry (import.meta.glob 构建期锁死)
                    └─ InMemoryFileManager (Map<path,string>，刷新丢失)
```

### v6 目标

```
User → chatStore → OrchestratorEngine
                    ├─ LLMClient        → POST /api/llm/chat        → LLM 厂商
                    ├─ skillRegistry    ← GET  /api/skills           ← 扫盘 + overlay
                    └─ HttpFileManager  ↔ /api/projects/:id/assets   ↔ 文件系统
                                        ↔ /api/projects/:id/chat
```

关键：`OrchestratorEngine` 本身**不改**——它对外只依赖 `FileManager`/`LLMClient`/`skillRegistry` 三个注入接口。改的都是这三个的实现。

## 保留的 v5.3 约束

- 四层框架（Orchestrator → Subagent → Skill Router → Skill）不动。
- Skill 归属靠目录、frontmatter 禁 `subagent/owner/agent` 键、硬约束不动。
- FC 面（`id` + `description`）语义不动。
- validator START/END tags 契约不动。

## 破坏性变更

- `import.meta.glob` 移除 → Skill 加载从**构建期同步**变为**运行期异步**；`App.tsx` 需要一个 boot gate 等 registry 就绪。
- `LLMClient` 不再直连厂商 → `dangerouslyAllowBrowser` 摘除、`VITE_DEEPSEEK_API_KEY` 停用。
- `InMemoryFileManager` 保留作为 fallback（测试/离线），生产走 `HttpFileManager`。
