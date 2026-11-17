import type { CandidateRecord, MasterDataRecord } from '@core/types'

/** 闸门测试统一夹具：真实语料形状的阿莫西林胶囊条目。 */
export const baseRecord = (over: Partial<MasterDataRecord> = {}): MasterDataRecord => ({
  code: 'XJ7000000000001',
  record_id: 'MD-0001',
  domain: 'drug',
  name: '阿莫西林胶囊',
  spec: '0.25g*12片',
  dosage_form: '胶囊剂',
  unit: '盒',
  insurance_code: 'XJ7000000000001',
  status: '启用',
  version: 'v1',
  ...over,
})

export const baseCandidate = (over: Partial<CandidateRecord> = {}): CandidateRecord => ({
  candidate_id: 'C-0001',
  domain: 'drug',
  name: '阿莫西林胶囊',
  spec: '0.25g*12片',
  dosage_form: '胶囊剂',
  unit: '盒',
  insurance_code: 'XJ7000000000001',
  submit_source: 'weekly-batch',
  submitted_at: '2026-01-05',
  version: 'v1',
  ...over,
})
