/**
 * 确认闸门 + 幂等键 + 逐行回执（Task 32）。
 *
 * 全部依赖注入：sink / now / sleep / privacyGate / auditAppend / replayLedger 均为假件，
 * 绝不触网。逐条断言：确认闸门、降级闸门、隐私闸门、固定调用顺序、三态回执与部分失败。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MdmResult, MergeSuggestionBody } from '@core/retrieval/mdm-client'
import type { EvidenceItem, MergeConclusion } from '@core/types'
import {
  actionHash,
  conclusionToBody,
  createReplayLedger,
  idempotencyKey,
  normalizeEvidenceSet,
  wireIdempotencyKey,
} from '@core/writeback/idempotency'
import {
  writeSuggestion,
  type PrivacyGate,
  type WritebackPorts,
} from '@core/writeback/suggestion-writer'
import { runWritebackBatch, type BatchPorts } from '@core/writeback/batch'

const NOW = '2026-11-10T10:00:00.000Z'
const FROZEN_CLOCK = 1_800_000_000_000

function makeEvidence(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    record_id: 'MD-0001',
    field: 'spec',
    candidate_value: '0.25g*12片',
    matched_value: '0.25g*12片',
    ...over,
  }
}

function makeConclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  return {
    candidate_id: 'C-1',
    domain: 'drug',
    action: 'merge',
    target_code: 'CODE-0001',
    confidence: 0.9,
    rationale: '规格与医保码一致',
    evidence: [
      makeEvidence(),
      makeEvidence({ field: 'insurance_code', candidate_value: 'XJ7000000000001', matched_value: 'XJ7000000000001' }),
    ],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    decided_at: NOW,
    ...over,
  }
}

type SinkResult = MdmResult<Record<string, unknown>>

function okSink() {
  return vi.fn(
    async (_candidateId: string, _body: MergeSuggestionBody, _key: string): Promise<SinkResult> => ({
      ok: true,
      status: 201,
      data: { suggestion_id: 'S-1' },
    }),
  )
}

function makePorts(over: Partial<WritebackPorts> = {}): WritebackPorts {
  return {
    sink: okSink(),
    now: () => NOW,
    sleep: async () => {},
    ...over,
  }
}

describe('确认闸门 / 幂等键 / 逐行回执（Task 32）', () => {
  it('actionHash 顺序无关且只覆盖实质字段，目标码变化即换键；idempotencyKey = sha256(candidate_id｜actionHash)', () => {
    const c = makeConclusion()
    const shuffled = makeConclusion({ evidence: [...c.evidence].reverse() })
    const reworded = makeConclusion({ rationale: '措辞调整', confidence: 0.5 })
    const retargeted = makeConclusion({ target_code: 'CODE-0002' })

    expect(actionHash(c)).toBe(actionHash(shuffled))
    expect(normalizeEvidenceSet(c.evidence)).toEqual(normalizeEvidenceSet(shuffled.evidence))
    expect(actionHash(c)).toBe(actionHash(reworded))
    expect(actionHash(c)).not.toBe(actionHash(retargeted))
    expect(idempotencyKey('C-1', c)).toMatch(/^[0-9a-f]{64}$/)
    expect(idempotencyKey('C-1', c)).not.toBe(idempotencyKey('C-2', c))
    // 复用 mdm-client 的 wire 键口径仍可用（显式键由本簇统一计算）。
    expect(wireIdempotencyKey('C-1', conclusionToBody(c))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('写回 body 五字段 1:1 对齐 MergeSuggestionBody，证据仅四要素、不含规则层附加位', () => {
    const c = makeConclusion({
      evidence: [makeEvidence({ evidence_mismatch: true, conflict_hit: true })],
    })
    const body = conclusionToBody(c)
    expect(Object.keys(body).sort()).toEqual(
      ['action', 'confidence', 'evidence', 'rationale', 'target_code'].sort(),
    )
    expect(body.evidence[0]).toEqual({
      record_id: 'MD-0001',
      field: 'spec',
      candidate_value: '0.25g*12片',
      matched_value: '0.25g*12片',
    })
    expect(body.evidence[0]).not.toHaveProperty('evidence_mismatch')
  })

  it('同一键提交两次 → sink 仅调用一次，第二次回执 skipped 且提交类别为 replay', async () => {
    const ledger = createReplayLedger({ now: () => NOW })
    const sink = okSink()
    const ports = makePorts({ sink, replayLedger: ledger })
    const c = makeConclusion()

    const first = await writeSuggestion(c, ports, { confirmed: true })
    const second = await writeSuggestion(c, ports, { confirmed: true })

    expect(first.status).toBe('success')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(second.status).toBe('skipped')
    expect(second.submission_kind).toBe('replay')
    expect(second.reason).toBe('idempotent_skip')
    expect(second.sink_calls).toBe(0)
    expect(sink.mock.calls[0]![2]).toBe(first.idempotency_key)
    expect(ledger.skippedCount).toBe(1)
  })

  it('未逐条确认的结论 → sink 零调用，回执 skipped（unconfirmed）', async () => {
    const sink = okSink()
    const trace: string[] = []
    const result = await writeSuggestion(makeConclusion(), makePorts({ sink, trace: (s) => trace.push(s) }), {
      confirmed: false,
    })
    expect(result.status).toBe('skipped')
    expect(result.kind).toBe('unconfirmed')
    expect(result.readable_reason).toContain('未逐条人工确认')
    expect(result.sink_calls).toBe(0)
    expect(sink).not.toHaveBeenCalled()
    expect(trace).toEqual(['confirm'])
  })

  it('降级（degraded）结论恒被拒绝 → sink 零调用，回执 failed 带中文原因', async () => {
    const sink = okSink()
    const result = await writeSuggestion(
      makeConclusion({ degraded: true, degraded_reason: '模型不可用' }),
      makePorts({ sink }),
      { confirmed: true },
    )
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('degraded')
    expect(result.readable_reason).toContain('降级')
    expect(result.sink_calls).toBe(0)
    expect(sink).not.toHaveBeenCalled()
  })

  it('隐私闸门拒绝 → sink 与审计零调用；放行时调用顺序恒为 闸门→审计→写', async () => {
    const order: string[] = []
    const sink = vi.fn(async () => {
      order.push('sink')
      return { ok: true, status: 201, data: {} } as SinkResult
    })
    const refuse: PrivacyGate = async () => ({ ok: false, reason: '隐私闸门拦截：命中个人信息' })
    const refused = await writeSuggestion(makeConclusion(), makePorts({ sink, privacyGate: refuse }), {
      confirmed: true,
    })
    expect(refused.status).toBe('failed')
    expect(refused.kind).toBe('privacy')
    expect(refused.readable_reason).toContain('个人信息')
    expect(sink).not.toHaveBeenCalled()
    expect(order).toEqual([])

    const pass: PrivacyGate = async (_rows, write) => {
      order.push('gate')
      await write()
      return { ok: true }
    }
    const auditAppend = vi.fn(() => order.push('audit'))
    const accepted = await writeSuggestion(
      makeConclusion({ candidate_id: 'C-2' }),
      makePorts({ sink, privacyGate: pass, auditAppend }),
      { confirmed: true },
    )
    expect(accepted.status).toBe('success')
    expect(order).toEqual(['gate', 'audit', 'sink'])
    expect(auditAppend).toHaveBeenCalledTimes(1)
  })

  it('单批 10 条中 1 条失败 → 其余 9 条照常写回，失败独立成项不中断', async () => {
    const conclusions = Array.from({ length: 10 }, (_, i) =>
      makeConclusion({ candidate_id: `C-${i + 1}` }),
    )
    const sink = vi.fn(async (candidateId: string): Promise<SinkResult> => {
      if (candidateId === 'C-4') return { ok: false, status: 422, error: '候选状态不允许写回' }
      return { ok: true, status: 201, data: {} }
    })
    const ports: BatchPorts = {
      sink,
      now: () => NOW,
      clock: () => FROZEN_CLOCK,
    }
    const summary = await runWritebackBatch(conclusions, ports, { concurrency: 1, confirmed: true, batchId: 'B-32' })
    expect(summary.succeeded).toBe(9)
    expect(summary.failed).toBe(1)
    expect(summary.skipped).toBe(0)
    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0]!.candidate_id).toBe('C-4')
    expect(summary.failures[0]!.kind).toBe('client_4xx')
    expect(sink).toHaveBeenCalledTimes(10)
  })
})
