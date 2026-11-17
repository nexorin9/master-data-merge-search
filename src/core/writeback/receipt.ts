/**
 * 写回回执归一化、错误分类与退避重试决策（Task 32 / 34）。
 *
 * 错误四分类 + 两态：
 *   - success         成功，不重试
 *   - idempotent_skip 409 / 200+existing / receipt.skipped——不是错误，不重试，记 skipped
 *   - client_4xx      4xx（非 409）——不可重试，中文可读原因
 *   - server_5xx      5xx——可重试
 *   - network         传输层网络错误——可重试
 *   - timeout         超时——只重试一次（maxAttempts=2）
 *   - unknown         兜底不可重试
 * 另外给闸门类拒绝（unconfirmed / degraded / privacy / exception）定义独立 kind，
 * 供 BatchSummary.failures.kind 使用。
 *
 * 回执优先「honor」MDM 结果自带的三态 receipt；没有时按 status / code 归一化。
 * 可读原因一律为中文、无堆栈、无文件行号。
 */
import { classifyWriteReceipt, type MdmResult } from '../retrieval/mdm-client'
import {
  CONFIG_WRITEBACK_BACKOFF_FACTOR,
  CONFIG_WRITEBACK_BACKOFF_INITIAL_MS,
  CONFIG_WRITEBACK_BACKOFF_MAX_ATTEMPTS,
} from '../constants'
import type { ReceiptStatus, WriteReceipt } from '../types'

export interface BackoffConfig {
  backoffInitialMs: number
  backoffFactor: number
  maxAttempts: number
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  backoffInitialMs: CONFIG_WRITEBACK_BACKOFF_INITIAL_MS,
  backoffFactor: CONFIG_WRITEBACK_BACKOFF_FACTOR,
  maxAttempts: CONFIG_WRITEBACK_BACKOFF_MAX_ATTEMPTS,
}

export function resolveBackoff(partial?: Partial<BackoffConfig>): BackoffConfig {
  return { ...DEFAULT_BACKOFF, ...(partial ?? {}) }
}

/** 第 failedAttempt（1-based）次失败后、下一次重试前的等待毫秒：initial * factor^(n-1)。 */
export function backoffDelayMs(failedAttempt: number, config: BackoffConfig): number {
  const n = Math.max(0, failedAttempt - 1)
  return Math.round(config.backoffInitialMs * Math.pow(config.backoffFactor, n))
}

export type FailureKind =
  | 'success'
  | 'idempotent_skip'
  | 'client_4xx'
  | 'server_5xx'
  | 'network'
  | 'timeout'
  | 'unknown'
  | 'unconfirmed'
  | 'degraded'
  | 'privacy'
  | 'exception'

export interface Classification {
  status: ReceiptStatus
  kind: FailureKind
  retryable: boolean
  /** 该错误的最大尝试次数；timeout 恒为 2（只重试一次）。 */
  maxAttempts?: number
  reason?: string
}

/** 堆栈 / 文件行号特征：可读原因里一律不出现。 */
const STACKISH = /\bat\s+\S|\.ts:\d|\.js:\d|node_modules|\/[^ ]+\.(?:ts|js)/i

/** 清洗原始错误：只取首行、去 Error 前缀、去堆栈行与文件行号，绝不回显凭据。 */
export function sanitizeReason(raw?: string): string {
  if (!raw) return ''
  return raw
    .split(/\r?\n/)[0]!
    .replace(/^\s*(?:[A-Za-z]+Error|Error)\s*:\s*/i, '')
    .replace(/\s+at\s+.*$/i, '')
    .replace(/\(?[^()\s]+\.(?:ts|js):\d+(?::\d+)?\)?/g, '')
    .trim()
    .slice(0, 200)
}

/** 可读原因中的细节片段：含堆栈特征则丢弃，只保留中文主句。 */
function safeDetail(raw?: string): string {
  const clean = sanitizeReason(raw)
  if (!clean || STACKISH.test(clean)) return ''
  return clean
}

export function readableFailure(kind: FailureKind, status?: number, detail?: string): string {
  const text = ((): string => {
    switch (kind) {
      case 'client_4xx':
        if (status === 401 || status === 403) return '权限不足，MDM 拒绝写回'
        if (status === 404) return '候选或目标主数据不存在，MDM 拒绝写回'
        if (status === 422) return '候选已被 MDM 侧驳回，写回被拒绝'
        return `MDM 拒绝写回（HTTP ${status ?? 400}）`
      case 'server_5xx': return `MDM 服务暂不可用（HTTP ${status ?? 500}），已按退避重试`
      case 'network': return '网络错误，无法连接 MDM，已按退避重试'
      case 'timeout': return '写回请求超时，已重试一次'
      case 'unknown': return '写回失败，MDM 未返回可识别原因'
      case 'unconfirmed': return '候选未逐条人工确认，已跳过写回'
      case 'degraded': return '降级结论不可写回，须人工指定目标后重新评估'
      case 'privacy': return '隐私闸门拦截，待写回数据命中个人信息'
      case 'exception': return '写回过程发生异常，已记录失败'
      case 'idempotent_skip': return '该候选已存在同哈希归并建议，已跳过'
      case 'success': return ''
      default: return '写回失败，原因未知'
    }
  })()
  const extra = safeDetail(detail)
  return extra && extra !== text ? `${text}（${extra}）` : text
}

/** 把一条 MDM 结果归类为成功 / 幂等跳过 / 四类错误。 */
export function classifyWriteResult(result: MdmResult<Record<string, unknown>>): Classification {
  const status = result.status
  const code = result.code ?? ''
  const error = result.error ?? ''

  // 幂等跳过优先：receipt.skipped、409、或 200+existing 标记。
  const existingByStatus =
    status !== undefined && status >= 200 && status < 300 &&
    classifyWriteReceipt(status, result.data) === 'skipped'
  if (result.receipt?.status === 'skipped' || status === 409 || existingByStatus) {
    return { status: 'skipped', kind: 'idempotent_skip', retryable: false, reason: 'IDEMPOTENT_SKIP' }
  }

  if (code === 'MDM_TIMEOUT' || /timeout|超时|aborted/i.test(error)) {
    return { status: 'failed', kind: 'timeout', retryable: true, maxAttempts: 2, reason: code || 'TIMEOUT' }
  }
  if (code === 'MDM_NETWORK' || /network|网络|fetch failed|econn|enotfound/i.test(error)) {
    return { status: 'failed', kind: 'network', retryable: true, reason: code || 'NETWORK' }
  }
  if (status !== undefined && status >= 500) {
    return { status: 'failed', kind: 'server_5xx', retryable: true, reason: `HTTP_${status}` }
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { status: 'failed', kind: 'client_4xx', retryable: false, reason: `HTTP_${status}` }
  }

  const successByStatus =
    status === undefined ||
    (status >= 200 && status < 300 && classifyWriteReceipt(status, result.data) === 'success')
  if ((result.ok && successByStatus) || result.receipt?.status === 'success') {
    return { status: 'success', kind: 'success', retryable: false }
  }

  // 无状态码的失败（例如自定义 sink 返回 {ok:false}）。
  return { status: 'failed', kind: 'unknown', retryable: false, reason: code || 'UNKNOWN' }
}

/**
 * 归一化成领域 WriteReceipt：优先 honor 结果自带的三态 receipt，否则按分类构造。
 * 可读原因始终重新按分类与状态码生成中文主句，杜绝堆栈泄漏。
 */
export function normalizeReceipt(
  candidateId: string,
  idempotencyKey: string,
  result: MdmResult<Record<string, unknown>>,
  now: () => string,
  classification: Classification,
): WriteReceipt {
  const existing = result.receipt
  const status: ReceiptStatus = existing?.status ?? classification.status
  const rawReason = existing?.reason ?? classification.reason
  const reason = rawReason && !STACKISH.test(rawReason) ? sanitizeReason(rawReason) : undefined
  // 干净的既有可读原因直接 honor；含堆栈特征则丢弃并按分类重新生成中文主句。
  const honoredReadable =
    existing?.readable_reason && !STACKISH.test(existing.readable_reason)
      ? existing.readable_reason
      : undefined
  const readable_reason =
    status === 'skipped'
      ? (honoredReadable ?? readableFailure('idempotent_skip'))
      : status === 'failed'
        ? (honoredReadable ?? readableFailure(classification.kind, result.status, result.error))
        : undefined
  return {
    candidate_id: candidateId,
    status,
    idempotency_key: idempotencyKey,
    ...(reason ? { reason } : {}),
    ...(readable_reason ? { readable_reason } : {}),
    created_at: now(),
  }
}

export interface RetryDecision {
  action: 'retry' | 'stop'
  delayMs?: number
  reason?: string
}

/** failedAttempt（1-based）失败后的决策：可重试且未到上限才 retry。 */
export function retryDecision(
  classification: Classification,
  failedAttempt: number,
  config: BackoffConfig,
): RetryDecision {
  if (classification.status === 'success' ||
      classification.status === 'skipped' ||
      !classification.retryable) {
    return { action: 'stop' }
  }
  const limit = classification.maxAttempts ?? config.maxAttempts
  if (failedAttempt >= limit) {
    return { action: 'stop', reason: readableFailure(classification.kind) }
  }
  return { action: 'retry', delayMs: backoffDelayMs(failedAttempt, config) }
}
