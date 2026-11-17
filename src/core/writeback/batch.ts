/**
 * 批次写回编排与部分失败汇总（Task 32 / 35）。
 *
 * - 逐行复用 writeSuggestion；单行抛异常被捕获成失败项，绝不中断同批。
 * - 并发上限复用 engine/queue.runBatch；退避 sleep 发生在行内，不阻塞其它行。
 * - 每行完成触发一次进度回调；汇总结算成 BatchSummary（三态计数 + 失败明细 + 耗时）。
 * - 一个批次级 summary 追加到注入审计链，并写入注入的持久化 state。
 * - retryFailures(failedIds) 只重跑失败行，复用同一 actionHash / 幂等键，绝不触碰已成功行。
 */
import { createHash } from 'node:crypto'
import { runBatch } from '../engine/queue'
import type { BatchSummary, MergeConclusion, WriteReceipt } from '../types'
import {
  actionHash,
  composeIdempotencyKey,
  createReplayLedger,
  type ReplayLedger,
} from './idempotency'
import { readableFailure, resolveBackoff, type BackoffConfig } from './receipt'
import {
  writeSuggestion,
  type PrivacyGate,
  type WritebackSink,
  type WriteResult,
} from './suggestion-writer'

/** 批次编排的全部可注入依赖（窄接口，绝不触网）。 */
export interface BatchPorts {
  sink: WritebackSink
  now?: () => string
  /** 毫秒单调时钟，仅用于 elapsed_ms；缺省 Date.now。 */
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  privacyGate?: PrivacyGate
  auditAppend?: (entry: unknown) => void
  /** 持久化 state 注入口：批次级 summary 落这里。 */
  persistState?: (patch: { batch_summary: BatchSummary }) => void
  replayLedger?: ReplayLedger
  config?: Partial<BackoffConfig>
}

export interface ProgressInfo {
  processed: number
  total: number
  succeeded: number
  skipped: number
  failed: number
  receipt: WriteReceipt
}

export interface BatchOptions {
  concurrency?: number
  batchId?: string
  confirmedBy?: string
  /** 逐行确认：优先按 candidate_id 查，未列出则取 defaultConfirmed。 */
  confirmed?: boolean
  confirmedOf?: (candidateId: string) => boolean
  onProgress?: (info: ProgressInfo) => void
  /** 本次整批提交是否带撤销链（supersede）。 */
  supersedes?: string
}

export interface BatchRunResult extends BatchSummary {
  receipts: WriteResult[]
  ledger: ReplayLedger
  peakConcurrency: number
}

/** 批次级审计条目的稳定 kind，供测试与审计链区分「单行建议」与「整批汇总」。 */
export const BATCH_SUMMARY_AUDIT_KIND = 'batch_summary'

function deriveBatchId(conclusions: MergeConclusion[], nowIso: string): string {
  const seed = `${nowIso}｜${conclusions.map((c) => c.candidate_id).join(',')}`
  return `B-${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)}`
}

function toFailure(receipt: WriteResult): { candidate_id: string; kind: string; readable_reason: string } {
  return {
    candidate_id: receipt.candidate_id,
    kind: receipt.failure_kind ?? 'unknown',
    readable_reason: receipt.readable_reason ?? readableFailure(receipt.failure_kind ?? 'unknown'),
  }
}

/** 把一行未预期异常转成失败回执（绝不外抛、绝不回显堆栈）。 */
function exceptionReceipt(
  conclusion: MergeConclusion,
  now: () => string,
  err: unknown,
): WriteResult {
  const detail = err instanceof Error ? err.message : String(err)
  return {
    candidate_id: conclusion.candidate_id,
    status: 'failed',
    idempotency_key: composeIdempotencyKey(conclusion.candidate_id, actionHash(conclusion)),
    reason: 'EXCEPTION',
    readable_reason: readableFailure('exception', undefined, detail),
    created_at: now(),
    submission_kind: 'fresh',
    sink_calls: 0,
    attempts: 0,
    kind: 'exception',
    failure_kind: 'exception',
  }
}

/**
 * 执行一批归并建议写回。返回 BatchSummary（含 receipts / ledger / peakConcurrency）。
 */
export async function runWritebackBatch(
  conclusions: MergeConclusion[],
  ports: BatchPorts,
  opts: BatchOptions = {},
): Promise<BatchRunResult> {
  const now = ports.now ?? (() => new Date().toISOString())
  const clock = ports.clock ?? (() => Date.now())
  const ledger = ports.replayLedger ?? createReplayLedger({ now })
  const config = resolveBackoff(ports.config)
  const batchId = opts.batchId ?? deriveBatchId(conclusions, now())
  const startMs = clock()

  let succeeded = 0
  let skipped = 0
  let failed = 0
  let processed = 0

  const run = await runBatch(
    conclusions,
    async (conclusion): Promise<WriteResult> => {
      let receipt: WriteResult
      try {
        const confirmed = opts.confirmedOf
          ? opts.confirmedOf(conclusion.candidate_id)
          : (opts.confirmed ?? false)
        receipt = await writeSuggestion(conclusion, { ...ports, replayLedger: ledger, config }, {
          confirmed,
          supersedes: opts.supersedes,
          batchId,
          confirmedBy: opts.confirmedBy,
        })
      } catch (err) {
        // 单行异常独立成失败项，不中断同批其它行。
        receipt = exceptionReceipt(conclusion, now, err)
      }
      processed += 1
      if (receipt.status === 'success') succeeded += 1
      else if (receipt.status === 'skipped') skipped += 1
      else failed += 1
      try {
        opts.onProgress?.({
          processed,
          total: conclusions.length,
          succeeded,
          skipped,
          failed,
          receipt,
        })
      } catch {
        // 进度回调异常不应影响批次结果。
      }
      return receipt
    },
    opts.concurrency === undefined ? {} : { concurrency: opts.concurrency },
  )

  const receipts: WriteResult[] = []
  run.results.forEach((r, index) => {
    const conclusion = conclusions[index]!
    if (r.ok && r.value !== undefined) {
      receipts.push(r.value)
    } else {
      // runBatch 兜底：worker 抛出的异常（理论上已在上面 catch）也进失败明细。
      receipts.push(exceptionReceipt(conclusion, now, new Error(r.error ?? '未知批次异常')))
      failed += 1
    }
  })

  const summary: BatchSummary = {
    batch_id: batchId,
    total: conclusions.length,
    succeeded,
    skipped,
    failed,
    failures: receipts.filter((r) => r.status === 'failed').map(toFailure),
    elapsed_ms: Math.max(0, clock() - startMs),
  }

  // 一个批次级 summary：既进审计链，也进持久化 state（各一次）。
  ports.auditAppend?.({ kind: BATCH_SUMMARY_AUDIT_KIND, batch_id: batchId, summary, at: now() })
  ports.persistState?.({ batch_summary: summary })

  return {
    ...summary,
    receipts,
    ledger,
    peakConcurrency: run.peakConcurrency,
  }
}

export interface RetryOptions extends BatchOptions {}

/** 重试入口的额外注入：原始结论集合（按 candidate_id 取回同一 actionHash / 幂等键）。 */
export interface RetryPorts extends BatchPorts {
  conclusions: MergeConclusion[]
}

/**
 * 只重试给定失败行：从注入的 conclusions 取回原结论，复用同一 replayLedger 与
 * 幂等键；已成功行不在 failedIds 内，绝不被重新写入。
 * 复用 runWritebackBatch 的同一路径，因此退避、回执、汇总口径完全一致。
 */
export async function retryFailures(
  failedIds: string[],
  ports: RetryPorts,
  opts: RetryOptions = {},
): Promise<BatchRunResult> {
  const now = ports.now ?? (() => new Date().toISOString())
  const failedSet = new Set(failedIds)
  const rows = ports.conclusions.filter((c) => failedSet.has(c.candidate_id))
  return runWritebackBatch(rows, ports, {
    ...opts,
    batchId: opts.batchId ?? `retry-${createHash('sha256').update(now()).digest('hex').slice(0, 12)}`,
  })
}
