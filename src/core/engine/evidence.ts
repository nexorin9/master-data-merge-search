/**
 * 证据链构建与越界引用拒绝（Task 32）。
 *
 * 证据链是本产品核心产物。模型若引用了检索结果之外的 record_id，就是幻觉，
 * 必须拒绝出结论并显式记录越界事件，绝不静默接受。matched_value 与主数据
 * 实际值不一致时以主数据为准并标 evidence_mismatch（保留模型原值供对比）。
 */
import type { EvidenceItem, MasterDataRecord, MergeConclusion } from '../types'

export interface OutOfBoundsEvent {
  candidate_id: string
  record_id: string
  source: string
  at: string
}

export interface EvidenceBuildResult {
  ok: boolean
  evidence: EvidenceItem[]
  out_of_bounds: OutOfBoundsEvent[]
  mismatches: EvidenceItem[]
}

/** 证据 field 取值白名单（与 field-diff 字段集合同源）。 */
export const EVIDENCE_FIELDS = new Set([
  'insurance_code', 'name', 'spec', 'dosage_form', 'unit', 'code', 'status', 'version', 'record_id',
])

/** 检索快照 record_id 集合。 */
export function snapshotRecordIds(records: MasterDataRecord[]): Set<string> {
  return new Set(records.map((r) => r.record_id))
}

/**
 * 构建证据链：越界拒绝 + 值回填 + 字段一致性。
 * 返回 ok=false 表示存在越界引用或被拒收，调用方须转 uncertain。
 */
export function buildEvidenceChain(
  rawEvidence: EvidenceItem[],
  snapshot: MasterDataRecord[],
  candidateId: string,
  options: { now?: () => string } = {},
): EvidenceBuildResult {
  const now = options.now ?? (() => new Date().toISOString())
  const validIds = snapshotRecordIds(snapshot)
  const byId = new Map(snapshot.map((r) => [r.record_id, r]))
  const out_of_bounds: OutOfBoundsEvent[] = []
  const mismatches: EvidenceItem[] = []
  const evidence: EvidenceItem[] = []

  for (const e of rawEvidence) {
    if (!validIds.has(e.record_id)) {
      out_of_bounds.push({ candidate_id: candidateId, record_id: e.record_id, source: e.field || 'model', at: now() })
      continue // 越界证据不进入证据链
    }
    const record = byId.get(e.record_id)!
    const actual = (record as unknown as Record<string, unknown>)[e.field]
    const item: EvidenceItem = { ...e }
    if (typeof actual === 'string' && actual !== e.matched_value) {
      item.evidence_mismatch = true
      item.model_matched_value = e.matched_value
      item.matched_value = actual // 以主数据实际值为准回填
      mismatches.push(item)
    }
    evidence.push(item)
  }

  return { ok: out_of_bounds.length === 0 && evidence.length > 0, evidence, out_of_bounds, mismatches }
}

/** 证据最小完整性：merge 结论至少 1 条且覆盖一个关键字段。 */
export function hasCriticalFieldEvidence(evidence: EvidenceItem[]): boolean {
  const critical = new Set(['insurance_code', 'spec', 'unit'])
  return evidence.some((e) => critical.has(e.field))
}

/** 把越界事件叠加到结论：拒绝出结论并转 uncertain。 */
export function rejectOutOfBounds(
  conclusion: MergeConclusion,
  result: EvidenceBuildResult,
): MergeConclusion {
  if (result.out_of_bounds.length === 0) return conclusion
  return {
    ...conclusion,
    action: 'uncertain',
    uncertain_reason: '模型输出不合法',
    target_code: null,
    confidence: Math.min(conclusion.confidence, 0.5),
    evidence: result.evidence,
    statistics: {
      ...conclusion.statistics,
      out_of_snapshot_refs: result.out_of_bounds.length,
    },
    reason_fallback: `证据引用了 ${result.out_of_bounds.length} 条未检索的记录，已拒绝出结论并记越界事件`,
  }
}
