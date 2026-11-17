/**
 * 只增不改审计链（Task 36）。
 *
 * 每条记录含全部 AuditEntry 字段。seq 自 1 连续递增；prev_hash 取上一条的
 * hash，创世条目取 64 个 0；hash = sha256(prev_hash + canonicalJson(不含 hash
 * 的整条载荷))。链上只提供 append / revoke，绝不提供 update / delete / splice
 * 等改写口：任何显式复用既有 seq（= 试图覆写）或跳号的写入都被拒绝，并记入
 * violations 越权事件。
 *
 * revoke(targetHash) 不是原地改状态，而是「追加一条带 supersedes=targetHash
 * 的新记录」。旧记录原封不动留在链上且哈希不变；status 只由派生视图 view()/
 * query() 依据 supersedes 链接现场推导（revoked / active），不写回存储对象。
 *
 * verify() 重算整条哈希链：任一中间条目被篡改（载荷或链接）都会在首个断点
 * 处被检出，并返回 brokenAt 下标与 brokenSeq 序号。
 */
import { createHash } from 'node:crypto'
import type { Action, AuditEntry, EvidenceItem, WriteReceipt } from '../types'

/** 创世 prev_hash：64 个 0。 */
export const GENESIS_HASH = '0'.repeat(64)

/** 稳定序列化：对象键递归排序、跳过 undefined，数组保序，undefined 元素按 null。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** sha256 摘要（十六进制）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 取「不含 hash」的整条载荷，用于定哈希与重算。 */
function entryBody(entry: AuditEntry): Omit<AuditEntry, 'hash'> {
  const { hash: _hash, ...body } = entry
  return body
}

/** 由 prev_hash 与整条载荷重算条目哈希（导出供测试独立校验）。 */
export function computeEntryHash(prevHash: string, entry: AuditEntry): string {
  return sha256(prevHash + canonicalJson(entryBody(entry)))
}

/** 越权/拒绝事件种类。 */
export type AuditViolationKind = 'duplicate_seq' | 'overwrite_attempt' | 'out_of_order_seq'

/** 只增不改链记录的越权事件。 */
export interface AuditViolation {
  kind: AuditViolationKind
  attempted_seq: number
  expected_seq: number
  attempted_hash: string | null
  at: string
  reason: string
}

/** append 出口：成功带条目，被拒带越权事件。 */
export type AppendResult =
  | { ok: true; entry: AuditEntry }
  | { ok: false; violation: AuditViolation; reason: string }

/** 写入校验结果。 */
export interface VerifyResult {
  ok: boolean
  brokenAt?: number
  brokenSeq?: number
  reason?: string
}

/** 追加输入：除 seq/prev_hash/hash/status 外的全部审计字段，均可缺省取默认值。 */
export interface AppendInput {
  candidate_id: string
  action: Action
  target_code?: string | null
  evidence?: EvidenceItem[]
  model_call_id?: string | null
  prompt_hash?: string
  retrieved_record_ids?: string[]
  decided_at?: string
  confirmed_by?: string
  writeback_receipt?: WriteReceipt | null
  batch_id?: string
  confidence?: number
  /** 显式序号：仅当等于下一序号才接受；复用/跳号按越权拒绝。 */
  seq?: number
  /** 覆盖注入时钟（用于确定性测试）。 */
  ts?: string
}

/** 撤销选项。 */
export interface RevokeOptions {
  confirmedBy?: string
  evidence?: EvidenceItem[]
  batchId?: string
  ts?: string
  now?: () => string
}

/** 查询过滤（可组合）；status 为派生状态过滤。 */
export interface AuditQuery {
  candidate_id?: string
  action?: Action
  confirmed_by?: string
  batch_id?: string
  status?: 'active' | 'revoked'
  from?: string
  to?: string
  limit?: number
  offset?: number
}

/** 链配置：注入时钟与默认确认人。 */
export interface AuditChainOptions {
  now?: () => string
  confirmedBy?: string
  genesisHash?: string
}

/** 内部完整写入规格（append 与 revoke 共用）。 */
interface EntrySpec {
  candidate_id: string
  action: Action
  target_code: string | null
  evidence: EvidenceItem[]
  model_call_id: string | null
  prompt_hash: string
  retrieved_record_ids: string[]
  decided_at?: string
  confirmed_by: string
  writeback_receipt: WriteReceipt | null
  supersedes?: string
  batch_id?: string
  confidence?: number
  explicitSeq?: number
  explicitTs?: string
}

/** 只增不改审计链实例。 */
export interface AuditChain {
  readonly length: number
  readonly violations: AuditViolation[]
  readonly violationCount: number
  append(input: AppendInput): AppendResult
  revoke(targetHash: string, options?: RevokeOptions): AuditEntry
  verify(entries?: readonly AuditEntry[]): VerifyResult
  /** 存储快照深拷贝（权威链，供 verify/重载）；不做派生状态改写。 */
  toArray(): AuditEntry[]
  /** 派生视图：按 supersedes 链接现场推导 status，返回深拷贝。 */
  view(): AuditEntry[]
  /** 在派生视图上按可组合条件查询（默认按 seq 升序）。 */
  query(filter?: AuditQuery): AuditEntry[]
  last(): AuditEntry | undefined
  findByHash(hash: string): AuditEntry | undefined
}

/** 比较两个 ISO 时间戳；无法解析时退回字典序。 */
function compareTime(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb
  return a < b ? -1 : a > b ? 1 : 0
}

/** 依据全部 supersedes 链接推导每条记录的派生状态（不改动存储对象）。 */
function deriveView(entries: readonly AuditEntry[]): AuditEntry[] {
  const revokedHashes = new Set<string>()
  for (const entry of entries) {
    if (entry.supersedes) revokedHashes.add(entry.supersedes)
  }
  return entries.map((entry) => ({
    ...structuredClone(entry),
    status: revokedHashes.has(entry.hash) ? 'revoked' : 'active',
  }))
}

export function createAuditChain(options: AuditChainOptions = {}): AuditChain {
  const now = options.now ?? (() => new Date().toISOString())
  const defaultConfirmedBy = options.confirmedBy ?? 'system'
  const genesisHash = options.genesisHash ?? GENESIS_HASH

  const entries: AuditEntry[] = []
  const violations: AuditViolation[] = []

  /** 统一写入口：校验显式序号 → 定 prev_hash/hash → 冻结并追加。 */
  function appendEntry(spec: EntrySpec): AppendResult {
    const expectedSeq = entries.length + 1
    const attemptedSeq = spec.explicitSeq ?? expectedSeq

    if (spec.explicitSeq !== undefined && spec.explicitSeq !== expectedSeq) {
      const collision = entries.find((entry) => entry.seq === spec.explicitSeq)
      const kind: AuditViolationKind = collision ? 'overwrite_attempt' : 'out_of_order_seq'
      const violation: AuditViolation = {
        kind,
        attempted_seq: spec.explicitSeq,
        expected_seq: expectedSeq,
        attempted_hash: collision ? collision.hash : null,
        at: now(),
        reason:
          kind === 'overwrite_attempt'
            ? `越权：尝试复用 seq=${spec.explicitSeq} 覆写既有条目（应为 seq=${expectedSeq}），只增不改拒绝写入`
            : `越权：seq=${spec.explicitSeq} 与链序号不连续（应为 seq=${expectedSeq}），拒绝乱序写入`,
      }
      violations.push(violation)
      return { ok: false, violation, reason: violation.reason }
    }

    const ts = spec.explicitTs ?? now()
    const prevHash = entries.length === 0 ? genesisHash : entries[entries.length - 1]!.hash
    const entry: AuditEntry = {
      seq: expectedSeq,
      ts,
      candidate_id: spec.candidate_id,
      action: spec.action,
      target_code: spec.target_code,
      evidence: spec.evidence,
      model_call_id: spec.model_call_id,
      prompt_hash: spec.prompt_hash,
      retrieved_record_ids: spec.retrieved_record_ids,
      decided_at: spec.decided_at ?? ts,
      confirmed_by: spec.confirmed_by,
      writeback_receipt: spec.writeback_receipt,
      prev_hash: prevHash,
      hash: '',
      status: 'active',
      ...(spec.supersedes !== undefined ? { supersedes: spec.supersedes } : {}),
      ...(spec.batch_id !== undefined ? { batch_id: spec.batch_id } : {}),
      ...(spec.confidence !== undefined ? { confidence: spec.confidence } : {}),
    }
    entry.hash = computeEntryHash(prevHash, entry)
    Object.freeze(entry)
    entries.push(entry)
    return { ok: true, entry: structuredClone(entry) }
  }

  function append(input: AppendInput): AppendResult {
    return appendEntry({
      candidate_id: input.candidate_id,
      action: input.action,
      target_code: input.target_code ?? null,
      evidence: input.evidence ?? [],
      model_call_id: input.model_call_id ?? null,
      prompt_hash: input.prompt_hash ?? '',
      retrieved_record_ids: input.retrieved_record_ids ?? [],
      decided_at: input.decided_at,
      confirmed_by: input.confirmed_by ?? defaultConfirmedBy,
      writeback_receipt: input.writeback_receipt ?? null,
      batch_id: input.batch_id,
      confidence: input.confidence,
      explicitSeq: input.seq,
      explicitTs: input.ts,
    })
  }

  function revoke(targetHash: string, revokeOptions: RevokeOptions = {}): AuditEntry {
    const target = entries.find((entry) => entry.hash === targetHash)
    if (!target) throw new Error(`撤销失败：链上不存在 hash=${targetHash} 的条目`)
    const clock = revokeOptions.now ?? now
    const ts = revokeOptions.ts ?? clock()
    const result = appendEntry({
      candidate_id: target.candidate_id,
      action: target.action,
      target_code: target.target_code,
      evidence: revokeOptions.evidence ?? [],
      model_call_id: null,
      prompt_hash: '',
      retrieved_record_ids: [],
      decided_at: ts,
      confirmed_by: revokeOptions.confirmedBy ?? defaultConfirmedBy,
      writeback_receipt: null,
      supersedes: targetHash,
      batch_id: revokeOptions.batchId ?? target.batch_id,
      confidence: target.confidence,
      explicitTs: ts,
    })
    if (!result.ok) throw new Error(result.reason)
    return result.entry
  }

  function verify(verified?: readonly AuditEntry[]): VerifyResult {
    const source = verified ?? entries
    for (let i = 0; i < source.length; i += 1) {
      const entry = source[i]!
      if (entry.seq !== i + 1) {
        return { ok: false, brokenAt: i, brokenSeq: entry.seq, reason: '序号不连续（疑似插入/删除条目）' }
      }
      const expectedPrev = i === 0 ? genesisHash : source[i - 1]!.hash
      if (entry.prev_hash !== expectedPrev) {
        return { ok: false, brokenAt: i, brokenSeq: entry.seq, reason: 'prev_hash 链接断裂' }
      }
      const recomputed = computeEntryHash(entry.prev_hash, entry)
      if (recomputed !== entry.hash) {
        return { ok: false, brokenAt: i, brokenSeq: entry.seq, reason: 'hash 与载荷不一致（条目被篡改）' }
      }
    }
    return { ok: true }
  }

  function query(filter: AuditQuery = {}): AuditEntry[] {
    let rows = deriveView(entries)
    if (filter.candidate_id !== undefined) {
      rows = rows.filter((entry) => entry.candidate_id === filter.candidate_id)
    }
    if (filter.action !== undefined) {
      rows = rows.filter((entry) => entry.action === filter.action)
    }
    if (filter.confirmed_by !== undefined) {
      rows = rows.filter((entry) => entry.confirmed_by === filter.confirmed_by)
    }
    if (filter.batch_id !== undefined) {
      rows = rows.filter((entry) => entry.batch_id === filter.batch_id)
    }
    if (filter.status !== undefined) {
      rows = rows.filter((entry) => entry.status === filter.status)
    }
    if (filter.from !== undefined) {
      rows = rows.filter((entry) => compareTime(entry.ts, filter.from!) >= 0)
    }
    if (filter.to !== undefined) {
      rows = rows.filter((entry) => compareTime(entry.ts, filter.to!) <= 0)
    }
    const offset = Math.max(0, filter.offset ?? 0)
    const end = filter.limit === undefined ? undefined : offset + Math.max(0, filter.limit)
    return rows.slice(offset, end)
  }

  return {
    get length() {
      return entries.length
    },
    get violations() {
      return structuredClone(violations)
    },
    get violationCount() {
      return violations.length
    },
    append,
    revoke,
    verify,
    toArray: () => structuredClone(entries),
    view: () => deriveView(entries),
    query,
    last: () => (entries.length === 0 ? undefined : structuredClone(entries[entries.length - 1]!)),
    findByHash: (hash) => {
      const found = entries.find((entry) => entry.hash === hash)
      return found ? structuredClone(found) : undefined
    },
  }
}
