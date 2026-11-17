import { describe, expect, it } from 'vitest'
import {
  applyMissingFieldCap, checkMissingFields, rejectIfMissingFields,
} from '@core/binding/missing-fields'
import { CONFIG_MISSING_FIELD_CAP } from '@core/constants'
import type { MergeConclusion } from '@core/types'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

const mergeConclusion = (confidence = 0.99): MergeConclusion => ({
  candidate_id: 'C-0001', domain: 'drug', action: 'merge', target_code: 'XJ7000000000001',
  confidence, rationale: '医保码相同', evidence: [{ record_id: 'MD-0001', field: 'insurance_code', candidate_value: 'XJ1', matched_value: 'XJ1' }],
  uncertain_reason: null, missing_fields: [], degraded: false,
})

describe('关键字段缺失封顶（Task 22）', () => {
  it('缺 spec → uncertain + reason=关键字段缺失 + confidence 被截断', () => {
    const c = baseCandidate({ spec: undefined })
    const r = applyMissingFieldCap(mergeConclusion(0.99), c)
    expect(r.action).toBe('uncertain')
    expect(r.uncertain_reason).toBe('关键字段缺失')
    expect(r.confidence).toBe(CONFIG_MISSING_FIELD_CAP)
    expect(r.capped_from).toBe(0.99)
    expect(r.missing_fields).toContain('spec')
  })

  it('缺 unit 同理', () => {
    const r = applyMissingFieldCap(mergeConclusion(0.9), baseCandidate({ unit: '' }))
    expect(r.action).toBe('uncertain')
    expect(r.missing_fields).toContain('unit')
    expect(r.confidence).toBe(CONFIG_MISSING_FIELD_CAP)
  })

  it('两字段都缺 → missing_fields 列两个', () => {
    const r = applyMissingFieldCap(mergeConclusion(), baseCandidate({ spec: undefined, unit: undefined }))
    expect(r.missing_fields.sort()).toEqual(['spec', 'unit'])
  })

  it('补齐字段后不再截断', () => {
    const r = applyMissingFieldCap(mergeConclusion(0.99), baseCandidate())
    expect(r.action).toBe('merge')
    expect(r.confidence).toBe(0.99)
    expect(r.capped_from).toBeUndefined()
  })

  it('置信度本就低于封顶值时不被抬高', () => {
    const r = applyMissingFieldCap(mergeConclusion(0.3), baseCandidate({ spec: undefined }))
    expect(r.confidence).toBe(0.3)
  })

  it('绕过引擎直接写回：缺字段的 merge 被拒收', () => {
    const verdict = rejectIfMissingFields(mergeConclusion(), baseCandidate({ unit: undefined }))
    expect(verdict.accepted).toBe(false)
    expect(verdict.reason).toContain('unit')
  })

  it('缺字段但结论已是 uncertain 时写回层放行（不产生错并）', () => {
    const uncertain = { ...mergeConclusion(), action: 'uncertain' as const, uncertain_reason: '关键字段缺失' as const }
    expect(rejectIfMissingFields(uncertain, baseCandidate({ spec: undefined })).accepted).toBe(true)
  })

  it('checkMissingFields 给出封顶值与缺失列表', () => {
    const v = checkMissingFields(baseCandidate({ spec: undefined }))
    expect(v.hasMissing).toBe(true)
    expect(v.cap).toBe(CONFIG_MISSING_FIELD_CAP)
    expect(v.missing_fields).toEqual(['spec'])
  })
})
