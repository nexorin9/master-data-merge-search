/**
 * 运维 CLI · export（归并建议sheet，Task 53）。
 *
 * 复用审计导出的约定：固定列顺序 + csvCell 单元格安全转义 + 落出前逐行
 * 隐私形状扫描；任一原始行或投影行命中即**整批拒绝**，不产出 JSON/CSV，
 * 也绝不调用 writer。
 *
 * CSV 固定列顺序（表头逐字一致）：
 *   序号,批次,候选,结论动作,目标 code,理由,逐字段证据,确认人,回执状态
 *
 * 分组与序号：先按 batch_id 字典序稳定排序（同批保持输入顺序），再给全局
 * 递增的固定序号 1..N，所以同一批输入两次导出的序号完全一致。
 *
 * 隐私：扫描「原始输入行」与「真正要落出的投影行」两遍，命中项的
 * value_preview 已由 pii-guard 掩码，报告里绝不回显完整姓名/证件号。
 * JSON 只含固定列投影，不携带原始附加字段，避免未扫描的列泄漏。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { csvCell } from '../core/audit/audit-export'
import { scanBatch } from '../core/audit/pii-guard'
import type { Action, EvidenceItem, PiiHit } from '../core/types'

/** CSV / JSON / 文本三份产物共用的固定列顺序。 */
export const EXPORT_CSV_COLUMNS = [
  '序号',
  '批次',
  '候选',
  '结论动作',
  '目标 code',
  '理由',
  '逐字段证据',
  '确认人',
  '回执状态',
] as const

export type ExportColumn = (typeof EXPORT_CSV_COLUMNS)[number]

/** 调用方可直接传 run-merge 的 SuggestionWire，也可带 batch_id / 确认人 / 回执。 */
export interface SuggestionExportRow {
  candidate_id?: string
  batch_id?: string
  action?: Action
  target_code?: string | null
  rationale?: string
  evidence?: EvidenceItem[] | string
  confirmed_by?: string
  receipt_status?: string
  /** 允许附加字段；这些字段同样会被隐私闸门扫描，但不会进入 JSON/CSV 投影。 */
  [key: string]: unknown
}

export type ExportSheetRow = Record<ExportColumn, string | number>

export interface ExportGroup {
  batch_id: string
  count: number
  first_seq: number
  last_seq: number
}

export interface ExportRejectedRow {
  index: number
  序号: number
  候选: string
  /** 与「候选」同值，便于机器按英文契约字段定位。 */
  candidate_id: string
  hits: PiiHit[]
}

export interface ExportWriterInput {
  /** 输出基路径（不含扩展名）。 */
  out: string
  json: string
  csv: string
  /** 人类可读的纯文本 sheet。 */
  txt: string
  sheet: ExportSheetRow[]
  columns: readonly string[]
}

export interface ExportWriterResult {
  json_file?: string
  csv_file?: string
  txt_file?: string
  [key: string]: unknown
}

export type ExportWriter = (
  input: ExportWriterInput,
) => ExportWriterResult | Promise<ExportWriterResult>

export interface ExportDeps {
  /** 固定时钟，用于 generated_at。 */
  now?: () => string
  /** 缺省批次名（行未带 batch_id 时使用）。 */
  batchId?: string
  /** 输出基路径；给出且未注入 writer 时用默认文件 writer。 */
  out?: string
  /** 注入的写口（测试用假件，绝不落盘到项目目录）。 */
  writer?: ExportWriter
}

export interface ExportResult {
  command: 'export'
  ok: boolean
  columns: readonly string[]
  row_count: number
  groups: ExportGroup[]
  generated_at: string
  json?: string
  csv?: string
  rejected_rows?: ExportRejectedRow[]
  reason?: string
  writer_result?: ExportWriterResult
}

/** 默认输出基路径：只有显式存在时才会落盘。 */
export const DEFAULT_EXPORT_BATCH = 'default-batch'

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 逐字段证据摊成单行可读文本（分号分隔，顺序来自引擎，不重排）。 */
export function evidenceText(evidence: SuggestionExportRow['evidence']): string {
  if (typeof evidence === 'string') return evidence
  if (!Array.isArray(evidence)) return ''
  return evidence
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const e = item as Partial<EvidenceItem>
      return `${e.record_id ?? ''}.${e.field ?? ''}: ${e.candidate_value ?? ''} → ${e.matched_value ?? ''}`
    })
    .filter(Boolean)
    .join('；')
}

/** 兼容英文契约字段与中文列名两种输入形状（英文优先）。 */
function pick(raw: Record<string, unknown>, english: string, chinese: string): unknown {
  const value = raw[english]
  return value === undefined || value === null ? raw[chinese] : value
}

/** 批次取值：空批次落回调用方给的缺省批次名。 */
function batchOf(raw: SuggestionExportRow, fallback: string): string {
  const value = pick(raw as Record<string, unknown>, 'batch_id', '批次')
  return value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : String(value)
}

/** 固定序号 + 固定列投影：JSON 与 CSV、TXT 三份产物同源。 */
export function toExportSheetRow(
  raw: SuggestionExportRow,
  seq: number,
  batchId: string,
): ExportSheetRow {
  const source = raw as Record<string, unknown>
  const candidate = pick(source, 'candidate_id', '候选')
  const action = pick(source, 'action', '结论动作')
  const target = pick(source, 'target_code', '目标 code')
  const rationale = pick(source, 'rationale', '理由')
  const evidence = pick(source, 'evidence', '逐字段证据') as SuggestionExportRow['evidence']
  const confirmedBy = pick(source, 'confirmed_by', '确认人')
  const receiptStatus = pick(source, 'receipt_status', '回执状态')
  return {
    序号: seq,
    批次: batchOf(raw, batchId),
    候选: candidate == null ? '' : String(candidate),
    结论动作: action == null ? 'uncertain' : String(action),
    '目标 code': target == null ? '' : String(target),
    理由: rationale == null ? '' : String(rationale),
    逐字段证据: evidenceText(evidence),
    确认人: confirmedBy == null ? '' : String(confirmedBy),
    回执状态: receiptStatus == null ? '' : String(receiptStatus),
  }
}

/** CSV 固定列顺序 + audit-export 的 csvCell 安全转义（防公式注入/引号/换行）。 */
export function buildExportCsv(sheet: ExportSheetRow[]): string {
  const header = EXPORT_CSV_COLUMNS.join(',')
  const lines = sheet.map((row) => EXPORT_CSV_COLUMNS.map((col) => csvCell(row[col])).join(','))
  return [header, ...lines].join('\n')
}

/** 人类可读纯文本 sheet（writer 落为 .txt）。 */
export function buildExportText(sheet: ExportSheetRow[]): string {
  const lines = [EXPORT_CSV_COLUMNS.join(' ｜ ')]
  for (const row of sheet) {
    lines.push(EXPORT_CSV_COLUMNS.map((col) => String(row[col])).join(' ｜ '))
  }
  return lines.join('\n')
}

/** 默认文件 writer：仅在调用方显式提供 out 时使用，产出三份可读文件。 */
export function createFileExportWriter(): ExportWriter {
  return ({ out, json, csv, txt }) => {
    const dir = dirname(out)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const jsonFile = `${out}.json`
    const csvFile = `${out}.csv`
    const txtFile = `${out}.txt`
    writeFileSync(jsonFile, `${json}\n`, 'utf8')
    writeFileSync(csvFile, `${csv}\n`, 'utf8')
    writeFileSync(txtFile, `${txt}\n`, 'utf8')
    return { json_file: jsonFile, csv_file: csvFile, txt_file: txtFile }
  }
}

/** 合并原始行与投影行的隐私命中（按行下标对齐，命中按 field+type 去重）。 */
function mergeHits(
  rawRejected: ReturnType<typeof scanBatch>['rejected'],
  sheetRejected: ReturnType<typeof scanBatch>['rejected'],
): Map<number, PiiHit[]> {
  const byIndex = new Map<number, PiiHit[]>()
  const add = (index: number, hits: PiiHit[]): void => {
    const previous = byIndex.get(index) ?? []
    const seen = new Set(previous.map((h) => `${h.field}\u0000${h.type}`))
    const next = [...previous]
    for (const hit of hits) {
      const key = `${hit.field}\u0000${hit.type}`
      if (seen.has(key)) continue
      seen.add(key)
      next.push(hit)
    }
    byIndex.set(index, next)
  }
  for (const rejected of rawRejected) add(rejected.index, rejected.verdict.hits)
  for (const rejected of sheetRejected) add(rejected.index, rejected.verdict.hits)
  return byIndex
}

function groupOf(sheet: ExportSheetRow[]): ExportGroup[] {
  const groups: ExportGroup[] = []
  for (const row of sheet) {
    const batchId = String(row.批次)
    let group = groups.find((g) => g.batch_id === batchId)
    if (!group) {
      group = { batch_id: batchId, count: 0, first_seq: Number(row.序号), last_seq: Number(row.序号) }
      groups.push(group)
    }
    group.count += 1
    group.last_seq = Number(row.序号)
  }
  return groups
}

/**
 * 纯函数导出：先投影 + 隐私门，通过后才产出 JSON/CSV/TXT 并调用注入 writer。
 * 任一行命中姓名/证件号形态 → ok:false 且 json/csv 均为 undefined，writer 零调用。
 */
export async function runExport(
  rows: SuggestionExportRow[],
  deps: ExportDeps = {},
): Promise<ExportResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const generatedAt = now()
  const fallbackBatch = deps.batchId ?? DEFAULT_EXPORT_BATCH

  // 按批次稳定排序，再给全局固定序号（同输入必得同序号）。
  const ordered = rows.map((row, inputIndex) => ({ row, inputIndex }))
  ordered.sort((a, b) => {
    const batchA = batchOf(a.row, fallbackBatch)
    const batchB = batchOf(b.row, fallbackBatch)
    return compareText(batchA, batchB) || a.inputIndex - b.inputIndex
  })
  const sheet: ExportSheetRow[] = ordered.map(({ row }, index) =>
    toExportSheetRow(row, index + 1, fallbackBatch),
  )

  // 隐私门：原始行与真正要落出的投影行都扫，命中即整批拒绝。
  const rawScan = scanBatch(ordered.map(({ row }) => ({ ...row })))
  const sheetScan = scanBatch(sheet.map((row) => ({ ...row }) as Record<string, unknown>))
  const hitsByIndex = mergeHits(rawScan.rejected, sheetScan.rejected)
  if (hitsByIndex.size > 0) {
    const rejectedRows: ExportRejectedRow[] = [...hitsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, hits]) => ({
        index,
        序号: Number(sheet[index]?.序号 ?? index + 1),
        候选: String(sheet[index]?.候选 ?? ''),
        candidate_id: String(sheet[index]?.候选 ?? ''),
        hits,
      }))
    return {
      command: 'export',
      ok: false,
      columns: EXPORT_CSV_COLUMNS,
      row_count: sheet.length,
      groups: groupOf(sheet),
      generated_at: generatedAt,
      rejected_rows: rejectedRows,
      reason: `导出被隐私闸门拦截：${rejectedRows.length} 行含姓名/证件号形态字段，整批拒绝且未写入任何文件`,
    }
  }

  const json = JSON.stringify({
    command: 'export',
    generated_at: generatedAt,
    columns: [...EXPORT_CSV_COLUMNS],
    row_count: sheet.length,
    batch_count: groupOf(sheet).length,
    groups: groupOf(sheet),
    note: 'JSON/CSV/TXT 均只含固定列投影；导出前已对原始行与投影行做隐私形状扫描。',
    rows: sheet,
  }, null, 2)
  const csv = buildExportCsv(sheet)
  const txt = buildExportText(sheet)
  const result: ExportResult = {
    command: 'export',
    ok: true,
    columns: EXPORT_CSV_COLUMNS,
    row_count: sheet.length,
    groups: groupOf(sheet),
    generated_at: generatedAt,
    json,
    csv,
  }

  // 只有显式注入 writer 或显式给出 out 时才落盘；被拒路径永不走到这里。
  const writer = deps.writer ?? (deps.out ? createFileExportWriter() : undefined)
  if (writer) {
    result.writer_result = await writer({
      out: deps.out ?? `${fallbackBatch}-merge-suggestions`,
      json,
      csv,
      txt,
      sheet,
      columns: EXPORT_CSV_COLUMNS,
    })
  }
  return result
}

/** CLI 人类可读摘要。 */
export function exportToText(result: ExportResult): string {
  if (!result.ok) {
    const lines = [`导出被拒绝：${result.reason ?? '隐私闸门拦截'}`, '命中行：']
    for (const row of result.rejected_rows ?? []) {
      const hitText = row.hits.map((h) => `${h.field}(${h.type})=${h.value_preview}`).join('、')
      lines.push(`  - 第 ${row.序号} 行（候选 ${row.候选}，输入下标 ${row.index}）：${hitText}`)
    }
    return lines.join('\n')
  }
  const lines = [
    `导出完成：${result.row_count} 行 / ${result.groups.length} 个批次（${result.generated_at}）`,
    `固定列顺序：${EXPORT_CSV_COLUMNS.join('、')}`,
    ...result.groups.map((g) => `  - 批次 ${g.batch_id}：${g.count} 行（序号 ${g.first_seq}–${g.last_seq}）`),
  ]
  if (result.writer_result) {
    const files = [result.writer_result.json_file, result.writer_result.csv_file, result.writer_result.txt_file]
      .filter(Boolean)
      .join('、')
    lines.push(`产物：${files || '已调用注入 writer'}`)
  }
  return lines.join('\n')
}
