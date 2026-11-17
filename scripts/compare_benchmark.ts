/**
 * 基准对照报告与码制口径对照（Task 51）。
 *
 * 对同一套 160 条人工标注跑两条路径并逐条对拍：
 *   路径A 字面相似度基线：baselineConclude(candidate, masterData)
 *   路径B 检索增强 + 模型：evaluateCandidate(candidate, { config, retrieve, now })
 *
 * 关键纪律：
 *   1. 指标只由 action / target_code / degraded / ambiguous_top_hits 计算，不读延迟、
 *      调用日志、当前时间或随机数；注入固定 now 后两次运行 JSON 逐字节一致。
 *   2. 默认不声明模型端点实连（createTestConfig 的占位地址不可达），此时路径B 的
 *      结论即使 degraded=false（闸门/规则短路）也不算模型输出，路径B 一律判「未验证」，
 *      报告显式写出「模型路径未实连，仅基线可核验」；退出码与「不放量」区分。
 *   3. --model-configured 才声明真实端点；若该批次仍有 degraded 结论，仍退回「未验证」，
 *      不把降级结论包装成模型结果。
 *   4. 权威码制 docx 在本环境不存在，码制报告只记录工程实际口径与缺失事实，
 *      不声称符合、不编造条文或页码。
 *
 * 用法（项目根目录执行）：
 *   pnpm tsx scripts/compare_benchmark.ts
 *   pnpm tsx scripts/compare_benchmark.ts --model-configured   # 需真实 LLM_* 环境变量
 *
 * 纯函数 compareAll 可被测试注入预计算的两路结论，不必重跑 320 条引擎评估。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Action, CandidateRecord, MasterDataRecord } from '../src/core/types'
import { baselineConclude } from '../src/core/engine/baseline'
import { evaluateCandidate } from '../src/core/engine/merge-engine'
import { createTestConfig, loadConfig, type AppConfig } from '../src/shared/config'
import { inMemoryRetriever, loadCorpus } from './run-merge'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
export const REPORT_DIR = resolve(ROOT, 'reports/benchmark')

/** 固定时钟：语料 generated_at 同一基准时间，只进报告元数据，不参与指标。 */
export const FIXED_NOW = '2024-07-01T08:00:00+08:00'
/** 诚实降级声明（要求报告中逐字出现）。 */
export const HONEST_DEGRADE_STATEMENT = '模型路径未实连，仅基线可核验'
/** 码制对照状态：权威文件缺失，不得声称符合。 */
export const CODE_RULES_STATUS = '未完成（权威码制文件缺失）'
export const CODE_RULES_REPORT = 'reports/benchmark/code-rules-check.md'

// ---------------------------------------------------------------------------
// 输入/输出类型
// ---------------------------------------------------------------------------

export interface BenchmarkAnnotation {
  candidate_id: string
  expected_action: Action
  expected_target_code: string | null
  expected_reason?: string | null
  category?: string
  source_note?: string
  notes?: string | null
}

export interface BenchmarkExpected {
  version: number
  source?: string
  dataset_ref?: Record<string, any>
  counts?: Record<string, any>
  annotations: BenchmarkAnnotation[]
}

/** 路径A 的注入结论；ambiguous_top_hits 来自 baselineConclude。 */
export interface PathAResult {
  candidate_id: string
  action: Action
  target_code: string | null
  ambiguous_top_hits?: number
  hit_count?: number
  confidence?: number
}

/** 路径B 的注入结论；degraded 来自 MergeConclusion.degraded。 */
export interface PathBResult {
  candidate_id: string
  action: Action
  target_code: string | null
  degraded?: boolean
  uncertain_reason?: string | null
}

export interface DatasetMeta {
  manifest_version?: string
  source?: string
  deterministic_seed?: number | string | null
  expected_version?: number
  generated_at?: string
  master_data_count?: number
  candidate_count?: number
}

export type PathVerdict = '不放量' | '允许人工灰度(仍需人工确认)' | '未验证'

/** 退出码只由路径B 结论决定：基线「不放量」是预期现象，不作门禁。 */
export const EXIT_CODE_BY_VERDICT: Record<PathVerdict, number> = {
  未验证: 0,
  不放量: 1,
  '允许人工灰度(仍需人工确认)': 2,
}

export const EXIT_CODE_MEANING: Record<string, string> = {
  '0': '模型路径未验证（诚实降级，本批不放行也不认定不合格）',
  '1': '模型路径不放量（存在错误归并）',
  '2': '模型路径允许人工灰度(仍需人工确认)',
}

export interface PathMetrics {
  名称: string
  命中数: number
  命中率: number
  错误归并数: number
  错误归并率: number
  漏并数: number
  漏并率: number
  存疑数: number
  存疑率: number
  结论: PathVerdict
  错误归并候选: string[]
  /** 仅路径A 有定义（基线 ambiguous_top_hits>1 且被错误归并）。 */
  多义误判数?: number
}

export interface MatrixRow {
  candidate_id: string
  category: string
  expected_action: Action
  expected_target_code: string | null
  pathA_action: Action
  pathA_target_code: string | null
  pathA_hit: boolean
  pathB_action: Action
  pathB_target_code: string | null
  pathB_hit: boolean
  pathA_wrong_merge: boolean
  pathB_wrong_merge: boolean
  pathA_miss: boolean
  pathB_miss: boolean
  pathB_degraded: boolean
  expected_code_resolved: boolean
}

export interface DiffRow extends MatrixRow {
  差异项: string[]
}

export interface CompareReport {
  报告类型: string
  schema_version: string
  样本量: number
  数据集版本: DatasetMeta
  样本构成: { 期望归并: number; 期望非归并: number; 期望存疑: number }
  生成时间: string
  固定时钟: string
  指标口径: Record<string, string>
  分母说明: string
  诚实降级声明: string | null
  诚实降级说明: string
  模型路径实连: boolean
  路径B降级数: number
  路径B规则短路数: number
  路径A: PathMetrics
  路径B: PathMetrics
  逐条差异: { diff_count: number; diffs: DiffRow[]; full_matrix: MatrixRow[] }
  码制口径对照: { 状态: string; 报告路径: string; 权威文件可用: boolean }
  退出码口径: Record<string, string>
  退出码: number
  复用模块说明: string[]
}

export interface CompareOptions {
  /** 固定时间戳生成器；缺省也用固定值，保证 compareAll 纯函数可复现。 */
  now?: () => string
  /** 是否显式声明已配置真实模型端点。缺省 false（诚实降级）。 */
  modelConfigured?: boolean
  dataset?: DatasetMeta
}

export interface RunCompareOptions extends CompareOptions {
  annotations?: BenchmarkAnnotation[]
  candidates?: CandidateRecord[]
  masterData?: MasterDataRecord[]
  pathAResults?: PathAResult[]
  pathBResults?: PathBResult[]
  outDir?: string
  /** 注入配置，便于测试覆盖 --model-configured 分支而不读环境变量。 */
  config?: AppConfig
}

export interface ReportFiles {
  json: string
  markdown: string
  codeRules: string
}

export interface RunCompareResult {
  report: CompareReport
  files: ReportFiles
  exitCode: number
}

/** 指标口径：四项率统一以样本量 N 为分母，公式写死在报告里供复核。 */
export const METRIC_FORMULAS: Record<string, string> = {
  样本量: 'N = 本次参与对拍的人工标注条数（expected.json.annotations 长度）。',
  命中率: '命中 = 路径 action 与 expected_action 相等，且 target_code 与 expected_target_code 相等（含同为 null）。命中率 = 命中数 / N。',
  错误归并率: '错误归并 = expected_action !== "merge" 且路径 action === "merge" 且 target_code 非空。错误归并率 = 错误归并数 / N。',
  漏并率: '漏并 = expected_action === "merge" 且未命中（未给出 action=merge 且 target_code 正确的结论）。漏并率 = 漏并数 / N。',
  存疑率: '存疑 = 路径 action === "uncertain"。存疑率 = 存疑数 / N。',
  多义误判数: '仅路径A：baseline 的 ambiguous_top_hits > 1 且该行同时被判为错误归并的条数。',
  放量阈值: '错误归并数 > 0 → 结论「不放量」并列出全部错误归并 candidate_id；错误归并数 = 0 → 结论「允许人工灰度(仍需人工确认)」；模型路径未实连 → 结论「未验证」，不套用前两条。',
  率值精度: '各项率 = 计数 / N，保留 6 位小数（四舍五入）；计数为逐条累加，N=0 时率记为 0。',
}

const CSV_COLUMNS: Array<keyof MatrixRow> = [
  'candidate_id', 'category', 'expected_action', 'expected_target_code',
  'pathA_action', 'pathA_target_code', 'pathA_hit',
  'pathB_action', 'pathB_target_code', 'pathB_hit',
  'pathA_wrong_merge', 'pathB_wrong_merge', 'pathA_miss', 'pathB_miss',
  'pathB_degraded', 'expected_code_resolved',
]

// ---------------------------------------------------------------------------
// 纯函数：判定与对拍
// ---------------------------------------------------------------------------

/** 空串与 null 同视作「无目标码」，避免空串制造伪命中。 */
function codeOf(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value
}

export function isHit(
  expected: Pick<BenchmarkAnnotation, 'expected_action' | 'expected_target_code'>,
  actual: { action: Action; target_code: string | null },
): boolean {
  return actual.action === expected.expected_action &&
    codeOf(actual.target_code) === codeOf(expected.expected_target_code)
}

export function isWrongMerge(
  expected: Pick<BenchmarkAnnotation, 'expected_action'>,
  actual: { action: Action; target_code: string | null },
): boolean {
  return expected.expected_action !== 'merge' &&
    actual.action === 'merge' &&
    codeOf(actual.target_code) !== null
}

export function isMiss(
  expected: Pick<BenchmarkAnnotation, 'expected_action' | 'expected_target_code'>,
  actual: { action: Action; target_code: string | null },
): boolean {
  return expected.expected_action === 'merge' && !isHit(expected, actual)
}

export function verdictOf(wrongMergeCount: number): PathVerdict {
  return wrongMergeCount > 0 ? '不放量' : '允许人工灰度(仍需人工确认)'
}

function indexBy<T extends { candidate_id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const row of rows) out.set(row.candidate_id, row)
  return out
}

const rateOf = (count: number, total: number): number =>
  total === 0 ? 0 : Number((count / total).toFixed(6))

/**
 * 纯对拍：不读磁盘、不取当前时间、不联网。测试可注入两路预计算结论。
 * candidates / masterData 用于样本量、候选存在性与期望目标码可解析性的核对。
 */
export function compareAll(
  annotations: BenchmarkAnnotation[],
  candidates: CandidateRecord[],
  masterData: MasterDataRecord[],
  pathAResults: PathAResult[],
  pathBResults: PathBResult[],
  opts: CompareOptions = {},
): CompareReport {
  const generatedAt = (opts.now ?? (() => FIXED_NOW))()
  const aById = indexBy(pathAResults)
  const bById = indexBy(pathBResults)
  const masterCodes = new Set(masterData.map((r) => r.code))
  const total = annotations.length

  let hitA = 0; let wmA = 0; let missA = 0; let uncA = 0; let ambiguousWrong = 0
  let hitB = 0; let wmB = 0; let missB = 0; let uncB = 0; let degradedB = 0
  let mergeExpected = 0; let uncertainExpected = 0
  const wrongIdsA: string[] = []
  const wrongIdsB: string[] = []
  const fullMatrix: MatrixRow[] = []
  const diffs: DiffRow[] = []

  for (const ann of annotations) {
    const a = aById.get(ann.candidate_id)
    const b = bById.get(ann.candidate_id)
    if (!a) throw new Error(`路径A缺少候选 ${ann.candidate_id} 的基线结论`)
    if (!b) throw new Error(`路径B缺少候选 ${ann.candidate_id} 的引擎结论`)

    const aHit = isHit(ann, a)
    const bHit = isHit(ann, b)
    const aWrong = isWrongMerge(ann, a)
    const bWrong = isWrongMerge(ann, b)
    const aMissed = isMiss(ann, a)
    const bMissed = isMiss(ann, b)
    const bDegraded = b.degraded === true

    if (aHit) hitA += 1
    if (bHit) hitB += 1
    if (aWrong) { wmA += 1; wrongIdsA.push(ann.candidate_id) }
    if (bWrong) { wmB += 1; wrongIdsB.push(ann.candidate_id) }
    if (aMissed) missA += 1
    if (bMissed) missB += 1
    if (a.action === 'uncertain') uncA += 1
    if (b.action === 'uncertain') uncB += 1
    if (bDegraded) degradedB += 1
    if (aWrong && (a.ambiguous_top_hits ?? 0) > 1) ambiguousWrong += 1
    if (ann.expected_action === 'merge') mergeExpected += 1
    if (ann.expected_action === 'uncertain') uncertainExpected += 1

    const expectedCode = codeOf(ann.expected_target_code)
    const row: MatrixRow = {
      candidate_id: ann.candidate_id,
      category: ann.category ?? '',
      expected_action: ann.expected_action,
      expected_target_code: expectedCode,
      pathA_action: a.action,
      pathA_target_code: codeOf(a.target_code),
      pathA_hit: aHit,
      pathB_action: b.action,
      pathB_target_code: codeOf(b.target_code),
      pathB_hit: bHit,
      pathA_wrong_merge: aWrong,
      pathB_wrong_merge: bWrong,
      pathA_miss: aMissed,
      pathB_miss: bMissed,
      pathB_degraded: bDegraded,
      expected_code_resolved: expectedCode === null ? true : masterCodes.has(expectedCode),
    }
    fullMatrix.push(row)

    const diffItems: string[] = []
    if (!aHit) diffItems.push(`路径A未命中${aWrong ? '（错误归并）' : aMissed ? '（漏并）' : ''}`)
    if (!bHit) diffItems.push(`路径B未命中${bWrong ? '（错误归并）' : bMissed ? '（漏并）' : ''}`)
    if (diffItems.length > 0) diffs.push({ ...row, 差异项: diffItems })
  }

  const pathA: PathMetrics = {
    名称: '字面相似度基线',
    命中数: hitA, 命中率: rateOf(hitA, total),
    错误归并数: wmA, 错误归并率: rateOf(wmA, total),
    漏并数: missA, 漏并率: rateOf(missA, total),
    存疑数: uncA, 存疑率: rateOf(uncA, total),
    多义误判数: ambiguousWrong,
    结论: verdictOf(wmA),
    错误归并候选: wrongIdsA,
  }

  // 诚实降级：只有「显式声明端点实连」且「本批无 degraded 结论」才给路径B 真实门禁结论。
  // 闸门短路（degraded=false）仍不是模型输出，靠 路径B规则短路数 单独披露，不冒充实连。
  const pathBConnected = opts.modelConfigured === true && degradedB === 0
  const pathB: PathMetrics = {
    名称: '检索增强 + 模型',
    命中数: hitB, 命中率: rateOf(hitB, total),
    错误归并数: wmB, 错误归并率: rateOf(wmB, total),
    漏并数: missB, 漏并率: rateOf(missB, total),
    存疑数: uncB, 存疑率: rateOf(uncB, total),
    结论: pathBConnected ? verdictOf(wmB) : '未验证',
    错误归并候选: wrongIdsB,
  }

  const honestNote = pathBConnected
    ? '已按 --model-configured 声明真实端点，且本批无 degraded 结论；路径B 按放量阈值给出真实结论。闸门短路的结论仍为规则结论，另见路径B规则短路数。'
    : `${HONEST_DEGRADE_STATEMENT}；路径B ${degradedB}/${total} 条为 degraded=true，其余 ${total - degradedB} 条为闸门/规则的确定性短路（degraded=false），同样不来自模型实连。基线指标不得当作模型路径结果。`

  return {
    报告类型: 'Task 51 基准对照报告（字面相似度基线 vs 检索增强 + 模型）',
    schema_version: '1.0',
    样本量: total,
    数据集版本: {
      ...(opts.dataset ?? {}),
      master_data_count: masterData.length,
      candidate_count: candidates.length,
    },
    样本构成: {
      期望归并: mergeExpected,
      期望非归并: total - mergeExpected,
      期望存疑: uncertainExpected,
    },
    生成时间: generatedAt,
    固定时钟: generatedAt,
    指标口径: METRIC_FORMULAS,
    分母说明: `四项率统一以样本量 N=${total} 为分母（期望归并 ${mergeExpected} 条、期望非归并 ${total - mergeExpected} 条、其中期望存疑 ${uncertainExpected} 条）；不按类别或期望动作换分母。错误归并数若改以「期望非归并」为分母则是另一口径，本报告不采用。`,
    诚实降级声明: pathBConnected ? null : HONEST_DEGRADE_STATEMENT,
    诚实降级说明: honestNote,
    模型路径实连: pathBConnected,
    路径B降级数: degradedB,
    路径B规则短路数: total - degradedB,
    路径A: pathA,
    路径B: pathB,
    逐条差异: { diff_count: diffs.length, diffs, full_matrix: fullMatrix },
    码制口径对照: { 状态: CODE_RULES_STATUS, 报告路径: CODE_RULES_REPORT, 权威文件可用: false },
    退出码口径: EXIT_CODE_MEANING,
    退出码: EXIT_CODE_BY_VERDICT[pathB.结论],
    复用模块说明: [
      '路径B 中 degraded=false 的条目来自闸门/规则的确定性短路（create 或 uncertain），不是模型实连输出；因此未实连时 路径B降级数 可以小于 样本量，但路径B 仍判未验证。',
      '基线只按排序首条出结论，ambiguous_top_hits>1 时仍归并，这正是其错误归并率大于 0 的结构性原因。',
      '指标计算只读取 action / target_code / degraded / ambiguous_top_hits；被引擎写入调用日志与延迟的墙钟时间不进入任何指标。',
      '默认路径B 使用 createTestConfig() 的占位端点 http://127.0.0.1:1（不可达），只产生本地连接拒绝，不引入外部网络依赖，也不改变结论。',
    ],
  }
}

// ---------------------------------------------------------------------------
// 渲染（纯函数，确定性）
// ---------------------------------------------------------------------------

export function renderJson(report: CompareReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 全量矩阵 CSV（矩阵随 JSON 一并落盘，CSV 文本内嵌于 MD，不额外造文件）。 */
export function toCsv(report: CompareReport): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of report.逐条差异.full_matrix) {
    lines.push(CSV_COLUMNS.map((col) => csvCell(row[col])).join(','))
  }
  return `${lines.join('\n')}\n`
}

function mdCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function formatConcretion(action: Action, code: string | null): string {
  return `${action} → ${code ?? 'null'}`
}

function idListLines(ids: string[], perLine = 12): string[] {
  if (ids.length === 0) return ['- 无']
  const out: string[] = []
  for (let i = 0; i < ids.length; i += perLine) {
    out.push(`- ${ids.slice(i, i + perLine).map((id) => `\`${id}\``).join('、')}`)
  }
  return out
}

/** 错误归并按类别分布（从全量矩阵现算，不硬编码语料类别）。 */
function wrongMergeCategoryLine(report: CompareReport, path: 'A' | 'B'): string {
  const counts: Record<string, number> = {}
  for (const row of report.逐条差异.full_matrix) {
    const hit = path === 'A' ? row.pathA_wrong_merge : row.pathB_wrong_merge
    if (!hit) continue
    const category = row.category || '<未分类>'
    counts[category] = (counts[category] ?? 0) + 1
  }
  const parts = Object.entries(counts)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, count]) => `${category} ${count} 条`)
  return `- 错误归并按类别分布：${parts.length > 0 ? parts.join('；') : '无'}`
}

function metricTable(path: PathMetrics): string[] {
  const lines = [
    '| 指标 | 计数 | 比率 |',
    '| --- | ---: | ---: |',
    `| 命中率 | ${path.命中数} | ${path.命中率} |`,
    `| 错误归并率 | ${path.错误归并数} | ${path.错误归并率} |`,
    `| 漏并率 | ${path.漏并数} | ${path.漏并率} |`,
    `| 存疑率 | ${path.存疑数} | ${path.存疑率} |`,
  ]
  if (path.多义误判数 !== undefined) lines.push(`| 多义误判数 | ${path.多义误判数} | 不适用 |`)
  return lines
}

export function renderMarkdown(report: CompareReport): string {
  const L: string[] = []
  const push = (...texts: string[]): void => { L.push(...texts) }

  push('# 基准对照报告（Task 51）')
  push()
  push(`报告类型：${report.报告类型}`)
  push()
  push('## 一、样本量与数据集版本')
  push()
  push(`- 样本量：**${report.样本量}**`)
  const v = report.数据集版本
  push(`- 数据集版本：manifest_version=${v.manifest_version ?? '未提供'}；expected_version=${v.expected_version ?? '未提供'}；source=${v.source ?? '未提供'}；deterministic_seed=${String(v.deterministic_seed ?? '未提供')}`)
  push(`- 语料规模：主数据 ${v.master_data_count ?? '未提供'} 条 / 候选 ${v.candidate_count ?? '未提供'} 条；manifest.generated_at=${v.generated_at ?? '未提供'}`)
  push(`- 样本构成：期望归并 ${report.样本构成.期望归并} 条；期望非归并 ${report.样本构成.期望非归并} 条（其中期望存疑 ${report.样本构成.期望存疑} 条）`)
  push(`- 固定时钟：${report.固定时钟}；报告生成时间：${report.生成时间}`)
  push('- 说明：路径A 与路径B 使用同一套标注、同一候选顺序；除报告元数据外不含任何时间/随机/外部网络输入。')
  push()
  push('## 二、指标口径（公式）')
  push()
  push('| 指标 | 公式 |')
  push('| --- | --- |')
  for (const [name, formula] of Object.entries(report.指标口径)) {
    push(`| ${mdCell(name)} | ${mdCell(formula)} |`)
  }
  push()
  push(`分母说明：${report.分母说明}`)
  push()
  push('## 三、路径 A · 字面相似度基线')
  push()
  push(...metricTable(report.路径A))
  push()
  push(`- 放量阈值判定：**${report.路径A.结论}**`)
  push(`- 全部错误归并 candidate_id（${report.路径A.错误归并数} 条）：`)
  push(...idListLines(report.路径A.错误归并候选))
  push(wrongMergeCategoryLine(report, 'A'))
  push('- 多义误判数的口径：基线 ambiguous_top_hits>1 且被错误归并；这些行仅按排序首条取目标，不区分规格/单位/停用/码错配。')
  push('- 口径提醒：期望动作本身为 merge 的行永远不计入错误归并，这类行若目标码不对只计漏并；因此「换单位」这类期望归并的语料不会出现在上面的错误归并清单里。')
  push()
  push('## 四、路径 B · 检索增强 + 模型')
  push()
  push(...metricTable(report.路径B))
  push()
  push(`- 模型路径实连：**${report.模型路径实连 ? '是' : '否'}**`)
  push(`- 降级结论数：**${report.路径B降级数} / ${report.样本量}**；闸门/规则短路数：**${report.路径B规则短路数} / ${report.样本量}**（这些行 degraded=false，但一样不来自模型实连）`)
  push(`- 放量阈值判定：**${report.路径B.结论}**`)
  push(`- 全部错误归并 candidate_id（${report.路径B.错误归并数} 条）：`)
  push(...idListLines(report.路径B.错误归并候选))
  push(wrongMergeCategoryLine(report, 'B'))
  push()
  push('## 五、诚实降级声明')
  push()
  if (report.诚实降级声明 !== null) {
    push(`> ${report.诚实降级声明}`)
  } else {
    push('> 模型端点已声明实连且本批无 degraded 结论；以下仍保留规则短路计数供复核。')
  }
  push()
  push(report.诚实降级说明)
  push()
  push('注意：路径A 的错误归并率不得当作模型路径结果；未实连时路径B 的「未验证」不等于「放行」，也不等于「不放量」，退出码单独区分。')
  push()
  push('## 六、逐条差异')
  push()
  push(`- 差异条数：**${report.逐条差异.diff_count}**（diffs 数组仅含任一侧未命中的行）`)
  push(`- 全量矩阵：${report.逐条差异.full_matrix.length} 行，全部写入下方 CSV 与 JSON 的 full_matrix，保证可复现。`)
  push()
  push('| candidate_id | 类别 | 期望 | 路径A | 路径B | 差异项 |')
  push('| --- | --- | --- | --- | --- | --- |')
  for (const row of report.逐条差异.diffs) {
    push(`| ${mdCell(row.candidate_id)} | ${mdCell(row.category)} | ${mdCell(formatConcretion(row.expected_action, row.expected_target_code))} | ${mdCell(formatConcretion(row.pathA_action, row.pathA_target_code))} | ${mdCell(formatConcretion(row.pathB_action, row.pathB_target_code))} | ${mdCell(row.差异项.join('；'))} |`)
  }
  push()
  push('### 全量矩阵（CSV）')
  push()
  push('```csv')
  for (const line of toCsv(report).trimEnd().split('\n')) push(line)
  push('```')
  push()
  push('## 七、码制口径对照')
  push()
  push(`- 状态：**${report.码制口径对照.状态}**`)
  push(`- 报告路径：\`${report.码制口径对照.报告路径}\``)
  push('- 摘要：参考 docx 在本环境不存在，未打开、未引用；本文只记录复合键实际使用的码制形状与归一实现，不声称符合权威标准。')
  push()
  push('## 八、放量阈值与退出码')
  push()
  push('| 路径 | 结论 | 退出码 |')
  push('| --- | --- | ---: |')
  push(`| 路径A 字面相似度基线 | ${report.路径A.结论} | 不由基线决定 |`)
  push(`| 路径B 检索增强 + 模型 | ${report.路径B.结论} | ${report.退出码} |`)
  push()
  for (const [code, meaning] of Object.entries(report.退出码口径)) push(`- ${code}：${meaning}`)
  push()
  push('## 九、复用模块说明（仅记录，未修改）')
  push()
  for (const note of report.复用模块说明) push(`- ${note}`)
  push()
  return `${L.join('\n')}\n`
}

/**
 * 码制口径对照：权威 docx 不存在时只写事实与工程口径，不编造引用、条款或页码。
 * 全文静态（除固定时钟），因此逐字节可复现。
 */
export function renderCodeRulesCheck(): string {
  return [
    '# 码制口径对照（Task 51）',
    '',
    '## 结论',
    '',
    `- 对照状态：**${CODE_RULES_STATUS}**`,
    '- 权威码制文件在本环境不存在；本次**未咨询、未打开、未引用**该文件，也**未据其判定符合性**。',
    '- 下文只记录本工程源码/配置/夹具中确实存在的码制形状与归一口径；不含来自权威 docx 的条文、页码、条款号或发布日期。',
    '',
    '## 一、权威文件缺失（检索事实）',
    '',
    '- 参考文档：`domain/corpus/dictionary/code_rules_15_医疗保障定点医疗机构等10项信息业务编码规则和方法共15项编码标准.docx`（医保发〔2019〕55号附件）。',
    '- 检索范围 1：项目根目录。已执行 `find . -iname \'*code_rules*\' -o -iname \'*.docx\' | grep -v node_modules | sort`，结果 0 条。',
    '- 检索范围 2：本回合目录 `/Users/kamini/Desktop/RUN/Agent-GIT-CLAUDE-gpt/projects/round_032_20261108_220804`。已执行 `find <回合目录> -iname \'*.docx\' -o -iname \'*code_rules*\'`，结果 0 条。',
    '- 结论：该 docx 无法取得，因此码制符合性**未核验**；禁止把本文解读为已完成标准对齐。',
    '',
    '## 二、复合键实际使用的码制形状（以源码为准，非权威核验）',
    '',
    '### 2.1 医保码 insurance_code（drug 域）',
    '',
    '- 数据集生成口径：`tests/fixtures/corpus/MANIFEST.json:157` 记载「官方医保码风格 15 位：类别前缀 XJ + 13 位数字；主数据段 7000…/5000…/4000…/3000…，错配段 9100…/9200…」。这是仿真器约定，不是权威标准条文。',
    '- 工程实际强校验：仅 `src/core/engine/gate-decision.ts:58-70` 对 `drug` 域且非空医保码做「长度 < 8 → 格式异常、转人工存疑」，源码判据是 `insuranceCode.length < 8`（见该文件 `:60`）。**没有** `^XJ\\d{13}$` 这类完整形状正则；长度 8–14 或含非数字的字符串不会因形状被拒。',
    '- 复合键用法：`src/core/binding/composite-key.ts:44-56` 把 `textKey(insurance_code)` 拼成 `ic=...` 段；`textKey`（同文件 `:30-32`）经 `normalizeText`（`src/core/normalize/encoding.ts:92-101`）做宽度/不可见字符归一与去空白，不校验码制形状。',
    '- 因此「XJ + 13 位」目前只是语料生成约定 + 过短拦截，不能据此声称已与任何医保编码标准对齐。',
    '',
    '### 2.2 院内主数据编码 code',
    '',
    '- 数据集生成口径：`tests/fixtures/corpus/MANIFEST.json:158` 记载 `drug=YP+6位`、`fee_item=FY+6位`、`department=KS+6位`、`exam=JC+6位`。',
    '- 复合键与闸门**不解析** `code` 形状；`code` 只作为归并目标标识输出（`src/core/engine/baseline.ts:192`、`src/core/engine/gate-decision.ts:127`）。',
    '- 该前缀规则同样来源于确定性仿真器，未与权威码制比对。',
    '',
    '### 2.3 规格 spec / 剂型 dosage_form / 单位 unit',
    '',
    '- `src/core/binding/composite-key.ts:15-21`：`spec` 走 `normalizedSpecKey`（`src/core/normalize/spec.ts:125-138`），含量按维度换算到 mg/ml 基准，包装计数与单位按别名归一。',
    '- `src/core/normalize/spec.ts:107-122`：`equivalentSpec` 要求含量同类换算相等（如 250mg ≡ 0.25g）、包装计数相同、包装单位不得跨维度冲突；解析失败返回不等价，不猜测。',
    '- `config/unit-alias.json:2` 明确「按维度分组，跨维度不换算」；维度含 `mass / count / volume / time / dose_form`（`dose_form` 分组见 `:29`）。同文件 `:3-11` 给出 mg/g/μg/kg 的质量别名，`:12-21` 给出片/粒/袋/支/瓶/盒等计数别名。',
    '- `src/core/normalize/unit.ts:42-55`：`lookupUnit` 把别名映射到标准单位与维度，未命中保留原值并标 `dimension=unknown`；`:58-65` 的 `normalizeUnit` 对未知单位写 `unit_unknown`。',
    '- 同文件 `:89-102` 的 `convertUnit` 只在同维度且系数表内换算；`:105-110` 的 `isUnitMismatch` 对跨维度或不同标准单位返回冲突。换算系数表见 `:69-73`（mass 基准 mg、volume 基准 ml、time 基准 min）。',
    '- `unit` 字段归一：`src/core/binding/composite-key.ts:24-27` 用 `lookupUnit` 取标准单位后拼入复合键，未知值保留原样。',
    '- `dosage_form` 字段：`src/core/binding/composite-key.ts:30-32` 的 `textKey` 只做文本归一与去空白，**未查别名表**。`config/unit-alias.json:29-36` 虽有 `dose_form` 分组，但复合键当前未直接使用它；这是已观察到、待人工确认的口径差异，本次只记录不修改源码。',
    '- 基线路径另有一套实现：`src/core/engine/baseline.ts:43-58` 用 `equivalentSpec` 加字面 `unitEqual`，与复合键的 `normalizedSpecKey` 并非同一份代码。',
    '',
    '## 三、未完成项与具体下一步',
    '',
    `- 状态：${CODE_RULES_STATUS}。`,
    '1. 从权威渠道取得医保发〔2019〕55号附件原文，置于 `domain/corpus/dictionary/code_rules_15_医疗保障定点医疗机构等10项信息业务编码规则和方法共15项编码标准.docx`，并登记来源 URL、发布日期与文件哈希。',
    '2. 逐条抽取「XJ + 13 位」、各域院内编码前缀、单位/剂型归一与跨维度禁止换算的条文，与本文第二节逐项对照，登记「一致 / 不一致 / 未覆盖」。',
    '3. 重点核实两点：医保码是否应做 `^XJ\\d{13}$` 完整校验；`dosage_form` 是否应按 `config/unit-alias.json` 的 `dose_form` 别名分组归一。',
    '4. 对照完成并留存证据后，才可将状态改为「已完成」并在放量决策中引用；在此之前不得据此声称符合权威码制。',
    '',
    `固定时钟：${FIXED_NOW}（仅用于报告元数据，不影响码制结论）。`,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 落盘与编排
// ---------------------------------------------------------------------------

export function writeReports(report: CompareReport, outDir: string): ReportFiles {
  mkdirSync(outDir, { recursive: true })
  const files: ReportFiles = {
    json: resolve(outDir, 'compare-report.json'),
    markdown: resolve(outDir, 'compare-report.md'),
    codeRules: resolve(outDir, 'code-rules-check.md'),
  }
  writeFileSync(files.json, renderJson(report), 'utf8')
  writeFileSync(files.markdown, renderMarkdown(report), 'utf8')
  writeFileSync(files.codeRules, renderCodeRulesCheck(), 'utf8')
  return files
}

/** 读取人工标注文件。 */
export function readExpected(path = resolve(ROOT, 'tests/fixtures/benchmark/expected.json')): BenchmarkExpected {
  return JSON.parse(readFileSync(path, 'utf8')) as BenchmarkExpected
}

/** 从 MANIFEST + expected 读取数据集版本元数据（不含时间/随机源）。 */
export function readDatasetMeta(): DatasetMeta {
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, 'tests/fixtures/corpus/MANIFEST.json'), 'utf8'),
  ) as Record<string, any>
  const expected = readExpected()
  return {
    manifest_version: String(manifest.manifest_version ?? ''),
    source: String(manifest.source ?? ''),
    deterministic_seed: manifest.deterministic_seed ?? null,
    expected_version: expected.version,
    generated_at: String(manifest.generated_at ?? ''),
  }
}

/**
 * 可运行入口：默认跑全量真实引擎；测试可注入两路预计算结论以跳过 160 次模型降级调用。
 * 写出的三份产物路径固定，重复运行逐字节一致。
 */
export async function runCompare(options: RunCompareOptions = {}): Promise<RunCompareResult> {
  const annotations = options.annotations ?? readExpected().annotations
  const corpus = options.candidates && options.masterData
    ? { candidates: options.candidates, masterData: options.masterData }
    : loadCorpus()
  const modelConfigured = options.modelConfigured ?? false
  const now = options.now ?? (() => FIXED_NOW)
  const config = options.config ?? (modelConfigured ? loadConfig() : createTestConfig())
  const retrieve = inMemoryRetriever(corpus.masterData)

  const pathAResults = options.pathAResults
    ?? corpus.candidates.map((candidate) => baselineConclude(candidate, corpus.masterData))
  const pathBResults = options.pathBResults ?? await Promise.all(
    corpus.candidates.map(async (candidate) => {
      const result = await evaluateCandidate(candidate, { config, retrieve, now })
      return {
        candidate_id: candidate.candidate_id,
        action: result.conclusion.action,
        target_code: result.conclusion.target_code,
        degraded: result.conclusion.degraded,
        uncertain_reason: result.conclusion.uncertain_reason,
      }
    }),
  )

  const report = compareAll(
    annotations,
    corpus.candidates,
    corpus.masterData,
    pathAResults,
    pathBResults,
    {
      now,
      modelConfigured,
      dataset: options.dataset ?? (options.annotations === undefined ? readDatasetMeta() : undefined),
    },
  )
  const files = writeReports(report, options.outDir ?? REPORT_DIR)
  return { report, files, exitCode: report.退出码 }
}

/** CLI：仅直接运行本脚本时触发，被测试 import 时零副作用。 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const modelConfigured = args.includes('--model-configured')
  const result = await runCompare({ modelConfigured })
  const a = result.report.路径A
  const b = result.report.路径B
  process.stdout.write(
    `基准对照完成：样本量 ${result.report.样本量}；` +
    `路径A 命中率 ${a.命中率} / 错误归并率 ${a.错误归并率} / ${a.结论}（${a.错误归并数} 条）；` +
    `路径B 命中率 ${b.命中率} / 错误归并率 ${b.错误归并率} / ${b.结论}\n`,
  )
  if (result.report.诚实降级声明 !== null) {
    process.stdout.write(`诚实降级：${result.report.诚实降级声明}（降级 ${result.report.路径B降级数} 条，规则短路 ${result.report.路径B规则短路数} 条）\n`)
  }
  process.stdout.write(`报告：${result.files.json}、${result.files.markdown}、${result.files.codeRules}\n`)
  process.stdout.write(`退出码：${result.exitCode}（${result.report.退出码口径[String(result.exitCode)]}）\n`)
  process.exitCode = result.exitCode
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`compare_benchmark 失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
