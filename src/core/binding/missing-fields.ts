/**
 * 关键字段缺失的置信度封顶与强制存疑（Task 22）。
 *
 * 候选缺规格或缺单位时，复合键不成立，模型置信度再高也不许自动并入。
 * 规则层硬约束，不依赖模型自觉。
 */
import { CONFIG_MISSING_FIELD_CAP } from '../constants'
import { missingKeyFields } from './composite-key'
import type { CandidateRecord, MergeConclusion } from '../types'

export interface MissingFieldVerdict {
  hasMissing: boolean
  missing_fields: string[]
  cap: number
}

/** 判定候选是否缺关键字段，并给出封顶值。 */
export function checkMissingFields(candidate: CandidateRecord): MissingFieldVerdict {
  const missing = missingKeyFields(candidate)
  return { hasMissing: missing.length > 0, missing_fields: missing, cap: CONFIG_MISSING_FIELD_CAP }
}

/**
 * 对一条结论施加「缺字段 → 封顶 + 强制存疑」。
 * 幂等：多次调用不会重复封顶（capped_by 已存在时保留最早原因）。
 */
export function applyMissingFieldCap(
  conclusion: MergeConclusion,
  candidate: CandidateRecord,
): MergeConclusion {
  const verdict = checkMissingFields(candidate)
  if (!verdict.hasMissing) return conclusion
  const capped: MergeConclusion = {
    ...conclusion,
    action: 'uncertain',
    uncertain_reason: '关键字段缺失',
    missing_fields: verdict.missing_fields,
    confidence: Math.min(conclusion.confidence, verdict.cap),
  }
  if (conclusion.confidence > verdict.cap) {
    capped.capped_from = conclusion.confidence
    capped.capped_by = `关键字段缺失：${verdict.missing_fields.join('、')}`
  }
  if (!capped.reason_fallback) {
    capped.reason_fallback = `本次因缺${verdict.missing_fields.join('、')}未作自动判定`
  }
  return capped
}

/** 写回层二次校验：缺字段结论一律拒收（防止绕过引擎直接调用写回）。 */
export function rejectIfMissingFields(
  conclusion: MergeConclusion,
  candidate: CandidateRecord,
): { accepted: boolean; reason?: string } {
  const verdict = checkMissingFields(candidate)
  if (verdict.hasMissing && conclusion.action === 'merge') {
    return {
      accepted: false,
      reason: `候选缺${verdict.missing_fields.join('、')}，不允许写回归并建议`,
    }
  }
  return { accepted: true }
}
