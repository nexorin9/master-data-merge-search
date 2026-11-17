/**
 * 批次编排与部分失败汇总（Task 35）。
 *
 * 逐行复用 writeSuggestion；单行抛异常被捕获成失败项不中断同批；并发上限复用
 * engine/queue.runBatch 并暴露 peakConcurrency；每行触发一次进度回调；一个批次级
 * summary 追加到注入审计链并写入注入 state；retryFailures 只重试失败行且复用幂等键。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MdmResult, MergeSuggestionBody } from '@core/retrieval/mdm-client'
import type { EvidenceItem, MergeConclusion } from '@core/types'
import {
  BATCH_SUMMARY_AUDIT_KIND,
  retryFailures,
  runWritebackBatch,
  type BatchPorts,
} from '@core/writeback/batch'

const NOW = '2026-11-10T10:00:00.000Z'
type SinkResult = MdmResult<Record<string, unknown>>

function makeConclusion(over: Partial<MergeConclusion> = {}): MergeConclusion {
  const evidence: EvidenceItem[] = [{
    record_id: 'MD-0001',
    field: 'spec',
    candidate_value: '0.25g*12片',
    matched_value: '0.25g*12片',
  }]
  return {
    candidate_id: 'C-0',
    domain: 'drug',
    action: 'merge',
    target_code: 'CODE-0001',
    confidence: 0.9,
    rationale: '规格与医保码一致',
    evidence,
    uncertain_reason: null,
    missing_fields: [],
    degraded: false,
    decided_at: NOW,
    ...over,
  }
}

function makeConclusions(n: number): MergeConclusion[] {
  return Array.from({ length: n }, (_, i) => makeConclusion({ candidate_id: `C-${i + 1}` }))
}

/** 记录每次 sink 调用的 candidate_id 与幂等键，按自定义规则回应。 */
function recordingSink(resolve: (id: string) => SinkResult) {
  const calls: Array<{ id: string; key: string }> = []
  const fn = vi.fn(
    async (id: string, _body: MergeSuggestionBody, key: string): Promise<SinkResult> => {
      calls.push({ id, key })
      return resolve(id)
    },
  )
  return { fn, calls }
}

const success: SinkResult = { ok: true, status: 201, data: {} }

describe('批次编排与部分失败汇总（Task 35）', () => {
  it('10 条中 1 条失败 → 其余 9 条照常写回，失败不中断', async () => {
    const { fn: sink } = recordingSink((id) =>
      id === 'C-4' ? { ok: false, status: 422, error: '候选已被驳回' } : success,
    )
    const summary = await runWritebackBatch(
      makeConclusions(10),
      { sink, now: () => NOW },
      { concurrency: 1, confirmed: true, batchId: 'B-35-1' },
    )
    expect(summary.succeeded).toBe(9)
    expect(summary.failed).toBe(1)
    expect(summary.skipped).toBe(0)
    expect(summary.total).toBe(10)
    expect(sink).toHaveBeenCalledTimes(10)
  })

  it('失败明细逐条含 candidate_id + kind + 中文 readable_reason', async () => {
    const { fn: sink } = recordingSink((id) =>
      id === 'C-2' ? { ok: false, status: 403, error: '禁止写入' } : success,
    )
    const summary = await runWritebackBatch(
      makeConclusions(3),
      { sink, now: () => NOW },
      { concurrency: 1, confirmed: true },
    )
    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0]).toMatchObject({ candidate_id: 'C-2', kind: 'client_4xx' })
    expect(summary.failures[0]!.readable_reason).toContain('权限不足')
    expect(summary.failures[0]!.readable_reason).not.toMatch(/at\s+\S|\.ts:|\.js:/)
  })

  it('单独重试失败行 → 成功且复用同一幂等键，已成功行零触碰', async () => {
    const conclusions = makeConclusions(5)
    const firstSink = recordingSink((id) =>
      id === 'C-3' ? { ok: false, status: 503, error: '上游不可用' } : success,
    )
    const first = await runWritebackBatch(
      conclusions,
      { sink: firstSink.fn, now: () => NOW },
      { concurrency: 1, confirmed: true, batchId: 'B-first' },
    )
    expect(first.failed).toBe(1)
    expect(first.succeeded).toBe(4)
    const failedKey = firstSink.calls.find((c) => c.id === 'C-3')!.key

    const retrySink = recordingSink(() => success)
    const retried = await retryFailures(
      ['C-3'],
      { sink: retrySink.fn, now: () => NOW, conclusions, replayLedger: first.ledger },
      { confirmed: true },
    )
    expect(retried.total).toBe(1)
    expect(retried.succeeded).toBe(1)
    expect(retried.failed).toBe(0)
    expect(retrySink.calls).toHaveLength(1)
    expect(retrySink.calls[0]!.id).toBe('C-3')
    expect(retrySink.calls[0]!.key).toBe(failedKey) // 同 conclusion → 同 actionHash → 同幂等键
  })

  it('汇总计数正确：三态计数、batch_id、elapsed_ms 与失败数一致', async () => {
    let tick = 0
    const clock = () => { tick += 7; return tick }
    const { fn: sink } = recordingSink((id) => {
      if (id === 'C-7' || id === 'C-8') return { ok: true, status: 409, data: {} }
      if (id === 'C-9' || id === 'C-10') return { ok: false, status: 422, error: '驳回' }
      return success
    })
    const summary = await runWritebackBatch(
      makeConclusions(10),
      { sink, now: () => NOW, clock },
      { concurrency: 2, confirmed: true, batchId: 'B-mixed' },
    )
    expect(summary.batch_id).toBe('B-mixed')
    expect(summary.total).toBe(10)
    expect(summary.succeeded).toBe(6)
    expect(summary.skipped).toBe(2)
    expect(summary.failed).toBe(2)
    expect(summary.failures).toHaveLength(2)
    expect(summary.elapsed_ms).toBe(7) // clock 仅在起点与终点各调用一次
  })

  it('并发上限受控：peakConcurrency 不超过注入的 cap 且确实发生并发', async () => {
    // 让每次写跨一个宏任务，从而可被并发观测。
    const slowSink = vi.fn(
      async (_id: string, _body: MergeSuggestionBody, _key: string): Promise<SinkResult> => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        return success
      },
    )
    const summary = await runWritebackBatch(
      makeConclusions(10),
      { sink: slowSink, now: () => NOW },
      { concurrency: 2, confirmed: true },
    )
    expect(summary.succeeded).toBe(10)
    expect(summary.peakConcurrency).toBeLessThanOrEqual(2)
    expect(summary.peakConcurrency).toBeGreaterThan(1)
  })

  it('进度回调每行触发一次，processed 递增且携带逐行回执', async () => {
    const onProgress = vi.fn()
    const { fn: sink } = recordingSink(() => success)
    await runWritebackBatch(
      makeConclusions(5),
      { sink, now: () => NOW },
      { concurrency: 1, confirmed: true, onProgress },
    )
    expect(onProgress).toHaveBeenCalledTimes(5)
    const infos = onProgress.mock.calls.map((c) => c[0] as { processed: number; total: number; receipt: { candidate_id: string } })
    expect(infos.map((i) => i.processed)).toEqual([1, 2, 3, 4, 5])
    expect(infos.every((i) => i.total === 5)).toBe(true)
    expect(infos.map((i) => i.receipt.candidate_id)).toEqual(['C-1', 'C-2', 'C-3', 'C-4', 'C-5'])
  })

  it('单行 sink 抛异常被捕获成失败项，同批其余行不受影响', async () => {
    const sink = vi.fn(async (id: string): Promise<SinkResult> => {
      if (id === 'C-2') throw new Error('boom\n at internal.ts:3:3')
      return success
    })
    const summary = await runWritebackBatch(
      makeConclusions(4),
      { sink, now: () => NOW },
      { concurrency: 1, confirmed: true },
    )
    expect(summary.succeeded).toBe(3)
    expect(summary.failed).toBe(1)
    expect(summary.failures[0]!.candidate_id).toBe('C-2')
    expect(summary.failures[0]!.readable_reason).not.toMatch(/at\s+\S|\.ts:|\.js:/)
  })

  it('一个批次级 summary 追加审计链（一次）并写入持久化 state（一次）', async () => {
    const auditAppend = vi.fn()
    const persistState = vi.fn()
    const { fn: sink } = recordingSink(() => success)
    const summary = await runWritebackBatch(
      makeConclusions(4),
      { sink, now: () => NOW, auditAppend, persistState },
      { concurrency: 2, confirmed: true, batchId: 'B-audit' },
    )
    const batchEntries = auditAppend.mock.calls.filter(
      (c) => (c[0] as { kind?: string }).kind === BATCH_SUMMARY_AUDIT_KIND,
    )
    expect(batchEntries).toHaveLength(1)
    expect(batchEntries[0]![0]).toMatchObject({ batch_id: 'B-audit' })
    expect(persistState).toHaveBeenCalledTimes(1)
    expect(persistState.mock.calls[0]![0]).toMatchObject({ batch_summary: { total: 4, succeeded: 4 } })
    expect(summary.succeeded).toBe(4)
  })

  it('整批未确认 → 全部跳过、sink 零调用', async () => {
    const { fn: sink } = recordingSink(() => success)
    const summary = await runWritebackBatch(
      makeConclusions(4),
      { sink, now: () => NOW },
      { concurrency: 2, confirmed: false },
    )
    expect(summary.skipped).toBe(4)
    expect(summary.succeeded).toBe(0)
    expect(sink).not.toHaveBeenCalled()
  })
})
