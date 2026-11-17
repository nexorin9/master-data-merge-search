/**
 * 单条归并建议写回编排（Task 32 / 33 / 34）。
 *
 * 固定调用顺序（任一闸门拒绝即 sink 零调用）：
 *   确认闸门 → 降级闸门 → 重放判定 → 隐私闸门(privacy) → 审计(append) → 写调用(sink)
 * 其中「审计 → 写调用」放在隐私闸门交给的 write 回调里，只有闸门放行才会执行；
 * 因此「闸门拒绝 ⇒ 既不审计也不写」由结构保证。
 *
 * 全依赖注入：sink / now / sleep / privacyGate / auditAppend / replayLedger / config
 * 都是窄接口，绝无真实网络、全局可变状态或裸时钟依赖。
 */
import { rejectWritebackIfDegraded } from '../engine/degrade'
import { scanBatch } from '../audit/pii-guard'
import type { MdmResult, MergeSuggestionBody } from '../retrieval/mdm-client'
import type { MergeConclusion, ReceiptStatus, WriteReceipt } from '../types'
import {
  actionHash,
  classifySubmission,
  composeIdempotencyKey,
  conclusionToBody,
  createReplayLedger,
  type ReplayLedger,
  type SubmissionKind,
} from './idempotency'
import {
  classifyWriteResult,
  normalizeReceipt,
  readableFailure,
  resolveBackoff,
  retryDecision,
  sanitizeReason,
  type BackoffConfig,
  type Classification,
  type FailureKind,
} from './receipt'

/** 注入的写口：与 mdm-client.postMergeSuggestion 同签名，永不触网（测试给假件）。 */
export type WritebackSink = (
  candidateId: string,
  body: MergeSuggestionBody,
  idempotencyKey: string,
) => Promise<MdmResult<Record<string, unknown>>>

/**
 * 隐私闸门：先决策，放行的唯一方式是调用 write()（审计 + 写）；拒绝则直接返回 ok:false，
 * 绝不触碰 write。与 pii-guard.enforcePiiBeforeWrite(rows, writeFn) 语义一致。
 */
export type PrivacyGate = (
  rows: unknown[],
  write: () => Promise<void>,
) => Promise<{ ok: boolean; reason?: string }>

/** 默认隐私闸门：复用 pii-guard.scanBatch，命中个人信息即整行拒绝。 */
export const piiPrivacyGate: PrivacyGate = async (rows, write) => {
  const list = rows.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row),
  )
  const scan = scanBatch(list)
  if (scan.rejected_count > 0) {
    return {
      ok: false,
      reason: `隐私闸门拦截：${scan.rejected_count} 行命中个人信息，禁止写回`,
    }
  }
  await write()
  return { ok: true }
}

export interface WritebackPorts {
  sink: WritebackSink
  now?: () => string
  sleep?: (ms: number) => Promise<void>
  privacyGate?: PrivacyGate
  auditAppend?: (entry: unknown) => void
  /** 阶段轨迹（注入的观测口）：'confirm' | 'degrade' | 'replay' | 'privacy' | 'audit' | 'sink'。 */
  trace?: (stage: string) => void
  /** 共享重放账本；缺省时每次调用新建私有账本。 */
  replayLedger?: ReplayLedger
  config?: Partial<BackoffConfig>
}

export interface WriteOptions {
  /** 逐行人工确认（复选框）；必须显式为 true 才允许写回。 */
  confirmed: boolean
  /** 撤销链：存在即视为 revoke-then-resubmit（新哈希才生效）。 */
  supersedes?: string
  batchId?: string
  confirmedBy?: string
}

export interface WriteResult extends WriteReceipt {
  /** 本次提交类别。 */
  submission_kind: SubmissionKind
  /** sink 实际调用次数（含退避重试）。 */
  sink_calls: number
  /** 总尝试次数。 */
  attempts: number
  /** 本次回执的分类（成功 / 四类错误 / 闸门类拒绝），任何状态都始终填充。 */
  kind: FailureKind
  /** 失败类别别名（仅 status='failed' 时填充），供 BatchSummary.failures.kind 使用。 */
  failure_kind?: FailureKind
}

export function createWriteResult(
  conclusion: MergeConclusion,
  idempotencyKey: string,
  now: () => string,
  status: ReceiptStatus,
  kind: FailureKind,
  details: Partial<WriteResult> = {},
): WriteResult {
  // 可读原因只从 kind 派生（永不回显闸门 / 异常的原始字符串，杜绝堆栈泄漏）；
  // 调用方想覆盖时必须自己在详情里放干净中文，这里用 sanitizeReason 兜底。
  const rawReadable = details.readable_reason
  const readable_reason =
    status === 'success'
      ? undefined
      : rawReadable
        ? sanitizeReason(rawReadable) || readableFailure(kind)
        : readableFailure(kind)
  return {
    candidate_id: conclusion.candidate_id,
    status,
    idempotency_key: idempotencyKey,
    reason: kind,
    created_at: now(),
    submission_kind: 'fresh',
    sink_calls: 0,
    attempts: 0,
    kind,
    failure_kind: status === 'failed' ? kind : undefined,
    ...details,
    readable_reason,
  }
}

/**
 * 执行单条归并建议写回。返回三态回执（附带提交类别与尝试次数）。
 */
export async function writeSuggestion(
  conclusion: MergeConclusion,
  ports: WritebackPorts,
  opts: WriteOptions,
): Promise<WriteResult> {
  const now = ports.now ?? (() => new Date().toISOString())
  const sleep = ports.sleep ?? (async () => {})
  const trace = ports.trace ?? (() => {})
  const config = resolveBackoff(ports.config)
  const ledger = ports.replayLedger ?? createReplayLedger({ now })

  const body = conclusionToBody(conclusion)
  const hash = actionHash(body)
  const key = composeIdempotencyKey(conclusion.candidate_id, hash)

  // 1) 确认闸门：未逐条确认 ⇒ sink 零调用。
  trace('confirm')
  if (opts.confirmed !== true) {
    return createWriteResult(conclusion, key, now, 'skipped', 'unconfirmed')
  }

  // 2) 降级闸门：degraded 结论恒拒绝写回。
  trace('degrade')
  const degraded = rejectWritebackIfDegraded(conclusion)
  if (!degraded.accepted) {
    return createWriteResult(conclusion, key, now, 'failed', 'degraded', {
      readable_reason: degraded.reason ?? readableFailure('degraded'),
    })
  }

  // 3) 重放判定：同哈希直接返回既有建议，无审计、无 sink、不推进状态。
  trace('replay')
  const submission = classifySubmission(ledger, conclusion.candidate_id, hash, opts.supersedes)
  if (submission === 'replay') {
    const hit = ledger.lookup(conclusion.candidate_id, hash)
    ledger.noteReplay()
    return createWriteResult(conclusion, key, now, 'skipped', 'idempotent_skip', {
      submission_kind: 'replay',
      readable_reason: hit.entry?.receipt.readable_reason ?? readableFailure('idempotent_skip'),
    })
  }

  let sinkCalls = 0
  let attempts = 0
  let finalResult: MdmResult<Record<string, unknown>> | null = null
  let classification: Classification = { status: 'failed', kind: 'exception', retryable: false }

  // 隐私闸门放行后才会调用：先审计，再写（含退避重试）。
  const write = async (): Promise<void> => {
    if (submission === 'supersede') {
      trace('revoke')
      ports.auditAppend?.({
        kind: 'revoke',
        candidate_id: conclusion.candidate_id,
        supersedes: opts.supersedes,
        batch_id: opts.batchId,
        at: now(),
      })
    }
    trace('audit')
    ports.auditAppend?.({
      kind: 'suggestion',
      candidate_id: conclusion.candidate_id,
      action: conclusion.action,
      target_code: conclusion.target_code,
      evidence: conclusion.evidence,
      model_call_id: null,
      prompt_hash: '',
      retrieved_record_ids: conclusion.retrieved_record_ids ?? [],
      decided_at: conclusion.decided_at ?? now(),
      confirmed_by: opts.confirmedBy ?? 'system',
      writeback_receipt: null,
      status: 'active',
      batch_id: opts.batchId,
      confidence: conclusion.confidence,
      submission_kind: submission,
      ...(opts.supersedes !== undefined ? { supersedes: opts.supersedes } : {}),
      at: now(),
    })
    for (;;) {
      attempts += 1
      trace('sink')
      sinkCalls += 1
      try {
        finalResult = await ports.sink(conclusion.candidate_id, body, key)
      } catch (err) {
        // 传输层 / 未预期异常统一结构化，绝不向上抛裸串、绝不回显堆栈。
        finalResult = {
          ok: false,
          code: 'MDM_EXCEPTION',
          error: err instanceof Error ? err.message : String(err),
        }
      }
      classification = classifyWriteResult(finalResult)
      const decision = retryDecision(classification, attempts, config)
      if (decision.action === 'stop') break
      await sleep(decision.delayMs ?? 0)
    }
  }

  // 4) 隐私闸门：命中即拒，write 不被调用 ⇒ 审计与 sink 都不发生。
  trace('privacy')
  const gate = ports.privacyGate ?? piiPrivacyGate
  let verdict: { ok: boolean; reason?: string }
  try {
    verdict = await gate([body, ...body.evidence], write)
  } catch (err) {
    return createWriteResult(conclusion, key, now, 'failed', 'exception', {
      sink_calls: sinkCalls,
      attempts,
      readable_reason: err instanceof Error ? err.message : String(err),
    })
  }
  if (!verdict.ok) {
    return createWriteResult(conclusion, key, now, 'failed', 'privacy', {
      readable_reason: verdict.reason ?? readableFailure('privacy'),
    })
  }
  if (!finalResult) {
    // 闸门放行却未触发写入：保守按跳过处理，绝不臆造成功回执。
    return createWriteResult(conclusion, key, now, 'skipped', 'unknown', {
      readable_reason: '隐私闸门放行但未执行写调用，已跳过',
    })
  }

  const receipt = normalizeReceipt(conclusion.candidate_id, key, finalResult, now, classification)
  const result: WriteResult = {
    ...receipt,
    submission_kind: submission,
    sink_calls: sinkCalls,
    attempts,
    kind: classification.kind,
    ...(receipt.status === 'failed' ? { failure_kind: classification.kind } : {}),
  }

  // 仅成功 / 幂等跳过写入账本并推进状态；失败不入库、不推进，交给 retryFailures 重试。
  if (result.status === 'success' || result.status === 'skipped') {
    ledger.record({ candidateId: conclusion.candidate_id, body, receipt, supersedes: opts.supersedes })
    ledger.advanceState(conclusion.candidate_id)
  }
  return result
}
