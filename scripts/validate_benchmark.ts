/**
 * 基准集人工标注文件的生成与校验（Task 49）。
 *
 * buildExpected / validateExpected 是纯函数：不读写磁盘、不含时间/随机/网络，
 * 可被单元测试直接调用并注入篡改后的副本。只有被 CLI 直接运行时才读取语料、
 * 输出中文报告并按需写出 expected.json。
 *
 * 用法（项目根目录执行）：
 *   pnpm tsx scripts/validate_benchmark.ts               校验并打印报告，异常退出码非 0
 *   pnpm tsx scripts/validate_benchmark.ts --regenerate  从语料确定性重建 expected.json 后校验
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 词表与口径常量
// ---------------------------------------------------------------------------

/** 三态动作词表，与 src/core/types.ts 的 Action / src/core/constants.ts 的 ACTIONS 对齐。 */
export const ACTIONS = ['create', 'merge', 'uncertain'] as const
export type ExpectedAction = (typeof ACTIONS)[number]

/** 5 类干扰类别，与 MANIFEST.category_distribution 对齐。 */
export const CATEGORIES = ['同义改名', '同名异规格', '换单位', '停用码', '医保码错配'] as const
export type Category = (typeof CATEGORIES)[number]
/** 每类最少标注条数。 */
export const MIN_PER_CATEGORY = 30

/**
 * 存疑理由词表，与 src/core/types.ts 的 UncertainReason 非空成员一一对应。
 * 这里内联而非 import '@core/types'，保证本脚本可被 tsx 独立运行。
 */
export const UNCERTAIN_REASONS = [
  '多义命中',
  '关键字段缺失',
  '无近似项',
  '版本冲突',
  '模型输出不合法',
  '检索失败',
  '模型不可用',
  '命中记录均已停用',
] as const

/**
 * 语料 source_note 的「期望=」→ 本基准集动作词表的归一映射。
 * 语料用 non-merge 表达「绝不能并」，其落库动作是 create（新建），
 * 与 gate-cases GC-03 / GC-14 / GC-15 的 no-match → create 口径一致。
 */
export const EXPECTATION_MAPPING: Record<string, ExpectedAction> = {
  merge: 'merge',
  'non-merge': 'create',
  create: 'create',
  uncertain: 'uncertain',
}

/** 类别 → gate-cases 参考用例类别与应有口径。 */
export interface GateAlignment {
  /** 用于对齐的 gate-case category 集合（可多于一个）。 */
  gateCategories: string[]
  expectedAction: ExpectedAction
  /** uncertain 类别必须采用的存疑理由。 */
  expectedReason?: string
  /** 无同名 gate-case 时的对齐依据说明。 */
  rationale?: string
}

export const GATE_ALIGNMENT: Record<Category, GateAlignment> = {
  同义改名: { gateCategories: ['同义改名'], expectedAction: 'merge' },
  同名异规格: { gateCategories: ['同名异规格'], expectedAction: 'create' },
  换单位: { gateCategories: ['换单位'], expectedAction: 'merge' },
  停用码: {
    gateCategories: ['停用码命中'],
    expectedAction: 'uncertain',
    expectedReason: '命中记录均已停用',
  },
  医保码错配: {
    gateCategories: ['无近似项', '域不匹配'],
    expectedAction: 'create',
    rationale:
      'gate-cases 无同名用例；医保码「全局无匹配」等价于无近似项 / 域不匹配过滤的 no-match → create 口径（GC-14、GC-15）',
  },
}

/** 降级为 uncertain 时允许的兜底理由，须同时登记到 degraded_candidate_ids 并写 notes。 */
const DEGRADATION_REASONS = new Set(['无近似项', '关键字段缺失'])

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

/** 校验脚本接收的语料形状（由 CLI 从 JSON 读入，测试可构造任意副本）。 */
export interface BenchmarkCorpus {
  master: any[]
  candidates: any[]
  manifest?: any
}

export interface GateCase {
  name?: string
  category?: string
  candidate?: { candidate_id?: string; [key: string]: any }
  expected?: { gate?: string; action?: string; target_code?: string | null; reason?: string }
  [key: string]: any
}

export interface GateCasesInput {
  version?: number
  cases: GateCase[]
}

/** 单条人工标注。notes 仅在降级为 uncertain 时给出非空说明。 */
export interface BenchmarkAnnotation {
  candidate_id: string
  expected_action: ExpectedAction
  expected_target_code: string | null
  expected_reason: string | null
  category: string
  source_note: string
  notes: string | null
}

export interface BenchmarkExpected {
  version: number
  source: string
  annotation_method: string
  dataset_ref: Record<string, any>
  counts: {
    total: number
    by_category: Record<string, number>
    by_action: Record<ExpectedAction, number>
  }
  expectation_mapping: Record<string, ExpectedAction>
  degraded_candidate_ids: string[]
  notes: string
  annotations: BenchmarkAnnotation[]
}

export interface ParsedNote {
  category: string
  counterpart: string | null
  expectation: string | null
  explanation: string
}

export interface ValidationSummary {
  total_annotations: number
  total_candidates: number
  by_category: Record<string, number>
  by_action: Record<string, number>
  merge_targets_resolved: number
  gate_overlap_count: number
  degraded_count: number
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** 可读的中文报告行，CLI 与测试均可使用。 */
  report: string[]
  summary: ValidationSummary
}

interface DerivationResult {
  annotation: BenchmarkAnnotation
  degraded: boolean
}

const isObject = (value: any): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------
// 纯函数：解析与确定性推导
// ---------------------------------------------------------------------------

/** 解析 source_note 的管道分隔字段；缺项暴露为 null，不猜测默认值。 */
export function parseSourceNote(sourceNote: unknown): ParsedNote {
  const parts = String(sourceNote ?? '').split('|')
  const field = (prefix: string): string | null => {
    const hit = parts.find((p) => p.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : null
  }
  return {
    category: parts[0] ?? '',
    counterpart: field('对照记录='),
    expectation: field('期望='),
    explanation: field('说明=') ?? '',
  }
}

/**
 * 从单条候选确定性推导人工标注。
 * 期望值无法归一、或对照记录无法解析时，一律降级为 uncertain 并在 notes 记录决策，
 * 保证任何候选都不会缺标注行。
 */
export function deriveAnnotation(candidate: any, masterByRecordId: Map<string, any>): DerivationResult {
  const note = String(candidate?.source_note ?? '')
  const parsed = parseSourceNote(note)
  const counterpartRecord = parsed.counterpart ? masterByRecordId.get(parsed.counterpart) : undefined
  const targetCode = typeof counterpartRecord?.code === 'string' && counterpartRecord.code.length > 0
    ? counterpartRecord.code
    : null
  const base = {
    candidate_id: String(candidate?.candidate_id ?? ''),
    category: parsed.category,
    source_note: note,
  }

  const action = parsed.expectation ? EXPECTATION_MAPPING[parsed.expectation] : undefined
  if (!action) {
    return {
      annotation: {
        ...base,
        expected_action: 'uncertain',
        expected_target_code: null,
        expected_reason: '关键字段缺失',
        notes: `期望= 取值${parsed.expectation ? `「${parsed.expectation}」` : '缺失'}无法归一到 create/merge/uncertain，降级为存疑并转人工复核`,
      },
      degraded: true,
    }
  }

  if (!targetCode) {
    return {
      annotation: {
        ...base,
        expected_action: 'uncertain',
        expected_target_code: null,
        expected_reason: '无近似项',
        notes: `对照记录=${parsed.counterpart ?? '缺失'} 无法在主数据中解析出 code，无法给出可信结论，降级为存疑并转人工复核`,
      },
      degraded: true,
    }
  }

  const aligned = CATEGORIES.includes(parsed.category as Category)
    ? GATE_ALIGNMENT[parsed.category as Category]
    : undefined
  return {
    annotation: {
      ...base,
      expected_action: action,
      expected_target_code: action === 'merge' ? targetCode : null,
      expected_reason: action === 'uncertain' ? (aligned?.expectedReason ?? '多义命中') : null,
      notes: null,
    },
    degraded: false,
  }
}

// ---------------------------------------------------------------------------
// 纯函数：生成与校验
// ---------------------------------------------------------------------------

/**
 * 从语料全量生成人工标注文件。纯函数、无副作用、无时间戳，
 * 相同输入必得相同输出，可由 --regenerate 复现。
 */
export function buildExpected(corpus: BenchmarkCorpus): BenchmarkExpected {
  const master = Array.isArray(corpus?.master) ? corpus.master : []
  const candidates = Array.isArray(corpus?.candidates) ? corpus.candidates : []
  const masterByRecordId = new Map<string, any>()
  for (const record of master) {
    const id = record?.record_id
    if (typeof id === 'string' && !masterByRecordId.has(id)) masterByRecordId.set(id, record)
  }

  const annotations: BenchmarkAnnotation[] = []
  const degradedCandidateIds: string[] = []
  for (const candidate of candidates) {
    const { annotation, degraded } = deriveAnnotation(candidate, masterByRecordId)
    annotations.push(annotation)
    if (degraded) degradedCandidateIds.push(annotation.candidate_id)
  }

  const byCategory: Record<string, number> = {}
  const byAction: Record<ExpectedAction, number> = { create: 0, merge: 0, uncertain: 0 }
  for (const annotation of annotations) {
    byCategory[annotation.category] = (byCategory[annotation.category] ?? 0) + 1
    byAction[annotation.expected_action] = (byAction[annotation.expected_action] ?? 0) + 1
  }

  return {
    version: 1,
    source: 'synthetic-simulator',
    annotation_method:
      '逐条读取 candidates.json 的 source_note，解析「类别 / 对照记录 / 期望 / 说明」；以对照记录的 record_id 在 master-data.json 解析其 code 作为 merge 目标；语料「期望=」按 expectation_mapping 归一到三态动作（non-merge → create，对齐 gate-cases GC-03 / GC-14 / GC-15 的 no-match → create）；uncertain 的 expected_reason 采用 src/core/types.ts 的 UncertainReason 词表，停用码对齐 GC-08「命中记录均已停用」。期望值无法归一或对照记录无法解析时降级为 uncertain，在 notes 记录决策并登记 degraded_candidate_ids。全量推导不含时间戳、随机源或网络调用，可由 --regenerate 确定性重建。',
    dataset_ref: {
      master_data: 'tests/fixtures/corpus/master-data.json',
      candidates: 'tests/fixtures/corpus/candidates.json',
      gate_cases: 'tests/fixtures/gate-cases.json',
      manifest: 'tests/fixtures/corpus/MANIFEST.json',
      manifest_version: corpus?.manifest?.manifest_version ?? null,
      deterministic_seed: corpus?.manifest?.deterministic_seed ?? null,
      master_data_count: master.length,
      candidate_count: candidates.length,
    },
    counts: {
      total: annotations.length,
      by_category: byCategory,
      by_action: byAction,
    },
    expectation_mapping: EXPECTATION_MAPPING,
    degraded_candidate_ids: degradedCandidateIds,
    notes:
      `全量 ${annotations.length} 条候选均已标注，无缺行；降级存疑 ${degradedCandidateIds.length} 条。` +
      'merge 行的 expected_target_code 为对照记录 code；create / uncertain 行为 null（source_note 中的对照记录仅作「不应并入」的反例，不登记为目标）。' +
      '同名异规格与医保码错配的语料期望为 non-merge，按 gate-cases 口径归一为 create；医保码错配无同名 gate-case，按「医保码全局无匹配 → no-match → create」对齐 GC-14 与 GC-15。',
    annotations,
  }
}

const countsEqual = (actual: Record<string, number>, declared: Record<string, number>): boolean => {
  const a = Object.keys(actual).sort()
  const b = Object.keys(declared).sort()
  return a.length === b.length && a.every((key, i) => b[i] === key && actual[key] === declared[key])
}

/**
 * 校验人工标注文件。纯函数：不读文件、不打印、不修改入参。
 * 任何违规都写入 errors 并使 ok=false，同时给出可读中文报告行。
 */
export function validateExpected(
  expected: any,
  corpus: BenchmarkCorpus,
  gateCases: GateCasesInput,
): ValidationResult {
  const candidates = Array.isArray(corpus?.candidates) ? corpus.candidates : []
  const master = Array.isArray(corpus?.master) ? corpus.master : []
  const cases = Array.isArray(gateCases?.cases) ? gateCases.cases : []

  const masterByRecordId = new Map<string, any>()
  const masterCodes = new Set<string>()
  for (const record of master) {
    if (typeof record?.record_id === 'string') masterByRecordId.set(record.record_id, record)
    if (typeof record?.code === 'string') masterCodes.add(record.code)
  }
  const candidateById = new Map<string, any>()
  for (const candidate of candidates) {
    if (typeof candidate?.candidate_id === 'string' && !candidateById.has(candidate.candidate_id)) {
      candidateById.set(candidate.candidate_id, candidate)
    }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const report: string[] = []
  const summary: ValidationSummary = {
    total_annotations: Array.isArray(expected?.annotations) ? expected.annotations.length : 0,
    total_candidates: candidates.length,
    by_category: {},
    by_action: {},
    merge_targets_resolved: 0,
    gate_overlap_count: 0,
    degraded_count: 0,
  }

  const section = (title: string): void => {
    report.push('', `[${title}]`)
  }
  const info = (text: string): void => {
    report.push(`  ${text}`)
  }
  const record = (label: string, detail: string, ok: boolean): void => {
    report.push(`  ${label}：${detail} ${ok ? '[OK]' : '[异常]'}`)
    if (!ok) errors.push(`${label}：${detail}`)
  }
  const issue = (message: string): void => {
    errors.push(message)
    report.push(`    - ${message}`)
  }
  const finish = (): ValidationResult => {
    report.push('')
    report.push(errors.length === 0
      ? `===== 结论：全部 ${summary.total_annotations} 条标注校验通过 =====`
      : `===== 结论：发现 ${errors.length} 处异常，校验未通过 =====`)
    return { ok: errors.length === 0, errors, warnings, report, summary }
  }

  report.push('===== 基准集人工标注校验报告 =====')
  report.push(`标注文件：tests/fixtures/benchmark/expected.json`)
  report.push(`语料规模：候选 ${candidates.length} 条 / 主数据 ${master.length} 条 / gate-cases ${cases.length} 条`)

  // --- 顶层结构 -------------------------------------------------------------
  section('顶层结构与元数据')
  record('expected 为对象', isObject(expected) ? '对象' : String(expected), isObject(expected))
  if (!isObject(expected)) return finish()
  record('version', JSON.stringify(expected.version), Number.isInteger(expected.version) && expected.version > 0)
  record('source', String(expected.source), typeof expected.source === 'string' && expected.source.length > 0)
  const method = String(expected.annotation_method ?? '')
  record('annotation_method', `长度 ${method.length}`, method.length > 0)
  record('dataset_ref', isObject(expected.dataset_ref) ? '对象' : '缺失或非对象', isObject(expected.dataset_ref))
  record('counts', isObject(expected.counts) ? '对象' : '缺失或非对象', isObject(expected.counts))
  const annotations = expected.annotations
  record('annotations 为数组', Array.isArray(annotations) ? `${annotations.length} 条` : '缺失或非数组', Array.isArray(annotations))
  if (!Array.isArray(annotations)) return finish()

  // --- 规模与类别分布 -------------------------------------------------------
  section('规模与类别分布')
  record('标注总数 == 候选总数', `${annotations.length} / ${candidates.length}`, annotations.length === candidates.length)
  const byCategory: Record<string, number> = {}
  const byAction: Record<string, number> = {}
  for (const annotation of annotations) {
    const cat = typeof annotation?.category === 'string' ? annotation.category : '<无效类别>'
    const act = typeof annotation?.expected_action === 'string' ? annotation.expected_action : '<无效动作>'
    byCategory[cat] = (byCategory[cat] ?? 0) + 1
    byAction[act] = (byAction[act] ?? 0) + 1
    summary.by_category[cat] = (summary.by_category[cat] ?? 0) + 1
    summary.by_action[act] = (summary.by_action[act] ?? 0) + 1
  }
  for (const category of CATEGORIES) {
    const count = byCategory[category] ?? 0
    record(`类别「${category}」`, `${count} 条（阈值 >= ${MIN_PER_CATEGORY}）`, count >= MIN_PER_CATEGORY)
  }
  const unknownCategories = Object.keys(byCategory).filter(
    (cat) => !(CATEGORIES as readonly string[]).includes(cat),
  )
  record('无未知干扰类别', unknownCategories.length === 0 ? '5 类齐全' : unknownCategories.join('、'), unknownCategories.length === 0)

  if (isObject(expected.counts)) {
    const declaredCategories = isObject(expected.counts.by_category) ? expected.counts.by_category : {}
    const declaredActions = isObject(expected.counts.by_action) ? expected.counts.by_action : {}
    record('counts.total 与实际一致', `${expected.counts.total} / ${annotations.length}`, expected.counts.total === annotations.length)
    record('counts.by_category 与实际一致', JSON.stringify(declaredCategories), countsEqual(byCategory, declaredCategories))
    record('counts.by_action 与实际一致', JSON.stringify(declaredActions), countsEqual(byAction, declaredActions))
  }

  // --- 一一对应与字段完整性 -------------------------------------------------
  section('逐条完整性与一一对应')
  const annotationsByCandidate = new Map<string, any[]>()
  for (const annotation of annotations) {
    const id = annotation?.candidate_id
    if (typeof id === 'string' && id.length > 0) {
      annotationsByCandidate.set(id, [...(annotationsByCandidate.get(id) ?? []), annotation])
    } else {
      issue(`存在空或非法 candidate_id 的标注行：${JSON.stringify(annotation).slice(0, 100)}`)
    }
  }
  let missing = 0
  let duplicated = 0
  let orphan = 0
  let emptyAction = 0
  let invalidAction = 0
  let badCategory = 0
  let badSourceNote = 0
  let badFieldType = 0
  for (const id of candidateById.keys()) {
    const hits = annotationsByCandidate.get(id) ?? []
    if (hits.length === 0) {
      missing += 1
      issue(`候选 ${id} 缺标注行`)
    } else if (hits.length > 1) {
      duplicated += 1
      issue(`候选 ${id} 有 ${hits.length} 条重复标注`)
    }
  }
  for (const id of annotationsByCandidate.keys()) {
    if (!candidateById.has(id)) {
      orphan += 1
      issue(`标注 ${id} 在 candidates.json 中不存在`)
    }
  }
  for (const annotation of annotations) {
    const id = String(annotation?.candidate_id)
    const action = annotation?.expected_action
    if (typeof action !== 'string' || action.length === 0) {
      emptyAction += 1
      issue(`候选 ${id} 的 expected_action 缺失或为空`)
    } else if (!(ACTIONS as readonly string[]).includes(action)) {
      invalidAction += 1
      issue(`候选 ${id} 的 expected_action「${action}」不在词表 create/merge/uncertain 内`)
    }
    if (typeof annotation?.category !== 'string' || annotation.category.length === 0) {
      badCategory += 1
      issue(`候选 ${id} 的 category 缺失或为空`)
    }
    const note = annotation?.source_note
    const corpusNote = candidateById.get(id)?.source_note
    if (typeof note !== 'string' || note.length === 0) {
      badSourceNote += 1
      issue(`候选 ${id} 的 source_note 缺失或为空`)
    } else if (typeof corpusNote === 'string' && note !== corpusNote) {
      badSourceNote += 1
      issue(`候选 ${id} 的 source_note 与语料不一致`)
    }
    if (
      (annotation?.expected_target_code !== null && typeof annotation?.expected_target_code !== 'string') ||
      (annotation?.expected_reason !== null && typeof annotation?.expected_reason !== 'string') ||
      (annotation?.notes !== null && annotation?.notes !== undefined && typeof annotation?.notes !== 'string')
    ) {
      badFieldType += 1
      issue(`候选 ${id} 的 expected_target_code / expected_reason / notes 字段类型非法`)
    }
  }
  record('每条候选恰好一条标注', `缺 ${missing} / 重 ${duplicated} / 孤立 ${orphan}`, missing + duplicated + orphan === 0)
  record('expected_action 非空且词表合法', `空 ${emptyAction} / 非法 ${invalidAction}`, emptyAction + invalidAction === 0)
  record('category 与 source_note 完整且忠于语料', `类别 ${badCategory} / 注释 ${badSourceNote}`, badCategory + badSourceNote === 0)
  record('字段类型合法', `异常 ${badFieldType}`, badFieldType === 0)

  // --- 结论字段与可解析性 ---------------------------------------------------
  section('结论字段与可解析性')
  const gateActions = new Set<string>()
  const gateReasons = new Set<string>()
  for (const gateCase of cases) {
    const action = gateCase?.expected?.action
    const reason = gateCase?.expected?.reason
    if (typeof action === 'string' && action.length > 0) gateActions.add(action)
    if (typeof reason === 'string' && reason.length > 0) gateReasons.add(reason)
  }
  for (const action of gateActions) {
    if (!(ACTIONS as readonly string[]).includes(action)) issue(`gate-cases 动作「${action}」不在三态词表`)
  }
  for (const reason of gateReasons) {
    if (!(UNCERTAIN_REASONS as readonly string[]).includes(reason)) issue(`gate-cases 存疑理由「${reason}」不在词表`)
  }
  record('gate-cases 动作词表对齐', [...gateActions].sort().join(' / '), [...gateActions].every((a) => (ACTIONS as readonly string[]).includes(a)))
  record('gate-cases 存疑理由词表对齐', [...gateReasons].sort().join(' / '), [...gateReasons].every((r) => (UNCERTAIN_REASONS as readonly string[]).includes(r)))

  let mergeCount = 0
  let resolved = 0
  let badMerge = 0
  let badNonMerge = 0
  let badReason = 0
  for (const annotation of annotations) {
    const id = String(annotation?.candidate_id)
    const action = annotation?.expected_action
    if (!(ACTIONS as readonly string[]).includes(action)) continue
    if (action === 'merge') {
      mergeCount += 1
      const code = annotation.expected_target_code
      const parsed = parseSourceNote(candidateById.get(id)?.source_note)
      const expectedCode = parsed.counterpart ? masterByRecordId.get(parsed.counterpart)?.code : undefined
      if (typeof code !== 'string' || code.length === 0 || !masterCodes.has(code)) {
        badMerge += 1
        issue(`候选 ${id} 的 merge 目标码「${String(code)}」无法在主数据 code 中解析`)
      } else {
        resolved += 1
        if (expectedCode !== code) {
          badMerge += 1
          issue(`候选 ${id} 的 merge 目标码与对照记录解析结果不一致（应为「${String(expectedCode)}」）`)
        }
      }
    } else if (annotation.expected_target_code !== null) {
      badNonMerge += 1
      issue(`候选 ${id} 为 ${action} 但 expected_target_code 非 null`)
    }
    if (action === 'uncertain') {
      const reason = annotation.expected_reason
      if (typeof reason !== 'string' || reason.length === 0 || !(UNCERTAIN_REASONS as readonly string[]).includes(reason)) {
        badReason += 1
        issue(`候选 ${id} 的存疑理由「${String(reason)}」非法`)
      } else if (!gateReasons.has(reason) && !DEGRADATION_REASONS.has(reason)) {
        badReason += 1
        issue(`候选 ${id} 的存疑理由「${reason}」既不在 gate-cases 口径也非已知降级理由`)
      }
    } else if (annotation.expected_reason !== null) {
      badReason += 1
      issue(`候选 ${id} 为 ${action} 但 expected_reason 非 null`)
    }
  }
  summary.merge_targets_resolved = resolved
  record('merge 目标码可解析且忠于对照记录', `${resolved} / ${mergeCount}`, badMerge === 0 && mergeCount > 0)
  record('create / uncertain 目标码为 null', `违规 ${badNonMerge}`, badNonMerge === 0)
  record('存疑理由词表与口径对齐', `违规 ${badReason}`, badReason === 0)

  // --- 降级存疑记录 ---------------------------------------------------------
  section('降级存疑记录')
  const degradedIds = Array.isArray(expected.degraded_candidate_ids)
    ? expected.degraded_candidate_ids.filter((id: unknown): id is string => typeof id === 'string')
    : []
  const degradedSet = new Set(degradedIds)
  let badDegraded = 0
  for (const id of degradedSet) {
    const annotation = (annotationsByCandidate.get(id) ?? [])[0]
    if (!annotation) {
      badDegraded += 1
      issue(`降级候选 ${id} 无标注行`)
      continue
    }
    if (annotation.expected_action !== 'uncertain') {
      badDegraded += 1
      issue(`降级候选 ${id} 未标为 uncertain`)
    }
    if (typeof annotation.notes !== 'string' || annotation.notes.length === 0) {
      badDegraded += 1
      issue(`降级候选 ${id} 未在 notes 记录降级决策`)
    }
    if (annotation.expected_target_code !== null) {
      badDegraded += 1
      issue(`降级候选 ${id} 的 expected_target_code 应为 null`)
    }
  }
  for (const annotation of annotations) {
    if (typeof annotation?.notes === 'string' && annotation.notes.length > 0 && !degradedSet.has(annotation.candidate_id)) {
      badDegraded += 1
      issue(`候选 ${annotation.candidate_id} 有 notes 但未登记到 degraded_candidate_ids`)
    }
  }
  summary.degraded_count = degradedSet.size
  record('降级行均记录 notes 且无遗漏', `${degradedSet.size} 条，违规 ${badDegraded}`, badDegraded === 0)

  // --- 与语料的确定性口径对齐 -----------------------------------------------
  section('与语料的确定性口径对齐')
  let deriveMismatch = 0
  for (const annotation of annotations) {
    const candidate = candidateById.get(annotation?.candidate_id)
    if (!candidate) continue
    const derived = deriveAnnotation(candidate, masterByRecordId).annotation
    if (
      derived.expected_action !== annotation.expected_action ||
      derived.expected_target_code !== annotation.expected_target_code ||
      derived.expected_reason !== annotation.expected_reason ||
      derived.category !== annotation.category ||
      derived.source_note !== annotation.source_note
    ) {
      deriveMismatch += 1
      issue(
        `候选 ${annotation.candidate_id} 与语料确定性推导不一致：` +
        `应为 ${derived.expected_action} / ${String(derived.expected_target_code)} / ${String(derived.expected_reason)}，` +
        `实际 ${annotation.expected_action} / ${String(annotation.expected_target_code)} / ${String(annotation.expected_reason)}`,
      )
    }
  }
  record('逐条结论可由语料确定性重建', `不一致 ${deriveMismatch}`, deriveMismatch === 0)

  // --- gate-cases 口径一致性 ------------------------------------------------
  section('gate-cases 口径一致性')
  const gateByCandidateId = new Map<string, GateCase>()
  for (const gateCase of cases) {
    const id = gateCase?.candidate?.candidate_id
    if (typeof id === 'string' && !gateByCandidateId.has(id)) gateByCandidateId.set(id, gateCase)
  }
  let overlap = 0
  let overlapMismatch = 0
  for (const annotation of annotations) {
    const gateCase = gateByCandidateId.get(annotation?.candidate_id)
    if (!gateCase) continue
    overlap += 1
    if (gateCase.expected?.action !== annotation.expected_action) {
      overlapMismatch += 1
      issue(`候选 ${annotation.candidate_id} 与 gate-case 动作冲突（标注 ${annotation.expected_action} / 闸门 ${String(gateCase.expected?.action)}）`)
    }
    if (typeof gateCase.expected?.reason === 'string' && gateCase.expected.reason !== annotation.expected_reason) {
      overlapMismatch += 1
      issue(`候选 ${annotation.candidate_id} 与 gate-case 存疑理由冲突`)
    }
  }
  summary.gate_overlap_count = overlap
  record(
    '交叉 candidate_id 逐条比对',
    overlap === 0 ? '无重叠，改按动作/理由词表与类别口径对齐' : `${overlap} 条，冲突 ${overlapMismatch}`,
    overlapMismatch === 0,
  )

  let aligned = 0
  for (const category of CATEGORIES) {
    const alignment = GATE_ALIGNMENT[category]
    const gateHits = cases.filter(
      (gateCase) => typeof gateCase?.category === 'string' && alignment.gateCategories.includes(gateCase.category),
    )
    const categoryAnnotations = annotations.filter((annotation) => annotation?.category === category)
    let categoryOk = gateHits.length > 0 && categoryAnnotations.length > 0
    if (!categoryOk) issue(`类别「${category}」缺少可对齐的 gate-case 或标注行`)

    const gateActionSet = new Set(gateHits.map((gateCase) => gateCase?.expected?.action))
    if (gateActionSet.size !== 1 || !gateActionSet.has(alignment.expectedAction)) {
      categoryOk = false
      issue(`类别「${category}」的 gate-case 动作口径为 ${[...gateActionSet].join(' / ')}，与约定的 ${alignment.expectedAction} 不一致`)
    }
    for (const annotation of categoryAnnotations) {
      if (!degradedSet.has(annotation?.candidate_id) && annotation?.expected_action !== alignment.expectedAction) {
        categoryOk = false
        issue(`候选 ${annotation?.candidate_id} 动作「${String(annotation?.expected_action)}」与类别「${category}」口径 ${alignment.expectedAction} 冲突`)
      }
    }
    if (alignment.expectedReason) {
      const gateReasonSet = new Set(gateHits.map((gateCase) => gateCase?.expected?.reason))
      if (!gateReasonSet.has(alignment.expectedReason)) {
        categoryOk = false
        issue(`类别「${category}」的 gate-case 未给出理由「${alignment.expectedReason}」`)
      }
      for (const annotation of categoryAnnotations) {
        if (
          !degradedSet.has(annotation?.candidate_id) &&
          annotation?.expected_action === 'uncertain' &&
          annotation?.expected_reason !== alignment.expectedReason
        ) {
          categoryOk = false
          issue(`候选 ${annotation?.candidate_id} 的存疑理由与类别「${category}」口径冲突`)
        }
      }
    }
    if (categoryOk) aligned += 1
    const actualActions = [...new Set(categoryAnnotations.map((annotation) => String(annotation?.expected_action)))].join(' / ')
    const refIds = gateHits.map((gateCase) => String(gateCase?.candidate?.candidate_id)).join('、')
    info(`类别「${category}」：标注动作 ${actualActions || '无'}；参考 ${refIds || '无'} → ${alignment.expectedAction}${alignment.expectedReason ? `（${alignment.expectedReason}）` : ''}`)
    if (alignment.rationale) info(`  对齐依据：${alignment.rationale}`)
  }
  record('类别动作/理由口径与 gate-cases 对齐', `${aligned} / ${CATEGORIES.length}`, aligned === CATEGORIES.length)

  return finish()
}

// ---------------------------------------------------------------------------
// CLI（仅直接运行时执行）
// ---------------------------------------------------------------------------

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))

const cli = (argv: string[]): void => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const corpus: BenchmarkCorpus = {
    master: readJson(resolve(root, 'tests/fixtures/corpus/master-data.json')),
    candidates: readJson(resolve(root, 'tests/fixtures/corpus/candidates.json')),
    manifest: readJson(resolve(root, 'tests/fixtures/corpus/MANIFEST.json')),
  }
  const gateCases: GateCasesInput = readJson(resolve(root, 'tests/fixtures/gate-cases.json'))
  const expectedPath = resolve(root, 'tests/fixtures/benchmark/expected.json')

  if (argv.includes('--regenerate')) {
    const generated = buildExpected(corpus)
    const preflight = validateExpected(generated, corpus, gateCases)
    if (!preflight.ok) {
      console.error('[异常] 生成结果未通过校验，已放弃写出：')
      for (const message of preflight.errors) console.error(`  - ${message}`)
      process.exitCode = 1
      return
    }
    mkdirSync(dirname(expectedPath), { recursive: true })
    writeFileSync(expectedPath, `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
    console.log(`已重建标注文件：${expectedPath}（${generated.annotations.length} 条）`)
    console.log('')
  }

  const result = validateExpected(readJson(expectedPath), corpus, gateCases)
  for (const line of result.report) console.log(line)
  if (result.warnings.length > 0) {
    console.log('')
    console.log('[提示]')
    for (const warning of result.warnings) console.log(`  - ${warning}`)
  }
  if (!result.ok) {
    console.log('')
    console.log('[异常明细]')
    for (const message of result.errors) console.log(`  - ${message}`)
    process.exitCode = 1
  }
}

/** 仅 CLI 直跑时触发；被单元测试 import 时保持零副作用。 */
if (basename(process.argv[1] ?? '') === 'validate_benchmark.ts') {
  try {
    cli(process.argv.slice(2))
  } catch (error) {
    console.error(`[异常] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
