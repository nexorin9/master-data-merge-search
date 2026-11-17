/**
 * 追问轮越界引用拒绝（Task 37）。
 *
 * 追问是模型最容易被诱导幻觉的场景：用户问「为什么不并到那条呢」，模型可能
 * 顺势引用一条根本没检索过的记录。本闸门是独立的一层：
 *   1) referenced_record_ids / evidence.record_id 必须落在该候选快照集合内，
 *      越界即拒绝、记事件（含越界 id 与来源），答案绝不写进结论或证据链；
 *   2) 答案须带 ≥1 条完整 evidence（record_id + field + 两侧取值），否则只回
 *      「无法给出依据」，绝不编一段理由；
 *   3) 追问只产出补充说明，不得把既有主结论的 action 改写（改结论须重新评估）。
 * 全程纯函数：不改动传入的 conclusion，也不接触任何会话仓库。
 */
import { snapshotRecordIds } from '../engine/evidence'
import { normalizeAction } from '../engine/merge-decision'
import type { Action, EvidenceItem, MasterDataRecord, MergeConclusion } from '../types'

/** 越界事件：带违规 record_id 与其出现来源。 */
export interface OutOfBoundsGuardEvent {
  candidate_id: string
  record_id: string
  source: string
  at: string
}

/** 一次追问答案（模型原始输出 + 调用痕迹）。 */
export interface FollowupAnswer {
  question?: string
  answer: string
  referenced_record_ids?: string[]
  evidence?: EvidenceItem[]
  /** 模型试图给出的 action；追问轮禁止改写主结论。 */
  proposed_action?: Action | string
  /** 模型附带的结论片段；其 action 与既有结论不同即拒绝。 */
  proposed_conclusion?: { action?: Action | string; target_code?: string | null; confidence?: number } | null
  model_call_id?: string | null
}

export interface GuardDeps {
  /** 该候选快照记录集（与 allowed_record_ids 二选一）。 */
  snapshot?: MasterDataRecord[]
  /** 允许的 record_id 集合（与 snapshot 二选一，优先）。 */
  allowed_record_ids?: Iterable<string>
  /** 既有主结论，追问不得改写其 action。 */
  conclusion: MergeConclusion
  now?: () => string
}

/** 校验通过时允许挂到追问轮的内容（补充说明，不改写主结论）。 */
export interface AttachFollowup {
  question: string
  answer: string
  referenced_record_ids: string[]
  evidence: EvidenceItem[]
  rationale: string
  model_call_id: string | null
}

export interface GuardResult {
  ok: boolean
  /** 可读中文原因；拒绝时为明确的拒答提示。 */
  reason: string
  /** 拒绝时恒为空串，绝不编造理由。 */
  rationale: string
  /** 通过时返回可挂接内容；拒绝时恒为 null（答案不入库）。 */
  attach: AttachFollowup | null
  /** 既有结论原样返回（深克隆），拒绝也不改写。 */
  conclusion: MergeConclusion
  /** 去重后的越界 record_id 列表。 */
  offending_record_ids: string[]
  out_of_bounds: OutOfBoundsGuardEvent[]
}

/** 试图改写 action 的确定性模式表（只匹配正向改写，不误伤「不能并入」）。 */
const ACTION_REWRITE_PATTERNS: RegExp[] = [
  /(?:改|修正|变更|重写|推翻)\s*(?:为|成)\s*(?:新建|并入|存疑|create|merge|uncertain)/i,
  /(?:应|应该|应当|建议|须|需|必须)\s*(?:当)?\s*(?:改|判|定|归)\s*(?:为|成)?\s*(?:新建|并入|存疑|create|merge|uncertain)/i,
  /action\s*[=:]\s*(?:create|merge|uncertain)/i,
]

/** 从模型答案里抽出「被改写成」的 action；无改写尝试返回 null。 */
function actionFromText(text: string): Action | null {
  for (const base of ACTION_REWRITE_PATTERNS) {
    // 每次新建全局正则以复位 lastIndex，逐个命中检查否定前缀。
    const pattern = new RegExp(base.source, `${base.flags}g`)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      // 否定前缀（不能改 / 别改为 / 拒绝改为）不算改写尝试。
      const prefix = text.slice(Math.max(0, match.index - 3), match.index)
      if (/[不别勿]|拒绝|无需/.test(prefix)) continue
      const hit = match[0]
      if (/新建|create/i.test(hit)) return 'create'
      if (/并入|merge/i.test(hit)) return 'merge'
      if (/存疑|uncertain/i.test(hit)) return 'uncertain'
      // 只说「结论改为」未带明确动作，也按改写尝试处理。
      return 'uncertain'
    }
  }
  return null
}

/** evidence 最小完整性：record_id + field + 两侧取值齐备。 */
function isCompleteEvidence(item: EvidenceItem): boolean {
  return !!item.record_id
    && !!item.field
    && typeof item.candidate_value === 'string'
    && typeof item.matched_value === 'string'
}

/**
 * 追问答案闸门。deps 提供该候选快照集合与既有结论；所有依赖显式注入，不触网。
 */
export function guardFollowupAnswer(answer: FollowupAnswer, deps: GuardDeps): GuardResult {
  const allowed = new Set(deps.allowed_record_ids ?? snapshotRecordIds(deps.snapshot ?? []))
  const now = deps.now ?? (() => new Date().toISOString())
  const conclusion = structuredClone(deps.conclusion)

  const reject = (reason: string, events: OutOfBoundsGuardEvent[]): GuardResult => ({
    ok: false,
    reason,
    rationale: '',
    attach: null,
    conclusion,
    offending_record_ids: [...new Set(events.map((event) => event.record_id))],
    out_of_bounds: events,
  })

  // 1) 越界引用拒绝：逐个来源记录事件，同一 (record_id, source) 只记一次。
  const offenders: OutOfBoundsGuardEvent[] = []
  const seen = new Set<string>()
  const flag = (recordId: string, source: string): void => {
    const key = `${recordId}|${source}`
    if (seen.has(key)) return
    seen.add(key)
    offenders.push({ candidate_id: deps.conclusion.candidate_id, record_id: recordId, source, at: now() })
  }
  for (const id of answer.referenced_record_ids ?? []) {
    if (!allowed.has(id)) flag(id, 'referenced_record_ids')
  }
  for (const item of answer.evidence ?? []) {
    if (!allowed.has(item.record_id)) flag(item.record_id, `evidence:${item.field || 'model'}`)
  }
  if (offenders.length > 0) {
    return reject('回答引用了未检索的记录，已拒绝', offenders)
  }

  // 2) 证据要求：至少 1 条完整 evidence，否则不编理由。
  const evidence = (answer.evidence ?? []).filter(isCompleteEvidence)
  if (evidence.length === 0) {
    return reject('无法给出依据', [])
  }

  // 3) 追问不得改写主结论的 action（结构化字段 + 确定性文本模式）。
  const proposed: Action[] = []
  if (answer.proposed_action !== undefined) proposed.push(normalizeAction(answer.proposed_action))
  if (answer.proposed_conclusion?.action !== undefined) {
    proposed.push(normalizeAction(answer.proposed_conclusion.action))
  }
  // 只扫描模型答案：追问问题属于用户输入，不应被当作「改写主结论」的断言。
  const textAction = actionFromText(answer.answer)
  if (textAction !== null) proposed.push(textAction)
  if (proposed.some((action) => action !== deps.conclusion.action)) {
    return reject('追问轮不得改写主结论，需改结论请走重新评估', [])
  }

  // 4) 正常答案：作为补充说明挂回追问轮，结论原样不动。
  const attach: AttachFollowup = {
    question: answer.question ?? '',
    answer: answer.answer,
    referenced_record_ids: [...(answer.referenced_record_ids ?? [])],
    evidence,
    rationale: answer.answer,
    model_call_id: answer.model_call_id ?? null,
  }
  return {
    ok: true,
    reason: '已通过越界与证据校验',
    rationale: answer.answer,
    attach,
    conclusion,
    offending_record_ids: [],
    out_of_bounds: [],
  }
}
