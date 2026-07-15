/**
 * structuralAudit.ts — 质检 subagent 语境的跨文件硬完整性校验（v7.3 新增）
 *
 * 功能：读取多个已落盘的设计资产文件，做跨文件引用完整性机械比对。
 * 与 structuralChecks.ts（validator 语境、校验单次 LLM 产出是否合规）完全解耦，
 * 不共享代码、不建立 import 依赖关系。
 *
 * 校验三个端点：
 *   1. 序列满足幕：act_map.md 的每个幕 ID 是否有 ≥1 个序列声明归属
 *   2. 场景满足序列：每个序列是否有对应场景层文件 + 场景 ID 格式与归属一致性
 *   3. 节拍满足场景：场景层文件里的每个场景 ID 是否在节拍层有对应节拍块
 */

/** 场景 ID 正则：SC-{序列ID}-{nn}，兼容 SC-S1-1-01 和 SC-3-1-01 两种格式（LLM 有时掉 S 前缀） */
const SCENE_ID_REGEX = /^SC-[A-Z0-9]+-\d+-\d{1,2}$/

export interface StructuralIssue {
  level: '序列满足幕' | '场景满足序列' | '节拍满足场景'
  sequenceId: string
  issueType: '缺失' | '悬空引用' | '格式错误'
  detail: string
}

/**
 * 全量结构审计：吃全部已落盘文件的内容映射，返回扁平化 issue 数组。
 *
 * 三级检查独立进行，结果合并后返回扁平数组（不按序列分组）。
 */
export function auditStructure(files: {
  actMap: string
  sequenceList: string
  sequenceFiles: Map<string, string>    // key = sequenceId, value = sequences/<ID>.md 内容
  sceneFiles: Map<string, string>       // key = sequenceId, value = scenes/<ID>.md 内容
  beatFiles: Map<string, string>        // key = sequenceId, value = beats/<ID>.md 内容
}): StructuralIssue[] {
  const issues: StructuralIssue[] = []

  // === 1. 序列满足幕 ===
  issues.push(...checkActsToSequences(files.actMap, files.sequenceList, files.sequenceFiles))

  // === 2. 场景满足序列 ===
  issues.push(...checkSequencesToScenes(files.sequenceFiles, files.sceneFiles))

  // === 3. 节拍满足场景 ===
  issues.push(...checkScenesToBeats(files.sceneFiles, files.beatFiles))

  return issues
}

/**
 * 单序列结构审计：只检查一个序列的三份文件是否闭合。
 * 供 outlineMerger.ts 合并链路复用（不引入全量扫描的性能开销）。
 */
export function auditStructureForSequence(
  seqId: string,
  files: { sequenceMd: string; sceneMd: string; beatMd: string },
): StructuralIssue[] {
  const issues: StructuralIssue[] = []

  // 场景满足序列（单序列）
  if (!files.sceneMd || files.sceneMd.trim().length === 0) {
    issues.push({
      level: '场景满足序列',
      sequenceId: seqId,
      issueType: '缺失',
      detail: `scenes/${seqId}.md 不存在或为空`,
    })
  } else {
    const sceneIds = extractSceneIdsFromMd(files.sceneMd)
    for (const scId of sceneIds) {
      if (!scId.startsWith(`SC-${seqId}-`)) {
        issues.push({
          level: '场景满足序列',
          sequenceId: seqId,
          issueType: '格式错误',
          detail: `场景 ID ${scId} 的前缀与文件名 scenes/${seqId}.md 不匹配`,
        })
      }
    }
  }

  // 节拍满足场景（单序列）
  if (!files.beatMd || files.beatMd.trim().length === 0) {
    issues.push({
      level: '节拍满足场景',
      sequenceId: seqId,
      issueType: '缺失',
      detail: `beats/${seqId}.md 不存在或为空`,
    })
  } else {
    const sceneIds = extractSceneIdsFromMd(files.sceneMd)
    const beatSceneIds = extractBeatSceneIdsFromMd(files.beatMd)
    // 场景层有但节拍层无
    for (const scId of sceneIds) {
      if (!beatSceneIds.has(scId)) {
        issues.push({
          level: '节拍满足场景',
          sequenceId: seqId,
          issueType: '缺失',
          detail: `场景 ${scId} 在节拍层 beats/${seqId}.md 中缺少节拍块`,
        })
      }
    }
    // 节拍层有但场景层无（悬空）
    for (const scId of beatSceneIds) {
      if (!sceneIds.includes(scId)) {
        issues.push({
          level: '节拍满足场景',
          sequenceId: seqId,
          issueType: '悬空引用',
          detail: `节拍层 beats/${seqId}.md 引用了不存在于场景层 scenes/${seqId}.md 的场景 ${scId}`,
        })
      }
    }
  }

  return issues
}

// ===== 三级检查内部实现 =====

/** 1. 序列满足幕 */
function checkActsToSequences(
  actMapMd: string,
  _sequenceListMd: string,
  sequenceFiles: Map<string, string>,
): StructuralIssue[] {
  const issues: StructuralIssue[] = []

  // 从 act_map.md 提取幕 ID
  const actIds = extractActIds(actMapMd)
  if (actIds.length === 0) {
    issues.push({
      level: '序列满足幕',
      sequenceId: '—',
      issueType: '缺失',
      detail: 'act_map.md 未解析出任何幕 ID',
    })
    return issues
  }

  // 从 sequences/*.md 每份文件中提取"所属幕"字段的引用
  const seqToAct = new Map<string, string>()
  for (const [seqId, content] of sequenceFiles) {
    // "所属幕：A{n}" 格式
    const m = content.match(/所属幕[：:]\s*(A\d+)/i)
    if (m) {
      seqToAct.set(seqId, m[1].toUpperCase())
    }
  }

  // 检查每个幕是否有序列
  for (const actId of actIds) {
    const hasSeq = [...seqToAct.values()].some((a) => a === actId)
    if (!hasSeq) {
      issues.push({
        level: '序列满足幕',
        sequenceId: actId,
        issueType: '缺失',
        detail: `幕 ${actId} 在 act_map.md 中声明但没有任何序列声明"所属幕"为该幕`,
      })
    }
  }

  // 检查是否有序列引用了不存在的幕（悬空）
  const actIdSet = new Set(actIds)
  for (const [seqId, actId] of seqToAct) {
    if (!actIdSet.has(actId)) {
      issues.push({
        level: '序列满足幕',
        sequenceId: seqId,
        issueType: '悬空引用',
        detail: `序列 ${seqId} 声明"所属幕"为 ${actId}，但该幕不在 act_map.md 中`,
      })
    }
  }

  return issues
}

/** 2. 场景满足序列 */
function checkSequencesToScenes(
  sequenceFiles: Map<string, string>,
  sceneFiles: Map<string, string>,
): StructuralIssue[] {
  const issues: StructuralIssue[] = []

  for (const [seqId] of sequenceFiles) {
    const sceneMd = sceneFiles.get(seqId)
    if (!sceneMd || sceneMd.trim().length === 0) {
      issues.push({
        level: '场景满足序列',
        sequenceId: seqId,
        issueType: '缺失',
        detail: `scenes/${seqId}.md 不存在或为空`,
      })
      continue
    }

    const sceneIds = extractSceneIdsFromMd(sceneMd)
    for (const scId of sceneIds) {
      if (!SCENE_ID_REGEX.test(scId)) {
        issues.push({
          level: '场景满足序列',
          sequenceId: seqId,
          issueType: '格式错误',
          detail: `场景 ID "${scId}" 不符合 SC-{序列ID}-{nn} 格式`,
        })
      } else if (!scId.startsWith(`SC-${seqId}-`)) {
        issues.push({
          level: '场景满足序列',
          sequenceId: seqId,
          issueType: '悬空引用',
          detail: `场景 ID ${scId} 的归属与文件名 scenes/${seqId}.md 不匹配`,
        })
      }
    }
  }

  // 检查是否有场景文件没有对应序列文件（悬空）
  for (const [seqId] of sceneFiles) {
    if (!sequenceFiles.has(seqId)) {
      issues.push({
        level: '场景满足序列',
        sequenceId: seqId,
        issueType: '悬空引用',
        detail: `scenes/${seqId}.md 存在但 sequences/${seqId}.md 不存在`,
      })
    }
  }

  return issues
}

/** 3. 节拍满足场景 */
function checkScenesToBeats(
  sceneFiles: Map<string, string>,
  beatFiles: Map<string, string>,
): StructuralIssue[] {
  const issues: StructuralIssue[] = []

  for (const [seqId, sceneMd] of sceneFiles) {
    if (!sceneMd || sceneMd.trim().length === 0) continue

    const beatMd = beatFiles.get(seqId)
    if (!beatMd || beatMd.trim().length === 0) {
      issues.push({
        level: '节拍满足场景',
        sequenceId: seqId,
        issueType: '缺失',
        detail: `beats/${seqId}.md 不存在或为空`,
      })
      continue
    }

    const sceneIds = extractSceneIdsFromMd(sceneMd)
    const beatSceneIds = extractBeatSceneIdsFromMd(beatMd)

    // 场景层有但节拍层无
    for (const scId of sceneIds) {
      if (!beatSceneIds.has(scId)) {
        issues.push({
          level: '节拍满足场景',
          sequenceId: seqId,
          issueType: '缺失',
          detail: `场景 ${scId} 在节拍层 beats/${seqId}.md 中缺少节拍块`,
        })
      }
    }

    // 节拍层有但场景层无（悬空）
    for (const scId of beatSceneIds) {
      if (!sceneIds.includes(scId)) {
        issues.push({
          level: '节拍满足场景',
          sequenceId: seqId,
          issueType: '悬空引用',
          detail: `节拍层 beats/${seqId}.md 引用了不存在于场景层 scenes/${seqId}.md 的场景 ${scId}`,
        })
      }
    }
  }

  // 检查是否有节拍文件没有对应场景文件（悬空）
  for (const [seqId] of beatFiles) {
    if (!sceneFiles.has(seqId)) {
      issues.push({
        level: '节拍满足场景',
        sequenceId: seqId,
        issueType: '悬空引用',
        detail: `beats/${seqId}.md 存在但 scenes/${seqId}.md 不存在`,
      })
    }
  }

  return issues
}

// ===== 辅助解析函数 =====

/** 从 act_map.md 文本中提取幕 ID 列表（如 A1, A2, A3） */
function extractActIds(md: string): string[] {
  const ids = new Set<string>()
  // 匹配 "A{n}" 格式（独立词边界）
  const re = /\b(A\d+)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    ids.add(m[1].toUpperCase())
  }
  return [...ids].sort()
}

/** 从 Markdown ## 标题中提取场景 ID */
function extractSceneIdsFromMd(md: string): string[] {
  const ids: string[] = []
  const re = /^##\s+(SC-[A-Z0-9]+-\d+-\d{1,2})\b/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    ids.push(m[1])
  }
  return ids
}

/** 从节拍文件 Markdown 中提取所有节拍块引用的场景 ID（去重集合） */
function extractBeatSceneIdsFromMd(md: string): Set<string> {
  const ids = new Set<string>()
  const re = /B-(SC-[A-Z0-9]+-\d+-\d{1,2})-\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    ids.add(m[1])
  }
  return ids
}
