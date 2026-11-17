import { describe, expect, it } from 'vitest'
import {
  computeCompositeKey, recordCompositeKey,
} from '@core/binding/composite-key'
import {
  checkVersionConflict, decideGate, filterByCompositeKey, insuranceCodeUniqueHit, resolveMatchedRecords,
} from '@core/binding/unique-gate'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

describe('唯一性闸门（Task 6）', () => {
  it('复合键在规格与单位归一后稳定（250mg ≡ 0.25g）', () => {
    const a = computeCompositeKey(baseCandidate({ spec: '0.25g*12片' }))
    const b = computeCompositeKey(baseCandidate({ spec: '250mg*12片' }))
    expect(a.status).toBe('ok')
    expect(a.status === 'ok' && b.status === 'ok' && a.key === b.key).toBe(true)
  })

  it('规格与单位归一：全半角混写不改变复合键', () => {
    const a = computeCompositeKey(baseCandidate({ spec: '0.25g*12片' }))
    const b = computeCompositeKey(baseCandidate({ spec: '0.25g×１２片' }))
    expect(a.status === 'ok' && b.status === 'ok' && a.key === b.key).toBe(true)
  })

  it('命中 1 条 → 放行 unique', () => {
    const gate = decideGate(baseCandidate(), [baseRecord()])
    expect(gate.kind).toBe('unique')
  })

  it('命中 >1 条 → 转 ambiguous 出口', () => {
    const gate = decideGate(baseCandidate(), [baseRecord(), baseRecord({ record_id: 'MD-0002', code: 'XJ2' })])
    expect(gate.kind).toBe('ambiguous')
  })

  it('命中 =0 条 → 转 no-match 出口（交检索层判无近似项）', () => {
    expect(decideGate(baseCandidate(), []).kind).toBe('no-match')
  })

  it('医保码唯一命中 → 确定性直接产出 unique', () => {
    const hit = insuranceCodeUniqueHit(baseCandidate(), [baseRecord()])
    expect(hit?.record_id).toBe('MD-0001')
    expect(resolveMatchedRecords(baseCandidate(), [baseRecord()])).toHaveLength(1)
  })

  it('医保码命中 >1 → 不作为唯一通道', () => {
    const hit = insuranceCodeUniqueHit(baseCandidate(), [
      baseRecord(), baseRecord({ record_id: 'MD-0002' }),
    ])
    expect(hit).toBeNull()
  })

  it('filterByCompositeKey 只保留同复合键记录', () => {
    const pool = [
      baseRecord(),
      baseRecord({ record_id: 'MD-0002', spec: '0.5g*24片' }),
      baseRecord({ record_id: 'MD-0003', domain: 'fee_item' }),
    ]
    const hits = filterByCompositeKey(baseCandidate(), pool)
    expect(hits.map((r) => r.record_id)).toEqual(['MD-0001'])
  })

  it('版本冲突独立判定：一致不触发、不一致触发', () => {
    expect(checkVersionConflict(baseCandidate({ version: 'v1' }), baseRecord({ version: 'v1' }))).toBe(false)
    expect(checkVersionConflict(baseCandidate({ version: 'v2' }), baseRecord({ version: 'v1' }))).toBe(true)
    expect(checkVersionConflict(baseCandidate({ version: undefined }), baseRecord())).toBe(false)
  })

  it('recordCompositeKey 与 computeCompositeKey 口径一致', () => {
    const ck = computeCompositeKey(baseCandidate())
    const rk = recordCompositeKey(baseRecord())
    expect(ck.status === 'ok' && rk.status === 'ok' && ck.key === rk.key).toBe(true)
  })
})
