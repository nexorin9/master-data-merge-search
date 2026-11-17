import { describe, expect, it } from 'vitest'
import {
  GENESIS_HASH,
  canonicalJson,
  computeEntryHash,
  createAuditChain,
  type AppendInput,
  type AuditChain,
} from '@core/audit/audit-chain'
import type { EvidenceItem } from '@core/types'

/** 递增时钟：保证每条审计记录时间戳不同且可复现。 */
function clock(start = 0): () => string {
  let tick = start
  return () => new Date(Date.UTC(2026, 10, 10, 8, 0, tick++)).toISOString()
}

const evidence: EvidenceItem[] = [
  { record_id: 'MD-0001', field: 'spec', candidate_value: '0.25g*12片', matched_value: '0.25g*12片' },
]

function baseInput(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    candidate_id: 'C-0001',
    action: 'merge',
    target_code: 'XJ7000000000001',
    evidence,
    model_call_id: 'mc-0001',
    prompt_hash: 'hash-prompt-0001',
    retrieved_record_ids: ['MD-0001'],
    decided_at: '2026-11-10T08:00:00.000Z',
    confirmed_by: 'reviewer-a',
    batch_id: 'B-001',
    confidence: 0.91,
    ...overrides,
  }
}

function makeChain(): AuditChain {
  return createAuditChain({ now: clock(), confirmedBy: 'reviewer-a' })
}

function mustAppend(chain: AuditChain, input: AppendInput) {
  const result = chain.append(input)
  expect(result.ok, result.ok ? '' : result.reason).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.entry
}

describe('只增不改审计链与撤销（Task 36）', () => {
  it('append 逐条追加使 length 递增，序号从 1 连续分配', () => {
    const chain = makeChain()
    expect(chain.length).toBe(0)
    const e1 = mustAppend(chain, baseInput())
    const e2 = mustAppend(chain, baseInput({ candidate_id: 'C-0002', action: 'create' }))
    const e3 = mustAppend(chain, baseInput({ candidate_id: 'C-0003', action: 'uncertain' }))
    expect(chain.length).toBe(3)
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3])
    expect(chain.last()?.seq).toBe(3)
    expect(chain.last()?.hash).toBe(e3.hash)
  })

  it('记录含全部 AuditEntry 字段，且创世 prev_hash 为 64 个 0', () => {
    const chain = makeChain()
    const entry = mustAppend(chain, baseInput())
    for (const key of [
      'seq', 'ts', 'candidate_id', 'action', 'target_code', 'evidence', 'model_call_id',
      'prompt_hash', 'retrieved_record_ids', 'decided_at', 'confirmed_by',
      'writeback_receipt', 'prev_hash', 'hash', 'status', 'batch_id', 'confidence',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(entry, key), `缺少字段 ${key}`).toBe(true)
    }
    expect(entry.prev_hash).toBe(GENESIS_HASH)
    expect(entry.status).toBe('active')
    expect(entry.writeback_receipt).toBeNull()
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('链不暴露 update / delete / splice 等改写方法', () => {
    const chain = makeChain()
    const raw = chain as unknown as Record<string, unknown>
    for (const forbidden of ['update', 'delete', 'remove', 'splice', 'overwrite', 'set']) {
      expect(raw[forbidden], `不应暴露改写方法 ${forbidden}`).toBeUndefined()
    }
    mustAppend(chain, baseInput())
    expect(chain.length).toBe(1)
  })

  it('干净追加的哈希链通过 verify()，且 hash 可由 prev_hash + 载荷重算', () => {
    const chain = makeChain()
    const e1 = mustAppend(chain, baseInput())
    const e2 = mustAppend(chain, baseInput({ candidate_id: 'C-0002' }))
    const e3 = mustAppend(chain, baseInput({ candidate_id: 'C-0003' }))
    expect(chain.verify()).toEqual({ ok: true })
    expect(e2.prev_hash).toBe(e1.hash)
    expect(e3.prev_hash).toBe(e2.hash)
    const stored = chain.toArray()
    expect(computeEntryHash(stored[1]!.prev_hash, stored[1]!)).toBe(stored[1]!.hash)
    expect(computeEntryHash(stored[2]!.prev_hash, stored[2]!)).toBe(stored[2]!.hash)
  })

  it('revoke 以追加一条带 supersedes 的新记录实现，旧记录仍在且派生视图标为 revoked', () => {
    const chain = makeChain()
    mustAppend(chain, baseInput())
    const target = mustAppend(chain, baseInput({ candidate_id: 'C-0002' }))
    mustAppend(chain, baseInput({ candidate_id: 'C-0003' }))
    const before = chain.length
    const revocation = chain.revoke(target.hash, { confirmedBy: 'reviewer-b' })

    expect(chain.length).toBe(before + 1)
    expect(revocation.seq).toBe(before + 1)
    expect(revocation.supersedes).toBe(target.hash)
    expect(revocation.status).toBe('active')

    // 旧记录仍存储且存储态不可变（仍为 active）。
    const stored = chain.toArray()
    expect(stored.find((e) => e.hash === target.hash)).toBeDefined()
    expect(stored.find((e) => e.hash === target.hash)?.status).toBe('active')

    // 派生视图依据 supersedes 链接推导状态，不写回存储对象。
    const view = chain.view()
    expect(view.find((e) => e.hash === target.hash)?.status).toBe('revoked')
    expect(view.find((e) => e.hash === revocation.hash)?.status).toBe('active')
    expect(chain.toArray().find((e) => e.hash === target.hash)?.status).toBe('active')
    expect(chain.verify()).toEqual({ ok: true })
  })

  it('篡改中间条目后 verify() 失败并报告断点下标与序号', () => {
    const chain = makeChain()
    mustAppend(chain, baseInput({ candidate_id: 'C-0001' }))
    mustAppend(chain, baseInput({ candidate_id: 'C-0002' }))
    mustAppend(chain, baseInput({ candidate_id: 'C-0003' }))
    expect(chain.verify()).toEqual({ ok: true })

    const tampered = chain.toArray()
    tampered[1]!.target_code = 'TAMPERED'
    const result = chain.verify(tampered)
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(1)
    expect(result.brokenSeq).toBe(2)
    expect(result.reason).toContain('篡改')

    // 篡改副本不影响内部链：内部仍校验通过。
    expect(chain.verify()).toEqual({ ok: true })
  })

  it('复用既有 seq 或乱序 seq 被拒绝并记为越权事件，链长度不变', () => {
    const chain = makeChain()
    mustAppend(chain, baseInput({ candidate_id: 'C-0001' }))
    const before = chain.length

    const duplicate = chain.append(baseInput({ candidate_id: 'C-X', seq: 1 }))
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      expect(duplicate.violation.kind).toBe('overwrite_attempt')
      expect(duplicate.reason).toContain('越权')
    }

    const outOfOrder = chain.append(baseInput({ candidate_id: 'C-Y', seq: 9 }))
    expect(outOfOrder.ok).toBe(false)
    if (!outOfOrder.ok) expect(outOfOrder.violation.kind).toBe('out_of_order_seq')

    expect(chain.length).toBe(before)
    expect(chain.violationCount).toBe(2)
    expect(chain.violations).toHaveLength(2)
    expect(chain.violations[0]!.attempted_seq).toBe(1)
    // 拒绝后仍可正常追加，序号未被越权写入污染。
    const next = mustAppend(chain, baseInput({ candidate_id: 'C-0002' }))
    expect(next.seq).toBe(2)
    expect(chain.verify()).toEqual({ ok: true })
  })

  it('toArray / view / query 返回深拷贝，外部改动不影响链；query 可按字段组合', () => {
    const chain = makeChain()
    mustAppend(chain, baseInput({ candidate_id: 'C-0001', action: 'merge', batch_id: 'B-001' }))
    mustAppend(chain, baseInput({ candidate_id: 'C-0002', action: 'create', batch_id: 'B-001' }))
    mustAppend(chain, baseInput({ candidate_id: 'C-0003', action: 'merge', batch_id: 'B-002' }))

    const snap = chain.toArray()
    snap[0]!.candidate_id = 'MUTATED'
    expect(chain.toArray()[0]!.candidate_id).toBe('C-0001')

    expect(chain.query({ candidate_id: 'C-0002' }).map((e) => e.candidate_id)).toEqual(['C-0002'])
    expect(chain.query({ action: 'merge', batch_id: 'B-001' }).map((e) => e.seq)).toEqual([1])
    expect(chain.query({ from: '2026-11-10T08:00:01.000Z' }).map((e) => e.seq)).toEqual([2, 3])
    expect(chain.findByHash(chain.toArray()[0]!.hash)?.seq).toBe(1)
    expect(chain.findByHash('not-exist')).toBeUndefined()
  })

  it('canonicalJson 对键顺序稳定且跳过 undefined', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson([1, 'x', null])).toBe('[1,"x",null]')
    expect(canonicalJson({ nest: { y: 2, x: 1 } })).toBe('{"nest":{"x":1,"y":2}}')
  })
})
