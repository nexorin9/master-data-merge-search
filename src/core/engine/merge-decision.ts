/**
 * 三态归一与置信度守门（Task 31）。
 *
 * 模型输出归一成 create / merge / uncertain；非法 action 转 uncertain；置信度
 * 低于阈值、证据缺失、多义命中一律转存疑。守门规则在规则层，不依赖模型自评。
 * 闸门的判定（多义/停用/缺字段/版本冲突）优先于模型结论——闸门判多义时，
 * 即使模型给 merge 也必须转 uncertain。
 */
import { CONFIG_CONFIDENCE_THRESHOLD, UNCERTAIN_REASON_PRIORITY } from '../constants'
import type {
  Action, CandidateRecord, GateOutcome, MasterDataRecord, MergeConclusion, RawModelConclusion, UncertainReason,
} from '../types'

export interface MergeDecisionDeps {
  candidate: CandidateRecord
  gate: GateOutcome
  matched: MasterDataRecord[]
  threshold?: number
}

/** 合法 uncertain_reason 集合（与 schema 对齐）。 */
const VALID_REASONS: UncertainReason[] = [
  '检索失败', '多义命中', '命中记录均已停用', '版本冲突', '关键字段缺失',
  '模型不可用', '模型输出不合法', '无近似项', null,
]

/** action 归一：非法转 uncertain。 */
export function normalizeAction(raw: unknown): Action {
  return raw === 'create' || raw === 'merge' || raw === 'uncertain' ? raw : 'uncertain'
}

/** 置信度阈值守门。 */
export function belowThreshold(confidence: number, threshold = CONFIG_CONFIDENCE_THRESHOLD): boolean {
  return confidence < threshold
}

/**
 * reason 枚举兜底：缺失或非法时按优先级补齐，并记 reason_fallback。
 * 优先级由 UNCERTAIN_REASON_PRIORITY 定义（检索失败 > 多义 > 停用 > 版本 > 缺字段 ...）。
 */
export function fallbackReason(
  current: UncertainReason,
  gate: GateOutcome,
): { reason: UncertainReason; fallback?: string } {
  if (current && VALID_REASONS.includes(current)) return { reason: current }
  const gateReason: UncertainReason =
    gate.kind === 'ambiguous' ? '多义命中'
      : gate.kind === 'missing-fields' ? '关键字段缺失'
        : gate.kind === 'no-match' ? '无近似项'
          : null
  if (gateReason) return { reason: gateReason, fallback: `按闸门出口补齐原因：${gate.kind}` }
  // 按优先级取第一个可用（此处兜底为「模型输出不合法」）。
  const chosen = UNCERTAIN_REASON_PRIORITY.find((r) => r === '模型输出不合法') ?? '模型输出不合法'
  return { reason: chosen, fallback: 'uncertain_reason 缺失或非法，按枚举兜底' }
}

/** 证据最小完整性：≥1 条且字段齐全。 */
export function hasCompleteEvidence(model: RawModelConclusion): boolean {
  return model.evidence.length > 0 && model.evidence.every(
    (e) => !!e.record_id && !!e.field && typeof e.candidate_value === 'string' && typeof e.matched_value === 'string',
  )
}

/**
 * 三态守门：模型结论 + 闸门 → 最终结论。
 * 闸门优先：多义/缺字段/无近似项（create）由闸门直接决定 action。
 */
export function applyDecisionGates(
  conclusion: MergeConclusion,
  model: RawModelConclusion | null,
  deps: MergeDecisionDeps,
): MergeConclusion {
  const { candidate, gate, threshold = CONFIG_CONFIDENCE_THRESHOLD } = deps
  let out = { ...conclusion }

  // 1) 闸门多义优先：无论模型给什么，强制 uncertain。
  if (gate.kind === 'ambiguous') {
    out.action = 'uncertain'
    out.uncertain_reason = '多义命中'
    out.target_code = null
    out.reason_fallback = out.reason_fallback ?? '闸门判多义，覆盖模型结论'
    return out
  }
  if (gate.kind === 'missing-fields') {
    out.action = 'uncertain'
    out.uncertain_reason = '关键字段缺失'
    out.target_code = null
    out.missing_fields = gate.missing_keys
    return out
  }

  // 2) 模型结论归一（若提供）。
  if (model) {
    const action = normalizeAction(model.action)
    if (action === 'uncertain' && model.action !== 'uncertain') {
      out.reason_fallback = '模型 action 非法，转存疑'
    }
    if (action === 'merge' && (!model.target_code || model.target_code.trim() === '')) {
      out.action = 'uncertain'
      out.uncertain_reason = '模型输出不合法'
      out.reason_fallback = 'action=merge 缺 target_code'
      return out
    }
  }

  // 3) 置信度阈值守门。
  if (out.action === 'merge' && belowThreshold(out.confidence, threshold)) {
    out.action = 'uncertain'
    out.uncertain_reason = out.uncertain_reason ?? '无近似项'
    out.reason_fallback = `置信度 ${out.confidence.toFixed(2)} 低于阈值 ${threshold}，转存疑`
    return out
  }

  // 4) 证据缺失守门（最终裁决）。
  if (out.action === 'merge' && out.evidence.length === 0) {
    out.action = 'uncertain'
    out.uncertain_reason = '无近似项'
    out.target_code = null
    out.reason_fallback = '证据缺失，转存疑'
    return out
  }

  // 5) reason 枚举补齐。
  if (out.action === 'uncertain') {
    const { reason, fallback } = fallbackReason(out.uncertain_reason, gate)
    out.uncertain_reason = reason
    if (fallback) out.reason_fallback = out.reason_fallback ?? fallback
  }
  void candidate
  return out
}

/** 从模型原始结论构造结论骨架（供 merge-engine 组装）。 */
export function conclusionFromModel(
  candidate: CandidateRecord,
  model: RawModelConclusion,
): MergeConclusion {
  return {
    candidate_id: candidate.candidate_id,
    domain: candidate.domain,
    action: normalizeAction(model.action),
    target_code: model.target_code,
    confidence: model.confidence,
    rationale: model.rationale,
    evidence: model.evidence,
    uncertain_reason: model.uncertain_reason,
    missing_fields: [],
    degraded: false,
    source: 'model',
  }
}
