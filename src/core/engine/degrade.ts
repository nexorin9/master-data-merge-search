/**
 * 模型不可达降级路径（Task 33）。
 *
 * 模型不可达/超时/结构化校验失败时，走确定性排序路径（精确医保码 → 规格单位
 * 归一后精确 → 拼音首字母 → 字面相似）产出候选排序；降级结论强制
 * action=uncertain 且 uncertain_reason=模型不可用，带 degraded=true 与
 * degraded_reason，**绝不写回、绝不推进候选状态**。降级可观测：记结构化事件。
 */
import { CONFIG_MISSING_FIELD_CAP } from '../constants'
import type {
  CandidateRecord, MasterDataRecord, MergeConclusion, EvidenceItem,
} from '../types'

export type DegradeReason = '模型不可达' | '超时' | 'schema 校验失败'

/** 确定性排序层：层级 1–4，越小越优先。 */
export function deterministicRank(candidate: CandidateRecord, record: MasterDataRecord): {
  level: 1 | 2 | 3 | 4
  score: number
  reason: string
} {
  // 1) 医保码精确
  if (candidate.insurance_code && record.insurance_code === candidate.insurance_code) {
    return { level: 1, score: 0.95, reason: '医保码精确命中' }
  }
  // 2) 规格单位归一后精确（名称也接近才给高层级；这里用同名 + 同规格）
  if (candidate.name === record.name && candidate.spec && record.spec) {
    // 用 spec 的结构化等价（避免循环依赖，做轻量宽度归一比较）
    const norm = (s: string) => s.replace(/[×xX／/]/g, '*').replace(/\s+/g, '').toLowerCase()
    if (norm(candidate.spec) === norm(record.spec)) {
      return { level: 2, score: 0.8, reason: '规格单位归一后精确' }
    }
  }
  // 3) 拼音首字母（示例：按名称首字粗排，避免引入 normalize 循环依赖）
  if (candidate.name && record.name && candidate.name[0] === record.name[0]) {
    return { level: 3, score: 0.5, reason: '首字母/同字命中' }
  }
  // 4) 字面相似（共同字符占比）
  const cs = new Set([...candidate.name])
  const rs = new Set([...record.name])
  const common = [...cs].filter((c) => rs.has(c)).length
  const score = common / Math.max(1, Math.max(cs.size, rs.size))
  return { level: 4, score: score * 0.4, reason: '字面相似' }
}

export interface DegradeRanking {
  record: MasterDataRecord
  level: number
  score: number
  reason: string
}

/** 降级排序：按层级升序、同层按分数降序、同分按 record_id 稳定排序。 */
export function deterministicRanking(
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
): DegradeRanking[] {
  return pool
    .filter((r) => r.domain === candidate.domain)
    .map((record) => ({ record, ...deterministicRank(candidate, record) }))
    .sort((a, b) => a.level - b.level || b.score - a.score || a.record.record_id.localeCompare(b.record.record_id))
}

/** 降级事件（可观测、可按批统计降级率）。 */
export interface DegradeEvent {
  candidate_id: string
  reason: DegradeReason
  retry_count: number
  latency_ms: number
  at: string
}

/** 构造降级结论：强制 uncertain + degraded，写回开关恒关闭。 */
export function makeDegradeConclusion(
  candidate: CandidateRecord,
  pool: MasterDataRecord[],
  reason: DegradeReason,
  options: { retries?: number; now?: () => string } = {},
): { conclusion: MergeConclusion; ranking: DegradeRanking[]; event: DegradeEvent } {
  const ranking = deterministicRanking(candidate, pool)
  const top = ranking[0]
  const evidence: EvidenceItem[] = top
    ? [{
      record_id: top.record.record_id,
      field: 'insurance_code',
      candidate_value: candidate.insurance_code ?? candidate.name,
      matched_value: top.record.insurance_code ?? top.record.name,
    }]
    : []
  const now = options.now ?? (() => new Date().toISOString())
  // 降级置信度封顶：待人工结论不得呈现决策级高置信度（否则界面会把
  // 「仅规则排序、未过模型」误读为高把握）。真实排序分仍保留在 ranking[]。
  const rawScore = top ? top.score : 0
  const capped = rawScore > CONFIG_MISSING_FIELD_CAP
  const conclusion: MergeConclusion = {
    candidate_id: candidate.candidate_id,
    domain: candidate.domain,
    action: 'uncertain',
    target_code: null,
    confidence: capped ? CONFIG_MISSING_FIELD_CAP : rawScore,
    rationale: '',
    evidence,
    uncertain_reason: '模型不可用',
    missing_fields: [],
    degraded: true,
    degraded_reason: reason,
    source: 'degrade',
    retrieved_record_ids: ranking.map((r) => r.record.record_id),
    capped_from: capped ? rawScore : undefined,
    capped_by: capped ? '模型不可达降级，仅规则排序不作决策级置信度' : undefined,
    reason_fallback: '模型不可用，当前仅按规则排序，全部结论待人工；不可写回',
  }
  const event: DegradeEvent = {
    candidate_id: candidate.candidate_id,
    reason,
    retry_count: options.retries ?? 0,
    latency_ms: 0,
    at: now(),
  }
  return { conclusion, ranking, event }
}

/** 降级结论的写回闸门：恒拒绝。 */
export function rejectWritebackIfDegraded(conclusion: MergeConclusion): {
  accepted: boolean
  reason?: string
} {
  if (conclusion.degraded) {
    return { accepted: false, reason: '降级模式结论不可写回，须人工指定目标后重新评估' }
  }
  return { accepted: true }
}

/** 降级率统计（按批）。 */
export function degradeRate(events: DegradeEvent[], total: number): number {
  return total === 0 ? 0 : events.length / total
}
