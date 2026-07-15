// ===== Subagent / Skill 注册表（v5.3 四层框架） =====

/**
 * Subagent 身份卡（取代 v5 的 ToolSpec）
 *
 * 四层框架：Orchestrator → Subagent → Skill Router → Skill
 * Subagent 是 Orchestrator 通过 Function Calling 选择的单元，
 * 具体执行由其名下的 Skill 承载（见 SkillSpec）。
 * 磁盘表示：src/skills/<id>/subagent.md（frontmatter + 角色前缀正文）。
 */
export interface SubagentSpec {
  /** 唯一标识符，作为 Function Calling 的 function.name（= 目录名） */
  id: string

  /** 人类可读名称（前端展示用） */
  name: string

  /**
   * Subagent 描述（最关键字段）
   * 直接作为 function.description 传给 Orchestrator LLM，
   * LLM 据此决定是否调用此 Subagent。
   */
  description: string

  /** 前端分组展示标签（如 '基础设定'、'大纲结构'、'微观精铸'） */
  group: string

  /** 角色定位/任务规划/质量控制前缀，作为 Skill body 的前置 system prompt */
  preamble: string

  /** v7.3：预装 skillId 列表（宽泛 subagent 启动时整份拼入专属 messages 的 system 消息） */
  skills?: string[]

  /** v7.1 M5：来源标记（builtin=内置 glob，user=server/data/skills overlay） */
  source?: 'builtin' | 'user'
}

/**
 * Skill 身份卡（可复用能力）
 *
 * 磁盘表示：src/skills/<subagentId>/<skillId>/SKILL.md（frontmatter + system prompt 正文）。
 * 硬约束：Skill 不声明属主 Subagent —— 归属仅由目录路径决定。
 * per-skill I/O：reads/writes/outputTags 属于 Skill 而非 Subagent。
 */
export interface SkillSpec {
  /** 所属 Subagent（由目录路径推导，非 frontmatter 声明） */
  subagentId: string

  /** Skill 标识（= 子目录名） */
  skillId: string

  /** 人类可读名称 */
  name: string

  /** 供 Skill Router 在 ≥2 skill 时选择的描述 */
  description: string

  /** 可选：Skill Router 的确定性关键词命中 */
  when: string[]

  /**
   * 上下文隔离边界
   * 执行此 Skill 时，只读取这些文件注入上下文。
   */
  reads: string[]

  /** Skill 执行后写入的文件列表 */
  writes: string[]

  /** 输出校验 TAG 列表（<<<TAG_START>>> / <<<TAG_END>>>） */
  outputTags: string[]

  /** 所属 Subagent 的角色前缀（loader 组装时注入，供 executeTool 直接取用） */
  preamble: string

  /** Skill system prompt 正文 */
  body: string

  /** v7.1 M5：来源标记（builtin=内置 glob，user=server/data/skills overlay） */
  source?: 'builtin' | 'user'

  /** v7.3：该 Skill 目录下 references/*.md 的文件名列表（不含路径与 .md 后缀），供 read_reference 工具查询 */
  references?: string[]

  /**
   * v6.2 可选结构化校验钩子。
   *
   * validateOutput 在完成 START/END tag 提取后调用；返回 null 视作通过，返回 string
   * 则视作结构错误、消息将作为 retry 反馈追加到 userContent 尾部。
   *
   * 该钩子无法通过 SKILL.md frontmatter 声明（自研解析器只吃扁平标量+内联数组）。
   * 由 orchestratorEngine 在 runSingleStep / executeTool 内按 subagentId/skillId 动态挂载。
   *
   * 未定义 = 保持既有行为（仅 tag 存在性校验）。
   */
  structuralCheck?: (extracted: string) => string | null
}

// ===== 资产文件状态 =====

/** 卡片状态（简化 3 态，v4 取消了 approved/locked） */
export type AssetStatus = 'pending' | 'generated' | 'modified'

// ===== 资产间逻辑关系（v7.1 M6 预留，文件关系系统未实现功能） =====

/** 资产关系类型（预留枚举，文件关系系统后续启用） */
export type AssetRelationType = 'depends_on' | 'references' | 'derived_from'

/** 资产间逻辑关系（预留：当前无任何代码填充或消费此字段） */
export interface AssetRelation {
  /** 源资产路径 */
  from: string
  /** 目标资产路径 */
  to: string
  /** 关系类型 */
  type: AssetRelationType
  /** 可选备注 */
  note?: string
}

// ===== 资产文件信息 =====

/** 资产文件元信息（v4 去掉了 stage/agentId） */
export interface AssetFileInfo {
  path: string
  filename: string
  group: string
  exists: boolean
  /** v7.1 M6 预留：资产关系（init/refresh 不填充，文件关系系统未实现） */
  relations?: AssetRelation[]
}

/** 前端卡片展示数据（v4 去掉了 stage/isLocked） */
export interface AssetCardData {
  path: string
  filename: string
  group: string
  status: AssetStatus
  /** v6.4：是否被 Phase Gate 冻结（只读） */
  locked?: boolean
  /** v6.4：正文字数（仅 chapters/* 计算） */
  wordCount?: number
  /** v6.4：额外展示文本（如 "S1-1 所属"） */
  metaInfo?: string
}

// ===== 文件条目 =====

/** 文件内容条目 */
export interface FileEntry {
  path: string
  content: string
}

// ===== 对话消息 =====

/** 对话消息（v4 去掉了 agent 角色和 agentId） */
export interface ChatMessage {
  id: string
  role: 'user' | 'system'
  content: string
  timestamp: number
  /**
   * v7.1 改动3：消息类型。缺省（普通文本）；'stage_proposal' 时 ChatHistory 渲染 StageCard。
   */
  kind?: 'stage_proposal'
  /**
   * v7.1 改动3：StageCard 交互状态。'pending' 可点选；'resolved' 只读展示已选阶段。
   */
  stageState?: 'pending' | 'resolved'
  /**
   * v7.1 改动3：StageCard 用户点选后的落定阶段（resolved 时有值）。
   */
  resolvedStage?: 'designing' | 'writing'
}

/**
 * 传给引擎的轻量对话轮次（跨轮需求记忆，v5.5）
 *
 * chatStore 回传最近若干轮对话给引擎，用于解析指代性澄清
 * （如"那个再坚强点"）。role 映射：ChatMessage 的 system → assistant。
 */
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

// ===== 调度相关类型 =====

/** 单次 Tool 执行结果 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean

  /** 写入的文件列表（成功时） */
  writes?: string[]

  /** 错误信息（失败时） */
  error?: string

  /** Tool 输出内容 */
  output?: string

  /** v6.4：软校验警告 */
  warnings?: string[]

  /** 本次执行实际使用的 Skill ID（四层框架） */
  skillId?: string

  /** 本次执行实际使用的 Skill 名称 */
  skillName?: string
}

/** 调度引擎的运行时状态 */
export interface SchedulerState {
  /** 当前调度轮次 */
  currentRound: number

  /** 最大允许轮次（安全阀，非业务约束） */
  maxRounds: number

  /** 已调用的 Tool ID 列表 */
  toolsCalled: string[]

  /** 已执行的 Tool 结果 */
  toolResults: ToolResult[]
}

/** 一次 processUserInput 的整体结果 */
export interface DispatchResult {
  /** 整体调度是否成功 */
  success: boolean

  /** 每个 Tool 的执行结果 */
  results: ToolResult[]

  /** 最终回复消息 */
  response: string

  /**
   * v7.1 改动3：本轮结束时若引擎探测到"全部场记完成且仍处设计期"，置 true。
   * chatStore 据此在对话流追加一张 stage_proposal 消息（StageCard）。
   */
  stageProposal?: boolean
}

// ===== 执行事件（实时日志） =====

/** 执行事件类型 */
export type ExecutionEventType =
  | 'orchestrator_thinking'
  | 'tool_start'
  | 'tool_retry'
  | 'tool_complete'
  | 'tool_error'
  | 'subagent_loop_start'   // v7.3：宽泛 subagent 专属循环开始
  | 'subagent_loop_step'    // v7.3：专属循环内一轮 read_file/read_reference（可选，用于展示进度）
  | 'subagent_loop_complete' // v7.3：专属循环结束，取得最终文本
  | 'engine_complete'
  | 'engine_error'

/** 执行事件（实时日志条目） */
export interface ExecutionEvent {
  /** 事件类型 */
  type: ExecutionEventType

  /** 发生时间戳 */
  timestamp: number

  /** 当前调度轮次 */
  round?: number

  /** 最大调度轮次 */
  maxRounds?: number

  /** 工具 ID（现语义 = subagent id） */
  toolId?: string

  /** 工具名称（展示用，现语义 = subagent name） */
  toolName?: string

  /** 本次执行实际使用的 Skill ID（四层框架） */
  skillId?: string

  /** 本次执行实际使用的 Skill 名称（展示用） */
  skillName?: string

  /** 本次执行写入的文件列表（供 store 精准刷新资产） */
  writes?: string[]

  /** 当前重试次数 */
  attempt?: number

  /** 最大重试次数 */
  maxAttempts?: number

  /** 人类可读的中文描述 */
  message: string

  /** v6.4：软校验警告（非阻塞，提示用） */
  warnings?: string[]

  /** v7.2：本次调用的用户/编排指令摘要（tool_start 时截断，供时间线副标题展示） */
  instruction?: string
}

/** 执行事件回调 */
export type ExecutionEventCallback = (event: ExecutionEvent) => void

// ===== Diff =====

/** Diff 片段 */
export interface DiffPart {
  value: string
  added?: boolean
  removed?: boolean
}

// ===== 校验 =====

/** 输出校验结果 */
export interface ValidationResult {
  valid: boolean
  missingTags: string[]
  extracted: Record<string, string>
  /**
   * v6.2：结构化校验失败原因（SkillSpec.structuralCheck 返回的中文错误消息）。
   * 仅在 missingTags 为空但结构校验未通过时置位；供 retry 追加具体反馈使用。
   */
  structuralError?: string
}

// ===== IPC 接口（Phase 1b Electron，保留但简化） =====

/** 导入结果 */
export interface ImportResult {
  content: string
  filename: string
  format: 'md' | 'docx' | 'xlsx'
}

/** Electron Preload 暴露的 API（Phase 1b） */
export interface StoryAPI {
  readFile(filename: string): Promise<string>
  writeFile(filename: string, content: string): Promise<void>
  listAssetFiles(): Promise<AssetFileInfo[]>
  importFile(filePath: string): Promise<ImportResult>
}

/** 声明 window.storyAPI（Phase 1b） */
declare global {
  interface Window {
    storyAPI?: StoryAPI
  }
}
