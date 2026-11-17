/**
 * 多义命中判定与拒答（Task 21）。
 *
 * 同一复合键命中 >1 条主数据记录时必须**拒绝出结论**并转存疑，把全部命中
 * 记录 id 与冲突字段摊开给专员，绝不取第一条。这是与 Excel 模糊比对、
 * RAG 类工具最本质的差别。
 */
import type { CandidateRecord, MasterDataRecord } from '../types'

/** 关键字段（用于定位冲突）。 */
const CONFLICT_FIELDS = ['spec', 'dosage_form', 'unit', 'insurance_code'] as const

export interface ConflictField {
  field: string
  candidate_value: string
  matched_value: string
  reason: string
}

/** 单条命中记录 vs 候选的字段对照。 */
export interface AmbiguousRecordView {
  record_id: string
  code: string
  name: string
  status: string
  version: string
  conflicts: ConflictField[]
}

/** 定位某条命中记录与候选的不一致关键字段。 */
export function conflictsFor(candidate: CandidateRecord, record: MasterDataRecord): ConflictField[] {
  const conflicts: ConflictField[] = []
  for (const field of CONFLICT_FIELDS) {
    const cv = (candidate[field] ?? '').trim()
    const mv = (record[field] ?? '').trim()
    if (cv !== mv) {
      conflicts.push({
        field,
        candidate_value: cv,
        matched_value: mv,
        reason: `候选「${cv || '空'}」与命中记录「${mv || '空'}」不一致`,
      })
    }
  }
  return conflicts
}

/**
 * 多义判定：命中数 >1 即 ambiguous，返回全部命中记录视图与逐条字段对照。
 * 命中数 =1 返回 null（不触发多义）。
 */
export function detectAmbiguity(
  candidate: CandidateRecord,
  records: MasterDataRecord[],
): { ambiguous: true; records: AmbiguousRecordView[] } | { ambiguous: false } {
  if (records.length <= 1) return { ambiguous: false }
  return {
    ambiguous: true,
    records: records.map((r) => ({
      record_id: r.record_id,
      code: r.code,
      name: r.name,
      status: r.status,
      version: r.version,
      conflicts: conflictsFor(candidate, r),
    })),
  }
}

/** 多义结论的 evidence[]：每条命中记录一条，标记 conflict_hit=true。 */
export function ambiguityEvidence(records: MasterDataRecord[]) {
  return records.map((r) => ({
    record_id: r.record_id,
    field: 'record_id',
    candidate_value: '多义命中',
    matched_value: `${r.code}（${r.name}）`,
    conflict_hit: true,
  }))
}
