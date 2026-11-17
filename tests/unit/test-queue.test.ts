/**
 * 批次队列、并发上限与陈旧/取消语义单测（Task 28 / 10）。
 *
 * 覆盖：并发峰值不超过 limit、默认并发取 CONFIG_LLM_CONCURRENCY、
 * generation 变化导致陈旧请求拒绝且不派发、单条失败不中断同批、
 * 进度计数、取消/重置后不再派发新请求、createConcurrencyLimiter 信号量为 0。
 * 全部用微任务驱动 worker，无真实网络、无定时器竞态。
 */
import { describe, expect, it } from 'vitest'
import { CONFIG_LLM_CONCURRENCY } from '@core/constants'
import { createConcurrencyLimiter, runBatch } from '@core/engine/queue'

/** 用微任务让 worker 真正重叠，避免依赖真实定时器。 */
const yieldTurn = () => Promise.resolve()

describe('runBatch 并发与进度（Task 28）', () => {
  it('10 条任务：并发峰值不超过 limit，全部成功且结果按 index 排序', async () => {
    let inFlight = 0
    let observedPeak = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    const result = await runBatch(
      items,
      async (n) => {
        inFlight += 1
        observedPeak = Math.max(observedPeak, inFlight)
        await yieldTurn()
        inFlight -= 1
        return n * 2
      },
      { concurrency: 3 },
    )

    expect(result.results).toHaveLength(10)
    expect(result.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.results.every((r) => r.ok)).toBe(true)
    expect(result.results.map((r) => r.value)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(result.peakConcurrency).toBeLessThanOrEqual(3)
    expect(result.peakConcurrency).toBeGreaterThan(0)
    expect(observedPeak).toBeLessThanOrEqual(3)
    expect(observedPeak).toBeGreaterThanOrEqual(2) // 确有并发发生
    expect(result.progress).toEqual({
      total: 10, processed: 10, succeeded: 10, failed: 0, staleRejected: 0, cancelled: false,
    })
  })

  it('默认并发上限取 CONFIG_LLM_CONCURRENCY', async () => {
    const items = Array.from({ length: CONFIG_LLM_CONCURRENCY * 3 }, (_, i) => i)
    const result = await runBatch(items, async (n) => { await yieldTurn(); return n })
    expect(result.results.every((r) => r.ok)).toBe(true)
    expect(result.peakConcurrency).toBeLessThanOrEqual(CONFIG_LLM_CONCURRENCY)
    expect(result.peakConcurrency).toBeGreaterThan(0)
  })

  it('单条失败不中断同批：其余仍成功，失败项带错误信息', async () => {
    const result = await runBatch(
      Array.from({ length: 6 }, (_, i) => i),
      async (n, index) => {
        if (index === 2) throw new Error('boom')
        await yieldTurn()
        return n
      },
      { concurrency: 2 },
    )
    expect(result.results).toHaveLength(6)
    expect(result.results[2].ok).toBe(false)
    expect(result.results[2].error).toContain('boom')
    expect(result.results.filter((r) => r.ok)).toHaveLength(5)
    expect(result.progress).toEqual({
      total: 6, processed: 6, succeeded: 5, failed: 1, staleRejected: 0, cancelled: false,
    })
  })

  it('进度计数：干净批次 processed/succeeded 等于 total，failed/staleRejected 为 0', async () => {
    const result = await runBatch([1, 2, 3, 4, 5, 6], async (n) => n, { concurrency: 2 })
    expect(result.results.map((r) => r.value)).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.progress.total).toBe(6)
    expect(result.progress.processed).toBe(6)
    expect(result.progress.succeeded).toBe(6)
    expect(result.progress.failed).toBe(0)
    expect(result.progress.staleRejected).toBe(0)
    expect(result.progress.cancelled).toBe(false)
  })
})

describe('陈旧请求拒绝与取消语义（Task 28）', () => {
  it('陈旧拒绝：generation 在中途被早期 worker 改变，剩余请求标 stale 且不派发', async () => {
    let generation = 0
    const dispatched: number[] = []
    const result = await runBatch(
      [0, 1, 2, 3, 4, 5],
      async (item, index) => {
        dispatched.push(index)
        if (index === 0) generation = 1 // 模拟批次被人工重置
        await yieldTurn()
        return item
      },
      { concurrency: 1, getGeneration: () => generation },
    )

    expect(dispatched).toEqual([0]) // 仅首个请求进入 worker
    const stale = result.results.filter((r) => r.stale)
    expect(stale).toHaveLength(5)
    expect(stale.every((r) => r.ok === false && r.error === '批次已重置，请求作废')).toBe(true)
    expect(stale.map((r) => r.index)).toEqual([1, 2, 3, 4, 5])
    expect(result.progress).toMatchObject({
      total: 6, processed: 6, succeeded: 1, staleRejected: 5,
    })
  })

  it('取消/重置后不再向 worker 派发新请求', async () => {
    let generation = 0
    const dispatched: number[] = []
    const items = Array.from({ length: 10 }, (_, i) => i)
    const result = await runBatch(
      items,
      async (item, index) => {
        dispatched.push(index)
        if (index === 0) generation = 99 // 首个 worker 触发「取消/重置」信号
        return item
      },
      { concurrency: 1, getGeneration: () => generation },
    )

    // 第 0 条之后 generation 已变，其余 9 条被作废，绝不再进入 worker
    expect(dispatched).toEqual([0])
    expect(result.results.filter((r) => r.stale)).toHaveLength(9)
    expect(result.progress.staleRejected).toBe(9)
    expect(result.progress.succeeded).toBe(1)

    /**
     * generation 变化语义上是「批次重置 / 陈旧拒绝」，与「人工取消」区分：
     * 只有显式取消（cancel() / getCancelled / AbortSignal）才置 cancelled=true。
     * 本用例触发的是重置，故 cancelled 仍为 false。
     */
    expect(result.progress.cancelled).toBe(false)
    expect(result.progress.staleRejected).toBe(9)
  })

  it('真实取消：getCancelled 在第 0 条后返回 true，剩余请求标记为 cancelled 且不再派发', async () => {
    let cancelledByUser = false
    const dispatched: number[] = []
    const result = await runBatch(
      Array.from({ length: 10 }, (_, i) => i),
      async (item, index) => {
        dispatched.push(index)
        if (index === 0) cancelledByUser = true // 模拟人工点击「取消批次」
        await yieldTurn()
        return item
      },
      { concurrency: 1, getCancelled: () => cancelledByUser },
    )

    expect(dispatched).toEqual([0]) // 取消后不再向 worker 派发新请求
    expect(result.progress.cancelled).toBe(true)
    expect(result.progress.total).toBe(10)
    expect(result.progress.processed).toBe(10) // 进度闭合到 total
    expect(result.progress.succeeded).toBe(1)
    const voided = result.results.filter((r) => r.cancelled)
    expect(voided).toHaveLength(9)
    expect(voided.every((r) => r.ok === false && r.error === '批次已取消，请求未发出')).toBe(true)
    expect(voided.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(typeof result.cancel).toBe('function')
  })

  it('真实取消：AbortSignal.abort() 后停止派发，未派发条目 cancelled', async () => {
    const controller = new AbortController()
    const dispatched: number[] = []
    const result = await runBatch(
      Array.from({ length: 8 }, (_, i) => i),
      async (item, index) => {
        dispatched.push(index)
        if (index === 0) controller.abort()
        await yieldTurn()
        return item
      },
      { concurrency: 1, signal: controller.signal },
    )
    expect(dispatched).toEqual([0])
    expect(result.progress.cancelled).toBe(true)
    expect(result.results.filter((r) => r.cancelled)).toHaveLength(7)
  })
})

describe('createConcurrencyLimiter 信号量（Task 28）', () => {
  it('activeCount / acquire / release：达上限后排队，release 唤醒等待者', async () => {
    const limiter = createConcurrencyLimiter(2)
    expect(limiter.activeCount).toBe(0)

    await limiter.acquire()
    await limiter.acquire()
    expect(limiter.activeCount).toBe(2)

    let thirdDone = false
    const third = limiter.acquire().then(() => { thirdDone = true })
    await yieldTurn() // 让第三次 acquire 进入等待队列
    expect(thirdDone).toBe(false)
    expect(limiter.activeCount).toBe(2)

    limiter.release() // active→1，唤醒等待者使其 acquire 继续（active→2）
    await third
    expect(thirdDone).toBe(true)
    expect(limiter.activeCount).toBe(2)

    limiter.release()
    limiter.release()
    expect(limiter.activeCount).toBe(0)
  })

  it('默认 limit 取 CONFIG_LLM_CONCURRENCY：可连续获取该数量而不阻塞', async () => {
    const limiter = createConcurrencyLimiter()
    for (let i = 0; i < CONFIG_LLM_CONCURRENCY; i += 1) await limiter.acquire()
    expect(limiter.activeCount).toBe(CONFIG_LLM_CONCURRENCY)

    let blocked = true
    const extra = limiter.acquire().then(() => { blocked = false })
    await yieldTurn()
    expect(blocked).toBe(true) // 超出默认上限后阻塞
    limiter.release()
    await extra
    expect(blocked).toBe(false)
  })
})
