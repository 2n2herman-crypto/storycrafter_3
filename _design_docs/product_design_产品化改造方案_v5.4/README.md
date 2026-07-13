# StoryCrafter 3 v5.4 前端视觉风格优化设计

> 版本：v5.4  
> 目标：参考 Ulysses 欢迎页的整体配色与美学气质，重塑 StoryCrafter 3 前端工作台视觉风格。  
> 范围：颜色、字体、阴影、边框、组件层级、交互动画与整体背景。  
> 约束：本阶段仅形成设计文档，不修改前端代码。

---

## 一、视觉方向

v5.4 的视觉基调从当前深色工具界面调整为 **米白色主背景 + 现代主义彩色点缀 + 纸张式工作台**。

参考图的核心特征：

1. 主背景为温暖米白，不使用纯白；
2. 大面积留白，界面显得安静、轻量；
3. 彩色元素集中在局部区域，使用蓝、红、黄、绿等高识别色块；
4. 阴影柔和、扩散半径大，制造轻微悬浮感；
5. 主按钮为低饱和浅橄榄/卡其色，和米白背景保持亲和；
6. 字体粗细对比明显，标题有重量，正文保持清晰克制；
7. 圆角较大但不玩具化，整体偏高级写作软件而非娱乐网站。

StoryCrafter 3 是创作工作台，不应做成营销页或装饰性页面。v5.4 要把参考图的审美转译为可长期使用的生产力界面：温暖、稳定、低干扰，但关键状态和操作足够清楚。

---

## 二、设计原则

### 1. 米白底色优先

全局背景改为暖米白，面板使用更浅的纸张白。避免大面积深色、纯白或高饱和渐变。

建议语义：

| 用途 | 建议颜色 | 说明 |
| --- | --- | --- |
| App 背景 | `#e9e6dc` | 温暖米白，接近参考图外部背景 |
| 主工作区背景 | `#f5f3ea` | 纸张感背景 |
| 面板背景 | `#fbfaf4` | 卡片/编辑面板 |
| 次级面板 | `#f0eee4` | 侧栏、底部栏 |
| 分割线 | `#ddd8c8` | 低对比边界 |
| 主文字 | `#171713` | 接近黑色但不刺眼 |
| 次级文字 | `#676356` | 温暖灰褐 |
| 弱文字 | `#9a9484` | 占位、辅助信息 |

### 2. 彩色只做结构与状态提示

参考图左侧彩色拼贴很有识别度，但 StoryCrafter 不适合大面积装饰。彩色应集中用于：

- Logo/品牌区小型色块；
- 资产卡片状态条；
- 当前选中资产强调；
- diff 增删高亮；
- 执行日志状态点；
- 主操作按钮 hover/active。

建议点缀色：

| 语义 | 颜色 | 用途 |
| --- | --- | --- |
| Ink Blue | `#5f6eb3` | 选中态、链接、可操作文本 |
| Vermilion | `#df4652` | 删除、错误、风险提示 |
| Marigold | `#f3b000` | 等待、处理中、重点提示 |
| Jade Green | `#46c774` | 成功、已完成 |
| Cyan | `#5fc0df` | 信息提示、辅助选中 |
| Olive Button | `#cbc895` | 主按钮默认态 |
| Olive Button Hover | `#d8d4a7` | 主按钮 hover |

彩色比例控制在整体界面的 10%-15%，背景与正文仍以米白和黑灰为主。

### 3. 纸张式面板，而非深色 IDE

当前四栏结构继续保留，但视觉表达从“暗色调试台”改为“多页稿纸并列”。

- 左侧聊天/任务区：像写作助手侧栏，背景略深于主面板；
- 资产卡片区：像资料索引，不做厚重卡片；
- Current/Baseline：像两张并列稿纸，强调阅读舒适度；
- 底部执行日志：像可折叠记录条，弱化存在感。

---

## 三、全局视觉 Token

建议在 `src/styles/global.css` 中逐步替换或新增语义变量。

```css
:root {
  --color-bg-primary: #e9e6dc;
  --color-bg-secondary: #f5f3ea;
  --color-bg-tertiary: #fbfaf4;
  --color-bg-hover: #efeadb;

  --color-text-primary: #171713;
  --color-text-secondary: #676356;
  --color-text-muted: #9a9484;

  --color-accent: #5f6eb3;
  --color-accent-hover: #4f5f9f;
  --color-success: #46c774;
  --color-warning: #f3b000;
  --color-danger: #df4652;
  --color-info: #5fc0df;

  --color-button-primary: #cbc895;
  --color-button-primary-hover: #d8d4a7;

  --shadow-soft: 0 18px 48px rgba(43, 39, 28, 0.12);
  --shadow-panel: 0 8px 24px rgba(43, 39, 28, 0.08);
  --shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.7);

  --radius-panel: 22px;
  --radius-card: 14px;
  --radius-control: 999px;
}
```

注意：组件内部不直接写死颜色，优先使用语义变量，方便后续主题扩展。

---

## 四、字体与排版

### 字体栈

继续使用系统字体，但中文优先适配苹果和 Windows：

```css
--font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif;
--font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Microsoft YaHei', sans-serif;
--font-mono: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
```

### 字重策略

- 顶部产品名/关键标题：`700-800`；
- 面板标题：`650-700`；
- 正文与 Markdown：`400-500`；
- 辅助信息：`400`，颜色降低对比。

### 阅读区排版

Markdown 内容区应更接近写作软件：

- 行高：`1.72`；
- 正文字号：`15px`；
- 段落最大宽度不强行收窄，适应当前面板宽度；
- 标题上下间距略大，形成稿件层级；
- 表格边框用浅米灰，表头背景用 `#f0eee4`。

---

## 五、组件改造方向

### 1. App 容器

- 背景使用 `--color-bg-primary`；
- 外层保留 100% 高宽；
- 主区域可增加 `12px-16px` 内边距，让四栏像浮在背景上的工作台；
- 避免使用纯黑分割线。

### 2. HeaderBar

目标：从 IDE 顶栏变成轻量品牌工具条。

设计要点：

- 背景：半透明米白或 `#f5f3ea`；
- 底部分割线：`1px solid #ddd8c8`；
- 左侧品牌可加入小型现代主义色块标识：蓝/红/黄/绿几何块；
- 标题文字加粗，字距保持 `0`；
- 右侧按钮使用胶囊形浅色控件。

### 3. MultiColumnLayout

目标：保持四栏效率，但降低机械感。

设计要点：

- 每列面板背景使用 `--color-bg-tertiary`；
- 面板之间留 `10px-12px` 缝隙；
- 面板圆角使用 `18px-22px`；
- 面板阴影使用柔和扩散阴影；
- 拖拽分隔条使用隐形热区，hover 时出现细色线；
- 分隔条 hover 色使用 `--color-accent` 的低透明度版本。

### 4. BottomPanel / 聊天区

目标：像写作助手输入台，不像控制台。

设计要点：

- 输入框背景：`#fbfaf4`；
- 输入框边框：`#d8d2bf`；
- focus 时边框变为 `#5f6eb3`，阴影为浅蓝外发光；
- 发送按钮使用浅橄榄胶囊按钮；
- 执行日志状态点使用彩色小圆点；
- 正在处理时使用轻微 pulse 动画，不使用强烈闪烁。

### 5. AssetCardPanel

目标：像资料卡索引，强调可扫描性。

设计要点：

- 卡片背景与面板背景接近，不做厚重嵌套卡片；
- 每张资产卡左侧加 4px 彩色状态条；
- selected 状态使用浅蓝米色背景 `#eceff8`；
- hover 使用 `transform: translateY(-1px)` 和轻微阴影；
- 状态名称用小号文字，避免大面积彩色标签；
- 内部文件仍隐藏，保持当前产品逻辑。

### 6. CurrentPanel / BaselinePanel

目标：两张并列稿纸，当前稿与基线稿对比清楚。

设计要点：

- 面板背景 `#fbfaf4`；
- 内容区背景不再深色；
- 标题栏底色 `#f0eee4`；
- 空态使用淡灰褐文字；
- loading 态使用浅橄榄骨架屏或细线动画；
- Markdown 标题、列表、表格统一暖色系边框。

### 7. DiffViewer

目标：保留差异可读性，避免红绿刺眼。

建议：

```css
--color-diff-add: rgba(70, 199, 116, 0.18);
--color-diff-remove: rgba(223, 70, 82, 0.16);
```

- `ins` 使用浅绿背景 + 深绿下划线；
- `del` 使用浅红背景 + 删除线；
- 不使用高饱和整块红绿。

---

## 六、交互动画规范

动效要轻，服务于状态反馈。

| 场景 | 动效 | 参数建议 |
| --- | --- | --- |
| 按钮 hover | 背景变亮 + 上浮 | `150ms ease-out`, `translateY(-1px)` |
| 卡片 hover | 微上浮 + 阴影增强 | `180ms ease-out` |
| 面板出现 | 透明度 + 轻微位移 | `220ms ease-out` |
| 正在生成 | 状态点 pulse | `1.4s ease-in-out infinite` |
| 拖拽分隔条 | 色线淡入 | `120ms ease-out` |
| 输入框 focus | 边框与外阴影过渡 | `160ms ease-out` |

统一使用：

```css
transition:
  background-color 160ms ease-out,
  border-color 160ms ease-out,
  box-shadow 160ms ease-out,
  transform 160ms ease-out;
```

避免大幅缩放、旋转、弹跳和长时间循环动画。

---

## 七、页面层级建议

v5.4 推荐视觉层级：

1. `body`：暖米白背景；
2. `app-container`：轻微内边距；
3. `HeaderBar`：浅米色顶栏；
4. 四栏面板：纸张白 + 柔和阴影；
5. 资产卡/输入框/按钮：在面板内用浅边框表达；
6. 彩色状态：只用于点、边条、选中态和 diff。

这样可以保留专业工具效率，同时接近参考图的欢迎页气质。

---

## 八、实施顺序建议

### 第一阶段：全局主题变量

修改：

- `src/styles/global.css`
- `src/styles/layout.css`
- `src/styles/diff.css`

目标：先完成米白底色、字体、基础颜色、滚动条和 diff 色彩。

### 第二阶段：布局与面板

修改：

- `src/components/Layout/MultiColumnLayout.tsx`
- `src/components/Layout/DiffLayout.module.css` 或当前替代样式文件
- `src/components/Layout/HeaderBar.tsx`
- 对应 CSS Module

目标：完成四栏纸张式工作台、圆角、间距、柔和阴影。

### 第三阶段：资产卡与聊天区

修改：

- `src/components/Layout/AssetCardPanel.tsx`
- `src/components/BottomBar/BottomPanel.tsx`
- 对应 CSS Module

目标：完成状态色条、浅色输入框、橄榄主按钮、处理状态动画。

### 第四阶段：阅读体验和细节

修改：

- `src/components/DiffViewer.tsx`
- Markdown 渲染相关样式
- 空态、loading 态、hover/focus 态

目标：提升长文阅读体验和差异对比舒适度。

---

## 九、验收标准

1. 页面主背景明显为米白色，而不是深色或纯白；
2. 四栏仍保持高效工作台结构，不变成落地页；
3. 彩色只作为结构和状态提示，不喧宾夺主；
4. 面板有柔和悬浮感，但阴影不脏、不重；
5. 输入、按钮、卡片、拖拽分隔条都有清晰 hover/focus 状态；
6. Markdown 长文本阅读舒适，表格和 diff 在浅色主题下清晰；
7. 移动或窄屏下文字不溢出，按钮不挤压变形；
8. 不新增第三方 UI 库，仅通过现有 CSS Module 和全局样式完成。

---

## 十、非目标

v5.4 本轮不处理：

- 多主题切换；
- 登录页或欢迎页；
- 新增品牌插画；
- 修改 Orchestrator / Subagent / Skill 逻辑；
- 修改资产数据结构；
- 引入 Tailwind、组件库或动画库。

本设计只定义前端视觉升级方向，后续实现应保持小步提交，优先复用现有组件与 CSS Module。
