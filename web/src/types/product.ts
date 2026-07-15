/**
 * 产品档案（ProductProfile）— v6.6 四产品统一框架的核心抽象
 *
 * 会话级、锁定不可变的配置对象，描述「当前产品的四层规格」。
 * 它是 v6.6 一切模式差异的唯一真源（single source of truth）：
 *   - buildFunctionSpec 据它决定成文区暴露哪个 writer
 *   - 设计区各 Subagent 据 <product_profile> 注入的区间/语义生成结构
 *   - scene_beats Pipeline 据它注入场景数/节拍数/词库
 *   - validator 据它切换节拍词库与相邻同类型约束
 *
 * 守 INV-3：本文件独立于 types/index.ts，不污染既有 SkillSpec/SubagentSpec；
 * frontmatter parser 零变更（ProductProfile 是 TS 运行时常量，不经 frontmatter 解析）。
 */

/** 四种产品方向 */
export type ProductKind = 'novel' | 'screenplay' | 'long_drama' | 'short_drama'

/** 一层的规格：语义标签 + 数量约束 */
export interface LayerSpec {
  /** 该层在本产品中的显示语义（如短剧「幕」=全剧大阶段） */
  semantic: string
  /** 数量区间 [min, max]；子层相对父层的每单位数量 */
  countRange: [number, number]
  /** 硬约束描述（如短剧每幕恰 1 序列 → [1,1]） */
  note?: string
}

/**
 * validator 按产品切换的校验集合。
 *
 * 抽象边界（守 INV-1）：列数(7/6)、ID 正则、场景表结构四产品**完全相同**
 * （文件结构红线不变），故它们保留为 structuralChecks 内的共享常量、不进档案。
 * ValidationSet 只承载真正随产品变化的两项：节拍词库 + 相邻同类型约束开关。
 */
export interface ValidationSet {
  /** 允许的节拍主词集合（唯一强校验差异项） */
  beatTypeVocab: string[]
  /** 是否强制「同场景相邻不得同类型」（小说关闭，剧作类开启） */
  enforceAdjacentTypeRule: boolean
}

export interface ProductProfile {
  kind: ProductKind
  displayName: string // "小说" / "剧本" / "长剧脚本" / "短剧脚本"

  // === 四层语义 + 量级 ===
  act: LayerSpec // 幕
  sequence: LayerSpec // 序列（子层数量 = 每幕序列数）
  scene: LayerSpec // 场景（子层数量 = 每序列场景数）
  beat: LayerSpec // 节拍（子层数量 = 每场景节拍数）

  // === 叙事单位映射 ===
  sequenceToEpisode: 'none' | 'one_to_one' | 'one_to_many'
  // none=无集(小说/剧本); one_to_one=一序列一集(长剧); one_to_many=一序列多集(短剧)
  episodesPerSequence?: [number, number] // one_to_many 时有效（短剧 8-15）

  // === 伏笔 ===
  foreshadowingMaxLifespan: number // 伏笔最大寿命（以序列或集计）

  // === 成文 ===
  writerSubagentId: string // 绑定的成文 Subagent id
  proseUnit: 'chapter' | 'sequence' | 'episode' | 'sequence_of_episodes'
  narrativeMode: 'unfold' | 'pulse' // 展开式 / 脉冲式
  allowInnerMonologue: boolean // 是否允许心理描写（小说 true，其余 false）
  outputAnnotations: ('behavior_track' | 'shot_breakdown' | 'foreshadow')[]

  /** 成文一次调用产出是否可能超单次 LLM 稳定上限 → 是则启用分段续写（长剧按场景、短剧按集） */
  proseSplitUnit: 'none' | 'scene' | 'episode'

  // === 运行时记忆窗口（Wave 6 消费，供 LRU/裁剪档案化）===
  behaviorTrackWindow: number // behaviorTrack 保留条数（短剧 100 集需更大窗口）

  // === 校验 ===
  validation: ValidationSet
}

/**
 * 四产品默认档案（权威值，数量区间为草案初值可后续调参）。
 *
 * 关键：结构由档案给定、代码不写死。
 */
export const PRODUCT_PROFILES: Record<ProductKind, ProductProfile> = {
  novel: {
    kind: 'novel', displayName: '小说',
    act:      { semantic: '卷/部',    countRange: [1, 6] },
    sequence: { semantic: '章',       countRange: [3, 12] },   // 每卷章数
    scene:    { semantic: '场景/段落', countRange: [2, 6] },    // 每章场景
    beat:     { semantic: '叙事节拍',  countRange: [4, 10] },
    sequenceToEpisode: 'none',
    foreshadowingMaxLifespan: 30,
    writerSubagentId: 'prose_writer',
    proseUnit: 'chapter', narrativeMode: 'unfold',
    allowInnerMonologue: true,
    outputAnnotations: ['behavior_track', 'foreshadow'],
    proseSplitUnit: 'none', behaviorTrackWindow: 8,
    // 小说节拍是「叙事节拍」，不套剧作张力五分法，也不强制相邻不同类型
    validation: { beatTypeVocab: ['铺垫', '推进', '转折', '高潮', '沉淀', '留白'], enforceAdjacentTypeRule: false },
  },

  screenplay: {
    kind: 'screenplay', displayName: '剧本',
    act:      { semantic: '幕(经典三幕)', countRange: [3, 5] },
    sequence: { semantic: '序列',        countRange: [2, 6] },
    scene:    { semantic: '场',          countRange: [3, 8] },
    beat:     { semantic: '节拍',        countRange: [4, 10] },
    sequenceToEpisode: 'none',
    foreshadowingMaxLifespan: 20,
    writerSubagentId: 'prose_writer',
    proseUnit: 'sequence', narrativeMode: 'unfold',
    allowInnerMonologue: false,
    outputAnnotations: ['behavior_track', 'foreshadow'],
    proseSplitUnit: 'none', behaviorTrackWindow: 8,
    validation: { beatTypeVocab: ['铺垫', '触发', '对抗', '转折', '收束'], enforceAdjacentTypeRule: true },
  },

  long_drama: {
    kind: 'long_drama', displayName: '长剧脚本',
    act:      { semantic: '叙事大阶段', countRange: [3, 8] },
    sequence: { semantic: '集',        countRange: [2, 8], note: '一序列=一集' },
    scene:    { semantic: '场景',      countRange: [5, 10] },  // 一集 5-10 场景
    beat:     { semantic: '节拍',      countRange: [6, 10] },  // 每场景，单集总 30-100
    sequenceToEpisode: 'one_to_one',
    foreshadowingMaxLifespan: 20,
    writerSubagentId: 'prose_writer',
    proseUnit: 'episode', narrativeMode: 'unfold',
    allowInnerMonologue: false,
    outputAnnotations: ['behavior_track', 'foreshadow'],
    proseSplitUnit: 'scene', behaviorTrackWindow: 12,  // 单集 5-10 场景可能超限 → 按场景分段续写
    validation: { beatTypeVocab: ['铺垫', '触发', '对抗', '转折', '收束'], enforceAdjacentTypeRule: true },
  },

  short_drama: {
    kind: 'short_drama', displayName: '短剧脚本',
    act:      { semantic: '全剧大阶段', countRange: [3, 5] },
    sequence: { semantic: '多集弧',     countRange: [1, 1], note: '每幕恰含 1 序列' },
    scene:    { semantic: '集(一集一场景)', countRange: [8, 15] }, // 每序列 8-15 集
    beat:     { semantic: '四拍微循环',  countRange: [4, 6] },
    sequenceToEpisode: 'one_to_many',
    episodesPerSequence: [8, 15],
    foreshadowingMaxLifespan: 10,
    writerSubagentId: 'prose_writer',
    proseUnit: 'sequence_of_episodes', narrativeMode: 'pulse',
    allowInnerMonologue: false,
    outputAnnotations: ['behavior_track', 'shot_breakdown', 'foreshadow'],
    proseSplitUnit: 'episode', behaviorTrackWindow: 20,  // 一序列 8-15 集必超单次上限 → 按集分段续写
    validation: {
      beatTypeVocab: ['铺垫', '触发', '对抗', '转折', '收束', '钩子', '摩擦', '尖峰', '钉'],
      enforceAdjacentTypeRule: true,
    },
  },
}

/** 全部成文 writer 的 Subagent id（供 FC 裁剪 / Phase 判定 / target 协议统一引用）*/
export const WRITER_IDS: readonly string[] = Object.values(PRODUCT_PROFILES).map((p) => p.writerSubagentId)

/**
 * 将 ProductProfile 渲染为注入给 Subagent 的 <product_profile> XML 区段。
 *
 * 设计区与成文区共用此格式（守 INV-2：由 caller 经 appendExtraLabels 追加，
 * 不侵入 contextAssembler.assembleContext 本体）。
 */
export function renderProductProfileXml(profile: ProductProfile): string {
  const layer = (name: string, spec: LayerSpec) => {
    const [lo, hi] = spec.countRange
    const noteAttr = spec.note ? ` note="${spec.note}"` : ''
    return `  <layer name="${name}" semantic="${spec.semantic}" count="${lo}-${hi}"${noteAttr}/>`
  }
  const [eLo, eHi] = profile.episodesPerSequence ?? [0, 0]
  const episodeLine = profile.sequenceToEpisode === 'one_to_many'
    ? `\n  <sequence_to_episode>one_to_many（${eLo}-${eHi}集）</sequence_to_episode>`
    : `\n  <sequence_to_episode>${profile.sequenceToEpisode}</sequence_to_episode>`
  return [
    `<product_profile kind="${profile.kind}" name="${profile.displayName}">`,
    layer('幕', profile.act),
    layer('序列', profile.sequence),
    layer('场景', profile.scene),
    layer('节拍', profile.beat),
    episodeLine,
    `  <beat_vocab>${profile.validation.beatTypeVocab.join(',')}</beat_vocab>`,
    `  <foreshadowing_lifespan>${profile.foreshadowingMaxLifespan}</foreshadowing_lifespan>`,
    `  <narrative_mode>${profile.narrativeMode}</narrative_mode>`,
    `  <allow_inner_monologue>${profile.allowInnerMonologue}</allow_inner_monologue>`,
    `  <prose_unit>${profile.proseUnit}</prose_unit>`,
    `  <prose_split_unit>${profile.proseSplitUnit}</prose_split_unit>`,
    `</product_profile>`,
  ].join('\n')
}
