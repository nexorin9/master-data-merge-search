/**
 * 追问会话压缩（Task 36）。
 *
 * 轮次超过 CONFIG_FOLLOWUP_COMPACTION_TURNS 才触发压缩（阈值触发，无随机性）。
 * 结论（action/target_code/confidence）、证据链 evidence[]、uncertain_reason、
 * 关键字段对照摘要一律保留；闲聊、重复提问、与本候选无关的措辞一律丢弃。
 * 丢弃判定用确定性模式表 + 归一化问句比对。报告字段取「累计」口径，使二次
 * 压缩（对已压缩会话再压一次）得到完全相同的结果——幂等且可观测。
 */
import { CONFIG_FOLLOWUP_COMPACTION_TURNS, FIELD_DIFF_ORDER } from '../constants'
import { snapshotRecordIds } from '../engine/evidence'
import type { MergeConclusion } from '../types'
import type { StoredFollowupSession, TrackedFollowupTurn } from './session-store'

export interface CompactionOptions {
  /** 触发压缩的轮次阈值，默认 CONFIG_FOLLOWUP_COMPACTION_TURNS。 */
  threshold?: number
  /** 压缩后最多保留轮次，默认与 threshold 相同。 */
  maxTurns?: number
}

export interface CompactionReport {
  /** 会话累计丢弃条目数（= 原 discarded_count + 本次丢弃）。 */
  discarded_count: number
  /** 累计丢弃轮次，与 discarded_count 同口径，保证二次压缩报告一致。 */
  discarded_turns: number
  /** 保留轮次数。 */
  kept: number
  /** 累计压缩比 = discarded_count / (kept + discarded_count)，0 表示未压缩。 */
  ratio: number
}

/** 关键字段对照摘要条目。 */
export interface KeyFieldDiffEntry {
  field: string
  candidate_value: string | null
  matched_value: string | null
  conflict: boolean
}

export interface KeyFieldSummary {
  entries: KeyFieldDiffEntry[]
  conflict_fields: string[]
}

export interface CompactedFollowupSession extends StoredFollowupSession {
  /** 最近一次压缩的可观测报告；未触发压缩时丢弃数为 0。 */
  compaction: CompactionReport
  /** 关键字段对照摘要（取自结论 field_diffs，缺省时由证据链派生）。 */
  key_field_summary: KeyFieldSummary
}

/** 闲聊模式：整条问句短且命中这些词才丢，不误伤正常追问。 */
const CHITCHAT_PATTERNS: RegExp[] = [
  /^(你好|您好|hi|hello|在吗|在么|嗨)[!！。.,，~～]*$/i,
  /^(谢谢|感谢|多谢|辛苦了|好的|收到|明白|了解|嗯+|哦+|对)[!！。.,，~～]*$/i,
  /^(没事|没关系|不客气|拜拜|再见|稍等|等一下|我先看看)[!！。.,，~～]*$/i,
  /^(请问|那个|额|呃|啊)[!！。.,，~～]*$/i,
]

/** 与当前候选无关的措辞（确定性模式表）。 */
const UNRELATED_PATTERNS: RegExp[] = [
  /顺便问(一下|下)?/, /另一个候选/, /其他候选/, /别的候选/, /换个话题/, /题外话/, /跟这个无关/,
]

/** 归一化问句：去空白、去标点、转小写，用于重复提问比对。 */
function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：,.!?;:'"“”‘’()（）\-—_]/g, '')
}

/** 闲聊：整条问句命中确定性模式表。 */
function isChitChat(question: string): boolean {
  const q = question.trim()
  return CHITCHAT_PATTERNS.some((pattern) => pattern.test(q))
}

/**
 * 与本候选无关：命中无关措辞表，或文本里出现非本会话快照的记录 id /
 * 非本会话 candidate_id。两者都是确定性比对，不含随机性。
 */
function isUnrelated(turn: TrackedFollowupTurn, allowed: Set<string>, candidateId: string): boolean {
  const text = `${turn.question}\n${turn.answer}`
  if (UNRELATED_PATTERNS.some((pattern) => pattern.test(text))) return true
  const foreignRecord = text.match(/\bMD-[A-Za-z0-9_-]+\b/g) ?? []
  if (foreignRecord.some((id) => !allowed.has(id))) return true
  const foreignCandidate = text.match(/\bC-[A-Za-z0-9_-]+\b/g) ?? []
  if (foreignCandidate.some((id) => id !== candidateId)) return true
  const refs = [
    ...turn.referenced_record_ids,
    ...turn.evidence.map((e) => e.record_id),
  ]
  return refs.some((id) => !allowed.has(id))
}

/** 从结论派生关键字段摘要：优先 field_diffs，缺省时退回证据链。 */
function deriveKeyFieldSummary(conclusion: MergeConclusion): KeyFieldSummary {
  const source = conclusion.field_diffs?.diffs
  const entries: KeyFieldDiffEntry[] = (source && source.length > 0 ? source : []).map((d) => ({
    field: d.field,
    candidate_value: d.candidate_value,
    matched_value: d.matched_value,
    conflict: d.kind === 'conflict',
  }))
  if (entries.length === 0) {
    for (const e of conclusion.evidence) {
      entries.push({
        field: e.field,
        candidate_value: e.candidate_value,
        matched_value: e.matched_value,
        conflict: e.evidence_mismatch === true || e.conflict_hit === true,
      })
    }
  }
  // 关键字段固定优先，其余保持原顺序（Array#sort 稳定）。
  const order = new Map<string, number>(FIELD_DIFF_ORDER.map((field, index) => [field, index]))
  entries.sort((a, b) => (order.get(a.field) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.field) ?? Number.MAX_SAFE_INTEGER))
  return { entries, conflict_fields: entries.filter((e) => e.conflict).map((e) => e.field) }
}

/**
 * 压缩会话。结论（含 evidence[] / uncertain_reason / field_diffs）原样深克隆保留，
 * 只替换 turns、discarded_count 并附报告与关键字段摘要。
 */
export function compactSession(
  session: StoredFollowupSession,
  options: CompactionOptions = {},
): CompactedFollowupSession {
  const threshold = Math.max(1, options.threshold ?? CONFIG_FOLLOWUP_COMPACTION_TURNS)
  const maxTurns = Math.max(1, options.maxTurns ?? threshold)
  const out = structuredClone(session) as CompactedFollowupSession
  // 关键字段摘要恒保留，与是否触发压缩无关（结论自身不被改写）。
  out.key_field_summary = deriveKeyFieldSummary(session.conclusion)

  let droppedThisRun = 0
  let keptTurns = out.turns
  const totalBefore = out.turns.length
  if (totalBefore > threshold) {
    const allowed = snapshotRecordIds(out.snapshot_records)
    const seen = new Set<string>()
    const kept: TrackedFollowupTurn[] = []
    for (const turn of out.turns) {
      const normalized = normalizeQuestion(turn.question)
      const duplicate = seen.has(normalized)
      if (duplicate) {
        droppedThisRun += 1
        continue
      }
      seen.add(normalized)
      if (isChitChat(turn.question) || isUnrelated(turn, allowed, out.candidate_id)) {
        droppedThisRun += 1
        continue
      }
      kept.push(turn)
    }
    // 仍超预算时保留最近的 maxTurns 轮（较早的追问整轮丢弃，计数不变口径）。
    if (kept.length > maxTurns) {
      droppedThisRun += kept.length - maxTurns
      keptTurns = kept.slice(kept.length - maxTurns)
    } else {
      keptTurns = kept
    }
    out.turns = keptTurns
  }

  const discardedCount = session.discarded_count + droppedThisRun
  out.discarded_count = discardedCount
  const kept = keptTurns.length
  const total = kept + discardedCount
  const report: CompactionReport = {
    discarded_count: discardedCount,
    discarded_turns: discardedCount,
    kept,
    ratio: total === 0 ? 0 : discardedCount / total,
  }
  out.compaction = report
  // 不改写 updated_at：压缩是视图变换，不产生新的业务更新时间（保证幂等）。
  return out
}
