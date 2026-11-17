import { describe, expect, it } from 'vitest'
import {
  allDisabled, applyStatusGate, excludeDisabled, hasVersionConflict, versionConflictReason,
} from '@core/binding/status-gate'
import type { MergeConclusion } from '@core/types'
import { baseCandidate, baseRecord } from '../fixtures/gate-helpers'

const mergeConclusion = (target = 'XJ7000000000001'): MergeConclusion => ({
  candidate_id: 'C-0001', domain: 'drug', action: 'merge', target_code: target,
  confidence: 0.95, rationale: '复合键唯一命中',
  evidence: [{ record_id: 'MD-0001', field: 'insurance_code', candidate_value: 'XJ1', matched_value: 'XJ1' }],
  uncertain_reason: null, missing_fields: [], degraded: false,
})

describe('停用码与版本状态（Task 23）', () => {
  it('唯一命中为停用码 → 不产生 merge 目标且带 excluded_status', () => {
    const r = applyStatusGate(mergeConclusion(), baseCandidate(), [baseRecord({ status: '停用' })])
    expect(r).not.toBeNull()
    expect(r!.action).toBe('uncertain')
    expect(r!.uncertain_reason).toBe('命中记录均已停用')
    expect(r!.target_code).toBeNull()
    expect(r!.excluded_status).toBe('停用')
  })

  it('停用 + 启用混合命中 → excludeDisabled 只保留启用，停用进 excluded', () => {
    const { eligible, excluded } = excludeDisabled([
      baseRecord({ record_id: 'MD-1', status: '停用' }),
      baseRecord({ record_id: 'MD-2', status: '启用' }),
    ])
    expect(eligible.map((r) => r.record_id)).toEqual(['MD-2'])
    expect(excluded).toHaveLength(1)
    expect(excluded[0].reason).toContain('停用')
  })

  it('全停用命中 → allDisabled=true', () => {
    expect(allDisabled([baseRecord({ status: '停用' }), baseRecord({ status: '停用' })])).toBe(true)
    expect(allDisabled([baseRecord({ status: '启用' })])).toBe(false)
  })

  it('版本冲突 → uncertain + reason=版本冲突', () => {
    const r = applyStatusGate(
      mergeConclusion(),
      baseCandidate({ version: 'v2' }),
      [baseRecord({ version: 'v1' })],
    )
    expect(r).not.toBeNull()
    expect(r!.action).toBe('uncertain')
    expect(r!.uncertain_reason).toBe('版本冲突')
    expect(r!.reason_fallback).toContain('v2')
  })

  it('版本一致 → 不触发冲突', () => {
    expect(hasVersionConflict(baseCandidate({ version: 'v1' }), baseRecord({ version: 'v1' }))).toBe(false)
    expect(applyStatusGate(mergeConclusion(), baseCandidate({ version: 'v1' }), [baseRecord()])).toBeNull()
  })

  it('命中含停用排除 + 目标启用 → 带 excluded_records 但保持 merge', () => {
    const enabled = baseRecord({ record_id: 'MD-2', status: '启用' })
    const r = applyStatusGate(
      mergeConclusion(enabled.code),
      baseCandidate(),
      [baseRecord({ record_id: 'MD-1', status: '停用', code: 'XJ-OLD' }), enabled],
    )
    expect(r?.action).toBe('merge')
    expect(r?.excluded_records).toHaveLength(1)
  })

  it('版本冲突说明可读', () => {
    const reason = versionConflictReason(baseCandidate({ version: 'v3' }), baseRecord({ version: 'v1' }))
    expect(reason).toContain('v3')
    expect(reason).toContain('v1')
  })
})
