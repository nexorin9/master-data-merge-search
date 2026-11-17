import { describe, expect, it } from 'vitest'
import { buildQueryTerms, queryTermList, stripName } from '@core/normalize/query-builder'
import type { CandidateRecord } from '@core/types'

const candidate: CandidateRecord = {
  candidate_id: 'C-001',
  domain: 'drug',
  name: '阿莫西林胶囊',
  spec: '0.25g*12片',
  dosage_form: '胶囊剂',
  unit: '盒',
  insurance_code: 'XJ7000000000001',
  submitted_at: '2026-01-01',
}

describe('检索词构造器（Task 19）', () => {
  it('四条检索词顺序固定且稳定', () => {
    const t = buildQueryTerms(candidate)
    expect(queryTermList(t)).toEqual(['阿莫西林胶囊', '阿莫西林', 'amxl', 'XJ7000000000001'])
  })

  it('同一候选两次输出完全一致', () => {
    expect(buildQueryTerms(candidate)).toEqual(buildQueryTerms(candidate))
  })

  it('去规格后名称不含片/粒等包装词与剂型词', () => {
    expect(stripName('阿莫西林胶囊 0.25g*12片')).toBe('阿莫西林')
    expect(stripName('布洛芬缓释胶囊')).not.toMatch(/胶囊|缓释/)
    expect(stripName('头孢克肟颗粒 50mg*10袋')).not.toMatch(/颗粒|袋/)
  })

  it('名称原文保留全半角归一后的值', () => {
    const t = buildQueryTerms({ ...candidate, name: '阿莫西林（0.25g）' })
    expect(t.raw_name).toBe('阿莫西林(0.25g)')
  })

  it('缺医保码时第四路为空串', () => {
    const t = buildQueryTerms({ ...candidate, insurance_code: undefined })
    expect(t.insurance_code).toBe('')
    expect(queryTermList(t)).toHaveLength(4)
  })
})
