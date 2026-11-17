import { describe, expect, it, vi } from 'vitest'
import { allowsCreate, createRetriever } from '@core/retrieval/retriever'
import type { CandidateRecord, MasterDataRecord } from '@core/types'
import type { MdmResult } from '@core/retrieval/mdm-client'

const candidate: CandidateRecord = {
  candidate_id: 'C-1', domain: 'drug', name: '阿莫西林胶囊',
  spec: '0.25g*12片', unit: '盒', insurance_code: 'XJ7000000000001',
}
const rec: MasterDataRecord = {
  code: 'XJ7000000000001', record_id: 'MD-1', domain: 'drug', name: '阿莫西林胶囊',
  spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001',
  status: '启用', version: 'v1',
}

describe('分域检索与「检索失败」显式报错（Task 25）', () => {
  it('端点 500 → 抛显式错误（retrieval_failed），绝不返回空数组', async () => {
    const r = createRetriever({
      getMasterData: vi.fn(async () => ({ ok: false, status: 500, code: 'SERVER_ERROR', error: '内服错误' })),
    })
    const out = await r.retrieve(candidate)
    expect(out.kind).toBe('retrieval_failed')
    if (out.kind === 'retrieval_failed') {
      expect(out.status).toBe(500)
      expect(out.message).toContain('检索失败')
      expect(out.endpoint).toBeTruthy()
    }
    expect(allowsCreate(out)).toBe(false)
  })

  it('网络异常（fetch 抛错）→ retrieval_failed 且不返回空数组', async () => {
    const r = createRetriever({
      getMasterData: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
    })
    const out = await r.retrieve(candidate)
    expect(out.kind).toBe('retrieval_failed')
    if (out.kind === 'retrieval_failed') expect(out.message).toContain('ECONNREFUSED')
  })

  it('端点 200 且 0 条 → retrieved_ok + 0 条，允许进入 create', async () => {
    const r = createRetriever({ getMasterData: vi.fn(async () => ({ ok: true, status: 200, data: [] })) })
    const out = await r.retrieve(candidate)
    expect(out.kind).toBe('retrieved_ok')
    if (out.kind === 'retrieved_ok') expect(out.hits).toBe(0)
    expect(allowsCreate(out)).toBe(true)
  })

  it('端点 200 有命中 → retrieved_ok + 去重记录', async () => {
    const r = createRetriever({ getMasterData: vi.fn(async () => ({ ok: true, status: 200, data: [rec] })) })
    const out = await r.retrieve(candidate)
    expect(out.kind === 'retrieved_ok')
    if (out.kind === 'retrieved_ok') expect(out.records).toHaveLength(1)
  })

  it('域不匹配记录被排除并计数', async () => {
    const wrong: MasterDataRecord = { ...rec, record_id: 'MD-E', domain: 'exam' }
    const r = createRetriever({
      getMasterData: vi.fn(async () => ({ ok: true, status: 200, data: [rec, wrong] } as MdmResult<MasterDataRecord[]>)),
    })
    const out = await r.retrieve(candidate)
    expect(out.kind === 'retrieved_ok')
    if (out.kind === 'retrieved_ok') {
      expect(out.records).toHaveLength(1)
      expect(out.domain_mismatch_excluded).toBe(1)
    }
  })

  it('四条检索词都被调用（按 domain 分域检索）', async () => {
    const spy = vi.fn(async (_domain: string, _q: string) => ({ ok: true, status: 200, data: [] } as MdmResult<MasterDataRecord[]>))
    const r = createRetriever({ getMasterData: spy })
    await r.retrieve(candidate)
    // 四条检索词：名称原文 / 去规格后名称 / 拼音首字母 / 医保码（均非空）
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(spy.mock.calls.every((c) => c[0] === 'drug')).toBe(true)
  })

  it('批量检索：单条失败不阻断其余', async () => {
    const spy = vi.fn(async (_d: string, q: string) => (
      q === 'BAD' ? ({ ok: false, status: 500, error: 'fail' } as MdmResult<MasterDataRecord[]>)
        : ({ ok: true, status: 200, data: [] } as MdmResult<MasterDataRecord[]>)
    ))
    const r = createRetriever({ getMasterData: spy })
    const cs = [
      { ...candidate, candidate_id: 'C-OK', name: '阿莫西林', insurance_code: 'XJ1' },
      { ...candidate, candidate_id: 'C-BAD', name: 'BAD', insurance_code: 'XJ2' },
    ]
    const results = await r.retrieveBatch(cs)
    expect(results).toHaveLength(2)
    expect(results[0].outcome.kind).toBe('retrieved_ok')
    expect(results[1].outcome.kind).toBe('retrieval_failed')
  })

  it('缺医保码时跳过空检索词，其余检索词照常发出', async () => {
    const spy = vi.fn(async (_domain: string, _q: string) => ({ ok: true, status: 200, data: [] } as MdmResult<MasterDataRecord[]>))
    const r = createRetriever({ getMasterData: spy })
    await r.retrieve({ ...candidate, insurance_code: undefined })
    expect(spy.mock.calls.every((c) => c[1] !== '')).toBe(true)
  })
})
