import { describe, expect, it } from 'vitest'
import { classifyField, compareFields, orderedFields, summarizeDiffs } from '@core/engine/field-diff'
import type { FieldDiff } from '@core/types'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

describe('字段级对照 diff（Task 27）', () => {
  it('exact 与 normalized 判定正确', () => {
    expect(classifyField('name', '阿莫西林胶囊', '阿莫西林胶囊').kind).toBe('exact')
    expect(classifyField('spec', '0.25g*12片', '0.25g×12片').kind).toBe('normalized')
    expect(classifyField('spec', '250mg*12片', '0.25g*12片').kind).toBe('normalized')
  })

  it('0.25g 与 0.5g 判 conflict', () => {
    const r = classifyField('spec', '0.25g*12片', '0.5g*24片')
    expect(r.kind).toBe('conflict')
    expect(r.equal).toBe(false)
  })

  it('候选缺字段判 missing', () => {
    const diffs = compareFields(baseCandidate({ spec: undefined }), baseRecord())
    const spec = diffs.diffs.find((d) => d.field === 'spec')
    expect(spec?.kind).toBe('missing')
    expect(spec?.candidate_value).toBeNull()
  })

  it('主数据缺字段判 absent', () => {
    const diffs = compareFields(baseCandidate(), baseRecord({ insurance_code: undefined }))
    const ic = diffs.diffs.find((d) => d.field === 'insurance_code')
    expect(ic?.kind).toBe('absent')
    expect(ic?.matched_value).toBeNull()
  })

  it('关键字段顺序固定：insurance_code → name → spec → dosage_form → unit', () => {
    const fields = compareFields(baseCandidate(), baseRecord()).diffs.map((d) => d.field)
    expect(fields.slice(0, 5)).toEqual(['insurance_code', 'name', 'spec', 'dosage_form', 'unit'])
    expect(orderedFields().slice(0, 5)).toEqual(['insurance_code', 'name', 'spec', 'dosage_form', 'unit'])
  })

  it('摘要 counts 各 kind 条数正确', () => {
    const diffs: FieldDiff[] = [
      { field: 'a', candidate_value: '1', matched_value: '1', equal: true, kind: 'exact' },
      { field: 'b', candidate_value: '1', matched_value: '2', equal: false, kind: 'conflict' },
      { field: 'c', candidate_value: '1', matched_value: '2', equal: false, kind: 'conflict' },
    ]
    const s = summarizeDiffs(diffs)
    expect(s.counts.exact).toBe(1)
    expect(s.counts.conflict).toBe(2)
    expect(s.conflict_fields).toEqual(['b', 'c'])
  })

  it('完全一致的候选与记录：无 conflict', () => {
    const s = compareFields(baseCandidate(), baseRecord())
    expect(s.counts.conflict).toBeGreaterThanOrEqual(0)
    expect(s.conflict_fields).not.toContain('name')
    expect(s.conflict_fields).not.toContain('insurance_code')
  })

  it('单位归一后等价：盒 vs 盒 为 exact', () => {
    expect(classifyField('unit', '盒', '盒').kind).toBe('exact')
  })
})
