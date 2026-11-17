/**
 * 三态归一与置信度守门单测（Task 23 / 31）。
 *
 * 覆盖：action 归一、阈值守门、证据缺失守门、闸门（多义/缺字段/no-match）
 * 优先于模型结论、置信度封顶、uncertain_reason 枚举兜底、从模型骨架构造结论。
 * 全部纯函数，无需 fetch。
 */
import { describe, expect, it } from 'vitest'
import { CONFIG_CONFIDENCE_THRESHOLD } from '@core/constants'
import {
  applyDecisionGates,
  belowThreshold,
  conclusionFromModel,
  fallbackReason,
  hasCompleteEvidence,
  normalizeAction,
  type MergeDecisionDeps,
} from '@core/engine/merge-decision'
import type {
  Action, EvidenceItem, GateOutcome, MergeConclusion, RawModelConclusion, UncertainReason,
} from '@core/types'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

const fullEvidence: EvidenceItem = {
  record_id: 'MD-0001',
  field: 'insurance_code',
  candidate_value: 'XJ7000000000001',
  matched_value: 'XJ7000000000001',
}

function validModel(over: Partial<RawModelConclusion> = {}): RawModelConclusion {
  return {
    action: 'merge',
    target_code: 'XJ7000000000001',
    confidence: 0.9,
    rationale: '规格与医保码一致',
    evidence: [{ ...fullEvidence }],
    uncertain_reason: null,
    ...over,
  }
}

function mergeConclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  return {
    candidate_id: 'C-0001',
    domain: 'drug',
    action: 'merge',
    target_code: 'XJ7000000000001',
    confidence: 0.9,
    rationale: '规格与医保码一致',
    evidence: [{ ...fullEvidence }],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    source: 'model',
    ...over,
  }
}

const uniqueGate: GateOutcome = { kind: 'unique', record: baseRecord() }

function depsFor(gate: GateOutcome, over: Partial<MergeDecisionDeps> = {}): MergeDecisionDeps {
  return { candidate: baseCandidate(), gate, matched: [], ...over }
}

describe('三态归一与基础守门（Task 23）', () => {
  it('normalizeAction：合法三态原样，其余一律转 uncertain', () => {
    expect(normalizeAction('create')).toBe('create')
    expect(normalizeAction('merge')).toBe('merge')
    expect(normalizeAction('uncertain')).toBe('uncertain')
    expect(normalizeAction('delete')).toBe('uncertain')
    expect(normalizeAction('MERGE')).toBe('uncertain')
    expect(normalizeAction(undefined)).toBe('uncertain')
    expect(normalizeAction(42)).toBe('uncertain')
  })

  it('belowThreshold：默认阈值取 CONFIG_CONFIDENCE_THRESHOLD，且支持自定义', () => {
    expect(belowThreshold(CONFIG_CONFIDENCE_THRESHOLD - 0.01)).toBe(true)
    expect(belowThreshold(CONFIG_CONFIDENCE_THRESHOLD)).toBe(false)
    expect(belowThreshold(CONFIG_CONFIDENCE_THRESHOLD + 0.01)).toBe(false)
    expect(belowThreshold(0.5, 0.6)).toBe(true)
    expect(belowThreshold(0.7, 0.6)).toBe(false)
  })

  it('hasCompleteEvidence：≥1 条且四要素齐全才为 true', () => {
    expect(hasCompleteEvidence(validModel())).toBe(true)
    expect(hasCompleteEvidence(validModel({ evidence: [] }))).toBe(false)
    expect(hasCompleteEvidence(validModel({ evidence: [{ ...fullEvidence, field: '' }] }))).toBe(false)
    expect(hasCompleteEvidence(validModel({ evidence: [{ ...fullEvidence, matched_value: 7 as unknown as string }] }))).toBe(false)
  })

  it('fallbackReason：合法 reason 原样返回；缺失按闸门出口/优先级补齐', () => {
    expect(fallbackReason('多义命中', uniqueGate)).toEqual({ reason: '多义命中' })
    expect(fallbackReason(null, { kind: 'ambiguous', records: [] })).toEqual({
      reason: '多义命中', fallback: '按闸门出口补齐原因：ambiguous',
    })
    expect(fallbackReason(null, { kind: 'missing-fields', missing_keys: ['spec'] }).reason).toBe('关键字段缺失')
    expect(fallbackReason(null, { kind: 'no-match' }).reason).toBe('无近似项')
    const uniqueFallback = fallbackReason(null, uniqueGate)
    expect(uniqueFallback.reason).toBe('模型输出不合法')
    expect(uniqueFallback.fallback).toContain('枚举兜底')
  })

  it('conclusionFromModel：按候选与模型骨架构造结论（action 归一、source=model）', () => {
    const candidate = baseCandidate()
    const c = conclusionFromModel(candidate, validModel({ action: 'merge' }))
    expect(c.candidate_id).toBe(candidate.candidate_id)
    expect(c.domain).toBe(candidate.domain)
    expect(c.action).toBe('merge')
    expect(c.target_code).toBe('XJ7000000000001')
    expect(c.confidence).toBe(0.9)
    expect(c.evidence).toEqual([fullEvidence])
    expect(c.missing_fields).toEqual([])
    expect(c.degraded).toBe(false)
    expect(c.source).toBe('model')

    const illegal = conclusionFromModel(candidate, validModel({ action: '删除' as unknown as Action }))
    expect(illegal.action).toBe('uncertain')
  })
})

describe('applyDecisionGates 最终裁决（Task 23）', () => {
  it('置信度低于阈值 → uncertain，并记 reason_fallback', () => {
    const out = applyDecisionGates(
      mergeConclusion({ confidence: 0.5 }),
      validModel(),
      depsFor(uniqueGate),
    )
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('无近似项')
    expect(out.reason_fallback).toContain('低于阈值')
  })

  it('自定义 threshold 参与守门：0.8 在 0.9 阈值下转存疑，在默认阈值下保持 merge', () => {
    const high = applyDecisionGates(mergeConclusion({ confidence: 0.8 }), validModel(), depsFor(uniqueGate, { threshold: 0.9 }))
    expect(high.action).toBe('uncertain')
    expect(high.reason_fallback).toContain('低于阈值')

    const normal = applyDecisionGates(mergeConclusion({ confidence: 0.8 }), validModel(), depsFor(uniqueGate))
    expect(normal.action).toBe('merge')
  })

  it('证据缺失（evidence 为空）→ uncertain，清 target_code', () => {
    const out = applyDecisionGates(
      mergeConclusion({ evidence: [] }),
      validModel(),
      depsFor(uniqueGate),
    )
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('无近似项')
    expect(out.target_code).toBeNull()
    expect(out.reason_fallback).toContain('证据缺失')
  })

  it('闸门判多义时覆盖模型的 merge 结论', () => {
    const ambiguous: GateOutcome = { kind: 'ambiguous', records: [baseRecord(), baseRecord({ record_id: 'MD-0002' })] }
    const out = applyDecisionGates(mergeConclusion(), validModel(), depsFor(ambiguous))
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('多义命中')
    expect(out.target_code).toBeNull()
    expect(out.reason_fallback).toContain('多义')
  })

  it('缺字段闸门 → uncertain + missing_fields 来自闸门', () => {
    const gate: GateOutcome = { kind: 'missing-fields', missing_keys: ['spec', 'unit'] }
    const out = applyDecisionGates(mergeConclusion(), validModel(), depsFor(gate))
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('关键字段缺失')
    expect(out.target_code).toBeNull()
    expect(out.missing_fields).toEqual(['spec', 'unit'])
  })

  it('模型 action 非法 → uncertain，并记「非法」reason_fallback（经骨架归一）', () => {
    const model = validModel({ action: '删除' as unknown as Action })
    const skeleton = conclusionFromModel(baseCandidate(), model)
    expect(skeleton.action).toBe('uncertain')
    const out = applyDecisionGates(skeleton, model, depsFor(uniqueGate))
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('模型输出不合法')
    expect(out.reason_fallback).toContain('非法')
  })

  it('模型给 merge 却缺 target_code → uncertain（模型输出不合法）', () => {
    const model = validModel({ target_code: null })
    const skeleton = conclusionFromModel(baseCandidate(), model)
    const out = applyDecisionGates(skeleton, model, depsFor(uniqueGate))
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('模型输出不合法')
    expect(out.reason_fallback).toContain('target_code')
  })

  it('uncertain 且 reason 缺失 → 按枚举兜底补 reason', () => {
    const out = applyDecisionGates(
      mergeConclusion({ action: 'uncertain', uncertain_reason: null as UncertainReason }),
      validModel({ action: 'uncertain' }),
      depsFor(uniqueGate),
    )
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('模型输出不合法')
    expect(out.reason_fallback).toContain('兜底')
  })

  it('no-match 闸门 + 模型 create → create 路径（不被误判为 merge/uncertain）', () => {
    const model = validModel({ action: 'create', target_code: null })
    const skeleton = conclusionFromModel(baseCandidate(), model)
    const out = applyDecisionGates(skeleton, model, depsFor({ kind: 'no-match' }))
    expect(out.action).toBe('create')
    expect(out.target_code).toBeNull()
    expect(out.uncertain_reason).toBeNull()
  })

  it('合法且高置信、证据齐全的 merge 保持原动作', () => {
    const out = applyDecisionGates(mergeConclusion(), validModel(), depsFor(uniqueGate))
    expect(out.action).toBe('merge')
    expect(out.target_code).toBe('XJ7000000000001')
    expect(out.uncertain_reason).toBeNull()
  })
})
