# 07 未决问题

按优先级排列，标注**倾向建议**。开工前需要用户拍板前 3 个；后面的可以随实现走。

## P0：影响架构选型

### Q1. 数据目录位置

- (A) `server/data/` —— 项目内，`.gitignore` 排除。开发调试直接看，rm -rf 即重置。
- (B) `~/.storycrafter/` —— 跨 clone 共享，用户所有项目集中一处。
- (C) 两者都支持，CLI 参数 `--data-dir` 或 env `STORYCRAFTER_DATA_DIR` 切换。

**倾向 (A) 做 MVP，代码里预留 `--data-dir` 的抽象**：`getDataDir()` 函数统一入口，默认返回 `path.resolve(__dirname, '../data')`，将来加 env 覆盖是一行改动。理由：MVP 用户即开发者，`server/data/` 直观；跨 clone 共享属于成熟期才需要的诉求。

### Q2. 内置 Skill 加载方式

- (A) 双源 overlay：`web/src/skills/` 保留 bundle 内 + 后端也扫这个目录合并 overlay。
- (B) 全后端：内置 skill 挪到 `server/builtin_skills/`，前端只从 `/api/skills` 拿。
- (C) 全 bundle：内置 skill 保持现状，只有**用户 overlay** 走后端，前端 registry 是「bundle registry ∪ 后端 overlay registry」。

**倾向 (A)**：source of truth 唯一（后端），但 `web/src/skills/` 保留作为分发内容源（不作为加载源）。这样：
- 内置 skill 的 TypeScript 路径引用/类型化保留（如果确有引用）。
- 后端 build 时把 `web/src/skills/` 复制到 `server/dist/builtin_skills/`（生产），dev 直接读 `web/src/skills/`。
- 前端不再依赖 `import.meta.glob`，`skillLoader.ts` 完全异步化。

(C) 看似渐进但会有一致性坑（bundle 里的 skill 和后端的可能不同版本）。(B) 干净但要动内置 skill 位置，改动面大。

### Q3. Key 存储保护

- (A) 明文 `config.json` + `chmod 0600` + README 警告。
- (B) 简单对称加密（AES + 从 machine-id 或用户 passphrase 派生 key）。
- (C) OS keyring（macOS keychain / Windows Credential Manager / libsecret），走 `keytar` 库。

**倾向 (A)**：本地单用户场景威胁模型是「屏幕被人瞟」和「配置文件泄露」——前者加密防不住，后者靠权限位。(C) 最正确但引入原生模块，跨平台分发复杂度骤增，与「clone 即跑」目标冲突。(B) 是自我安慰。

## P1：影响实现细节

### Q4. 后端命名风格

全局指令要求「后端不得耦合前端字段命名风格，统一通过序列化层转换」。但本项目后端也是 TS：

- (A) 前后端统一 camelCase，不做转换层。
- (B) 后端 snake_case，前后端各一套 DTO + 转换层。

**倾向 (A)**：Node/TS 生态原生 camelCase，(B) 会导致 40% 代码在写 keys 映射，收益仅是「符合抽象规则」。此点需与用户明确豁免。

### Q5. 对话流式响应

- (A) 阶段 1 上 SSE，痛快。
- (B) 阶段 1 先 non-streaming 打通链路，SSE 放阶段 6。

**倾向 (B)**：SSE 涉及后端流式 pipe、前端 iterator、错误恢复语义，与「解决 key 暴露」这个阶段 1 主目标混在一起会拖慢节奏。用户体验降级但不阻塞任何功能。

### Q6. 项目重命名 `src/` → `web/src/`

- (A) 做，符合前后端分离目录规范。
- (B) 不做，保留 `src/` 前端 + 新增 `server/`。

**倾向 (A)**：一次性重命名比后期改省事；`git mv` 保 blame。作为独立阶段 2，单独 PR。

### Q7. LLM Provider 抽象层次

- (A) MVP 只有 `openai-compatible` 一个 kind，Anthropic/Gemini 后置。
- (B) 一开始就设计好 provider 接口，MVP 只实现 openai 但结构完整。

**倾向 (A)**：YAGNI。Anthropic 消息格式差异较大（system prompt 分离、tool schema 不同），设计抽象容易过度。等真要接第二家再重构。

## P2：影响 UX，不影响架构

### Q8. 项目切换体验

- (A) 项目切换器放顶栏 dropdown，切换时清空 chat/asset 重新加载。
- (B) 每个项目独立标签页（浏览器 tab 或应用内 tab）。
- (C) URL 里带 projectId（`/projects/:id`），刷新保留当前项目。

**倾向 (C)**：`react-router` 引入成本低，URL 化对多项目 UX 是标配。可与 (A) 并存（顶栏 dropdown 触发路由跳转）。

### Q9. Skill 加载错误的展示

- (A) 前端 Settings 页专用「加载失败」列表 tab。
- (B) 全局 Toast 通知 + 详情弹窗。
- (C) 直接在 Skill 库列表中标红。

**倾向 (C) + (B)**：坏 skill 就地标记 + 首次加载有 toast 提示，用户点进去看详情。(A) 藏太深。

### Q10. reset_all 语义

- (A) 只清资产（现状），保留对话。
- (B) 清资产 + 清对话历史。
- (C) UI 提供两个选项让用户选。

**倾向 (A)**：保持 v5.3 语义；用户想清对话可以「新建项目」或专门加一个「清空对话」按钮。混淆两种 reset 语义不好。

## P3：远期，v6 不做

- 项目导出为 zip（含资产 + 对话 + 版本快照）。
- Skill marketplace / 远程 Skill 拉取。
- Anthropic / Gemini provider 支持。
- Electron 打包成桌面 app。
- 多用户 / 认证。
- 云同步。
- 版本快照/回滚（当前 diff 展示只有 previous，没有历史线）。
