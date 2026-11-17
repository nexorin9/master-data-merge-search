/**
 * 字面相似度基线单测（Task 55 验收文件）。
 *
 * 覆盖 step 6 四类断言：四级命中各自命中正确；排序稳定可复现；基线置信度按
 * 层级映射；基线不产出理由文本。外加命中数 / 多义计数 / 零命中 create / 批量
 * 顺序稳定。全程纯函数、无网络、无模型。
 */
import { describe, expect, it } from 'vitest'
import type { CandidateRecord, MasterDataRecord } from '@core/types'
import {
  BASELINE_CONFIDENCE,
  baselineBatch,
  baselineConclude,
  bm25,
  classifyBaselineHit,
  literalSimilarity,
} from '@core/engine/baseline'

function candidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    candidate_id: 'CAND-TEST-001',
    domain: 'drug',
    name: '阿莫西林胶囊',
    spec: '0.25g*12片',
    dosage_form: '胶囊剂',
    unit: '盒',
    insurance_code: 'XJ0000000000001',
    ...overrides,
  }
}

function record(overrides: Partial<MasterDataRecord> = {}): MasterDataRecord {
  return {
    code: 'M-TEST-001',
    record_id: 'MD-TEST-001',
    domain: 'drug',
    name: '阿莫西林胶囊',
    spec: '0.25g*12片',
    dosage_form: '胶囊剂',
    unit: '盒',
    insurance_code: 'XJ9999999999999',
    status: '启用',
    version: 'v1',
    ...overrides,
  }
}

describe('Task 55 四级确定性召回', () => {
  it('① 医保码精确匹配 → level 1', () => {
    const cand = candidate({ insurance_code: 'XJ1234567890123' })
    const rec = record({ insurance_code: 'XJ1234567890123' })
    const hit = classifyBaselineHit(cand, rec)
    expect(hit).toMatchObject({ level: 1, score: 1, matched_by: '医保码精确匹配' })
    expect(hit?.record).toBe(rec)
  })

  it('② 规格单位归一后精确（同名 + 等价规格 + 同单位，医保码不同）→ level 2', () => {
    const cand = candidate({ name: '阿莫西林胶囊', spec: '0.25g*12片', unit: '盒' })
    const rec = record({ name: '阿莫西林胶囊', spec: '250mg*12片', unit: '盒' })
    const hit = classifyBaselineHit(cand, rec)
    expect(hit).toMatchObject({ level: 2, matched_by: '规格单位归一后精确' })
  })

  it('③ 拼音首字母匹配（名称文本不同但首字母相同）→ level 3', () => {
    // 阿莫西林胶囊 与 奥美西林胶囊 首字母同为 amxljn，但文本不等 → 不进 level 2。
    const cand = candidate({ name: '阿莫西林胶囊', spec: undefined })
    const rec = record({ name: '奥美西林胶囊', spec: undefined })
    const hit = classifyBaselineHit(cand, rec)
    expect(hit).toMatchObject({ level: 3, matched_by: '拼音首字母匹配' })
  })

  it('④ 字面相似度（有共享字符但首字母不同）→ level 4', () => {
    const cand = candidate({ name: '阿莫西林胶囊' })
    const rec = record({ name: '阿莫西林片' })
    const hit = classifyBaselineHit(cand, rec)
    expect(hit).toMatchObject({ level: 4, matched_by: '字面相似' })
    expect(hit!.score).toBeGreaterThan(0)
    expect(hit!.score).toBeLessThanOrEqual(1)
  })

  it('域不匹配 → 不召回（null）', () => {
    const cand = candidate({ domain: 'drug' })
    const rec = record({ domain: 'fee_item' })
    expect(classifyBaselineHit(cand, rec)).toBeNull()
  })

  it('无共享字符、首字母不同、医保码不同 → 不召回（null）', () => {
    const cand = candidate({ name: '阿莫西林胶囊', insurance_code: 'XJ1111111111111', spec: undefined })
    const rec = record({ name: '维生素C片', insurance_code: 'XJ2222222222222', spec: undefined })
    expect(classifyBaselineHit(cand, rec)).toBeNull()
  })
})

describe('Task 55 基线排序、置信度与可复现', () => {
  it('四级置信度按层级映射（医保码 0.95 / 拼音 0.5 / 字面 0.4）', () => {
    expect(BASELINE_CONFIDENCE[1]).toBe(0.95)
    expect(BASELINE_CONFIDENCE[2]).toBe(0.8)
    expect(BASELINE_CONFIDENCE[3]).toBe(0.5)
    expect(BASELINE_CONFIDENCE[4]).toBe(0.4)
    // Object.keys 返回字符串键；四级层级齐全且无多余键。
    expect(Object.keys(BASELINE_CONFIDENCE).sort()).toEqual(['1', '2', '3', '4'])
  })

  it('基线结论置信度取自命中层级', () => {
    const l1 = baselineConclude(
      candidate({ insurance_code: 'XJ-1' }),
      [record({ code: 'M-L1', insurance_code: 'XJ-1' })],
    )
    expect(l1.confidence).toBe(BASELINE_CONFIDENCE[1])
    expect(l1.target_code).toBe('M-L1')

    const l4 = baselineConclude(
      candidate({ name: '阿莫西林胶囊', insurance_code: 'XJ-A', spec: undefined }),
      [record({ code: 'M-L4', name: '阿莫西林片', insurance_code: 'XJ-B', spec: undefined })],
    )
    expect(l4.confidence).toBe(BASELINE_CONFIDENCE[4])
    expect(l4.target_code).toBe('M-L4')
  })

  it('排序：低层级优先于高层级，取首条为目标', () => {
    const cand = candidate({ insurance_code: 'XJ-SAME' })
    const pool = [
      record({ code: 'M-L4', record_id: 'MD-Z9', name: '阿莫西林片', insurance_code: 'XJ-OTHER-A', spec: undefined }),
      record({ code: 'M-L1', record_id: 'MD-A1', insurance_code: 'XJ-SAME' }),
    ]
    const out = baselineConclude(cand, pool)
    expect(out.ranking.map((h) => h.level)).toEqual([1, 4])
    expect(out.target_code).toBe('M-L1')
    expect(out.hit_count).toBe(2)
  })

  it('同层级同分数按 record_id 稳定排序，并计入 ambiguous_top_hits', () => {
    const cand = candidate({ insurance_code: 'XJ-TIE' })
    const pool = [
      record({ code: 'M-Z', record_id: 'MD-ZZZ', insurance_code: 'XJ-TIE' }),
      record({ code: 'M-A', record_id: 'MD-AAA', insurance_code: 'XJ-TIE' }),
    ]
    const out = baselineConclude(cand, pool)
    expect(out.ranking.map((h) => h.record.record_id)).toEqual(['MD-AAA', 'MD-ZZZ'])
    expect(out.target_code).toBe('M-A')
    expect(out.ambiguous_top_hits).toBe(2)
  })

  it('零命中 → action=create、target_code=null、hit_count=0', () => {
    const cand = candidate({ name: '阿莫西林胶囊', insurance_code: 'XJ-NOMATCH', spec: undefined })
    const pool = [record({ name: '维生素C片', insurance_code: 'XJ-OTHER', spec: undefined })]
    const out = baselineConclude(cand, pool)
    expect(out.action).toBe('create')
    expect(out.target_code).toBeNull()
    expect(out.hit_count).toBe(0)
    expect(out.ranking).toEqual([])
  })

  it('基线不产出自然语言理由（rationale 恒为空串）', () => {
    const hit = baselineConclude(candidate({ insurance_code: 'XJ-1' }), [record({ insurance_code: 'XJ-1' })])
    const miss = baselineConclude(
      candidate({ name: '阿莫西林胶囊', insurance_code: 'XJ-A', spec: undefined }),
      [record({ name: '维生素C片', insurance_code: 'XJ-B', spec: undefined })],
    )
    expect(hit.rationale).toBe('')
    expect(miss.rationale).toBe('')
  })

  it('可复现：同一输入两次运行逐字段一致（无随机、无时间依赖）', () => {
    const cand = candidate({ insurance_code: 'XJ-R' })
    const pool = [
      record({ code: 'M-1', record_id: 'MD-1', insurance_code: 'XJ-R' }),
      record({ code: 'M-2', record_id: 'MD-2', name: '阿莫西林片', insurance_code: 'XJ-Q', spec: undefined }),
      record({ code: 'M-3', record_id: 'MD-3', name: '维生素C片', insurance_code: 'XJ-P', spec: undefined }),
    ]
    const first = baselineConclude(cand, pool)
    const second = baselineConclude(cand, pool)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('baselineBatch 逐条独立且顺序稳定', () => {
    const candidates = [
      candidate({ candidate_id: 'C1', insurance_code: 'XJ-A' }),
      candidate({ candidate_id: 'C2', name: '阿莫西林胶囊', insurance_code: 'XJ-X', spec: undefined }),
    ]
    // M-1 只在医保码上命中 C1；名称与 C2 无共享字符且首字母不同，确保 C2 零命中。
    const pool = [record({ code: 'M-1', record_id: 'MD-1', insurance_code: 'XJ-A', name: '维生素C片', spec: undefined })]
    const batch = baselineBatch(candidates, pool)
    expect(batch.map((c) => c.candidate_id)).toEqual(['C1', 'C2'])
    expect(batch[0].action).toBe('merge')
    expect(batch[1].action).toBe('create')
    expect(baselineBatch(candidates, pool)).toEqual(batch)
  })
})

describe('Task 55 字面相似工具函数', () => {
  it('literalSimilarity：同名=1，无共享字符=0', () => {
    expect(literalSimilarity(candidate({ name: '阿莫西林胶囊' }), record({ name: '阿莫西林胶囊' }))).toBe(1)
    expect(literalSimilarity(candidate({ name: '阿莫西林胶囊' }), record({ name: '环丙沙星' }))).toBe(0)
  })

  it('bm25：空 query 得 0，命中字符得正分', () => {
    expect(bm25('', ['阿莫西林胶囊'])).toBe(0)
    expect(bm25('阿莫西林', ['阿莫西林胶囊'])).toBeGreaterThan(0)
  })
})
