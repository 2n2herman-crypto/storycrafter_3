# 04 LLM 代理与可视化配置

## 现状与问题

`web/src/llm/client.ts`：

```ts
new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: import.meta.env.VITE_DEEPSEEK_API_KEY,   // 焊死进 bundle，DevTools 可见
  dangerouslyAllowBrowser: true,
})
```

问题：
- Key 在浏览器 bundle 里，任何用户或分享者都能拿到。
- Provider/model/baseURL 无 UI 配置，改需要重新 build。
- 不能对多项目分别配置不同模型（可选诉求）。

## 目标

- 前端 `LLMClient` 打**自家后端** `/api/llm/chat`。
- 后端读 `server/data/config.json` 拿 provider 配置，转发到真实厂商，透传 SSE。
- Settings 页 UI 让用户填 baseURL / apiKey / model / (可选)自定义 headers。
- 支持多 provider profile，Orchestrator 用「当前激活的 profile」。

## config.json 结构

```jsonc
{
  "activeProfileId": "deepseek-default",
  "profiles": [
    {
      "id": "deepseek-default",
      "name": "DeepSeek v4 flash",
      "kind": "openai-compatible",         // 未来: "anthropic" | "gemini" ...
      "baseURL": "https://api.deepseek.com",
      "apiKey": "sk-xxx",
      "model": "deepseek-v4-flash",
      "extraHeaders": {}                    // 可选
    }
  ]
}
```

- 文件权限 `0600`（后端首次写入时 `fs.chmod`）。
- MVP 只支持 `openai-compatible`（DeepSeek/OpenAI/Ollama/多数国内厂商都能覆盖）。
- 后续加 Anthropic：新增 `kind: "anthropic"` 分支，body/response 做转换。

## /api/llm/chat 契约

请求：

```jsonc
POST /api/llm/chat
{
  "profileId": "deepseek-default",        // 可选，默认用 activeProfileId
  "messages": [...],                       // OpenAI 格式
  "tools": [...],                          // function specs
  "tool_choice": "auto",
  "temperature": 0.7,
  "stream": true                           // v6 建议默认 true
}
```

响应：
- `stream=false`：JSON `{ id, choices: [...], usage }` 直接透传。
- `stream=true`：SSE，事件与 OpenAI 一致（`data: {json}\n\n` + `data: [DONE]`）。

后端做的事：
- 从 config 读 baseURL/apiKey/model，覆盖 body 里的 model（如果 body 没指定）。
- 加 `Authorization: Bearer <key>`。
- POST 到 `{baseURL}/v1/chat/completions`。
- 流式响应用 pipe 直接转发，不做解析（省事、少出错）。

## 前端 LLMClient 改造

`web/src/llm/client.ts`：

```ts
// v6
export class LLMClient {
  async chat(req: ChatRequest): Promise<ChatResponse | AsyncIterable<ChatChunk>> {
    const res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!res.ok) throw await parseError(res)
    if (req.stream) return sseIterator(res.body!)
    return res.json()
  }
}
```

- 摘除 `openai` SDK 前端依赖（可选，也可继续用 SDK 打 `/api/llm` 假 baseURL——但增加维护面）。
- 错误分类逻辑 `utils/llmError.ts` 保留，只是错误现在从后端结构化返回：

```jsonc
// 后端错误统一格式
{ "error": { "kind": "auth" | "rate_limit" | "network" | "upstream" | "config", "message": "..." } }
```

## Settings 页 UI

放在 `web/src/pages/Settings/`，功能：

- Profile 列表 + 增删改。
- 每个 profile 表单：name / kind (readonly openai-compatible for now) / baseURL / apiKey (masked, 有「显示」toggle) / model / extraHeaders (KV editor)。
- 「测试连接」按钮 → `POST /api/llm/test { profileId }` → 后端发一次 `models` 或 minimal chat 请求 → 返回成功/失败。
- 切换 activeProfileId。

前端不缓存 apiKey 到 localStorage，只在编辑时驻留内存；保存后立即从 state 清掉。

## 首次启动引导

`App.tsx` boot 后如果 `config.profiles.length === 0`：
- 显示 onboarding 卡：「未配置 LLM，请先添加一个 provider」。
- 点击进 Settings 页。
- 保存并「测试连接」通过后才允许进主界面。

避免用户 clone 下来一脸懵、发消息报 401 不知道原因。

## Function Calling 兼容性

OpenAI-compatible 协议 tools/tool_choice 字段各家实现一致（DeepSeek 已验证）。后端透传即可，不用做协议翻译。Anthropic 走另一个 kind 分支时再单独适配 `tools` → `input_schema` 映射。

## 潜在陷阱

- **CORS**：不涉及，前端打自家 origin。生产模式 express 托管 web dist，同源；dev 模式 vite proxy `/api` 到 3001，也是同源视角。
- **超时**：LLM 请求可能几十秒；express 默认无 body 超时，注意别装 body-parser 全局超时中间件。前端 fetch 也要有可取消 controller。
- **多进程写 config.json**：目前单进程无问题；如果引入 pm2/cluster 需要文件锁。v6 单进程假设。
- **key 泄露路径**：后端日志绝对不能打完整 body。日志中间件 mask 掉 `Authorization` header。
- **model 字段污染**：如果前端 body 传 `model: "gpt-4"`，后端应无脑用 profile 的 model 覆盖，避免用户瞎传导致费用错乱。
