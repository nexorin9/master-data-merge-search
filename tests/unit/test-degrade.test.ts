/**
 * 模型不可达降级路径单测（Task 25 / 33）。
 *
 * 覆盖：四级确定性排序（医保码精确 → 规格单位归一 → 首字母 → 字面相似）、
 * 稳定排序 + 同域过滤、降级结论强制 uncertain + degraded + source=degrade、
 * 写回恒拒绝、按批降级率、降级结论绝不产生可写回结论。
 * 全部纯函数，无需 fetch。
 */
import { describe, expect, it } from 'vitest'
import {
  degradeRate,
  deterministicRank,
  deterministicRanking,
  makeDegradeConclusion,
  rejectWritebackIfDegraded,
  type DegradeEvent,
} from '@core/engine/degrade'
import type { MasterDataRecord } from '@core/types'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

const FIXED_NOW = { now: () => 'T0' }

function event(candidateId: string): DegradeEvent {
  return { candidate_id: candidateId, reason: '超时', retry_count: 1, latency_ms: 0, at: 'T0' }
}

describe('确定性排序层级（Task 25）', () => {
  it('层级 1：医保码精确命中 → level=1, score=0.95', () => {
    const candidate = baseCandidate({ insurance_code: 'XJ7000000000001' })
    const r = deterministicRank(candidate, baseRecord({ insurance_code: 'XJ7000000000001' }))
    expect(r.level).toBe(1)
    expect(r.score).toBe(0.95)
    expect(r.reason).toContain('医保码')
  })

  it('层级 2：同名 + 规格单位归一后精确（× / X / 空格 / 斜杠）', () => {
    const candidate = baseCandidate({ insurance_code: '', name: '阿莫西林胶囊', spec: '0.25g×12片' })
    const record = baseRecord({ insurance_code: '', name: '阿莫西林胶囊', spec: '0.25g X 12片' })
    const r = deterministicRank(candidate, record)
    expect(r.level).toBe(2)
    expect(r.score).toBe(0.8)
    expect(r.reason).toContain('规格')
  })

  it('层级 3：拼音首字母 / 同字命中（名称首字相同但规格不等）', () => {
    const candidate = baseCandidate({ insurance_code: '', name: '阿莫西林胶囊', spec: '0.25g*12片' })
    const record = baseRecord({ insurance_code: '', name: '阿莫西林颗粒', spec: '0.5g*24片' })
    const r = deterministicRank(candidate, record)
    expect(r.level).toBe(3)
    expect(r.score).toBe(0.5)
    expect(r.reason).toContain('首字母')
  })

  it('层级 4：字面相似（首字不同，按共同字符比例兜底）', () => {
    const candidate = baseCandidate({ insurance_code: '', name: '布洛芬缓释胶囊', spec: '' })
    const record = baseRecord({ insurance_code: '', name: '阿莫西林胶囊', spec: '' })
    const r = deterministicRank(candidate, record)
    expect(r.level).toBe(4)
    expect(r.reason).toBe('字面相似')
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(0.4)
  })

  it('deterministicRanking：层级升序、同层分数降序、同分按 record_id 稳定排序', () => {
    const candidate = baseCandidate()
    const pool: MasterDataRecord[] = [
      baseRecord({ record_id: 'MD-L4', insurance_code: 'NONE', name: '布洛芬片', spec: '', domain: 'drug' }),
      baseRecord({ record_id: 'MD-L1', insurance_code: 'XJ7000000000001' }),
      baseRecord({ record_id: 'MD-L3', insurance_code: 'NONE', name: '阿莫西林颗粒', spec: '9g', domain: 'drug' }),
      baseRecord({ record_id: 'MD-L2', insurance_code: 'NONE', name: '阿莫西林胶囊', spec: '0.25g*12片' }),
    ]
    const ranking = deterministicRanking(candidate, pool)
    expect(ranking.map((x) => x.record.record_id)).toEqual(['MD-L1', 'MD-L2', 'MD-L3', 'MD-L4'])
    expect(ranking.map((x) => x.level)).toEqual([1, 2, 3, 4])
  })

  it('deterministicRanking：同层级同分数按 record_id 升序（稳定）且只保留同域', () => {
    const candidate = baseCandidate({ domain: 'drug' })
    const pool: MasterDataRecord[] = [
      baseRecord({ record_id: 'MD-Z', domain: 'drug' }),
      baseRecord({ record_id: 'MD-A', domain: 'drug' }),
      baseRecord({ record_id: 'MD-OTHER', domain: 'exam' }), // 域不匹配被排除
    ]
    const ranking = deterministicRanking(candidate, pool)
    expect(ranking.map((x) => x.record.record_id)).toEqual(['MD-A', 'MD-Z']) // 均 level=1 score=0.95
    expect(ranking.every((x) => x.record.domain === 'drug')).toBe(true)
  })
})

describe('降级结论与写回闸门（Task 25）', () => {
  it('makeDegradeConclusion：uncertain + degraded + uncertain_reason=模型不可用 + source=degrade', () => {
    const candidate = baseCandidate()
    const pool = [baseRecord()]
    const { conclusion, ranking, event } = makeDegradeConclusion(candidate, pool, '模型不可达', { retries: 2, ...FIXED_NOW })

    expect(conclusion.action).toBe('uncertain')
    expect(conclusion.target_code).toBeNull()
    expect(conclusion.uncertain_reason).toBe('模型不可用')
    expect(conclusion.degraded).toBe(true)
    expect(conclusion.degraded_reason).toBe('模型不可达')
    expect(conclusion.source).toBe('degrade')
    expect(conclusion.candidate_id).toBe(candidate.candidate_id)
    expect(conclusion.retrieved_record_ids).toEqual(ranking.map((r) => r.record.record_id))
    expect(conclusion.evidence).toHaveLength(1)
    expect(conclusion.evidence[0].field).toBe('insurance_code')
    // 待人工结论置信度封顶，不呈现决策级高把握；真实分数仍在 ranking[]。
    expect(conclusion.confidence).toBeLessThanOrEqual(0.5)
    expect(ranking[0].score).toBeGreaterThan(conclusion.confidence)
    expect(conclusion.capped_from).toBe(ranking[0].score)
    expect(conclusion.capped_by).toContain('降级')
    expect(event).toEqual({
      candidate_id: candidate.candidate_id, reason: '模型不可达', retry_count: 2, latency_ms: 0, at: 'T0',
    })
  })

  it('makeDegradeConclusion：空池 → 无排序、无证据、置信度 0，结论仍为降级存疑', () => {
    const { conclusion, ranking } = makeDegradeConclusion(baseCandidate(), [], '超时', FIXED_NOW)
    expect(ranking).toEqual([])
    expect(conclusion.evidence).toEqual([])
    expect(conclusion.confidence).toBe(0)
    expect(conclusion.action).toBe('uncertain')
    expect(conclusion.degraded).toBe(true)
  })

  it('rejectWritebackIfDegraded：降级结论恒拒绝写回，非降级允许', () => {
    const degraded = makeDegradeConclusion(baseCandidate(), [baseRecord()], 'schema 校验失败', FIXED_NOW).conclusion
    const refused = rejectWritebackIfDegraded(degraded)
    expect(refused.accepted).toBe(false)
    expect(refused.reason).toContain('不可写回')

    expect(rejectWritebackIfDegraded({ ...degraded, degraded: false })).toEqual({ accepted: true })
  })

  it('degrade 结论绝不产生可写回结论（三态非 merge/create，且写回闸门拒绝）', () => {
    for (const reason of ['模型不可达', '超时', 'schema 校验失败'] as const) {
      const { conclusion } = makeDegradeConclusion(baseCandidate(), [baseRecord()], reason, FIXED_NOW)
      expect(['merge', 'create']).not.toContain(conclusion.action)
      expect(conclusion.action).toBe('uncertain')
      expect(rejectWritebackIfDegraded(conclusion).accepted).toBe(false)
    }
  })

  it('degradeRate：按批统计降级率（10 条里 3 条），总数 0 时为 0', () => {
    const events = [event('C-1'), event('C-2'), event('C-3')]
    expect(degradeRate(events, 10)).toBeCloseTo(0.3)
    expect(degradeRate([], 0)).toBe(0)
    expect(degradeRate([event('C-1')], 1)).toBe(1)
  })
})
