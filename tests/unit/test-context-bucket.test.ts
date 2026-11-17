import { describe, expect, it } from 'vitest'
import { candidateToContextEntry, createContextBucket, recordToContextEntry } from '@core/retrieval/context-bucket'
import type { CandidateRecord, MasterDataRecord } from '@core/types'

const record = (id: string, domain: 'drug' | 'exam' = 'drug', at = 1): MasterDataRecord => ({
  code: `XJ${id}`, record_id: id, domain, name: `药${id}`, spec: '0.25g*12片',
  dosage_form: '胶囊剂', unit: '盒', insurance_code: `XJ${id}`, status: '启用', version: 'v1',
})
const candidate: CandidateRecord = {
  candidate_id: 'C-1', domain: 'drug', name: '阿莫西林胶囊', spec: '0.25g*12片', unit: '盒', insurance_code: 'XJ1',
}

describe('检索结果入桶与裁剪（Task 26）', () => {
  it('两桶入桶后快照深克隆', () => {
    let t = 0
    const b = createContextBucket({ now: () => ++t })
    b.ingestDomain('drug', [record('D1')], ['药'])
    b.ingestDomain('exam', [record('E1', 'exam')], ['检验'])
    const snap = b.snapshot()
    expect(snap).toHaveLength(2)
    snap[0].text = '篡改'
    expect(b.snapshot().some((e) => e.text === '篡改')).toBe(false)
  })

  it('append 与 replace 各自生效：关闭跨批时上一批不注入', () => {
    let t = 0
    const b = createContextBucket({ now: () => ++t, crossBatch: false })
    b.ingestDomain('drug', [record('D1')], ['a'])
    b.ingestDomain('drug', [record('D2')], ['b'])
    // 关跨批时 replace-self，只保留最新一批
    const texts = b.snapshot().filter((e) => e.key === 'masterdata:drug').map((e) => e.record_id)
    expect(texts).toEqual(['D2'])
  })

  it('开跨批时两批都保留（append-self）', () => {
    let t = 0
    const b = createContextBucket({ now: () => ++t, crossBatch: true })
    b.ingestDomain('drug', [record('D1')], ['a'])
    b.ingestDomain('drug', [record('D2')], ['b'])
    const texts = b.snapshot().filter((e) => e.key === 'masterdata:drug').map((e) => e.record_id)
    expect(texts.sort()).toEqual(['D1', 'D2'])
  })

  it('超上限后旧条目被裁剪，新条目仍在', () => {
    let t = 0
    const b = createContextBucket({ now: () => ++t, historyLimit: 3, crossBatch: true })
    for (const id of ['D1', 'D2', 'D3', 'D4']) b.ingestDomain('drug', [record(id, 'drug', ++t)], ['a'])
    const texts = b.snapshot().map((e) => e.record_id)
    expect(texts).toHaveLength(3)
    expect(texts).not.toContain('D1')
    expect(texts).toContain('D4')
  })

  it('命中追溯字段完整：record_id + 检索词 + 命中字段非空', () => {
    const e = recordToContextEntry(record('D1'), ['阿莫西林'], 1)
    expect(e.record_id).toBe('D1')
    expect(e.query_term).toBeTruthy()
    expect(e.matched_field).toBeTruthy()
  })

  it('候选桶条目含 candidate_id', () => {
    const e = candidateToContextEntry(candidate, 1)
    expect(e.record_id).toBe('C-1')
    expect(e.key).toBe('masterdata:candidate')
  })

  it('跨批开关可切换并可读', () => {
    const b = createContextBucket({ crossBatch: false })
    expect(b.isCrossBatchEnabled()).toBe(false)
    b.setCrossBatch(true)
    expect(b.isCrossBatchEnabled()).toBe(true)
  })

  it('候选与主数据分桶存储', () => {
    let t = 0
    const b = createContextBucket({ now: () => ++t })
    b.ingestDomain('drug', [record('D1')], ['a'])
    b.ingestCandidate(candidate)
    const snap = b.snapshot()
    expect(snap.some((e) => e.key === 'masterdata:drug')).toBe(true)
    expect(snap.some((e) => e.key === 'masterdata:candidate')).toBe(true)
  })
})
