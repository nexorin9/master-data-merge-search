/**
 * 结构化输出与 schema 校验契约测试（Task 21 / 29 的纯函数层）。
 *
 * 本文件只测纯决策 / 校验函数：makeMergeRequestBody 的两种 response_format、
 * needsSchemaDowngrade 判定、validateConclusion 的 schema + 业务一致性、
 * parseModelJson、validationErrorSummary、hasEvidenceQuartet，以及导出的
 * valibot schema。
 *
 * 注：json_schema → json_object 的「降级编排」与「校验失败重试 1 次转人工」
 * 由 merge-engine 集成层（另一任务）承接，此处不涉及任何 fetch / 编排。
 */
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { CONFIG_RATIONALE_MAX_LENGTH } from '@core/constants'
import { makeMergeRequestBody } from '@core/model/model-gateway'
import {
  EvidenceWireSchema,
  RawConclusionSchema,
  hasEvidenceQuartet,
  needsSchemaDowngrade,
  parseModelJson,
  validateConclusion,
  validationErrorSummary,
} from '@core/model/merge-validator'
import type { EvidenceItem, RawModelConclusion } from '@core/types'
import { baseCandidate } from '../fixtures/gate-helpers'

const fullEvidence: EvidenceItem = {
  record_id: 'MD-0001',
  field: 'insurance_code',
  candidate_value: 'XJ7000000000001',
  matched_value: 'XJ7000000000001',
}

const jsonSchema = {
  name: 'merge_conclusion',
  schema: { type: 'object', properties: { action: { type: 'string' } } },
}

/** 构造一个默认合法的模型结论，便于逐项破坏字段。 */
function validRaw(over: Partial<RawModelConclusion> = {}): RawModelConclusion {
  return {
    action: 'merge',
    target_code: 'XJ7000000000001',
    confidence: 0.9,
    rationale: '规格与医保码一致，证据充分',
    evidence: [{ ...fullEvidence }],
    uncertain_reason: null,
    ...over,
  }
}

describe('结构化请求 response_format（Task 21）', () => {
  it('makeMergeRequestBody 默认 → response_format=json_object', () => {
    const body = makeMergeRequestBody(baseCandidate(), [], 'm-1')
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('makeMergeRequestBody 带 jsonSchema → response_format=json_schema 并回传 schema', () => {
    const body = makeMergeRequestBody(baseCandidate(), [], 'm-1', jsonSchema)
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: jsonSchema })
  })
})

describe('schema 降级判定 needsSchemaDowngrade（Task 29）', () => {
  it('400 + 提示不支持 json_schema/response_format → true', () => {
    expect(needsSchemaDowngrade(400, 'response_format json_schema is not supported')).toBe(true)
    expect(needsSchemaDowngrade(400, 'unsupported response_format: json_schema')).toBe(true)
    expect(needsSchemaDowngrade(400, 'server does not support this type')).toBe(true)
  })

  it('非 400 或无关 body → false', () => {
    expect(needsSchemaDowngrade(400, 'invalid api key')).toBe(false)
    expect(needsSchemaDowngrade(401, 'json_schema not supported')).toBe(false)
    expect(needsSchemaDowngrade(500, 'json_schema not supported')).toBe(false)
    expect(needsSchemaDowngrade(200, 'ok')).toBe(false)
  })
})

describe('validateConclusion 业务一致性（Task 29）', () => {
  it('接受合法结论：ok:true、errors 为空、回传 conclusion', () => {
    const r = validateConclusion(validRaw())
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.conclusion).toBeDefined()
    expect(r.conclusion?.action).toBe('merge')
    expect(r.conclusion?.evidence).toHaveLength(1)
  })

  it('拒绝：action=merge 缺 target_code', () => {
    const r = validateConclusion(validRaw({ target_code: null }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('target_code')
  })

  it('拒绝：action=create 却带 target_code', () => {
    const r = validateConclusion(validRaw({ action: 'create', target_code: 'XJ7000000000001' }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('create')
  })

  it('拒绝：action=uncertain 缺 uncertain_reason', () => {
    const r = validateConclusion(validRaw({ action: 'uncertain', uncertain_reason: null }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('uncertain_reason')
  })

  it('拒绝：evidence 缺四要素（字段缺失 → schema 失败，空值 → 业务失败）', () => {
    const missingField = validateConclusion(
      validRaw({ evidence: [{ record_id: 'MD-0001', field: 'spec', candidate_value: 'a' } as unknown as EvidenceItem] }),
    )
    expect(missingField.ok).toBe(false)
    expect(missingField.errors.length).toBeGreaterThan(0)

    const emptyValue = validateConclusion(
      validRaw({ evidence: [{ ...fullEvidence, record_id: '' }] }),
    )
    expect(emptyValue.ok).toBe(false)
    expect(emptyValue.errors.join(' ')).toContain('四要素')
  })

  it('拒绝：evidence 为空', () => {
    const r = validateConclusion(validRaw({ evidence: [] }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('evidence')
  })

  it(`拒绝：rationale 超过 ${CONFIG_RATIONALE_MAX_LENGTH} 字`, () => {
    const r = validateConclusion(validRaw({ rationale: 'x'.repeat(CONFIG_RATIONALE_MAX_LENGTH + 1) }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('rationale')
  })

  it('拒绝：confidence 越出 [0,1]', () => {
    expect(validateConclusion(validRaw({ confidence: 1.5 })).ok).toBe(false)
    expect(validateConclusion(validRaw({ confidence: -0.1 })).ok).toBe(false)
  })

  it('拒绝：非法 action / 非法 uncertain_reason（schema 层 picklist）', () => {
    expect(validateConclusion(validRaw({ action: 'delete' as unknown as RawModelConclusion['action'] })).ok).toBe(false)
    expect(validateConclusion(validRaw({ action: 'uncertain', uncertain_reason: '瞎写的原因' as never })).ok).toBe(false)
  })

  it('validationErrorSummary：非空且含前缀与首条错误', () => {
    const r = validateConclusion(validRaw({ target_code: null, confidence: 2 }))
    expect(r.ok).toBe(false)
    const summary = validationErrorSummary(r.errors)
    expect(summary.length).toBeGreaterThan(0)
    expect(summary).toContain('上次输出未通过 schema 校验')
    expect(summary).toContain(r.errors[0])
  })
})

describe('parseModelJson / hasEvidenceQuartet / 导出 schema（Task 21）', () => {
  it('parseModelJson 兼容 ```json 围栏与纯 JSON，拒绝非法 JSON', () => {
    const fenced = parseModelJson('```json\n{"action":"merge"}\n```')
    expect(fenced.ok).toBe(true)
    expect(fenced.value).toEqual({ action: 'merge' })

    const plain = parseModelJson('  {"action":"create"}  ')
    expect(plain.ok).toBe(true)
    expect(plain.value).toEqual({ action: 'create' })

    const bad = parseModelJson('{ 这不是 json')
    expect(bad.ok).toBe(false)
    expect(bad.error?.length).toBeGreaterThan(0)
  })

  it('hasEvidenceQuartet：四要素齐全为 true，缺 record_id/字段/类型错误为 false', () => {
    expect(hasEvidenceQuartet(fullEvidence)).toBe(true)
    expect(hasEvidenceQuartet({ ...fullEvidence, record_id: '' })).toBe(false)
    expect(hasEvidenceQuartet({ ...fullEvidence, field: '' })).toBe(false)
    expect(hasEvidenceQuartet({ ...fullEvidence, matched_value: 123 as unknown as string })).toBe(false)
  })

  it('导出的 EvidenceWireSchema / RawConclusionSchema 可被 valibot 直接使用', () => {
    expect(v.safeParse(EvidenceWireSchema, fullEvidence).success).toBe(true)
    expect(v.safeParse(EvidenceWireSchema, { record_id: 'MD-1' }).success).toBe(false)
    expect(v.safeParse(RawConclusionSchema, validRaw()).success).toBe(true)
    expect(v.safeParse(RawConclusionSchema, validRaw({ action: 'bad' as never })).success).toBe(false)
  })
})
