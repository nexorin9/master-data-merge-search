/**
 * 闸门到三态结论的编排（Task 24 / 31）。
 *
 * 把唯一性闸门、多义、缺字段、停用码与版本状态的判定统一编排成一条
 * 「闸门结论」。test-gate-boundaries 与 merge-engine 复用同一份口径，
 * 保证边界用例集与引擎判定不各算一套。
 * 本函数只做规则层裁决（确定性），模型结论由后续的 merge-decision 合并。
 */
import { decideGate, resolveMatchedRecords } from '../binding/unique-gate'
import { applyMissingFieldCap, checkMissingFields } from '../binding/missing-fields'
import { allDisabled, applyStatusGate, excludeDisabled } from '../binding/status-gate'
import { ambiguityEvidence, detectAmbiguity } from '../binding/ambiguity'
import type {
  CandidateRecord, GateOutcome, MasterDataRecord, MergeConclusion, UncertainReason,
} from '../types'

export interface GateDecision {
  gate: GateOutcome['kind'] | 'dirty'
  conclusion: MergeConclusion
  matched: MasterDataRecord[]
}

/** 从候选与命中池出发，产出闸门级结论（不含模型调用）。 */
export function decideByGate(
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
  options: { dirty?: boolean } = {},
): GateDecision {
  const base: MergeConclusion = {
    candidate_id: candidate.candidate_id,
    domain: candidate.domain,
    action: 'uncertain',
    target_code: null,
    confidence: 0,
    rationale: '',
    evidence: [],
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    source: 'model',
    retrieved_record_ids: pool.map((r) => r.record_id),
  }

  // 脏行：显式标记转人工（模型输出不合法口径），绝不进入自动归并。
  if (options.dirty) {
    return {
      gate: 'dirty',
      matched: [],
      conclusion: {
        ...base,
        uncertain_reason: '模型输出不合法',
        reason_fallback: '候选含脏行（乱码 / 不可打印字符），不进入自动归并判定',
      },
    }
  }

  // 医保码格式异常（位长明显不符）：绝不拿它做自动归并，转人工。
  // 院内医保编码通常 15 位（XJ + 13 位数字）；过短视为脏数据。
  const insuranceCode = (candidate.insurance_code ?? '').trim()
  if (candidate.domain === 'drug' && insuranceCode && insuranceCode.length < 8) {
    return {
      gate: 'dirty',
      matched: [],
      conclusion: {
        ...base,
        action: 'uncertain',
        uncertain_reason: '模型输出不合法',
        reason_fallback: `医保码格式异常（位长 ${insuranceCode.length}，过短），转人工核对`,
      },
    }
  }

  const matched = resolveMatchedRecords(candidate, pool)
  const gate = decideGate(candidate, matched, { baseVersion: candidate.version })

  if (gate.kind === 'missing-fields') {
    const c = { ...base, action: 'uncertain' as const, uncertain_reason: '关键字段缺失' as const, missing_fields: gate.missing_keys }
    return { gate: gate.kind, matched: [], conclusion: applyMissingFieldCap(c, candidate) }
  }

  if (gate.kind === 'no-match') {
    // 需区分「全停用」与「真无近似项」：由调用方传全量命中池判别。
    const allHitByCode = pool.filter(
      (r) => r.domain === candidate.domain && (r.insurance_code ?? '') === (candidate.insurance_code ?? ''),
    )
    if (allDisabled(allHitByCode)) {
      const { excluded } = excludeDisabled(allHitByCode)
      return {
        gate: gate.kind,
        matched: allHitByCode,
        conclusion: {
          ...base,
          action: 'uncertain',
          uncertain_reason: '命中记录均已停用',
          excluded_status: '停用',
          excluded_records: excluded,
          reason_fallback: '命中记录均已停用，不产出自动并入目标',
        },
      }
    }
    return {
      gate: gate.kind,
      matched: [],
      conclusion: { ...base, action: 'create', uncertain_reason: null, rationale: '院内主数据无近似项，建议新建' },
    }
  }

  if (gate.kind === 'ambiguous') {
    return {
      gate: gate.kind,
      matched: gate.records,
      conclusion: {
        ...base,
        action: 'uncertain',
        uncertain_reason: '多义命中',
        evidence: ambiguityEvidence(gate.records),
        ambiguous_records: gate.records,
        reason_fallback: '同一复合键命中多条主数据，已拒绝出结论并列出全部命中',
      },
    }
  }

  // gate.kind === 'unique'
  const merged: MergeConclusion = {
    ...base,
    action: 'merge',
    target_code: gate.record.code,
    confidence: 0.95,
    rationale: '医保码或复合键唯一命中，规格单位归一后一致',
    evidence: [
      {
        record_id: gate.record.record_id,
        field: 'insurance_code',
        candidate_value: candidate.insurance_code ?? '',
        matched_value: gate.record.insurance_code ?? '',
      },
    ],
  }
  const statusAdjusted = applyStatusGate(merged, candidate, [gate.record])
  return {
    gate: gate.kind,
    matched: [gate.record],
    conclusion: statusAdjusted ?? merged,
  }
}

/** 期望 reason 的归一化工具（供基准对拍比对）。 */
export function reasonOf(c: MergeConclusion): UncertainReason {
  return c.action === 'uncertain' ? c.uncertain_reason : null
}
