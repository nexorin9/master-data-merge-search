/**
 * 写回幂等：实质动作哈希、幂等键与重放账本（Task 32 / 33）。
 *
 * 设计约束：
 *   1. actionHash 只覆盖「实质」字段（action + target_code + 顺序无关的规范化证据集合），
 *      与 rationale / confidence / 证据顺序无关——这样措辞微调不会误生成新建议，
 *      而目标码或证据值变化一定会生成新建议（supersede 的前提）。
 *   2. 幂等键组合只有一处定义：sha256(candidate_id｜actionHash)，分隔符与
 *      mdm-client.computeIdempotencyKey 完全一致（同构），故线上可无痛接收显式键。
 *   3. 重放账本记录 (candidate_id, actionHash) → 既有建议 + 回执；命中即直接返回，
 *      不产生 sink 调用、不新增审计、不推进候选状态，只累加 skipped 计数。
 *   4. 全部依赖注入（时钟 / 账本），绝不触网、无模块级共享可变状态。
 */
import { createHash } from 'node:crypto'
import { computeIdempotencyKey, type MergeSuggestionBody } from '../retrieval/mdm-client'
import type { EvidenceItem, MergeConclusion, WriteReceipt } from '../types'

/** 参与 actionHash 的证据四要素（与线上 wire 证据逐字段对齐，剔除规则层附加位）。 */
export interface NormalizedEvidence {
  record_id: string
  field: string
  candidate_value: string
  matched_value: string
}

/** actionHash 输入：结论或建议 body 均可（二者都具备 action / target_code / evidence）。 */
export type ActionHashSource =
  | Pick<MergeConclusion, 'action' | 'target_code' | 'evidence'>
  | MergeSuggestionBody

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stableTuple(item: NormalizedEvidence): string {
  return JSON.stringify([item.record_id, item.field, item.candidate_value, item.matched_value])
}

/** 规范化证据为顺序无关、去重的「字段-值集合」。 */
export function normalizeEvidenceSet(evidence: EvidenceItem[]): NormalizedEvidence[] {
  const seen = new Set<string>()
  const items: NormalizedEvidence[] = []
  for (const raw of evidence ?? []) {
    const item: NormalizedEvidence = {
      record_id: raw.record_id,
      field: raw.field,
      candidate_value: raw.candidate_value,
      matched_value: raw.matched_value,
    }
    const token = stableTuple(item)
    if (seen.has(token)) continue
    seen.add(token)
    items.push(item)
  }
  const keyed = items.map((item) => ({ item, token: stableTuple(item) }))
  keyed.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
  return keyed.map(({ item }) => item)
}

/** 实质载荷：action + target_code + 顺序无关的规范化证据集合。 */
export interface ActionPayload {
  action: ActionHashSource['action']
  target_code: string | null
  evidence: NormalizedEvidence[]
}

/** 提取实质载荷（唯一定义）。 */
export function actionPayload(source: ActionHashSource): ActionPayload {
  return {
    action: source.action,
    target_code: source.target_code ?? null,
    evidence: normalizeEvidenceSet(source.evidence),
  }
}

/** 唯一的 actionHash 定义：sha256(规范实质载荷)。 */
export function actionHash(source: ActionHashSource): string {
  return sha256(JSON.stringify(actionPayload(source)))
}

/** 唯一的幂等键组合定义：sha256(candidate_id｜actionHash)。 */
export function composeIdempotencyKey(candidateId: string, hash: string): string {
  return sha256(`${candidateId}｜${hash}`)
}

/** 从结论 / 建议直接得到写回幂等键（规范入口）。 */
export function idempotencyKey(candidateId: string, source: ActionHashSource): string {
  return composeIdempotencyKey(candidateId, actionHash(source))
}

/**
 * 复用 mdm-client 的 wire 键口径：当调用方只有完整 MergeSuggestionBody、且不向
 * sink 传显式键时，与线上客户端保持一致。写回簇始终向 sink 传 composeIdempotencyKey
 * 产出的显式键，因此不会与本函数形成两套并行键。
 */
export function wireIdempotencyKey(candidateId: string, body: MergeSuggestionBody): string {
  return computeIdempotencyKey(candidateId, body)
}

/** 把结论收敛为 1:1 对齐 MergeSuggestionBody 的写回正文（保留证据原序，剔除规则层附加位）。 */
export function conclusionToBody(conclusion: MergeConclusion): MergeSuggestionBody {
  return {
    action: conclusion.action,
    target_code: conclusion.target_code,
    rationale: conclusion.rationale,
    evidence: (conclusion.evidence ?? []).map((e) => ({
      record_id: e.record_id,
      field: e.field,
      candidate_value: e.candidate_value,
      matched_value: e.matched_value,
    })),
    confidence: conclusion.confidence,
  }
}

// ── 重放账本 ──

export interface ReplayLedgerPorts {
  now?: () => string
}

/** 账本记录：键为 (candidate_id, actionHash)，值为既有建议与回执。 */
export interface LedgerEntry {
  candidate_id: string
  action_hash: string
  idempotency_key: string
  suggestion: MergeSuggestionBody
  receipt: WriteReceipt
  recorded_at: string
  supersedes?: string
}

/** 提交类别：replay（同哈希，直接跳过）/ fresh（新哈希）/ supersede（撤销后重提交）。 */
export type SubmissionKind = 'replay' | 'fresh' | 'supersede'

export interface ReplayLookup {
  kind: 'hit' | 'miss'
  entry: LedgerEntry | null
}

export interface ReplayLedger {
  lookup(candidateId: string, hash: string): ReplayLookup
  record(input: {
    candidateId: string
    body: MergeSuggestionBody
    receipt: WriteReceipt
    supersedes?: string
  }): LedgerEntry
  /** 记一次 replay 命中：只累加 skipped 计数，绝不产生其它副作用。 */
  noteReplay(): void
  /** 仅新写入调用；replay 不推进候选状态。 */
  advanceState(candidateId: string): number
  stateVersionOf(candidateId: string): number
  readonly skippedCount: number
  readonly entries: readonly LedgerEntry[]
}

export function createReplayLedger(ports: ReplayLedgerPorts = {}): ReplayLedger {
  const now = ports.now ?? (() => new Date().toISOString())
  const byKey = new Map<string, LedgerEntry>()
  const stateVersion = new Map<string, number>()
  const all: LedgerEntry[] = []
  let skippedCount = 0
  const slot = (candidateId: string, hash: string): string => `${candidateId}\u0000${hash}`

  return {
    lookup(candidateId, hash) {
      const entry = byKey.get(slot(candidateId, hash))
      return entry ? { kind: 'hit', entry: structuredClone(entry) } : { kind: 'miss', entry: null }
    },
    record({ candidateId, body, receipt, supersedes }) {
      const hash = actionHash(body)
      const entry: LedgerEntry = {
        candidate_id: candidateId,
        action_hash: hash,
        idempotency_key: composeIdempotencyKey(candidateId, hash),
        suggestion: structuredClone(body),
        receipt: structuredClone(receipt),
        recorded_at: now(),
        ...(supersedes !== undefined ? { supersedes } : {}),
      }
      byKey.set(slot(candidateId, hash), entry)
      all.push(entry)
      return structuredClone(entry)
    },
    noteReplay() {
      skippedCount += 1
    },
    advanceState(candidateId) {
      const next = (stateVersion.get(candidateId) ?? 0) + 1
      stateVersion.set(candidateId, next)
      return next
    },
    stateVersionOf(candidateId) {
      return stateVersion.get(candidateId) ?? 0
    },
    get skippedCount() {
      return skippedCount
    },
    get entries() {
      return all.map((entry) => structuredClone(entry))
    },
  }
}

/** 判定提交类别：命中账本即 replay；否则带 supersedes 视为撤销重提交。 */
export function classifySubmission(
  ledger: ReplayLedger,
  candidateId: string,
  hash: string,
  supersedes?: string,
): SubmissionKind {
  if (ledger.lookup(candidateId, hash).kind === 'hit') return 'replay'
  return supersedes !== undefined && supersedes !== '' ? 'supersede' : 'fresh'
}

/**
 * 「无 modelCallCount 字段」的合约：只在缓存未命中时调用 evaluate（等价于一次模型 /
 * 评估调用），命中时直接返回既有建议。测试通过断言 evaluate 未被调用来验证 replay。
 */
export interface ResolveInput<S> {
  candidateId: string
  /** 已存结论的 actionHash；replay 判定只依赖它，不需要先调用模型。 */
  hash: string
  /** 仅在未命中时调用一次，产出本次建议。 */
  evaluate: () => S
  supersedes?: string
}

export interface ResolveResult<S> {
  kind: SubmissionKind
  suggestion: S
  fromCache: boolean
}

export function resolveWithReplayLedger<S extends MergeSuggestionBody>(
  ledger: ReplayLedger,
  input: ResolveInput<S>,
): ResolveResult<S> {
  const hit = ledger.lookup(input.candidateId, input.hash)
  if (hit.kind === 'hit' && hit.entry) {
    ledger.noteReplay()
    return {
      kind: 'replay',
      suggestion: structuredClone(hit.entry.suggestion) as S,
      fromCache: true,
    }
  }
  const suggestion = input.evaluate()
  return {
    kind: input.supersedes !== undefined && input.supersedes !== '' ? 'supersede' : 'fresh',
    suggestion,
    fromCache: false,
  }
}
