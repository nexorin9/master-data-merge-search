/**
 * 审计查询与导出（Task 37）。
 *
 * 组合过滤（candidate_id / action / 时间区间 / confirmed_by / batch_id）后按
 * 时间倒序、稳定分页。导出两种格式：JSON 保留全部 AuditEntry 字段；CSV 固定
 * 列顺序，证据摊成条数、回执摊成状态，单元格安全转义，绝不让嵌套对象泄漏。
 *
 * 内容边界：导出前用 pii-guard 的 scanBatch 逐行扫描「真正要落出的行」，任一
 * 行命中即整体拒绝，并返回越权行下标 + 该行 seq/candidate_id + 命中明细（预览
 * 已掩码），不产出任何内容。每次导出都记一条 audit_export 事件（导出人 / 过滤
 * 条件 / 行数 / 状态）；被 PII 拒绝时只记 rejected 事件，不记成功事件。
 */
import type { Action, AuditEntry, PiiHit } from '../types'
import type { AuditChain } from './audit-chain'
import { scanBatch, type BatchScanResult } from './pii-guard'

/** CSV 固定列顺序（表头逐字一致）。 */
export const CSV_COLUMNS = [
  '时间',
  'candidate_id',
  'action',
  'target_code',
  '置信度',
  '证据条数',
  '确认人',
  '回执状态',
] as const

export type ExportFormat = 'json' | 'csv'

/** 可组合过滤条件；时间区间为闭区间 [from, to]。 */
export interface ExportFilter {
  candidate_id?: string
  action?: Action | Action[]
  from?: string
  to?: string
  confirmed_by?: string
  batch_id?: string
}

/** 分页：page/pageSize（1 起）或 limit/offset 二选一。 */
export interface ExportPage {
  page?: number
  pageSize?: number
  limit?: number
  offset?: number
}

export interface ExportOptions {
  format: ExportFormat
  filter?: ExportFilter
  page?: ExportPage
  /** 本次导出人；缺省取 exporter 的默认值。 */
  exportedBy?: string
}

/** 查询分页出口。 */
export interface PagedAuditResult {
  items: AuditEntry[]
  total: number
  offset: number
  limit: number
}

/** 导出的 audit_export 事件。 */
export interface AuditExportEvent {
  event: 'audit_export'
  id: string
  at: string
  format: ExportFormat
  exported_by: string
  filter: ExportFilter
  page: ExportPage
  row_count: number
  total: number
  status: 'success' | 'rejected'
  rejected_indices?: number[]
}

/** 越权（PII）行明细。 */
export interface OffendingRow {
  index: number
  seq: number
  candidate_id: string
  hits: PiiHit[]
}

export interface ExportSuccess {
  ok: true
  format: ExportFormat
  content: string
  row_count: number
  total: number
  event: AuditExportEvent
}

export interface ExportRejection {
  ok: false
  rejected_by: 'pii_guard'
  format: ExportFormat
  reason: string
  rejected_indices: number[]
  offending: OffendingRow[]
  event: AuditExportEvent
}

export type ExportResult = ExportSuccess | ExportRejection

export interface AuditExporterOptions {
  now?: () => string
  idGen?: () => string
  defaultExportedBy?: string
  /** 回调端口：每次导出（含被拒）都会收到事件。 */
  onExport?: (event: AuditExportEvent) => void
}

export interface AuditExporter {
  exportAudit(chain: AuditChain, options: ExportOptions): ExportResult
  exportJson(chain: AuditChain, options?: Omit<ExportOptions, 'format'>): ExportResult
  exportCsv(chain: AuditChain, options?: Omit<ExportOptions, 'format'>): ExportResult
  /** 只读快照，改返回值不影响内部事件。 */
  readonly exportEvents: AuditExportEvent[]
  snapshotEvents(): AuditExportEvent[]
}

/** 比较两个时间字符串；不可解析时退回字典序。 */
function compareTime(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb
  return a < b ? -1 : a > b ? 1 : 0
}

/** 组合过滤：所有给定条件同时满足。 */
function matchesFilter(entry: AuditEntry, filter: ExportFilter): boolean {
  if (filter.candidate_id !== undefined && entry.candidate_id !== filter.candidate_id) return false
  if (filter.action !== undefined) {
    const actions = Array.isArray(filter.action) ? filter.action : [filter.action]
    if (!actions.includes(entry.action)) return false
  }
  if (filter.confirmed_by !== undefined && entry.confirmed_by !== filter.confirmed_by) return false
  if (filter.batch_id !== undefined && entry.batch_id !== filter.batch_id) return false
  if (filter.from !== undefined && compareTime(entry.ts, filter.from) < 0) return false
  if (filter.to !== undefined && compareTime(entry.ts, filter.to) > 0) return false
  return true
}

/** 解析分页参数：显式 limit/offset 优先，否则 page/pageSize。 */
function resolvePage(page: ExportPage, total: number): { offset: number; limit: number } {
  if (page.limit !== undefined || page.offset !== undefined) {
    const offset = Math.max(0, Math.floor(page.offset ?? 0))
    const limit = Math.max(0, Math.floor(page.limit ?? total))
    return { offset, limit }
  }
  const pageNo = Math.max(1, Math.floor(page.page ?? 1))
  const pageSize = Math.max(1, Math.floor(page.pageSize ?? 50))
  return { offset: (pageNo - 1) * pageSize, limit: pageSize }
}

/** 查询链：组合过滤 → 时间倒序（同刻按 seq 倒序）→ 稳定分页。 */
export function queryAudit(
  chain: AuditChain,
  filter: ExportFilter = {},
  page: ExportPage = {},
): PagedAuditResult {
  const matched = chain
    .query()
    .filter((entry) => matchesFilter(entry, filter))
    .sort((a, b) => compareTime(b.ts, a.ts) || b.seq - a.seq)
  const { offset, limit } = resolvePage(page, matched.length)
  return { items: matched.slice(offset, offset + limit), total: matched.length, offset, limit }
}

/** 把整条审计记录摊成固定列顺序的 CSV 行（值均为基本类型）。 */
export function toCsvRow(entry: AuditEntry): Record<(typeof CSV_COLUMNS)[number], string | number> {
  return {
    时间: entry.ts,
    candidate_id: entry.candidate_id,
    action: entry.action,
    target_code: entry.target_code ?? '',
    置信度: entry.confidence ?? '',
    证据条数: entry.evidence.length,
    确认人: entry.confirmed_by,
    回执状态: entry.writeback_receipt?.status ?? '',
  }
}

/** 单元格安全转义：逗号/引号/换行加引号，并防 CSV 公式注入。 */
export function csvCell(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** 组装 CSV 文本：表头 + 数据行，固定列顺序。 */
export function buildCsv(rows: Array<Record<(typeof CSV_COLUMNS)[number], string | number>>): string {
  const header = CSV_COLUMNS.join(',')
  const lines = rows.map((row) => CSV_COLUMNS.map((col) => csvCell(row[col])).join(','))
  return [header, ...lines].join('\n')
}

/** 从批量扫描结果里挑出越权行明细（含掩码预览，不回显完整值）。 */
function collectOffending(
  scan: BatchScanResult,
  page: AuditEntry[],
): OffendingRow[] {
  return scan.rejected.map((rejected) => {
    const entry = page[rejected.index]!
    return {
      index: rejected.index,
      seq: entry.seq,
      candidate_id: entry.candidate_id,
      hits: rejected.verdict.hits,
    }
  })
}

export function createAuditExporter(options: AuditExporterOptions = {}): AuditExporter {
  const now = options.now ?? (() => new Date().toISOString())
  let counter = 0
  const idGen = options.idGen ?? (() => `export-${++counter}`)
  const defaultExportedBy = options.defaultExportedBy ?? 'system'
  const events: AuditExportEvent[] = []

  function record(event: AuditExportEvent): void {
    events.push(event)
    options.onExport?.(structuredClone(event))
  }

  function exportAudit(chain: AuditChain, exportOptions: ExportOptions): ExportResult {
    const { format } = exportOptions
    const filter = exportOptions.filter ?? {}
    const pageOpts = exportOptions.page ?? {}
    const exportedBy = exportOptions.exportedBy ?? defaultExportedBy
    const { items, total } = queryAudit(chain, filter, pageOpts)

    // 真正要落出的行：CSV 为摊平后的固定列行；JSON 为完整记录。
    const csvRows = format === 'csv' ? items.map(toCsvRow) : []
    const scanRows: Array<Record<string, unknown>> =
      format === 'csv'
        ? csvRows.map((row) => ({ ...row }) as Record<string, unknown>)
        : items.map((entry) => structuredClone(entry) as unknown as Record<string, unknown>)

    const baseEvent: AuditExportEvent = {
      event: 'audit_export',
      id: idGen(),
      at: now(),
      format,
      exported_by: exportedBy,
      filter: structuredClone(filter),
      page: structuredClone(pageOpts),
      row_count: 0,
      total,
      status: 'rejected',
    }

    const scan = scanBatch(scanRows)
    if (scan.rejected_count > 0) {
      const rejectedIndices = scan.rejected.map((rejected) => rejected.index)
      const offending = collectOffending(scan, items)
      const event: AuditExportEvent = { ...baseEvent, rejected_indices: rejectedIndices }
      record(event)
      return {
        ok: false,
        rejected_by: 'pii_guard',
        format,
        reason: `导出被隐私闸门拦截：${scan.rejected_count} 行含姓名/证件号形态字段`,
        rejected_indices: rejectedIndices,
        offending,
        event,
      }
    }

    const content = format === 'csv' ? buildCsv(csvRows) : JSON.stringify(items, null, 2)
    const event: AuditExportEvent = { ...baseEvent, row_count: items.length, status: 'success' }
    record(event)
    return { ok: true, format, content, row_count: items.length, total, event }
  }

  return {
    exportAudit,
    exportJson: (chain, rest = {}) => exportAudit(chain, { ...rest, format: 'json' }),
    exportCsv: (chain, rest = {}) => exportAudit(chain, { ...rest, format: 'csv' }),
    get exportEvents() {
      return structuredClone(events)
    },
    snapshotEvents: () => structuredClone(events),
  }
}
