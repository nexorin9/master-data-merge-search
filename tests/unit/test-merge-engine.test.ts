/**
 * 归并判定接入主路径单测（Task 27 / 3）。
 *
 * 用注入的检索驱动 + mock fetch 跑通完整路径：检索 → 闸门 → 上下文 →
 * ModelGateway 结构化归并 → 证据链 → 三态结论；覆盖闸门多义覆盖模型、
 * 检索失败显式报错、模型不可达走降级、越界引用拒绝、schema 重试与降级。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestConfig } from '@shared/config'
import { evaluateCandidate } from '@core/engine/merge-engine'
import { baselineBatch, baselineConclude, BASELINE_CONFIDENCE } from '@core/engine/baseline'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'
import type { CandidateRecord, MasterDataRecord, RetrievalOutcome } from '@core/types'

const NOW = '2024-07-01T00:00:00.000Z'

function okRetrieval(records: MasterDataRecord[]): RetrievalOutcome {
  return { kind: 'retrieved_ok', records, hits: records.length, domain_mismatch_excluded: 0 }
}

function failedRetrieval(): RetrievalOutcome {
  return { kind: 'retrieval_failed', endpoint: 'GET /api/v1/master-data', status: 503, retries: 0, message: 'MDM 不可用' }
}

/** 构造 OpenAI-compatible 响应体。 */
function chatResponse(content: string, finish = 'stop'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function jsonConclusion(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'merge',
    target_code: 'XJ7000000000001',
    confidence: 0.92,
    rationale: '医保码与规格一致，唯一命中',
    uncertain_reason: null,
    evidence: [{ record_id: 'MD-01', field: 'insurance_code', candidate_value: 'XJ7000000000001', matched_value: 'XJ7000000000001' }],
    ...over,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('归并判定接入主路径（Task 27）', () => {
  it('唯一命中 + 模型 merge：产出三态结论 + evidence[] 每条带 record_id', async () => {
    const candidate = baseCandidate({
      spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001',
    })
    const pool = [baseRecord({ record_id: 'MD-01', code: 'XJ7000000000001', insurance_code: 'XJ7000000000001' })]
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(jsonConclusion())))

    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => okRetrieval(pool), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('merge')
    expect(r.conclusion.target_code).toBe('XJ7000000000001')
    expect(r.conclusion.evidence.length).toBeGreaterThan(0)
    expect(r.conclusion.evidence.every((e) => e.record_id)).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.model_call_logs.length).toBeGreaterThan(0)
  })

  it('闸门判多义时，即使模型给 merge 也被覆盖为 uncertain', async () => {
    const candidate = baseCandidate({
      spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001',
    })
    // 同复合键两条 → 多义
    const pool = [
      baseRecord({ record_id: 'MD-01', code: 'CODE-A', insurance_code: 'XJ7000000000001' }),
      baseRecord({ record_id: 'MD-02', code: 'CODE-B', insurance_code: 'XJ7000000000001' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(jsonConclusion())))

    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => okRetrieval(pool), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('uncertain')
    expect(r.conclusion.uncertain_reason).toBe('多义命中')
    expect(r.conclusion.target_code).toBeNull()
    expect(r.model_call_logs).toHaveLength(0) // 闸门已定案，不调模型
  })

  it('检索失败 → 显式 uncertain(检索失败)，绝不 create，也不调模型', async () => {
    const candidate = baseCandidate()
    const fetchMock = vi.fn(async () => chatResponse(jsonConclusion()))
    vi.stubGlobal('fetch', fetchMock)
    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => failedRetrieval(), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('uncertain')
    expect(r.conclusion.uncertain_reason).toBe('检索失败')
    expect(r.conclusion.reason_fallback).toContain('检索失败')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('无近似项 → create（确定性通道，不调模型）', async () => {
    const candidate = baseCandidate({ spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000999' })
    const fetchMock = vi.fn(async () => chatResponse(jsonConclusion()))
    vi.stubGlobal('fetch', fetchMock)
    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => okRetrieval([]), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('create')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('模型不可达（fetch 抛错）→ 降级 uncertain + degraded=true + 不产可写回结论', async () => {
    const candidate = baseCandidate({ spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001' })
    const pool = [baseRecord({ record_id: 'MD-01', code: 'XJ7000000000001', insurance_code: 'XJ7000000000001' })]
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const r = await evaluateCandidate(candidate, {
      config: createTestConfig({ llm: { maxRetries: 0 } }), retrieve: async () => okRetrieval(pool), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('uncertain')
    expect(r.conclusion.uncertain_reason).toBe('模型不可用')
    expect(r.conclusion.degraded).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.conclusion.target_code).toBeNull()
  })

  it('证据越界引用 → 拒绝出结论转 uncertain + 记越界统计', async () => {
    const candidate = baseCandidate({ spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001' })
    const pool = [baseRecord({ record_id: 'MD-01', code: 'XJ7000000000001', insurance_code: 'XJ7000000000001' })]
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(jsonConclusion({
      evidence: [{ record_id: 'MD-OUT-OF-SCOPE', field: 'insurance_code', candidate_value: 'X', matched_value: 'Y' }],
    }))))

    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => okRetrieval(pool), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('uncertain')
    expect(r.conclusion.statistics?.out_of_snapshot_refs).toBe(1)
    expect(r.conclusion.evidence.some((e) => e.record_id === 'MD-OUT-OF-SCOPE')).toBe(false)
  })

  it('schema 校验失败重试 1 次仍失败 → 降级转人工', async () => {
    const candidate = baseCandidate({ spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001' })
    const pool = [baseRecord({ record_id: 'MD-01', code: 'XJ7000000000001', insurance_code: 'XJ7000000000001' })]
    // 两次都返回非法 JSON（缺 action 一致性：merge 无 target_code）
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse(jsonConclusion({ target_code: null }))))

    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => okRetrieval(pool), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('uncertain')
    expect(r.conclusion.degraded).toBe(true)
    expect(r.conclusion.uncertain_reason).toBe('模型不可用')
  })

  it('json_schema 端点不支持(400) → 降级 json_object 并成功出结论', async () => {
    const candidate = baseCandidate({ spec: '0.25g*12片', dosage_form: '胶囊剂', unit: '盒', insurance_code: 'XJ7000000000001' })
    const pool = [baseRecord({ record_id: 'MD-01', code: 'XJ7000000000001', insurance_code: 'XJ7000000000001' })]
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      calls.push(body.response_format?.type ?? 'none')
      if (body.response_format?.type === 'json_schema') {
        return new Response(JSON.stringify({ error: { message: 'json_schema not supported' } }), { status: 400 })
      }
      return chatResponse(jsonConclusion())
    }))

    const r = await evaluateCandidate(candidate, {
      config: createTestConfig(), retrieve: async () => okRetrieval(pool), now: () => NOW,
    })
    expect(r.conclusion.action).toBe('merge')
    expect(calls).toEqual(['json_schema', 'json_object'])
    expect(r.model_call_logs.some((l) => l.degraded_reason === 'json_schema_unsupported')).toBe(true)
  })
})

describe('字面相似度基线（Task 50）', () => {
  it('① 医保码精确命中 → level 1 / merge / 置信度 0.95', () => {
    const c = baseCandidate({ insurance_code: 'XJ7000000000001', spec: '0.25g*12片' })
    const r = baseRecord({ record_id: 'MD-01', code: 'CODE-1', insurance_code: 'XJ7000000000001', spec: '0.25g*12片' })
    const out = baselineConclude(c, [r])
    expect(out.action).toBe('merge')
    expect(out.target_code).toBe('CODE-1')
    expect(out.ranking[0].level).toBe(1)
    expect(out.confidence).toBe(BASELINE_CONFIDENCE[1])
    expect(out.rationale).toBe('') // 基线不产理由
  })

  it('② 规格单位归一后精确（250mg ≡ 0.25g）→ level 2', () => {
    const c = baseCandidate({ name: '阿莫西林', spec: '250mg*12片', unit: '盒', insurance_code: '' })
    const r = baseRecord({ record_id: 'MD-02', code: 'CODE-2', name: '阿莫西林', spec: '0.25g*12片', unit: '盒', insurance_code: '' })
    const out = baselineConclude(c, [r])
    expect(out.ranking[0].level).toBe(2)
    expect(out.action).toBe('merge')
  })

  it('③ 拼音首字母命中 → level 3 / 置信度 0.5', () => {
    const c = baseCandidate({ name: '阿莫西林胶囊', spec: 'X', insurance_code: '' })
    const r = baseRecord({ record_id: 'MD-03', code: 'CODE-3', name: '阿莫西林胶囊', spec: 'Y', insurance_code: '' })
    const out = baselineConclude(c, [r])
    expect(out.ranking[0].level).toBe(3)
    expect(out.confidence).toBe(BASELINE_CONFIDENCE[3])
  })

  it('④ 字面相似兜底 → level 4', () => {
    const c = baseCandidate({ name: '阿莫西林片', spec: 'X', insurance_code: '' })
    const r = baseRecord({ record_id: 'MD-04', code: 'CODE-4', name: '阿莫西林胶囊', spec: 'Y', insurance_code: '' })
    const out = baselineConclude(c, [r])
    expect(out.ranking[0].level).toBe(4)
  })

  it('零命中 → create，无 ranking', () => {
    const c = baseCandidate({ name: '不存在的项目', insurance_code: '' })
    const out = baselineConclude(c, [baseRecord({ name: '阿莫西林' })])
    expect(out.action).toBe('create')
    expect(out.target_code).toBeNull()
    expect(out.ranking).toHaveLength(0)
  })

  it('排序稳定可复现：层级升序 → 分数降序 → record_id 升序，两次结果逐字段一致', () => {
    const c = baseCandidate({ name: '阿莫西林胶囊', spec: '250mg*12片', unit: '盒', insurance_code: '' })
    const pool = [
      baseRecord({ record_id: 'MD-Z', code: 'Z', name: '阿莫西林胶囊', spec: '0.25g*12片', unit: '盒', insurance_code: '' }),
      baseRecord({ record_id: 'MD-A', code: 'A', name: '阿莫西林胶囊', spec: '0.25g*12片', unit: '盒', insurance_code: '' }),
    ]
    const a = baselineConclude(c, pool)
    const b = baselineConclude(c, pool)
    expect(a).toEqual(b)
    expect(a.ranking.map((h) => h.record.record_id)).toEqual(['MD-A', 'MD-Z'])
  })

  it('多义首条同分计数：记录 ambiguous_top_hits 供对拍统计基线误并占比', () => {
    const c = baseCandidate({ insurance_code: 'XJ7000000000001', spec: '0.25g*12片' })
    const pool = [
      baseRecord({ record_id: 'MD-1', code: 'A', insurance_code: 'XJ7000000000001' }),
      baseRecord({ record_id: 'MD-2', code: 'B', insurance_code: 'XJ7000000000001' }),
    ]
    const out = baselineConclude(c, pool)
    expect(out.action).toBe('merge') // 基线固有缺陷：多义仍取首条
    expect(out.ambiguous_top_hits).toBe(2)
    expect(out.hit_count).toBe(2)
  })

  it('批量基线逐条独立、顺序稳定', () => {
    const cs: CandidateRecord[] = [
      baseCandidate({ candidate_id: 'C1', insurance_code: 'XJ1' }),
      baseCandidate({ candidate_id: 'C2', insurance_code: '', name: '不存在' }),
    ]
    const out = baselineBatch(cs, [])
    expect(out.map((o) => o.candidate_id)).toEqual(['C1', 'C2'])
    expect(out[1].action).toBe('create')
  })
})
