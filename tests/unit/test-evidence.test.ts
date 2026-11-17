/**
 * 证据链构建与越界引用拒绝单测（Task 24 / 32）。
 *
 * 覆盖：快照 record_id 集合、字段白名单、正常链构建、越界拒绝 + 事件、
 * matched_value 以主数据回填并保留模型原值、关键字段证据判定、
 * rejectOutOfBounds 把结论转存疑并统计 out_of_snapshot_refs。
 * 全部纯函数，无需 fetch。
 */
import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_FIELDS,
  buildEvidenceChain,
  hasCriticalFieldEvidence,
  rejectOutOfBounds,
  snapshotRecordIds,
} from '@core/engine/evidence'
import type { EvidenceItem, MergeConclusion, MasterDataRecord } from '@core/types'
import { baseRecord } from '../fixtures/gate-helpers'

const FIXED_NOW = { now: () => 'T0' }

function conclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  return {
    candidate_id: 'C-0001',
    domain: 'drug',
    action: 'merge',
    target_code: 'XJ7000000000001',
    confidence: 0.9,
    rationale: 'ok',
    evidence: [],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    source: 'model',
    ...over,
  }
}

function ev(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    record_id: 'MD-0001',
    field: 'insurance_code',
    candidate_value: 'XJ7000000000001',
    matched_value: 'XJ7000000000001',
    ...over,
  }
}

describe('证据链基础（Task 24）', () => {
  it('snapshotRecordIds：取快照 record_id 集合并去重', () => {
    const pool: MasterDataRecord[] = [
      baseRecord({ record_id: 'MD-0001' }),
      baseRecord({ record_id: 'MD-0002' }),
      baseRecord({ record_id: 'MD-0001' }),
    ]
    expect(snapshotRecordIds(pool)).toEqual(new Set(['MD-0001', 'MD-0002']))
    expect(snapshotRecordIds([]).size).toBe(0)
  })

  it('EVIDENCE_FIELDS 白名单：含业务字段，排除非白名单字段', () => {
    for (const f of ['insurance_code', 'name', 'spec', 'dosage_form', 'unit', 'code', 'status', 'version', 'record_id']) {
      expect(EVIDENCE_FIELDS.has(f)).toBe(true)
    }
    expect(EVIDENCE_FIELDS.has('patient_id')).toBe(false)
    expect(EVIDENCE_FIELDS.has('phone')).toBe(false)
    expect(EVIDENCE_FIELDS.has('foo')).toBe(false)
  })

  it('正常链：四要素齐全且 matched_value 与主数据一致 → ok:true，证据原样进入', () => {
    const snapshot = [baseRecord()]
    const r = buildEvidenceChain([ev()], snapshot, 'C-0001', FIXED_NOW)
    expect(r.ok).toBe(true)
    expect(r.evidence).toEqual([ev()])
    expect(r.out_of_bounds).toEqual([])
    expect(r.mismatches).toEqual([])
  })

  it('空证据 / 全部越界 → ok:false', () => {
    expect(buildEvidenceChain([], [baseRecord()], 'C-0001', FIXED_NOW).ok).toBe(false)
    const allOob = buildEvidenceChain(
      [ev({ record_id: 'GHOST-1' }), ev({ record_id: 'GHOST-2' })],
      [baseRecord()], 'C-0001', FIXED_NOW,
    )
    expect(allOob.ok).toBe(false)
    expect(allOob.evidence).toEqual([])
    expect(allOob.out_of_bounds).toHaveLength(2)
  })

  it('非字符串实际值（字段不存在于主数据）不触发回填，证据原样保留', () => {
    const r = buildEvidenceChain([ev({ field: '不存在的字段', matched_value: 'M' })], [baseRecord()], 'C-0001', FIXED_NOW)
    expect(r.ok).toBe(true)
    expect(r.mismatches).toEqual([])
    expect(r.evidence[0].matched_value).toBe('M')
    expect(r.evidence[0].evidence_mismatch).toBeUndefined()
    expect(r.evidence[0].model_matched_value).toBeUndefined()
  })
})

describe('越界引用拒绝与值回填（Task 24）', () => {
  it('越界 record_id → 拒绝出结论并记事件（candidate_id/record_id/source/at）', () => {
    const snapshot = [baseRecord()]
    const raw = [ev(), ev({ record_id: 'GHOST-9', field: 'spec', candidate_value: 'x', matched_value: 'y' })]
    const r = buildEvidenceChain(raw, snapshot, 'C-0001', FIXED_NOW)

    expect(r.ok).toBe(false)
    expect(r.evidence).toEqual([ev()]) // 越界条目不进入证据链
    expect(r.out_of_bounds).toHaveLength(1)
    expect(r.out_of_bounds[0]).toEqual({
      candidate_id: 'C-0001', record_id: 'GHOST-9', source: 'spec', at: 'T0',
    })
  })

  it('matched_value 不一致 → 以主数据回填 + evidence_mismatch + 保留 model_matched_value', () => {
    const snapshot = [baseRecord({ spec: '0.25g*12片' })]
    const raw = [ev({ field: 'spec', candidate_value: '0.25g*12片', matched_value: '0.5g*24片' })]
    const r = buildEvidenceChain(raw, snapshot, 'C-0001', FIXED_NOW)

    expect(r.ok).toBe(true)
    expect(r.out_of_bounds).toEqual([])
    expect(r.mismatches).toHaveLength(1)
    expect(r.evidence[0]).toMatchObject({
      record_id: 'MD-0001',
      field: 'spec',
      candidate_value: '0.25g*12片',
      matched_value: '0.25g*12片', // 回填为主数据实际值
      model_matched_value: '0.5g*24片', // 保留模型原值供对比
      evidence_mismatch: true,
    })
    expect(r.mismatches[0].matched_value).toBe('0.25g*12片')
  })

  it('多条证据混合：合法项保留、越界项拒绝、不一致项回填', () => {
    const snapshot = [baseRecord({ spec: '0.25g*12片' })]
    const raw = [
      ev(),
      ev({ field: 'spec', matched_value: '错误规格' }),
      ev({ record_id: 'GHOST-1' }),
    ]
    const r = buildEvidenceChain(raw, snapshot, 'C-0001', FIXED_NOW)
    expect(r.ok).toBe(false)
    expect(r.evidence).toHaveLength(2)
    expect(r.mismatches).toHaveLength(1)
    expect(r.out_of_bounds).toHaveLength(1)
  })

  it('hasCriticalFieldEvidence：仅 insurance_code/spec/unit 计入关键字段', () => {
    expect(hasCriticalFieldEvidence([ev({ field: 'insurance_code' })])).toBe(true)
    expect(hasCriticalFieldEvidence([ev({ field: 'spec' })])).toBe(true)
    expect(hasCriticalFieldEvidence([ev({ field: 'unit' })])).toBe(true)
    expect(hasCriticalFieldEvidence([ev({ field: 'name' })])).toBe(false)
    expect(hasCriticalFieldEvidence([ev({ field: 'code' })])).toBe(false)
    expect(hasCriticalFieldEvidence([])).toBe(false)
  })

  it('merge 结论只有非关键字段证据 → hasCriticalFieldEvidence 为 false（供决策层转存疑）', () => {
    const r = buildEvidenceChain([ev({ field: 'name', matched_value: '阿莫西林胶囊' })], [baseRecord()], 'C-0001', FIXED_NOW)
    expect(r.ok).toBe(true)
    expect(hasCriticalFieldEvidence(r.evidence)).toBe(false)
  })
})

describe('rejectOutOfBounds（Task 24）', () => {
  it('有越界事件 → 转 uncertain、清 target_code、置信度封顶、统计 out_of_snapshot_refs', () => {
    const c = conclusion({ confidence: 0.9 })
    const result = buildEvidenceChain(
      [ev(), ev({ record_id: 'GHOST-1' }), ev({ record_id: 'GHOST-2' })],
      [baseRecord()], 'C-0001', FIXED_NOW,
    )
    const out = rejectOutOfBounds(c, result)
    expect(out.action).toBe('uncertain')
    expect(out.uncertain_reason).toBe('模型输出不合法')
    expect(out.target_code).toBeNull()
    expect(out.confidence).toBeLessThanOrEqual(0.5)
    expect(out.evidence).toEqual(result.evidence)
    expect(out.statistics?.out_of_snapshot_refs).toBe(2)
    expect(out.reason_fallback).toContain('拒绝出结论')
  })

  it('无越界事件 → 原结论原样返回', () => {
    const c = conclusion()
    const result = buildEvidenceChain([ev()], [baseRecord()], 'C-0001', FIXED_NOW)
    expect(rejectOutOfBounds(c, result)).toBe(c)
  })
})
