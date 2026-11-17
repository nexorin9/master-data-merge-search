/**
 * 停用码与版本状态处理（Task 23）。
 *
 * 院内主数据里 status=停用 的记录不能作为自动并入目标（并进去等于把废码
 * 复活）；version 与候选提交时的基准版本冲突时必须拒答并说明冲突。
 */
import type { CandidateRecord, MasterDataRecord, MergeConclusion } from '../types'

/** 停用码排除：返回被排除的停用记录（仍进证据与冲突展示，不进并入目标集合）。 */
export function excludeDisabled(records: MasterDataRecord[]): {
  eligible: MasterDataRecord[]
  excluded: Array<{ record_id: string; code: string; reason: string }>
} {
  const eligible: MasterDataRecord[] = []
  const excluded: Array<{ record_id: string; code: string; reason: string }> = []
  for (const r of records) {
    if (r.status === '停用') {
      excluded.push({ record_id: r.record_id, code: r.code, reason: '命中记录已停用，不作自动并入目标' })
    } else {
      eligible.push(r)
    }
  }
  return { eligible, excluded }
}

/** 全停用命中场景：全部为停用记录 → 不产出 merge 目标。 */
export function allDisabled(records: MasterDataRecord[]): boolean {
  return records.length > 0 && records.every((r) => r.status === '停用')
}

/** 版本冲突判定。 */
export function hasVersionConflict(
  candidate: CandidateRecord,
  record: MasterDataRecord,
): boolean {
  return !!candidate.version && candidate.version !== record.version
}

/** 版本冲突说明。 */
export function versionConflictReason(candidate: CandidateRecord, record: MasterDataRecord): string {
  return `候选基准版本 ${candidate.version ?? '未携带'} 与命中记录版本 ${record.version} 不一致`
}

/**
 * 把停用/版本状态裁决叠加到一条 unique 结论上。
 * 返回 null 表示无需改动，返回结论对象表示需转 uncertain。
 */
export function applyStatusGate(
  conclusion: MergeConclusion,
  candidate: CandidateRecord,
  matched: MasterDataRecord[],
): MergeConclusion | null {
  if (conclusion.action !== 'merge') return null
  const { eligible, excluded } = excludeDisabled(matched)
  // 全停用：merge 目标被排除。
  if (eligible.length === 0 && excluded.length > 0) {
    return {
      ...conclusion,
      action: 'uncertain',
      uncertain_reason: '命中记录均已停用',
      target_code: null,
      excluded_status: '停用',
      excluded_records: excluded,
      reason_fallback: '命中记录均已停用，不产出自动并入目标',
    }
  }
  const target = eligible.find((r) => r.code === conclusion.target_code) ?? eligible[0]
  if (target && hasVersionConflict(candidate, target)) {
    return {
      ...conclusion,
      action: 'uncertain',
      uncertain_reason: '版本冲突',
      target_code: null,
      reason_fallback: versionConflictReason(candidate, target),
    }
  }
  if (excluded.length > 0) {
    return { ...conclusion, excluded_status: '停用', excluded_records: excluded }
  }
  return null
}
