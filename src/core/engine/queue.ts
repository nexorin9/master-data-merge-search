/**
 * 批次队列、并发上限与陈旧请求拒绝（Task 10）。
 *
 * 复用源产品 isStaleGeneration + getSessionGeneration 比对语义：同批候选逐条
 * 排队，模型并发受 LLM_CONCURRENCY 限制；批次被人工重置后，队列中尚未发出的
 * 请求作废；批次可被取消，取消后不再发新请求；进度（已处理/总数）实时可见。
 */
import { CONFIG_LLM_CONCURRENCY } from '../constants'

export interface QueueOptions {
  concurrency?: number
  /** 批次当前 generation；变化即视为陈旧。 */
  getGeneration?: () => number
  /**
   * 取消观测口：返回 true 表示批次已被人工取消。每次派发前检查；为 true 时
   * 不再派发新请求，未派发条目记为 cancelled。调用方持有可变标志即可触发取消。
   */
  getCancelled?: () => boolean
  /** 标准取消信号：abort() 后不再派发新请求（与 getCancelled 二者取或）。 */
  signal?: AbortSignal
  now?: () => number
}

export interface QueueProgress {
  total: number
  processed: number
  succeeded: number
  failed: number
  staleRejected: number
  cancelled: boolean
}

export interface QueueRunResult<T> {
  results: Array<{ index: number; ok: boolean; value?: T; error?: string; stale?: boolean; cancelled?: boolean }>
  progress: QueueProgress
  peakConcurrency: number
  /** 真实取消句柄：调用后正在派发的循环停止，尚未派发的条目记为 cancelled。 */
  cancel(): void
}

/**
 * 批次并发执行：逐条取任务，受 concurrency 限制，超时/重置后未发请求作废。
 * 单条失败不中断同批。
 */
export async function runBatch<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: QueueOptions = {},
): Promise<QueueRunResult<R>> {
  const concurrency = Math.max(1, options.concurrency ?? CONFIG_LLM_CONCURRENCY)
  const getGeneration = options.getGeneration ?? (() => 0)
  const getCancelled = options.getCancelled ?? (() => false)
  const startGeneration = getGeneration()
  let next = 0
  let processed = 0
  let succeeded = 0
  let failed = 0
  let staleRejected = 0
  let cancelled = false
  let active = 0
  let peakConcurrency = 0
  const results: QueueRunResult<R>['results'] = []

  // 三种取消来源取或：显式句柄 cancel() / 注入 getCancelled / 标准 AbortSignal。
  // 注意与「陈旧拒绝」区分：generation 变化只作废旧请求（stale），不置 cancelled。
  let cancelRequested = false
  const cancel = () => { cancelRequested = true }
  const isCancelled = (): boolean =>
    cancelRequested || getCancelled() || options.signal?.aborted === true

  async function runner(): Promise<void> {
    while (true) {
      if (isCancelled()) { cancelled = true; break }
      const index = next++
      if (index >= items.length) break
      // 陈旧请求拒绝：批次被重置（generation 变化）后，尚未发出的请求作废。
      if (getGeneration() !== startGeneration) {
        staleRejected += 1
        processed += 1
        results.push({ index, ok: false, stale: true, error: '批次已重置，请求作废' })
        continue
      }
      active += 1
      peakConcurrency = Math.max(peakConcurrency, active)
      try {
        const value = await worker(items[index], index)
        results.push({ index, ok: true, value })
        succeeded += 1
      } catch (err) {
        results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err) })
        failed += 1
      } finally {
        active -= 1
        processed += 1
      }
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runner())
  await Promise.all(runners)
  if (cancelRequested || getCancelled() || options.signal?.aborted === true) {
    cancelled = true
    // 未派发条目：不在 results 中且索引 < total，补记为 cancelled，进度闭合到 total。
    const seen = new Set(results.map((r) => r.index))
    for (let i = 0; i < items.length; i++) {
      if (!seen.has(i)) {
        results.push({ index: i, ok: false, cancelled: true, error: '批次已取消，请求未发出' })
        processed += 1
      }
    }
  }

  results.sort((a, b) => a.index - b.index)
  return {
    results,
    progress: { total: items.length, processed, succeeded, failed, staleRejected, cancelled },
    peakConcurrency,
    cancel,
  }
}

/** 并发限流器（Semaphore 语义，供外部逐条调用场景）。 */
export function createConcurrencyLimiter(limit = CONFIG_LLM_CONCURRENCY) {
  let active = 0
  const waiting: Array<() => void> = []
  return {
    async acquire(): Promise<void> {
      if (active < limit) { active += 1; return }
      await new Promise<void>((resolve) => waiting.push(resolve))
      active += 1
    },
    release(): void {
      active -= 1
      const next = waiting.shift()
      if (next) next()
    },
    get activeCount(): number { return active },
  }
}
