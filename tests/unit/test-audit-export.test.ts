import { describe, expect, it, vi } from 'vitest'
import {
  CSV_COLUMNS,
  buildCsv,
  createAuditExporter,
  csvCell,
  queryAudit,
  toCsvRow,
  type AuditExportEvent,
} from '@core/audit/audit-export'
import type { AuditChain as Chain } from '@core/audit/audit-chain'
import { createAuditChain, type AppendInput } from '@core/audit/audit-chain'
import type { Action, AuditEntry } from '@core/types'

const T = (second: number): string => `2026-11-10T08:00:0${second}.000Z`

function clock(): () => string {
  return () => '2026-11-10T09:00:00.000Z'
}

function mustAppend(chain: Chain, input: AppendInput): AuditEntry {
  const result = chain.append(input)
  if (!result.ok) throw new Error(result.reason)
  return result.entry
}

interface Spec {
  cid: string
  action: Action
  ts: string
  batch: string
  by: string
  conf: number
  target?: string
}

const CLEAN_SPECS: Spec[] = [
  { cid: 'C-0001', action: 'merge', ts: T(1), batch: 'B-001', by: 'reviewer-a', conf: 0.91 },
  { cid: 'C-0002', action: 'create', ts: T(2), batch: 'B-001', by: 'reviewer-a', conf: 0.92 },
  { cid: 'C-0003', action: 'uncertain', ts: T(3), batch: 'B-002', by: 'reviewer-b', conf: 0.5 },
  { cid: 'C-0004', action: 'merge', ts: T(4), batch: 'B-002', by: 'reviewer-b', conf: 0.93 },
  { cid: 'C-0005', action: 'create', ts: T(5), batch: 'B-002', by: 'reviewer-a', conf: 0.94 },
  { cid: 'C-0006', action: 'merge', ts: T(6), batch: 'B-001', by: 'reviewer-b', conf: 0.95 },
]

function fromSpecs(specs: Spec[]): Chain {
  const chain = createAuditChain({ now: clock(), confirmedBy: 'reviewer-a' })
  for (const s of specs) {
    mustAppend(chain, {
      candidate_id: s.cid,
      action: s.action,
      ts: s.ts,
      decided_at: s.ts,
      target_code: s.target ?? 'XJ7000000000001',
      evidence: [
        { record_id: 'MD-0001', field: 'spec', candidate_value: '0.25g*12片', matched_value: '0.25g*12片' },
        { record_id: 'MD-0002', field: 'unit', candidate_value: '片', matched_value: '片' },
      ],
      model_call_id: 'mc-0001',
      prompt_hash: 'hash-prompt-0001',
      retrieved_record_ids: ['MD-0001', 'MD-0002'],
      confirmed_by: s.by,
      batch_id: s.batch,
      confidence: s.conf,
      writeback_receipt:
        s.cid === 'C-0006'
          ? { candidate_id: s.cid, status: 'success', idempotency_key: 'idem-0006', created_at: s.ts }
          : null,
    })
  }
  return chain
}

function makeCleanChain(): Chain {
  return fromSpecs(CLEAN_SPECS)
}

function makeExporter(onExport?: (event: AuditExportEvent) => void) {
  let tick = 0
  return createAuditExporter({
    now: () => '2026-11-10T09:00:00.000Z',
    idGen: () => `exp-${++tick}`,
    defaultExportedBy: 'auditor-cli',
    onExport,
  })
}

describe('审计查询与导出（Task 37）', () => {
  it('按 candidate_id + 时间区间组合过滤正确，且结果按时间倒序', () => {
    const chain = makeCleanChain()
    const hit = queryAudit(chain, {
      candidate_id: 'C-0003',
      from: '2026-11-10T08:00:03.000Z',
      to: '2026-11-10T08:00:04.000Z',
    })
    expect(hit.total).toBe(1)
    expect(hit.items.map((e) => e.candidate_id)).toEqual(['C-0003'])

    // 同一 candidate_id 但时间区间不重叠 → 空。
    const miss = queryAudit(chain, { candidate_id: 'C-0003', from: '2026-11-10T08:00:05.000Z' })
    expect(miss.total).toBe(0)
    expect(miss.items).toEqual([])

    // 全量时间倒序（同刻按 seq 倒序稳定性）。
    const all = queryAudit(chain)
    expect(all.total).toBe(6)
    expect(all.items.map((e) => e.candidate_id)).toEqual([
      'C-0006', 'C-0005', 'C-0004', 'C-0003', 'C-0002', 'C-0001',
    ])
  })

  it('action / batch_id / confirmed_by 可组合过滤', () => {
    const chain = makeCleanChain()
    const rows = queryAudit(chain, {
      action: 'merge',
      batch_id: 'B-002',
      confirmed_by: 'reviewer-b',
      from: '2026-11-10T08:00:03.000Z',
      to: '2026-11-10T08:00:05.000Z',
    })
    expect(rows.items.map((e) => e.candidate_id)).toEqual(['C-0004'])
    // action 支持数组。
    expect(queryAudit(chain, { action: ['create', 'uncertain'], batch_id: 'B-002' }).total).toBe(2)
  })

  it('分页 page/pageSize 与 limit/offset 均生效且顺序稳定', () => {
    const chain = makeCleanChain()
    const p2 = queryAudit(chain, {}, { page: 2, pageSize: 2 })
    expect(p2.total).toBe(6)
    expect(p2.offset).toBe(2)
    expect(p2.limit).toBe(2)
    expect(p2.items.map((e) => e.candidate_id)).toEqual(['C-0004', 'C-0003'])

    const off = queryAudit(chain, {}, { offset: 1, limit: 3 })
    expect(off.items.map((e) => e.candidate_id)).toEqual(['C-0005', 'C-0004', 'C-0003'])

    // 导出也遵循分页：表头 + 2 行。
    const exporter = makeExporter()
    const result = exporter.exportCsv(chain, { page: { page: 2, pageSize: 2 } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.content.split('\n')).toHaveLength(3)
  })

  it('CSV 列顺序固定、表头逐字一致，证据→条数、回执→状态，无嵌套对象泄漏', () => {
    expect(CSV_COLUMNS).toEqual([
      '时间', 'candidate_id', 'action', 'target_code', '置信度', '证据条数', '确认人', '回执状态',
    ])
    const chain = makeCleanChain()
    const exporter = makeExporter()
    const result = exporter.exportCsv(chain)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lines = result.content.split('\n')
    expect(lines).toHaveLength(7)
    expect(lines[0]).toBe('时间,candidate_id,action,target_code,置信度,证据条数,确认人,回执状态')
    const first = lines[1]!.split(',')
    expect(first[1]).toBe('C-0006')
    expect(first[5]).toBe('2')          // 证据条数
    expect(first[7]).toBe('success')    // 回执状态
    expect(result.content).not.toContain('record_id')
    expect(result.content).not.toContain('candidate_value')
    expect(result.content).not.toContain('idempotency_key')

    // toCsvRow / buildCsv / csvCell 的扁平与转义契约。
    const row = toCsvRow(chain.last()!)
    expect(row['证据条数']).toBe(2)
    expect(row['回执状态']).toBe('success')
    expect(typeof row).toBe('object')
    expect(buildCsv([row]).split('\n')).toHaveLength(2)
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('说"好"')).toBe('"说""好"""')
  })

  it('JSON 导出保留全部 AuditEntry 字段', () => {
    const chain = makeCleanChain()
    const exporter = makeExporter()
    const result = exporter.exportJson(chain, { filter: { candidate_id: 'C-0006' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content.startsWith('[')).toBe(true)
    const parsed = JSON.parse(result.content) as AuditEntry[]
    expect(parsed).toHaveLength(1)
    const entry = parsed[0]!
    for (const key of [
      'seq', 'ts', 'candidate_id', 'action', 'target_code', 'evidence', 'model_call_id',
      'prompt_hash', 'retrieved_record_ids', 'decided_at', 'confirmed_by',
      'writeback_receipt', 'prev_hash', 'hash', 'status', 'batch_id', 'confidence',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(entry, key), `JSON 缺字段 ${key}`).toBe(true)
    }
    expect(entry.evidence).toHaveLength(2)
    expect(entry.writeback_receipt?.status).toBe('success')
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('导出含姓名形态字符串时拒绝并报告越权行，且不产出内容、不记成功事件', () => {
    const dirty = fromSpecs([
      { cid: 'C-0001', action: 'merge', ts: T(1), batch: 'B-ALL', by: 'reviewer-a', conf: 0.91 },
      { cid: 'C-BAD', action: 'merge', ts: T(2), batch: 'B-ALL', by: '张三', conf: 0.9 },
      { cid: 'C-0003', action: 'uncertain', ts: T(3), batch: 'B-ALL', by: 'reviewer-b', conf: 0.5 },
    ])
    const exporter = makeExporter()
    const result = exporter.exportCsv(dirty, { filter: { batch_id: 'B-ALL' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejected_by).toBe('pii_guard')
    expect(result.rejected_indices).toEqual([1])
    expect(result.offending).toHaveLength(1)
    expect(result.offending[0]!.seq).toBe(2)
    expect(result.offending[0]!.candidate_id).toBe('C-BAD')
    expect(result.offending[0]!.hits.some((h) => h.type === 'name_field' && h.field === '确认人')).toBe(true)
    expect(result.offending[0]!.hits[0]!.value_preview).toContain('*')
    expect(JSON.stringify(result.offending)).not.toContain('张三')
    // 被拒导出没有 content 出口。
    expect('content' in result).toBe(false)

    // 只记 rejected 事件，不记任何成功事件。
    const events = exporter.snapshotEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.status).toBe('rejected')
    expect(events[0]!.rejected_indices).toEqual([1])
    expect(events.some((e) => e.status === 'success')).toBe(false)

    // JSON 导出同样拒绝：confirmed_by 字段名 + 非编码值。
    const jsonResult = exporter.exportJson(dirty, { filter: { candidate_id: 'C-BAD' } })
    expect(jsonResult.ok).toBe(false)
    if (!jsonResult.ok) {
      expect(jsonResult.offending[0]!.hits.some((h) => h.type === 'name_field' && h.field === 'confirmed_by')).toBe(true)
    }
  })

  it('证件号形态值内嵌于 target_code 时导出被拒（id_card）', () => {
    const dirty = fromSpecs([
      { cid: 'C-ID', action: 'merge', ts: T(1), batch: 'B-1', by: 'reviewer-a', conf: 0.9, target: 'REF-110101199003072316' },
    ])
    const exporter = makeExporter()
    const result = exporter.exportCsv(dirty)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.offending[0]!.hits.some((h) => h.type === 'id_card')).toBe(true)
      expect(result.offending[0]!.hits.every((h) => !h.value_preview.includes('110101199003072316'))).toBe(true)
    }
  })

  it('每次导出都记 audit_export 事件：导出人 / 过滤条件 / 行数 / 状态，并支持回调端口', () => {
    const onExport = vi.fn()
    const exporter = makeExporter(onExport)
    const chain = makeCleanChain()
    const filter = { action: 'merge' as Action, batch_id: 'B-001' }
    const result = exporter.exportCsv(chain, { filter, exportedBy: 'operator-7' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.row_count).toBe(2)
    expect(onExport).toHaveBeenCalledTimes(1)
    const event = exporter.snapshotEvents()[0]!
    expect(event.event).toBe('audit_export')
    expect(event.id).toBe('exp-1')
    expect(event.at).toBe('2026-11-10T09:00:00.000Z')
    expect(event.format).toBe('csv')
    expect(event.exported_by).toBe('operator-7')
    expect(event.filter).toEqual(filter)
    expect(event.row_count).toBe(2)
    expect(event.total).toBe(2)
    expect(event.status).toBe('success')
    expect(onExport.mock.calls[0]![0]).toEqual(event)
  })

  it('exportEvents 为只读快照，改动返回值不影响内部事件', () => {
    const exporter = makeExporter()
    const chain = makeCleanChain()
    expect(exporter.exportJson(chain).ok).toBe(true)
    expect(exporter.exportEvents).toHaveLength(1)
    const snap = exporter.exportEvents as unknown as Array<Record<string, unknown>>
    snap[0]!.status = 'TAMPERED'
    snap.push({ fake: true })
    expect(exporter.snapshotEvents()[0]!.status).toBe('success')
    expect(exporter.snapshotEvents()).toHaveLength(1)
  })
})
