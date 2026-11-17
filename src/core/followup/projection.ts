/**
 * 追问会话投影（Task 35）。
 *
 * 投影出真正送给模型的会话视图：已有结论、证据链、追问历史。跨候选泄漏在这里
 * 被结构性切断——视图**只**从传入的那一份会话自身字段构建，从不查仓库、从不
 * 读第二份会话；结论只取白名单标量字段（不带 rationale / ambiguous_records 等
 * 可能夹带他候选内容的自由字段）；证据与引用按本会话快照 record_id 白名单过滤；
 * 自由文本里的快照外记录 id / 他候选 id 也被抹掉。
 */
import { buildEvidenceChain, snapshotRecordIds } from '../engine/evidence'
import type { Action, Domain, EvidenceItem, UncertainReason } from '../types'
import type { StoredFollowupSession } from './session-store'

export interface ProjectionDeps {
  /** 仅供证据链构建内部事件使用；不把越界 record_id 带进模型视图。 */
  now?: () => string
}

/** 结论视图：仅白名单字段，绝不带其他候选的结论或理由文本。 */
export interface ProjectedConclusion {
  candidate_id: string
  domain: Domain
  action: Action
  target_code: string | null
  confidence: number
  uncertain_reason: UncertainReason
  /** 与 evidence_chain 同一条链，方便消费方从结论直接取证据。 */
  evidence: EvidenceItem[]
}

/** 单轮追问视图。 */
export interface ProjectedTurn {
  question: string
  answer: string
  referenced_record_ids: string[]
  evidence: EvidenceItem[]
  model_call_id: string | null
  asked_action: Action
  refreshed: boolean
  at: string
  snapshot_version: string
}

export interface FollowupProjection {
  candidate_id: string
  snapshot_version: string
  /** 本候选快照允许的 record_id 白名单（有序）。 */
  allowed_record_ids: string[]
  conclusion: ProjectedConclusion
  evidence_chain: EvidenceItem[]
  /** 构建证据链时因越界被丢弃的条数；只报数量，不带越界 id。 */
  dropped_evidence_count: number
  history: ProjectedTurn[]
}

/**
 * 抹去自由文本里不属于本候选快照的记录 id 与其它候选 id。
 * 只匹配形如 MD-xxxx / C-xxxx 的 id 位，中文正文原样保留。
 */
function sanitizeText(text: string, allowed: Set<string>, candidateId: string): string {
  return text
    .replace(/\bMD-[A-Za-z0-9_-]+\b/g, (id) => (allowed.has(id) ? id : '[未检索记录]'))
    .replace(/\bC-[A-Za-z0-9_-]+\b/g, (id) => (id === candidateId ? id : '[其他候选]'))
}

/** 清理证据条目里的自由文本值（record_id 已按白名单校验，不再重复）。 */
function sanitizeEvidence(item: EvidenceItem, allowed: Set<string>, candidateId: string): EvidenceItem {
  const out: EvidenceItem = { ...item }
  out.candidate_value = sanitizeText(out.candidate_value, allowed, candidateId)
  out.matched_value = sanitizeText(out.matched_value, allowed, candidateId)
  if (out.model_matched_value !== undefined) {
    out.model_matched_value = sanitizeText(out.model_matched_value, allowed, candidateId)
  }
  return out
}

/**
 * 构建模型视图。结构性隔离：只读 session，不接触其它会话。
 */
export function projectSession(
  session: StoredFollowupSession,
  deps: ProjectionDeps = {},
): FollowupProjection {
  const clock = { now: deps.now ?? (() => new Date().toISOString()) }
  const allowed = snapshotRecordIds(session.snapshot_records)
  const candidateId = session.candidate_id

  const chainResult = buildEvidenceChain(
    session.conclusion.evidence,
    session.snapshot_records,
    candidateId,
    clock,
  )
  const evidence_chain = chainResult.evidence.map((e) => sanitizeEvidence(e, allowed, candidateId))

  const conclusion: ProjectedConclusion = {
    candidate_id: candidateId,
    domain: session.conclusion.domain,
    action: session.conclusion.action,
    target_code: session.conclusion.target_code,
    confidence: session.conclusion.confidence,
    uncertain_reason: session.conclusion.uncertain_reason,
    evidence: evidence_chain,
  }

  const history: ProjectedTurn[] = session.turns.map((turn) => {
    const turnChain = buildEvidenceChain(turn.evidence, session.snapshot_records, candidateId, clock)
    return {
      question: sanitizeText(turn.question, allowed, candidateId),
      answer: sanitizeText(turn.answer, allowed, candidateId),
      referenced_record_ids: turn.referenced_record_ids.filter((id) => allowed.has(id)),
      evidence: turnChain.evidence.map((e) => sanitizeEvidence(e, allowed, candidateId)),
      model_call_id: turn.model_call_id,
      asked_action: turn.asked_action,
      refreshed: turn.refreshed,
      at: turn.at,
      snapshot_version: turn.snapshot_version,
    }
  })

  return {
    candidate_id: candidateId,
    snapshot_version: session.snapshot_version,
    allowed_record_ids: [...allowed],
    conclusion,
    evidence_chain,
    dropped_evidence_count: chainResult.out_of_bounds.length,
    history,
  }
}
