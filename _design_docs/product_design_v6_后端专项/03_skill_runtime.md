# 03 Skill 运行时加载

## 现状与问题

v5.3 `src/skills/skillLoader.ts` 使用：

```ts
const subagentModules = import.meta.glob('./*/subagent.md',      { eager: true, query: '?raw', import: 'default' })
const skillModules    = import.meta.glob('./*/*/SKILL.md',       { eager: true, query: '?raw', import: 'default' })
```

- Vite **构建期**静态分析这些 glob，把匹配到的文件内容打包进 bundle。
- **运行期**再往 `src/skills/` 加文件不会被识别，除非重新 `npm run build`。
- 用户装 Skill 场景（把目录扔进某处）在当前实现下不可能。

## 目标

用户装 Skill 流程：

1. 用户把 `<subagentId>/<skillId>/SKILL.md` 目录放入 `server/data/skills/<subagentId>/<skillId>/`（或新 Subagent 则同级放 `subagent.md`）。
2. 前端 Settings 页点「重新扫描 Skill 库」，或后端 fs.watch 自动刷新。
3. Orchestrator 下次 FC 面即可见新 Subagent / Skill Router 可选新 Skill。

## 双源 overlay 方案

Skill/Subagent 来源分两层：

| 层 | 位置 | 加载方 | 作用 |
| --- | --- | --- | --- |
| **内置** | `web/src/skills/` | 构建期 `import.meta.glob` bundle 进 web | 保证 clone 后立即可用；作为默认能力集 |
| **用户 overlay** | `server/data/skills/` | 后端启动时/watch 时扫描 | 用户扩展、覆盖 |

合并规则（后端 `skillRegistry.ts` 负责）：

- `subagentId` 冲突 → **用户 overlay 覆盖内置**（允许用户改 subagent.md 角色前缀/description）。
- `skillId` 冲突 → 同上，用户版覆盖。
- 目录约定与 frontmatter 硬约束（禁 `subagent/owner/agent` 键）两层一致。

前端 registry 通过 `GET /api/skills` 拿到**合并后**的完整 registry；内置 skill 也走后端返回，让前端只有一个数据源。这意味着 `web/src/skills/*/SKILL.md` 需要在 build 时也能被后端读到——最简方案：

- 内置 skill 在 `web/src/skills/` 保留（TypeScript 路径引用、类型化、glob 兜底）。
- 后端启动时**额外**扫 `web/src/skills/**/*.md`（相对 workspace root），与用户 overlay 合并。
- 生产模式 `web/src/skills/` 已经不在 dist 里，需要 build 步骤把 `.md` 复制到 `server/dist/builtin_skills/` 或者保留源码目录一起分发。倾向后者：分发包本来就带 `web/src/`，不占几 KB。

## 后端 Skill Registry

```ts
// server/src/services/skillRegistry.ts
interface SkillRegistry {
  subagents: Map<string, SubagentSpec>
  skills: Map<string, SkillSpec[]>       // key = subagentId
}

async function scan(root: string): Promise<Partial<SkillRegistry>> {
  // glob(`${root}/*/subagent.md`)  → parse frontmatter → SubagentSpec
  // glob(`${root}/*/*/SKILL.md`)   → parse frontmatter → SkillSpec
  //   subagentId 从路径取（第一段目录名），不信 frontmatter
  //   校验 frontmatter 不含 subagent/owner/agent 键，否则抛错
}

async function buildRegistry(): Promise<SkillRegistry> {
  const builtin = await scan(BUILTIN_SKILLS_DIR)
  const overlay = await scan(USER_SKILLS_DIR)
  return merge(builtin, overlay)      // overlay wins
}
```

frontmatter 解析器逻辑逐字从 `web/src/skills/skillLoader.ts` 移植过来（只支持扁平标量 + 内联数组，含 `>>>` 必须加引号）。放 `shared/src/frontmatter.ts` 前后端复用；如果不做 shared 包，直接后端复制一份，diff 由测试守。

## 前端加载路径

`web/src/skills/skillLoader.ts` 改造：

```ts
// v6: 异步、从后端拉
export async function loadRegistry(): Promise<SkillRegistry> {
  const res = await api.get('/api/skills')
  return normalizeRegistry(res)
}
```

`App.tsx` 启动加 boot gate：

```tsx
useEffect(() => {
  Promise.all([loadRegistry(), loadConfig(), loadProjects()])
    .then(([reg, cfg, projs]) => { setReady({ reg, cfg, projs }) })
    .catch(setBootError)
}, [])

if (!ready) return <BootScreen error={bootError} />
```

Orchestrator 构造时把 registry 传进去（现在是模块级 import，需要改成依赖注入）。

## 热更新

- 开发期后端 `chokidar.watch(USER_SKILLS_DIR)` → debounce 500ms → 重建 registry → 通过 SSE `/api/skills/events` 推送到前端，前端更新 store。
- MVP 可以先不做 watch，前端 Settings 页提供「刷新」按钮，`POST /api/skills/refresh` 触发重扫。

## `reset_all` 与用户 Skill

`reset_all` 目前靠 `writes:[] + outputTags:[]` 的空 Skill 信号识别。用户 overlay 理论上可以塞一个恶意 `reset_all` skill 覆盖，但它必须放在 `server/data/skills/reset_all/*/SKILL.md` 目录下——归属靠目录已经隔离了 subagent，重点是**不允许 overlay 内的 skill 保留空 writes+空 outputTags 组合以外的路径**触发 `clearAll`。这是引擎侧现有约束，不用改。

## 潜在陷阱

- **命名冲突**：内置 `worldbuilding` subagent，用户塞 `worldbuilding` 同名会静默覆盖。加载日志需明确打印 "user overlay overrides builtin: worldbuilding"，并在前端 Skill 管理页展示来源标签。
- **frontmatter 硬约束 loader 抛错**：现在直接 throw 会让整个 registry build 失败。后端应改为**跳过坏 skill 并记录错误**，前端能看到「加载失败的 skill」列表，避免一个坏文件搞垮整站。
- **同步 → 异步**：`SUBAGENT_REGISTRY` 现在是模块级 const，很多地方直接 import。改成 provider 模式（`useRegistry()` hook / `getRegistry()` 函数从 store 拿），涉及面较广但机械。
- **打包分发**：`web/src/skills/` 里的 `.md` 是 raw import，Vite 处理没问题；但后端 Node 需要走 fs 读，路径依赖 workspace 布局。生产模式建议 build 步骤显式 `cp -r web/src/skills server/dist/builtin_skills/`。
