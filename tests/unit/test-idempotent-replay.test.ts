/**
 * 幂等重放语义（Task 33）。
 *
 * 核心合约：resolveWithReplayLedger 只在缓存未命中时调用 evaluate（等价于「模型 /
 * 重新评估」回调），命中时直接返回既有建议——测试用 vi.fn 断言 replay 时该回调
 * 一次都没被调用（无 modelCallCount 字段，靠回调次数证明）。replay 同时无 sink 调用、
 * 无审计条目、不推进候选状态，只累加 skipped 计数。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MdmResult, MergeSuggestionBody } from '@core/retrieval/mdm-client'
import type { EvidenceItem, MergeConclusion } from '@core/types'
import {
  actionHash,
  conclusionToBody,
  createReplayLedger,
  idempotencyKey,
  resolveWithReplayLedger,
  type ReplayLedger,
} from '@core/writeback/idempotency'
import { writeSuggestion, type WritebackPorts } from '@core/writeback/suggestion-writer'

const NOW = '2026-11-10T10:00:00.000Z'

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
    evidence: [makeEvidence()],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    decided_at: NOW,
    ...over,
  }
}

function makeSink() {
  const calls: Array<{ id: string; key: string; body: MergeSuggestionBody }> = []
  const fn = vi.fn(
    async (id: string, body: MergeSuggestionBody, key: string): Promise<MdmResult<Record<string, unknown>>> => {
      calls.push({ id, key, body })
      return { ok: true, status: 201, data: {} }
    },
  )
  return { fn, calls }
}

function makePorts(over: Partial<WritebackPorts> = {}): WritebackPorts {
  return { sink: makeSink().fn, now: () => NOW, sleep: async () => {}, ...over }
}

/** 一次「重新评估」：同哈希命中账本时 evaluate 不被调用，直接返回既有建议。 */
function evaluateOnce(ledger: ReplayLedger, conclusion: MergeConclusion, model: () => MergeSuggestionBody) {
  return resolveWithReplayLedger(ledger, {
    candidateId: conclusion.candidate_id,
    hash: actionHash(conclusion),
    evaluate: model,
  })
}

describe('幂等重放语义（Task 33）', () => {
  it('同一候选重放两次 → sink 仅 1 次、评估回调仅 1 次，第二次直接 skipped', async () => {
    const ledger = createReplayLedger({ now: () => NOW })
    const { fn: sink, calls } = makeSink()
    const model = vi.fn(() => conclusionToBody(makeConclusion()))
    const ports = makePorts({ sink, replayLedger: ledger })
    const c = makeConclusion()

    const first = evaluateOnce(ledger, c, model)
    expect(first.kind).toBe('fresh')
    expect(first.fromCache).toBe(false)
    expect(model).toHaveBeenCalledTimes(1)
    const w1 = await writeSuggestion(c, ports, { confirmed: true })
    expect(w1.status).toBe('success')
    expect(sink).toHaveBeenCalledTimes(1)

    const second = evaluateOnce(ledger, c, model)
    expect(second.kind).toBe('replay')
    expect(second.fromCache).toBe(true)
    expect(second.suggestion).toEqual(first.suggestion)
    expect(model).toHaveBeenCalledTimes(1) // 关键：replay 不触发新的模型 / 评估调用

    const w2 = await writeSuggestion(c, ports, { confirmed: true })
    expect(w2.status).toBe('skipped')
    expect(w2.submission_kind).toBe('replay')
    expect(sink).toHaveBeenCalledTimes(1) // 关键：replay 不触发新的 sink 调用
    expect(calls).toHaveLength(1)
  })

  it('改动 target_code → actionHash 变化 → 生成新建议并写入', async () => {
    const ledger = createReplayLedger({ now: () => NOW })
    const { fn: sink } = makeSink()
    const ports = makePorts({ sink, replayLedger: ledger })
    const original = makeConclusion()
    const changed = makeConclusion({ target_code: 'CODE-0002' })

    expect(actionHash(changed)).not.toBe(actionHash(original))
    expect(idempotencyKey('C-1', changed)).not.toBe(idempotencyKey('C-1', original))

    const w1 = await writeSuggestion(original, ports, { confirmed: true })
    const w2 = await writeSuggestion(changed, ports, { confirmed: true })
    expect(w1.status).toBe('success')
    expect(w2.status).toBe('success')
    expect(w2.submission_kind).toBe('fresh')
    expect(sink).toHaveBeenCalledTimes(2)
    expect(ledger.entries).toHaveLength(2)
  })

  it('证据值实质变化也会换哈希，生成新建议；仅证据顺序变化不换键', async () => {
    const c = makeConclusion({
      evidence: [makeEvidence(), makeEvidence({ field: 'unit', matched_value: '盒', candidate_value: '盒' })],
    })
    const reordered = makeConclusion({ evidence: [...c.evidence].reverse() })
    const valueChanged = makeConclusion({
      evidence: [makeEvidence({ matched_value: '0.5g*12片' })],
    })
    expect(actionHash(c)).toBe(actionHash(reordered))
    expect(idempotencyKey('C-1', c)).toBe(idempotencyKey('C-1', reordered))
    expect(actionHash(c)).not.toBe(actionHash(valueChanged))
  })

  it('带 supersedes 的新哈希重提交 → 识别为 revoke-then-resubmit，走正常写路径', async () => {
    const ledger = createReplayLedger({ now: () => NOW })
    const { fn: sink } = makeSink()
    const order: string[] = []
    const auditAppend = vi.fn((entry: unknown) => order.push((entry as { kind: string }).kind))
    const ports = makePorts({ sink, replayLedger: ledger, auditAppend })
    const original = makeConclusion()
    await writeSuggestion(original, ports, { confirmed: true })

    const superseding = makeConclusion({ target_code: 'CODE-0009' })
    const model = vi.fn(() => conclusionToBody(superseding))
    const resolved = resolveWithReplayLedger(ledger, {
      candidateId: 'C-1',
      hash: actionHash(superseding),
      evaluate: model,
      supersedes: original.candidate_id,
    })
    expect(resolved.kind).toBe('supersede')
    expect(model).toHaveBeenCalledTimes(1)

    const written = await writeSuggestion(superseding, ports, {
      confirmed: true,
      supersedes: 'old-hash',
    })
    expect(written.status).toBe('success')
    expect(written.submission_kind).toBe('supersede')
    expect(sink).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['suggestion', 'revoke', 'suggestion'])
    expect(ledger.entries[1]!.supersedes).toBe('old-hash')
  })

  it('replay 不新增审计条目（只累加 skipped 计数）', async () => {
    const ledger = createReplayLedger({ now: () => NOW })
    const auditAppend = vi.fn()
    const ports = makePorts({ sink: makeSink().fn, replayLedger: ledger, auditAppend })
    const c = makeConclusion()

    await writeSuggestion(c, ports, { confirmed: true })
    const afterFirst = auditAppend.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    await writeSuggestion(c, ports, { confirmed: true })
    expect(auditAppend).toHaveBeenCalledTimes(afterFirst) // 关键：replay 无新审计
    expect(ledger.skippedCount).toBe(1)
  })

  it('replay 不推进候选状态水位', async () => {
    const ledger = createReplayLedger({ now: () => NOW })
    const ports = makePorts({ sink: makeSink().fn, replayLedger: ledger })
    const c = makeConclusion()

    expect(ledger.stateVersionOf('C-1')).toBe(0)
    await writeSuggestion(c, ports, { confirmed: true })
    const afterWrite = ledger.stateVersionOf('C-1')
    expect(afterWrite).toBe(1)
    await writeSuggestion(c, ports, { confirmed: true })
    await writeSuggestion(c, ports, { confirmed: true })
    expect(ledger.stateVersionOf('C-1')).toBe(afterWrite) // 关键：replay 状态不前进
  })
})
