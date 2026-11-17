import { describe, expect, it } from 'vitest'
import { ambiguityEvidence, conflictsFor, detectAmbiguity } from '@core/binding/ambiguity'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

describe('多义命中判定与拒答（Task 21）', () => {
  it('同复合键 2 条命中 → ambiguous 且返回两条 record_id', () => {
    const r = detectAmbiguity(baseCandidate(), [
      baseRecord({ record_id: 'MD-1' }),
      baseRecord({ record_id: 'MD-2' }),
    ])
    expect(r.ambiguous).toBe(true)
    if (r.ambiguous) expect(r.records.map((x) => x.record_id)).toEqual(['MD-1', 'MD-2'])
  })

  it('3 条命中同理，全部返回', () => {
    const r = detectAmbiguity(baseCandidate(), [
      baseRecord({ record_id: 'MD-1' }), baseRecord({ record_id: 'MD-2' }), baseRecord({ record_id: 'MD-3' }),
    ])
    expect(r.ambiguous).toBe(true)
    if (r.ambiguous) expect(r.records).toHaveLength(3)
  })

  it('命中数为 1 时不触发多义', () => {
    expect(detectAmbiguity(baseCandidate(), [baseRecord()]).ambiguous).toBe(false)
  })

  it('停用 + 启用混合命中 → 仍判多义（不因停用被排除而降为单义）', () => {
    const r = detectAmbiguity(baseCandidate(), [
      baseRecord({ record_id: 'MD-1', status: '停用' }),
      baseRecord({ record_id: 'MD-2', status: '启用' }),
    ])
    expect(r.ambiguous).toBe(true)
    if (r.ambiguous) {
      expect(r.records.map((x) => x.status).sort()).toEqual(['停用', '启用'])
    }
  })

  it('冲突字段定位：spec 不一致被标出', () => {
    const conflicts = conflictsFor(baseCandidate({ spec: '0.25g*12片' }), baseRecord({ spec: '0.5g*24片' }))
    const spec = conflicts.find((c) => c.field === 'spec')
    expect(spec).toBeDefined()
    expect(spec?.candidate_value).toBe('0.25g*12片')
    expect(spec?.matched_value).toBe('0.5g*24片')
  })

  it('全部关键字段一致时无冲突', () => {
    expect(conflictsFor(baseCandidate(), baseRecord())).toEqual([])
  })

  it('多义 evidence 至少列出全部命中 id 且标冲突命中', () => {
    const ev = ambiguityEvidence([baseRecord({ record_id: 'MD-1' }), baseRecord({ record_id: 'MD-2' })])
    expect(ev).toHaveLength(2)
    expect(ev.every((e) => e.conflict_hit === true)).toBe(true)
    expect(ev.map((e) => e.record_id)).toContain('MD-1')
    expect(ev.map((e) => e.record_id)).toContain('MD-2')
  })
})
